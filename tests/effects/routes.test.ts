/**
 * PROD-DUR-07 direct REST joins for /api/platform/v1/effects: the real route handlers, the real browser/principal
 * guards, the real effects service over a real control store (PGlite). External identity, credential
 * verification, boot/admission and the provider read are explicit adapters; no provider, worker or scheduler
 * is started here.
 */
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/controlplane/types";
import type { PlatformEffects } from "@/lib/platform/effects-service";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-effect-routes-", { fast: true });
process.env.ZENITH_STORE = "file";
// Identity/policy transports are fixture adapters; the shipping MFA guard still verifies them.
const stepUp = vi.hoisted(() => ({ aal: "aal2", policyAvailable: true }));
const adapters = vi.hoisted(() => ({
  platform: undefined as PlatformEffects | undefined,
  userId: "alice", liveSubject: "alice", emailVerified: true,
  token: "",
  verifyCredential: vi.fn<(header: string) => Promise<{ id: string; workspaceId: string; subject: string; label: string }>>(),
}));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/supabase/env", async (original) => ({ ...await original<typeof import("@/lib/supabase/env")>(), isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => ({ id: adapters.userId, name: adapters.userId, email: `${adapters.userId}@zenith.test` }) }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: async () => ({ subject: adapters.liveSubject, email: `${adapters.liveSubject}@zenith.test`, emailVerified: adapters.emailVerified }) }));
vi.mock("@/lib/agent-access/authority", () => ({ requireCredentialAuthority: async () => ({ verify: adapters.verifyCredential }) }));
vi.mock("@/lib/platform/effects", () => ({ platformEffects: async () => {
  if (!adapters.platform) throw new Error("test composition absent");
  return adapters.platform;
} }));

vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: {
  getClaims: async () => ({ data: { claims: { sub: adapters.userId, aal: stepUp.aal, exp: Date.now() / 1000 + 600 } }, error: null }),
  getUser: async () => ({ data: { user: { id: adapters.userId, email_confirmed_at: "2026-01-01T00:00:00.000Z", factors: [{ factor_type: "totp", status: "verified" }] } }, error: null }),
} }) }));
vi.mock("@/lib/auth/mfa-policy", async (original) => {
  const policy = await original<typeof import("@/lib/auth/mfa-policy")>();
  return { ...policy, workspaceMfaControl: async () => {
    if (!stepUp.policyAvailable) { const { ApiError } = await import("@/lib/server/errors"); throw new ApiError("Workspace MFA controls could not be verified.", 503); }
    return policy.DEFAULT_MFA_CONTROL;
  } };
});

const { resetDb } = await import("@/lib/db/store");
const { BrokerError } = await import("@/lib/capabilities/errors");
const { openPlatformDb } = await import("@/lib/controlplane/db");
const store = await import("@/lib/controlplane/db/repos/external-effects");
const { createPlatformEffects } = await import("@/lib/platform/effects-service");
const { ResolverRegistry } = await import("@/lib/effects/readback");
const { resolutionBinding } = await import("@/lib/effects/binding");
const { insertAged, seed, readback } = await import("./_support");
const { GET: listEffects } = await import("@/app/api/platform/v1/effects/route");
const { GET: readEffect } = await import("@/app/api/platform/v1/effects/[id]/route");
const { POST: readbackEffect } = await import("@/app/api/platform/v1/effects/[id]/readback/route");
const { POST: resolveEffect } = await import("@/app/api/platform/v1/effects/[id]/resolve/route");

const WS = "ws-fx-a", OTHER = "ws-fx-b";
type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Options = { method?: "GET" | "POST"; workspace?: string; headers?: Record<string, string>; query?: string };

let db: Awaited<ReturnType<typeof openPlatformDb>>;
let found: "present" | "absent" | "unavailable" = "present";
let reads = 0;

beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); });
afterAll(async () => { await db.close(); });
beforeEach(() => {
  stepUp.aal = "aal2"; stepUp.policyAvailable = true;
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
  adapters.userId = adapters.liveSubject = "alice"; adapters.emailVerified = true;
  adapters.token = `za_${randomBytes(24).toString("hex")}`;
  adapters.verifyCredential.mockReset();
  adapters.verifyCredential.mockImplementation(async (header) => {
    if (header !== `Bearer ${adapters.token}`) throw new BrokerError("unauthenticated", "Present a valid integration credential.");
    return { id: "integration-a", workspaceId: WS, subject: "alice", label: "Route fixture" };
  });
  resetDb({ workspaces: [WS, OTHER].map((id) => ({ id, name: id, slug: id, createdAt: new Date().toISOString() })), members: [
    ...["alice", "erin", "viewer", "editor"].map((id) => ({ id, workspaceId: WS, role: id === "viewer" ? "viewer" as const : id === "editor" ? "editor" as const : "admin" as const, name: id, email: `${id}@zenith.test` })),
    { id: "bob", workspaceId: OTHER, role: "admin", name: "bob", email: "bob@zenith.test" },
  ] });
  reads = 0; found = "present";
  const rank = (p: Principal, workspaceId: string): number => {
    const human = p.onBehalfOf ?? p.id;
    return workspaceId === WS ? ({ alice: 2, erin: 2, editor: 1, viewer: 0 } as Record<string, number>)[human] ?? -1 : workspaceId === OTHER && human === "bob" ? 2 : -1;
  };
  adapters.platform = createPlatformEffects({
    db,
    registry: new ResolverRegistry([{ family: "build_launch", provider: "aws", async read() {
      reads++;
      return found === "present" ? { outcome: "present", source: "route.fake", resourceId: "found-build", requestIds: ["rq"], facts: { matches: 1 } }
        : { outcome: found, source: "route.fake", facts: { matches: 0 }, ...(found === "unavailable" ? { reason: "throttled" } : {}) };
    } }]),
    async authorize(principal, workspaceId, need) {
      const r = rank(principal, workspaceId);
      if (r < 0) throw new BrokerError("not_found", "Not found.");
      if (r < { viewer: 0, editor: 1, admin: 2 }[need]) throw new BrokerError("role_insufficient", "Not enough role.");
      if (principal.kind === "integration" && need !== "viewer") throw new BrokerError("role_insufficient", "Credential scope.");
    },
  });
});
afterEach(() => { adapters.platform = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const human = (id: string): void => { adapters.userId = adapters.liveSubject = id; };
function call(handler: Handler, pathname: string, body?: unknown, options: Options = {}) {
  const method = options.method ?? "POST", workspace = options.workspace ?? WS;
  return handler(new NextRequest(`https://zenith.test/api/platform/v1/effects${pathname}${options.query ?? ""}`, { method,
    headers: { "content-type": "application/json", origin: "https://zenith.test", "sec-fetch-site": "same-origin", cookie: `zenith-workspace=${workspace}`, "x-zenith-workspace": workspace, ...options.headers },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  }), { params: Promise.resolve({ id: pathname.split("/").filter(Boolean)[0] ?? "" }) });
}
async function refused(response: Response, status: number, code: string) {
  expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ error: { code } });
}
async function refusedStepUp(response: Response) {
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ error: { message: "Verify your authenticator before continuing with this privileged action." } });
}
async function uncertainEffect() {
  const s = await seed(db, WS);
  return { s, e: await insertAged(db, s, { state: "uncertain" }) };
}

describe("GET /effects and /effects/:id", () => {
  it("lists an operation's effects and shows the evidence, state and resolution options", async () => {
    const { s, e } = await uncertainEffect();
    const list = await call(listEffects, "", undefined, { method: "GET", query: `?operationId=${s.operationId}&unresolved=1` });
    expect(list.status).toBe(200);
    const body = await list.json() as { effects: { effectId: string; state: string; needsOperator: boolean }[] };
    expect(body.effects).toEqual([expect.objectContaining({ effectId: e.effectId, state: "uncertain", needsOperator: true })]);
    const one = await call(readEffect, `/${e.effectId}`, undefined, { method: "GET" });
    expect(await one.json()).toMatchObject({ effect: { effectId: e.effectId, state: "uncertain", resolutionOptions: [{ decision: "confirm_applied", available: false }, { decision: "confirm_not_applied", available: false }] } });
  });

  it("a viewer may read; a foreign workspace member and a foreign id are the same 404", async () => {
    const { e } = await uncertainEffect();
    human("viewer");
    expect((await call(readEffect, `/${e.effectId}`, undefined, { method: "GET" })).status).toBe(200);
    human("bob");
    await refused(await call(readEffect, `/${e.effectId}`, undefined, { method: "GET", workspace: OTHER }), 404, "not_found");
    await refused(await call(readEffect, `/${e.effectId}`, undefined, { method: "GET", workspace: WS }), 404, "not_found");
    await refused(await call(readEffect, "/fx_missing", undefined, { method: "GET", workspace: OTHER }), 404, "not_found");
  });

  it("rejects a malformed operation id and a malformed effect id", async () => {
    await refused(await call(listEffects, "", undefined, { method: "GET", query: "?operationId=../x" }), 404, "not_found");
    await refused(await call(readEffect, "/..%2F..", undefined, { method: "GET" }), 404, "not_found");
  });
});

describe("POST /effects/:id/readback", () => {
  it("an editor runs the read-only readback and the evidence is stored without resolving anything", async () => {
    const { e } = await uncertainEffect();
    human("editor");
    const response = await call(readbackEffect, `/${e.effectId}/readback`);
    expect(response.status).toBe(200);
    const { effect } = await response.json() as { effect: { state: string; readback: { outcome: string; source: string }; resolutionOptions: { decision: string; available: boolean }[] } };
    expect(reads).toBe(1);
    expect(effect).toMatchObject({ state: "uncertain", readback: { outcome: "present", source: "route.fake" } });
    expect(effect.resolutionOptions.find((o) => o.decision === "confirm_applied")?.available).toBe(true);
  });

  it("a viewer cannot cause provider reads", async () => {
    const { e } = await uncertainEffect();
    human("viewer");
    await refused(await call(readbackEffect, `/${e.effectId}/readback`), 403, "role_insufficient");
    expect(reads).toBe(0);
  });

  it("a foreign workspace cannot read back another workspace's effect", async () => {
    const { e } = await uncertainEffect();
    human("bob");
    await refused(await call(readbackEffect, `/${e.effectId}/readback`, undefined, { workspace: OTHER }), 404, "not_found");
    expect(reads).toBe(0);
  });
});

describe("POST /effects/:id/resolve", () => {
  const bindingFor = async (workspaceId: string, effectId: string, decision: "confirm_applied" | "confirm_not_applied") => {
    const e = (await store.get(db, workspaceId, effectId))!;
    return resolutionBinding(e, decision, e.readback!.digest);
  };
  async function withReadback(outcome: "present" | "absent" = "present") {
    const { s, e } = await uncertainEffect();
    await store.recordReadback(db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback(outcome === "present" ? {} : { outcome: "absent", resourceId: undefined }), actor: "t" });
    return { s, e };
  }

  it("a signed-in admin confirms the effect on the exact reviewed binding", async () => {
    const { s, e } = await withReadback();
    const response = await call(resolveEffect, `/${e.effectId}/resolve`, { decision: "confirm_applied", bindingDigest: await bindingFor(s.workspaceId, e.effectId, "confirm_applied"), reason: "the console shows one build" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ effect: { state: "confirmed", resolutions: [{ decision: "confirm_applied", approverId: "alice" }] } });
  });

  it("refuses a stale or wrong binding", async () => {
    const { e } = await withReadback();
    await refused(await call(resolveEffect, `/${e.effectId}/resolve`, { decision: "confirm_applied", bindingDigest: "f".repeat(64), reason: "because it is there" }), 409, "digest_mismatch");
  });

  it("accepts absence once the settle window has passed, and refuses it inside the window", async () => {
    const { s, e } = await withReadback("absent");
    const live = await call(resolveEffect, `/${e.effectId}/resolve`, { decision: "confirm_not_applied", bindingDigest: await bindingFor(s.workspaceId, e.effectId, "confirm_not_applied"), reason: "nothing there at all" });
    // aged one hour and no live fence: allowed. A young effect is refused by the database.
    expect(live.status).toBe(200);
    const young = await seed(db, WS);
    const y = await insertAged(db, young, { state: "uncertain", ageMs: 30_000 });
    await store.recordReadback(db, { workspaceId: WS, effectId: y.effectId, readback: readback({ outcome: "absent", resourceId: undefined }), actor: "t" });
    await refused(await call(resolveEffect, `/${y.effectId}/resolve`, { decision: "confirm_not_applied", bindingDigest: await bindingFor(WS, y.effectId, "confirm_not_applied"), reason: "nothing there at all" }), 409, "invalid_state");
  });

  it("refuses unverified MFA and unavailable policy before resolving the effect", async () => {
    const { s, e } = await withReadback();
    const before = await store.get(db, s.workspaceId, e.effectId);
    const body = { decision: "confirm_applied", bindingDigest: await bindingFor(s.workspaceId, e.effectId, "confirm_applied"), reason: "reviewed effect" };
    stepUp.aal = "aal1";
    await refusedStepUp(await call(resolveEffect, `/${e.effectId}/resolve`, body));
    stepUp.aal = "aal2"; stepUp.policyAvailable = false;
    expect((await call(resolveEffect, `/${e.effectId}/resolve`, body)).status).toBe(503);
    expect(await store.get(db, s.workspaceId, e.effectId)).toEqual(before);
  });

  it("is browser-only: an integration credential is refused whatever it says", async () => {
    const { s, e } = await withReadback();
    await refusedStepUp(await call(resolveEffect, `/${e.effectId}/resolve`, { decision: "confirm_applied", bindingDigest: await bindingFor(s.workspaceId, e.effectId, "confirm_applied"), reason: "credential attempt" }, { headers: { authorization: `Bearer ${adapters.token}` } }));
    expect((await store.get(db, s.workspaceId, e.effectId))!.state).toBe("uncertain");
  });

  it("refuses a cross-origin request and a non-admin member", async () => {
    const { s, e } = await withReadback();
    const body = { decision: "confirm_applied", bindingDigest: await bindingFor(s.workspaceId, e.effectId, "confirm_applied"), reason: "from elsewhere" };
    await refusedStepUp(await call(resolveEffect, `/${e.effectId}/resolve`, body, { headers: { origin: "https://evil.test" } }));
    human("editor");
    await refused(await call(resolveEffect, `/${e.effectId}/resolve`, body), 403, "role_insufficient");
    human("viewer");
    await refused(await call(resolveEffect, `/${e.effectId}/resolve`, body), 403, "role_insufficient");
    expect((await store.get(db, s.workspaceId, e.effectId))!.state).toBe("uncertain");
  });

  it("another workspace's admin cannot resolve it", async () => {
    const { s, e } = await withReadback();
    human("bob");
    await refused(await call(resolveEffect, `/${e.effectId}/resolve`, { decision: "confirm_applied", bindingDigest: await bindingFor(s.workspaceId, e.effectId, "confirm_applied"), reason: "foreign admin" }, { workspace: OTHER }), 404, "not_found");
    expect((await store.get(db, s.workspaceId, e.effectId))!.state).toBe("uncertain");
  });

  it("validates the body without echoing it", async () => {
    const { e } = await uncertainEffect();
    for (const body of [{}, { decision: "retry", bindingDigest: "a".repeat(64), reason: "no retry decision exists" }, { decision: "confirm_applied", bindingDigest: "xyz", reason: "bad digest shape" }, { decision: "confirm_applied", bindingDigest: "a".repeat(64), reason: "x" }, { decision: "confirm_applied", bindingDigest: "a".repeat(64), reason: "ok reason", extra: "BODY-VALUE-CANARY" }]) {
      const response = await call(resolveEffect, `/${e.effectId}/resolve`, body);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain("BODY-VALUE-CANARY");
    }
  });
});
