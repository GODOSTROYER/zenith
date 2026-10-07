/**
 * Regression tests for the five residual risks recorded by the first OPS-08 pass (PROD-OPS-08, findings F9-F13):
 *   F9  hosted launch `state` bound to the browser (login CSRF),
 *   F10 platform REST bearer path: one bearer kind, configured host, authority-kind rule,
 *   F11 runner dispatch honours grant revocation,
 *   F12 hosted source tar reader requires a real end-of-archive marker,
 *   F13 GitHub App private key custody.
 * Each block drives the public entry point only.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzip, writeTar } from "../_support/tar";
import { isolatedDataDir, removeDir } from "../hosted/_fixtures";
import { call as gatewayCall, makeDoubles, provenance, seedActiveRelease, seedApp, seedArtifactRow, writeBuiltTree } from "../hosted/gateway/_helpers";

/* ------------------------------ F10: platform bearer surface ------------------------------ */

const authState = vi.hoisted(() => ({ kind: "postgres" as "postgres" | "file" }));
vi.mock("@/lib/agent-access/authority", () => ({
  requireCredentialAuthority: async () => ({
    kind: authState.kind,
    verify: async () => ({ id: "cred_1", subject: "alice", workspaceId: "ws_a", label: "agent" }),
  }),
}));
vi.mock("@/lib/ops/admission", () => ({ bindRequestWorkspace: async () => undefined }));
vi.mock("@/lib/supabase/env", async (original) => ({ ...(await original<typeof import("@/lib/supabase/env")>()), isSupabaseConfigured: () => true }));

describe("F10: platform REST bearer surface", () => {
  const saved = { p: process.env.ZENITH_PLATFORM_ORIGIN, a: process.env.ZENITH_AGENT_ORIGIN };
  beforeEach(() => { process.env.ZENITH_PLATFORM_ORIGIN = "https://zenith.test"; delete process.env.ZENITH_AGENT_ORIGIN; authState.kind = "postgres"; });
  afterEach(() => {
    if (saved.p === undefined) delete process.env.ZENITH_PLATFORM_ORIGIN; else process.env.ZENITH_PLATFORM_ORIGIN = saved.p;
    if (saved.a === undefined) delete process.env.ZENITH_AGENT_ORIGIN; else process.env.ZENITH_AGENT_ORIGIN = saved.a;
  });
  const za = `za_${randomBytes(32).toString("base64url")}`;
  const request = (authorization: string, url = "https://zenith.test/api/platform/v1/operations", headers: Record<string, string> = {}) =>
    new NextRequest(url, { headers: { authorization, ...headers } });
  const outcome = async (req: NextRequest) => {
    const { callerOf } = await import("@/app/api/platform/v1/_lib/principal");
    try { return { ok: true as const, caller: await callerOf(req) }; } catch (error) { return { ok: false as const, code: (error as { code?: string }).code }; }
  };

  it("the control: a linked agent credential on the configured host becomes an integration principal", async () => {
    const result = await outcome(request(`Bearer ${za}`));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.caller).toMatchObject({ via: "bearer", workspaceId: "ws_a", principal: { kind: "integration" } });
  });

  it("refuses every other bearer kind: plugin tokens, OAuth JWTs, runner and cron secrets, other schemes", async () => {
    const wrong = [`Bearer zp_${randomBytes(32).toString("base64url")}`, "Bearer eyJhbGciOiJFUzI1NiJ9.e30.sig", `Bearer zl_${randomBytes(32).toString("base64url")}`, "Bearer cron-secret", "Bearer ", "Basic abc", `bearer ${za}`, `Bearer ${za} extra`, `Token ${za}`];
    const accepted: string[] = [];
    for (const header of wrong) if ((await outcome(request(header))).ok) accepted.push(header.slice(0, 16));
    expect(accepted).toEqual([]);
  });

  it("refuses a forged Host header (the configured origin is the only host)", async () => {
    expect((await outcome(request(`Bearer ${za}`, "https://zenith.test/api/platform/v1/operations", { host: "evil.example" }))).ok).toBe(false);
  });

  it("an operator file credential is a loopback development grant: refused over a remote origin, accepted on loopback", async () => {
    authState.kind = "file";
    process.env.ZENITH_PLATFORM_ORIGIN = "https://zenith.test";
    expect((await outcome(request(`Bearer ${za}`))).ok).toBe(false);
    process.env.ZENITH_PLATFORM_ORIGIN = "http://127.0.0.1:3400";
    expect((await outcome(request(`Bearer ${za}`, "http://127.0.0.1:3400/api/platform/v1/operations"))).ok).toBe(true);
  });
});

/* ------------------------------ F11: runner dispatch revocation ------------------------------ */

describe("F11: runner dispatch honours grant revocation", () => {
  it("a grant revoked after issue stops the job at dispatch, for both the operation and the read-job paths", async () => {
    const { createPlane, registerFakeAgent, runnerGrant, teardownPlane, OPERATION } = await import("../runners/_support");
    const { POST: registerRunner } = await import("@/app/api/platform/v1/runners/register/route");
    const { DispatchError, enqueueRunnerJob } = await import("@/lib/runners/dispatch");
    const revoked = new Set<string>();
    const lookups: string[] = [];
    const plane = await createPlane("fake", { grantRevoked: async (_workspace, jti) => { lookups.push(jti); return revoked.has(jti); } });
    try {
      const runner = await registerFakeAgent(plane, registerRunner);
      const grant = await runnerGrant(plane, { runnerId: runner.id, workspaceId: "w-a", operationId: OPERATION, capability: "infrastructure.observe" });
      const jti = (JSON.parse(Buffer.from(grant.split(".")[1]!, "base64url").toString("utf8")) as { jti: string }).jti;
      const input = { workspaceId: "w-a", runnerId: runner.id, operationId: OPERATION, capability: "infrastructure.observe", kind: "probe.tcp" as const, payload: { host: "10.0.0.1", port: 22, timeoutMs: 2000 }, grant };
      await expect(enqueueRunnerJob(input)).resolves.toBeTruthy();
      expect(lookups).toContain(jti);
      revoked.add(jti);
      await expect(enqueueRunnerJob(input)).rejects.toMatchObject({ code: "grant_invalid" });
      await expect(enqueueRunnerJob(input)).rejects.toBeInstanceOf(DispatchError);
      // the lookup is scoped to the workspace being dispatched into
      const seen: string[] = [];
      const scoped = await createPlane("fake", { grantRevoked: async (workspaceId) => { seen.push(workspaceId); return false; } });
      const second = await registerFakeAgent(scoped, registerRunner);
      await enqueueRunnerJob({ ...input, runnerId: second.id, grant: await runnerGrant(scoped, { runnerId: second.id, workspaceId: "w-a", operationId: OPERATION, capability: "infrastructure.observe" }) });
      expect(seen).toEqual(["w-a"]);
    } finally {
      teardownPlane();
    }
  });
});

/* ------------------------------ F12: hosted source tar terminator ------------------------------ */

describe("F12: hosted source tar reader needs a real end-of-archive marker", () => {
  const dir = isolatedDataDir("zenith-adv-residual-");
  afterAll(() => removeDir(dir));
  const files = () => [
    { path: "index.html", bytes: Buffer.from("<!doctype html><title>x</title>") },
    { path: "zenith.app.json", bytes: Buffer.from('{"contract":1,"schema":1,"name":"residual"}') },
    { path: "src/main.ts", bytes: Buffer.from("export const x = 1;\n") },
  ];
  const accepts = async (bytes: Buffer): Promise<boolean> => {
    const { validateSource } = await import("@/lib/hosted/source");
    try { validateSource({ kind: "tarball", bytes }); return true; } catch { return false; }
  };

  it("the control: a properly terminated archive (plain and gzipped) is accepted", async () => {
    expect(await accepts(writeTar(files()))).toBe(true);
    expect(await accepts(gzip(writeTar(files())))).toBe(true);
  });

  it("refuses an archive with no marker, a single zero block, trailing data after the marker, and cut-short entries", async () => {
    const full = writeTar(files());
    const cases: [string, Buffer][] = [
      ["no marker", writeTar(files(), { terminate: false })],
      ["one zero block", Buffer.concat([writeTar(files(), { terminate: false }), Buffer.alloc(512)])],
      ["hidden data after the marker", Buffer.concat([full, Buffer.from("hidden payload that putUpload would store")])],
      ["hidden block after the marker", Buffer.concat([full, Buffer.alloc(512, 7)])],
      ["marker then a full extra entry", Buffer.concat([full, writeTar([{ path: "src/late.ts", bytes: Buffer.from("x") }])])],
      ["truncated mid-entry", full.subarray(0, 512 + 100)],
      ["marker partly cut", full.subarray(0, full.length - 700)],
      ["declared size beyond payload", writeTar([{ path: "index.html", bytes: Buffer.from("abc"), declaredSize: 5000 }, ...files().slice(1)])],
    ];
    const accepted: string[] = [];
    for (const [label, bytes] of cases) {
      for (const form of [bytes, gzip(bytes)]) if (await accepts(form)) accepted.push(label);
    }
    expect(accepted).toEqual([]);
  });

  it("zero padding after the marker (block alignment to a record size) is still allowed", async () => {
    expect(await accepts(Buffer.concat([writeTar(files()), Buffer.alloc(10240)]))).toBe(true);
  });
});

/* ------------------------------ F13: GitHub App private key custody ------------------------------ */

describe.skipIf(process.platform === "win32")("F13: GitHub App private key custody (POSIX; Windows refuses explicitly)", () => {
  let dir = "";
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  async function usable(file: string): Promise<boolean> {
    const { createGithubApp } = await import("@/lib/sources/github/app");
    const fetchImpl = (async () => new Response(JSON.stringify({ id: 42, slug: "zenith-test" }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    try {
      await createGithubApp({ appId: "42", privateKeyFile: file }, { fetchImpl }).installUrl("state");
      return true;
    } catch { return false; }
  }

  it("accepts a private regular file and refuses group or world access, symlinks, hard links and foreign files", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "zenith-adv-ghkey-"));
    await chmod(dir, 0o700);
    const good = path.join(dir, "app.pem");
    await writeFile(good, pem, { mode: 0o600 });
    await chmod(good, 0o600);
    expect(await usable(good)).toBe(true);

    const open = path.join(dir, "open.pem");
    await writeFile(open, pem);
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o677]) { await chmod(open, mode); expect(await usable(open), mode.toString(8)).toBe(false); }

    const target = path.join(dir, "real.pem");
    await writeFile(target, pem, { mode: 0o600 });
    const sym = path.join(dir, "sym.pem");
    await symlink(target, sym);
    expect(await usable(sym)).toBe(false);

    const hard = path.join(dir, "hard.pem");
    await link(target, hard);
    expect(await usable(hard)).toBe(false);
    expect(await usable(dir)).toBe(false);
    expect(await usable(path.join(dir, "missing.pem"))).toBe(false);
    expect(await usable("relative/app.pem")).toBe(false);
  });
});

/* ------------------------------ F9: hosted launch state bound to the browser ------------------------------ */

describe("F9: hosted launch state is bound to the browser that will log in", () => {
  const DATA_DIR = isolatedDataDir("zenith-adv-launch-");
  afterAll(() => removeDir(DATA_DIR));

  it("the sign-in page mints a nonce cookie and the callback accepts only that nonce, once, for the matching code", async () => {
    const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
    const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
    const { hostedConfig } = await import("@/lib/hosted/config");
    const { handleGateway, resetGatewayDeps, setGatewayDepsForTests } = await import("@/lib/hosted/gateway");
    const authority = openAuthority();
    try {
      const store = new FsArtifactStore(hostedConfig().artifactDir);
      const artifact = await store.put(await writeBuiltTree(DATA_DIR), provenance("job-adv-launch"));
      await seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);
      const alpha = await seedApp(authority, { slug: "alpha", name: "Alpha" });
      await seedActiveRelease(authority, alpha, artifact.digest);
      const doubles = await makeDoubles();
      await resetGatewayDeps();
      await setGatewayDepsForTests(doubles.deps);
      const plant = (code: string, state: string) => doubles.state.exchanges.set(code, { state, appId: alpha.id, cookieValue: `session-${code}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      const callback = async (code: string, state: string, cookie?: string) => {
        const { req, params } = gatewayCall({ path: `/_zenith/auth/callback?code=${code}&state=${state}`, accept: "text/html", ...(cookie !== undefined ? { cookie } : {}) });
        return handleGateway(req, params);
      };

      // 1. the sign-in page sets a host-only HttpOnly nonce and links the launch with exactly that nonce
      const signin = async () => { const { req, params } = gatewayCall({ path: "/_zenith/auth/signin", accept: "text/html" }); return handleGateway(req, params); };
      const page = await signin();
      const set = page.headers.get("set-cookie") ?? "";
      const nonce = /__Host-zenith_login=([A-Za-z0-9._~-]+)/.exec(set)?.[1];
      expect(nonce, set).toBeTruthy();
      expect(set).toMatch(/Secure/);
      expect(set).toMatch(/HttpOnly/);
      expect(set).toMatch(/SameSite=Lax/);
      expect(set).toMatch(/Max-Age=\d+/);
      expect(set).not.toMatch(/Domain=/);
      expect(await page.text()).toContain(`/launch?state=${nonce}`);
      expect((await signin()).headers.get("set-cookie")).not.toBe(set); // a fresh nonce per visit

      // 2. login CSRF: the attacker's own code and state, delivered to a browser that holds no matching nonce
      const attackerState = `attacker-${randomBytes(12).toString("hex")}`;
      plant("attacker-code", attackerState);
      for (const cookie of [undefined, "", "__Host-zenith_login=", `__Host-zenith_login=${nonce}`, "__Host-zenith_login=other-nonce", `x=1; __Host-zenith_login=${nonce}`]) {
        const res = await callback("attacker-code", attackerState, cookie);
        expect(res.headers.get("location"), String(cookie)).toBe("/_zenith/auth/signin?error=invalid_input");
        expect(res.headers.get("set-cookie") ?? "").not.toContain("__Host-zenith_app=");
      }
      // the refusal did not consume the code: the legitimate holder of the matching nonce can still use it
      expect(doubles.state.exchanges.has("attacker-code")).toBe(true);

      // 3. the browser that holds the nonce redeems its own code and the nonce is cleared
      const state = nonce!;
      plant("good-code", state);
      const ok = await callback("good-code", state, `__Host-zenith_login=${state}`);
      expect(ok.status).toBe(303);
      expect(ok.headers.get("location")).toBe("/");
      const cookies = ok.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith("__Host-zenith_app=session-good-code"))).toBe(true);
      expect(cookies.some((c) => c.startsWith("__Host-zenith_login=") && /Max-Age=0/.test(c))).toBe(true);
    } finally {
      await resetGatewayDeps();
      closeAuthority();
    }
  });
});
