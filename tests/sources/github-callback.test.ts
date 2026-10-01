/**
 * Real route wrapper, membership/role checks, browser guard and PGlite intent SQL.
 * Supabase identity and GitHub HTTP are mocked; no live install is claimed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import type { Member, Workspace } from "@/lib/domain/types";
import type { PlatformDb } from "@/lib/controlplane/types";
import { tempDataDir } from "../_support/data-dir";
import { api, INSTALL_TOKEN, USER_TOKEN, json, keys } from "./fixtures";

tempDataDir("zenith-github-callback-", { fast: true });
process.env.ZENITH_STORE = "file";
const state = vi.hoisted(() => ({ user: { id: "human", email: "human@zenith.test", name: "Human" } as SessionUser | null, verified: true, db: undefined as PlatformDb | undefined }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", async (original) => ({ ...await original<typeof import("@/lib/supabase/env")>(), isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: async () => ({ subject: state.user?.id, email: state.user?.email, emailVerified: state.verified }) }));
vi.mock("@/lib/controlplane/db/open", async (original) => ({ ...await original<typeof import("@/lib/controlplane/db/open")>(), platformDb: async () => state.db! }));

const { resetDb } = await import("@/lib/db/store");
const { NextRequest } = await import("next/server");
const { openPlatformDb } = await import("@/lib/controlplane/db");
const { createGithubSourceStore } = await import("@/lib/sources/github/store");
const { digest } = await import("@/lib/sources/github/store");
const { GET, POST } = await import("@/app/api/platform/v1/github/callback/route");
const ROOT = "https://zenith.test/api/platform/v1/github/callback";
const AGENT_HEADERS: Record<string, string>[] = [{ authorization: "Bearer synthetic-agent-canary" }, { authorization: "" }, { "x-zenith-actor": "navigator" }, { "x-zenith-actor-key": "synthetic-navigator-canary" }];
const CROSS_SITE_HEADERS: Record<string, string>[] = [{ origin: "https://evil.test" }, { origin: "null" }, { origin: "" }, { "sec-fetch-site": "cross-site" }];
let material: Awaited<ReturnType<typeof keys>>;
let fetchImpl: ReturnType<typeof api>;
beforeAll(async () => { material = await keys(); state.db = await openPlatformDb({ kind: "pglite" }); });
afterAll(async () => { await state.db?.close(); await material.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test"); vi.stubEnv("ZENITH_HOSTED_MODE", "0");
  vi.stubEnv("ZENITH_GITHUB_APP_ID", "42"); vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE", material.config.privateKeyFile);
  vi.stubEnv("ZENITH_GITHUB_APP_CLIENT_ID", "Iv1.synthetic"); vi.stubEnv("ZENITH_GITHUB_APP_CLIENT_SECRET_FILE", material.config.clientSecretFile!);
  fetchImpl = api(); vi.stubGlobal("fetch", fetchImpl); state.verified = true;
  state.user = { id: "human", email: "human@zenith.test", name: "Human" };
  resetDb({ workspaces: ["ws-a", "ws-b"].map((id) => ({ id, name: id, slug: id, createdAt: new Date(0).toISOString() } as Workspace)), members: [
    { id: "human", workspaceId: "ws-a", email: "human@zenith.test", name: "Human", role: "admin" },
    { id: "editor", workspaceId: "ws-a", email: "editor@zenith.test", name: "Editor", role: "editor" },
  ] as Member[] });
  for (const table of ["github_install_intents", "github_source_bindings"]) await state.db!.query(`delete from platform.${table} where workspace_id = $1`, ["ws-a"]);
});
async function call(method: "GET" | "POST", query = "", opts: { cookie?: string; body?: string; headers?: Record<string, string> } = {}) {
  return (method === "GET" ? GET : POST)(new NextRequest(ROOT + query, {
    method, headers: { cookie: `zenith-workspace=ws-a${opts.cookie ? `; ${opts.cookie}` : ""}`, ...(method === "POST" ? { origin: "https://zenith.test", "content-type": "application/x-www-form-urlencoded" } : {}), ...opts.headers },
    ...(method === "POST" ? { body: opts.body ?? "repository=acme%2Fapp" } : {}),
  }), { params: Promise.resolve({}) });
}
async function start() {
  const response = await call("POST"); expect(response.status).toBe(303);
  const target = new URL(response.headers.get("location")!); const installState = target.searchParams.get("state")!;
  const cookie = response.headers.get("set-cookie")!.split(";")[0]; return { state: installState, cookie, response };
}
async function authorize(input: { state: string; cookie: string }) {
  return call("GET", `?installation_id=7&setup_action=install&state=${input.state}`, { cookie: input.cookie });
}

describe("GitHub browser install callback", () => {
  it("serves a browser form and redirects installation with protected expiring proof cookies", async () => {
    const form = await call("GET"); expect(form.status).toBe(200); expect(await form.text()).toContain("Install and bind repository");
    const started = await start(); expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.response.headers.get("location")?.startsWith("https://github.com/apps/zenith-test/installations/new?state=")).toBe(true);
    const allowedFormDestinations = /form-action ([^;]+)/.exec(form.headers.get("content-security-policy") ?? "")?.[1].split(" ");
    expect(allowedFormDestinations).toContain(new URL(started.response.headers.get("location")!).origin);
    expect(started.response.headers.get("set-cookie")).toMatch(/HttpOnly/); expect(started.response.headers.get("set-cookie")).toMatch(/Secure/); expect(started.response.headers.get("set-cookie")).toMatch(/SameSite=lax/i);
    expect(started.response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("binds only after server-side OAuth and GitHub user repository verification", async () => {
    const started = await start(); const auth = await authorize(started); expect(auth.status).toBe(303);
    const target = new URL(auth.headers.get("location")!);
    expect(target.origin + target.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(target.searchParams.get("code_challenge")).toBe(Buffer.from(digest(started.cookie.split("=")[1]), "hex").toString("base64url"));
    const response = await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie });
    expect(response.status).toBe(200); const body = await response.text(); expect(body).toContain("GitHub source connected");
    const binding = await createGithubSourceStore(state.db!).getBinding("ws-a"); expect(binding?.repositoryId).toBe(99); expect(binding?.installationId).toBe(7);
    const output = body + JSON.stringify(binding) + [...response.headers.values()].join(" ");
    expect(output.includes(INSTALL_TOKEN) || output.includes(USER_TOKEN) || output.includes("synthetic-code")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it.each(AGENT_HEADERS)("rejects agent headers for form/start/callback: %j", async (headers) => {
    for (const method of ["GET", "POST"] as const) expect((await call(method, "", { headers })).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(CROSS_SITE_HEADERS)("refuses cross-site install mutations: %j", async (headers) => {
    expect((await call("POST", "", { headers })).status).toBe(403); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("requires current verified identity and the admin role", async () => {
    state.verified = false; expect((await call("GET")).status).toBe(401);
    state.verified = true; state.user = { id: "editor", email: "editor@zenith.test", name: "Editor" }; expect((await call("POST")).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses a callback after the initiating human changes", async () => {
    const started = await start(); await authorize(started); state.user = { id: "editor", email: "editor@zenith.test", name: "Editor" };
    const response = await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie }); expect(response.status).toBe(403);
    expect(await createGithubSourceStore(state.db!).getBinding("ws-a")).toBeUndefined();
  });
  it("refuses a named workspace outside the selected membership", async () => {
    expect((await call("POST", "?workspace=ws-b")).status).toBe(403); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("requires the original browser proof and single-use callback state", async () => {
    const started = await start();
    expect((await call("GET", `?installation_id=7&state=${started.state}`)).status).toBe(403);
    expect((await authorize(started)).status).toBe(303); expect((await authorize(started)).status).toBe(403);
    expect((await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie })).status).toBe(200);
    expect((await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie })).status).toBe(403);
  });
  it("refuses a repository invisible to the GitHub user and consumes that callback", async () => {
    const started = await start(); await authorize(started);
    fetchImpl.mockResolvedValueOnce(json({ access_token: USER_TOKEN, token_type: "bearer" })).mockResolvedValueOnce(json({ repositories: [{ id: 100, full_name: "foreign/private" }] }));
    expect((await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie })).status).toBe(403);
    expect(await createGithubSourceStore(state.db!).getBinding("ws-a")).toBeUndefined();
    expect((await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie })).status).toBe(403);
  });
  it("scrubs external token errors from HTTP and logs", async () => {
    const started = await start(); await authorize(started); fetchImpl.mockRejectedValueOnce(new Error(USER_TOKEN));
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const response = await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie }); expect(response.status).toBe(503);
      const body = await response.text(); const output = body + JSON.stringify(logs.flatMap((log) => log.mock.calls));
      expect(output.includes(USER_TOKEN) || output.includes(INSTALL_TOKEN)).toBe(false);
    } finally { logs.forEach((log) => log.mockRestore()); }
  });
  it.each(["repository=acme%2Fapp&repository=foreign%2Fprivate", "repository=https%3A%2F%2Ftoken%40github.com%2Facme%2Fapp", "repository=acme%2Fapp&installation_id=7", "repository=" + "x".repeat(1100)])("rejects invalid form input without HTTP: %s", async (body) => {
    expect((await call("POST", "", { body })).status).toBe(400); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses duplicate parameters and direct callbacks without install state", async () => {
    const started = await start(); expect((await call("GET", `?installation_id=7&state=${started.state}&state=${started.state}`, { cookie: started.cookie })).status).toBe(400);
    expect((await call("GET", "?installation_id=7")).status).toBe(400);
  });
});
