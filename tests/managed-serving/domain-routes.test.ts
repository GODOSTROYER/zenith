/**
 * Domain route contracts through the real request/browser guards, broker role/scope ports, domain service and PGlite.
 * The session, identity and credential authority are test doubles. DNS is an explicit in-memory port; no cloud is called.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest as RequestType } from "next/server";
import type { SessionUser } from "@/lib/auth/session";
import type { CloudConnection, Environment, Manifest, Member, Project, Workspace } from "@/lib/domain/types";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import type { TxtLookup } from "@/lib/managed-serving/domains";
import { tempDataDir } from "../_support/data-dir";
import { FULL_ENV } from "../providers/zenith/support";

tempDataDir("zenith-domain-routes-", { fast: true });
process.env.ZENITH_STORE = "file";
process.env.ZENITH_PLATFORM_BROKER_MEMORY = "1";
process.env.ZENITH_PLATFORM_ORIGIN = "http://127.0.0.1:3000";
delete process.env.ZENITH_AGENT_ORIGIN;

const state = vi.hoisted(() => ({
  user: null as SessionUser | null,
  identityVerified: true,
  credentials: [] as Record<string, unknown>[],
  token: "",
  sql: undefined as PlatformDbHandle | undefined,
  dns: vi.fn<(name: string) => Promise<TxtLookup>>(),
}));

vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", async (original) => ({ ...(await original<typeof import("@/lib/supabase/env")>()), isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/auth/mfa-policy", () => ({ workspaceMfaControl: async () => ({ privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null }) }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: {
  getClaims: async () => ({ data: { claims: { sub: state.user?.id, aal: "aal2", exp: Date.now() / 1000 + 600 } }, error: null }),
  getUser: async () => ({ data: { user: { id: state.user?.id, email_confirmed_at: state.identityVerified ? new Date().toISOString() : null, factors: [{ factor_type: "totp", status: "verified" }] } }, error: null }),
} }) }));
vi.mock("@/lib/hosted/access/identity", () => ({
  verifyRequestIdentity: async () => ({ subject: state.user?.id ?? "nobody", email: state.user?.email ?? "", emailVerified: state.identityVerified }),
}));
vi.mock("@/lib/agent-access/authority", async () => {
  const { AgentError } = await import("@/lib/agent-access/security");
  const authority = {
    kind: "file" as const,
    ready: async () => undefined,
    verify: async (header: string | null) => {
      const found = header === `Bearer ${state.token}` ? state.credentials[0] : undefined;
      if (!found) throw new AgentError("unauthorized", "Supply a current scoped credential.", 401);
      return found;
    },
    listCredentials: async (subject: string, workspaceId: string) => state.credentials.filter((c) => c.subject === subject && c.workspaceId === workspaceId),
  };
  return { credentialAuthority: () => authority, requireCredentialAuthority: async () => authority };
});
vi.mock("@/lib/controlplane/db", async (original) => ({
  ...(await original<typeof import("@/lib/controlplane/db")>()),
  platformDb: async () => {
    if (!state.sql) throw new Error("The test database is not open.");
    return state.sql;
  },
}));
vi.mock("@/lib/managed-serving/domains", async (original) => ({
  ...(await original<typeof import("@/lib/managed-serving/domains")>()),
  systemDomainDns: () => ({ resolveTxt: state.dns }),
}));

const { db, resetDb } = await import("@/lib/db/store");
const { WORKSPACE_COOKIE } = await import("@/lib/server/workspace");
const { NextRequest } = await import("next/server");
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { resetPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const domains = await import("@/app/api/platform/v1/environments/[id]/domains/route");
const verify = await import("@/app/api/platform/v1/environments/[id]/domains/verify/route");
const revoke = await import("@/app/api/platform/v1/environments/[id]/domains/revoke/route");

const ORIGIN = "http://127.0.0.1:3000";
const AT = "2026-01-01T00:00:00.000Z";
const MANIFEST: Manifest = { version: 1, services: [], resources: [], routes: [], bindings: [] };
const workspace = (id: string): Workspace => ({ id, name: id, slug: id, createdAt: AT });
const member = (id: string, workspaceId: string, role: Member["role"]): Member => ({ id, workspaceId, role, name: id, email: `${id}@zenith.test` });
const project = (id: string, workspaceId: string): Project => ({ id, workspaceId, name: id, slug: id, workingManifest: MANIFEST, createdAt: AT, origin: { type: "blank" } }) as Project;
const environment = (id: string, projectId: string, connectionId = "managed"): Environment => ({
  id, projectId, name: id, class: "production", connectionId, region: "zenith-managed", createdAt: AT,
  policies: { approvalRequired: false, allowStatefulDeletion: false }, baseDomain: "apps.example.com",
}) as Environment;
const connection = (id: string, provider: "zenith" | "aws"): CloudConnection => ({
  id, workspaceId: "ws-a", provider, label: id, region: "zenith-managed", status: "healthy", grantedPermissions: [], createdAt: AT,
}) as CloudConnection;
const signIn = (id: string | null) => { state.user = id ? { id, email: `${id}@zenith.test`, name: id } : null; };

type Handler = (req: RequestType, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Action = "list" | "claim" | "verify" | "revoke";
const handlers: Record<Action, Handler> = { list: domains.GET, claim: domains.POST, verify: verify.POST, revoke: revoke.POST };
interface Options { body?: unknown; rawBody?: string; id?: string; headers?: Record<string, string>; origin?: string | false }
// Response JSON is intentionally untyped: each test asserts its wire contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
async function call(action: Action, opts: Options = {}): Promise<{ status: number; body: Json; text: string; headers: Headers }> {
  const id = opts.id ?? "env-a";
  const suffix = action === "verify" || action === "revoke" ? `/${action}` : "";
  const headers: Record<string, string> = { host: new URL(ORIGIN).host, "content-type": "application/json", cookie: `${WORKSPACE_COOKIE}=ws-a`, ...opts.headers };
  if (action !== "list" && opts.origin !== false) headers.origin = opts.origin ?? ORIGIN;
  const request = new NextRequest(`${ORIGIN}/api/platform/v1/environments/${id}/domains${suffix}`, {
    method: action === "list" ? "GET" : "POST", headers,
    ...(opts.rawBody !== undefined ? { body: opts.rawBody } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const response = await handlers[action](request, { params: Promise.resolve({ id }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, text, headers: response.headers };
}

beforeAll(async () => { state.sql = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await state.sql?.close(); });
beforeEach(async () => {
  for (const key of Object.keys(process.env)) if (key.startsWith("ZENITH_MANAGED_")) delete process.env[key];
  Object.assign(process.env, FULL_ENV);
  state.token = `za_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  state.identityVerified = true;
  state.dns.mockReset().mockResolvedValue({ status: "none" });
  state.credentials = [{ id: "cred-ro", subject: "viewer", workspaceId: "ws-a", projectIds: ["pa"], scopes: ["read"], label: "local test", issuedAt: AT, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }];
  resetDb({
    workspaces: [workspace("ws-a"), workspace("ws-b")],
    members: [member("admin", "ws-a", "admin"), member("editor", "ws-a", "editor"), member("viewer", "ws-a", "viewer"), member("other", "ws-b", "admin")],
    projects: [project("pa", "ws-a"), project("pa2", "ws-a"), project("pb", "ws-b")],
    environments: [environment("env-a", "pa"), environment("env-a2", "pa2"), environment("env-b", "pb"), environment("env-aws", "pa", "byoc")],
    connections: [connection("managed", "zenith"), connection("byoc", "aws")],
  });
  resetPlatformBrokerForTests();
  signIn("admin");
  await state.sql!.query("delete from platform.managed_domains where workspace_id in ($1, $2)", ["ws-a", "ws-b"]);
});

async function claim(id = "env-a") {
  const response = await call("claim", { id, body: { hostname: `shop-${randomUUID().slice(0, 8)}.customer.com` } });
  expect(response.status).toBe(201);
  return response.body;
}

describe("custom-domain route authorization", () => {
  it.each<Action>(["list", "claim", "verify", "revoke"])("requires authentication for %s", async (action) => {
    signIn(null);
    expect((await call(action, { body: action === "list" ? undefined : {} })).status).toBe(401);
    expect(state.dns).not.toHaveBeenCalled();
  });

  it("lists for a browser viewer and a scoped bearer without exposing the once-only challenge", async () => {
    const created = await claim();
    signIn("viewer");
    const browser = await call("list");
    expect(browser.status).toBe(200);
    expect(browser.body).toMatchObject({ environmentId: "env-a", domains: [{ id: created.domain.id, state: "pending" }], policy: { provisional: true } });
    expect(browser.headers.get("cache-control")).toContain("no-store");
    expect(browser.text).not.toContain(created.challenge.recordValue);
    signIn(null);
    const bearer = await call("list", { headers: { authorization: `Bearer ${state.token}` } });
    expect(bearer.status).toBe(200);
    expect(bearer.body).toEqual(browser.body);
  });

  it("refuses a forged bearer", async () => {
    signIn(null);
    expect((await call("list", { headers: { authorization: `Bearer za_${randomUUID()}` } })).status).toBe(401);
  });

  it("bounds bearer reads to the current project and environment grants", async () => {
    signIn(null);
    const headers = { authorization: `Bearer ${state.token}` };
    const absent = await call("list", { id: "absent", headers });
    expect(absent.status).toBe(404);
    const foreignProject = await call("list", { id: "env-a2", headers });
    expect(foreignProject.status).toBe(404);
    expect(foreignProject.body).toEqual(absent.body);
    state.credentials[0].environmentIds = ["env-a2"];
    const outsideEnvironment = await call("list", { headers });
    expect(outsideEnvironment.status).toBe(404);
    expect(outsideEnvironment.body).toEqual(absent.body);
  });

  it("requires read scope and rechecks current membership on every bearer read", async () => {
    signIn(null);
    const headers = { authorization: `Bearer ${state.token}` };
    state.credentials[0].scopes = ["write"];
    expect((await call("list", { headers })).status).toBe(403);
    state.credentials[0].scopes = ["read"];
    expect((await call("list", { headers })).status).toBe(200);
    db().members = db().members.filter((m) => m.id !== "viewer");
    expect((await call("list", { headers })).status).toBe(404);
  });

  it.each<Action>(["list", "claim", "verify", "revoke"])("hides foreign and missing environments for %s", async (action) => {
    const body = action === "list" ? undefined : action === "claim" ? { hostname: "shop.customer.com" } : { domainId: "domain-unseen" };
    const foreign = await call(action, { id: "env-b", body });
    const absent = await call(action, { id: "missing", body });
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(foreign.body).toEqual(absent.body);
  });

  describe.each<Action>(["claim", "verify", "revoke"])("%s browser mutation", (action) => {
    const body = action === "claim" ? { hostname: "shop.customer.com" } : { domainId: "domain-unseen" };
    it("requires the browser, same origin and a verified live identity", async () => {
      expect((await call(action, { body, headers: { authorization: `Bearer ${state.token}` } })).status).toBe(403);
      expect((await call(action, { body, origin: false })).status).toBe(403);
      expect((await call(action, { body, origin: "https://foreign.test" })).status).toBe(403);
      expect((await call(action, { body, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
      state.identityVerified = false;
      expect((await call(action, { body })).status).toBe(401);
      expect(state.dns).not.toHaveBeenCalled();
    });
    it("requires an admin and refuses non-managed providers", async () => {
      for (const role of ["viewer", "editor"]) {
        signIn(role);
        expect((await call(action, { body })).status).toBe(403);
      }
      signIn("admin");
      const byoc = await call(action, { body, id: "env-aws" });
      expect(byoc.status).toBe(409);
      expect(byoc.body.error.code).toBe("invalid_state");
      expect(state.dns).not.toHaveBeenCalled();
    });
    it("rejects malformed JSON, unknown fields and invalid field types", async () => {
      for (const rawBody of ["{", JSON.stringify({ ...body, approved: true }), JSON.stringify(action === "claim" ? { hostname: 42 } : { domainId: "../other" })]) {
        const response = await call(action, { rawBody });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("invalid_request");
      }
      expect(state.dns).not.toHaveBeenCalled();
      expect(await repos.managedServing.listDomains(state.sql!, "ws-a", "env-a")).toEqual([]);
    });
  });
});

describe("custom-domain route lifecycle", () => {
  it("claims, reissues, verifies DNS, lists serving state and terminally revokes through HTTP", async () => {
    const first = await claim();
    const again = await call("claim", { body: { hostname: first.domain.hostname } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: "reissued", domain: { id: first.domain.id } });
    expect(again.body.challenge.recordValue).not.toBe(first.challenge.recordValue);
    state.dns.mockResolvedValue({ status: "records", records: [again.body.challenge.recordValue] });
    const proven = await call("verify", { body: { domainId: first.domain.id } });
    expect(proven.status).toBe(200);
    expect(proven.body).toMatchObject({ change: "verified", domain: { state: "serving", status: "verified" }, verification: { outcome: "verified" } });
    expect(state.dns).toHaveBeenCalledExactlyOnceWith(again.body.challenge.recordName);
    const noChallenge = await call("claim", { body: { hostname: first.domain.hostname } });
    expect(noChallenge.status).toBe(200);
    expect(noChallenge.body.outcome).toBe("already_verified");
    expect(noChallenge.body).not.toHaveProperty("challenge");
    expect((await call("list")).body.domains).toMatchObject([{ id: first.domain.id, state: "serving" }]);
    const ended = await call("revoke", { body: { domainId: first.domain.id } });
    expect(ended.status).toBe(200);
    expect(ended.body.domain).toMatchObject({ id: first.domain.id, status: "revoked", state: "revoked" });
    expect((await call("verify", { body: { domainId: first.domain.id } })).status).toBe(409);
    expect((await call("revoke", { body: { domainId: first.domain.id } })).status).toBe(404);
    expect((await repos.managedServing.getDomain(state.sql!, "ws-a", first.domain.id))?.status).toBe("revoked");
  });

  it("reports absent and uncertain DNS proofs without marking the claim verified", async () => {
    const created = await claim();
    const missing = await call("verify", { body: { domainId: created.domain.id } });
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ domain: { state: "pending" }, verification: { outcome: "not_found" } });
    state.dns.mockResolvedValue({ status: "error", code: "SERVFAIL" });
    const uncertain = await call("verify", { body: { domainId: created.domain.id } });
    expect(uncertain.status).toBe(200);
    expect(uncertain.body).toMatchObject({ domain: { state: "pending" }, verification: { outcome: "uncertain" } });
  });

  it.each<Action>(["verify", "revoke"])("%s binds the claim to both workspace and environment before calling DNS", async (action) => {
    const otherEnvironment = await claim("env-a2");
    const notInEnvironment = await call(action, { body: { domainId: otherEnvironment.domain.id } });
    const absent = await call(action, { body: { domainId: "missing" } });
    expect(notInEnvironment.status).toBe(404);
    expect(notInEnvironment.body).toEqual(absent.body);
    const foreign = await repos.managedServing.claimDomain(state.sql!, {
      workspaceId: "ws-b", environmentId: "env-b", hostname: "foreign.customer.com", challengeHash: "a".repeat(64), requestedBy: "other", maxLive: 10, pendingTtlMs: 86_400_000, now: new Date(),
    });
    const notInWorkspace = await call(action, { body: { domainId: foreign.domain.id } });
    expect(notInWorkspace.status).toBe(404);
    expect(notInWorkspace.body).toEqual(absent.body);
    expect(state.dns).not.toHaveBeenCalled();
    expect((await repos.managedServing.getDomain(state.sql!, "ws-a", otherEnvironment.domain.id))?.status).toBe("pending");
  });

  it("maps hostname refusals and substrate unavailability while listing stays available", async () => {
    for (const hostname of ["*.customer.com", "app.apps.example.com", "127.0.0.1"]) {
      const response = await call("claim", { body: { hostname } });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("invalid_request");
    }
    delete process.env.ZENITH_MANAGED_APP_DOMAIN;
    expect((await call("claim", { body: { hostname: "shop.customer.com" } })).status).toBe(409);
    expect((await call("list")).status).toBe(200);
  });
});
