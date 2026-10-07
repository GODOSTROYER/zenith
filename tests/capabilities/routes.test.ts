/**
 * /api/platform/v1 as wire contracts, through the real `route()` wrapper, the
 * real product store (file store in a temp dir), the real policy bundle and the
 * broker over its in-memory store (`ZENITH_PLATFORM_BROKER_MEMORY=1`).
 *
 * What is faked: the session (who the cookie says you are), the identity
 * provider's live answer, and the credential authority for bearer tokens. What
 * is asserted: status codes, bodies, the browser-only guards on approve /
 * reject / autonomy / policy, tenant isolation over HTTP, and that nothing
 * secret-shaped ever appears in a response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDestroyReviewDispatcherForTests } from "@/lib/capabilities/destroy-review-dispatch";
import type { NextRequest as RequestType } from "next/server";
import type { SessionUser } from "@/lib/auth/session";
import type { CloudConnection, Environment, Manifest, Member, Project, Workspace } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-platform-v1-", { fast: true });
process.env.ZENITH_STORE = "file";
process.env.ZENITH_PLATFORM_BROKER_MEMORY = "1";
process.env.ZENITH_PLATFORM_ORIGIN = "https://zenith.test";
delete process.env.ZENITH_AGENT_ORIGIN;

const state = vi.hoisted(() => ({
  user: null as SessionUser | null,
  supabase: true,
  identity: { mode: "ok" as "ok" | "signed_out" | "down" | "unverified" | "other_subject" },
  credentials: [] as Record<string, unknown>[],
  token: "za_" + "a".repeat(43),
}));

vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/supabase/env")>()), isSupabaseConfigured: () => state.supabase }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/hosted/access/identity", async () => {
  const { HostedError } = await import("@/lib/hosted/contracts");
  return {
    verifyRequestIdentity: async () => {
      if (state.identity.mode === "signed_out") throw new HostedError("sign_in_required", "signed out");
      if (state.identity.mode === "down") throw new HostedError("policy_unavailable", "provider down");
      return {
        subject: state.identity.mode === "other_subject" ? "someone-else" : (state.user?.id ?? "nobody"),
        email: state.user?.email ?? "",
        emailVerified: state.identity.mode !== "unverified",
      };
    },
  };
});
vi.mock("@/lib/agent-access/authority", async () => {
  const { AgentError } = await import("@/lib/agent-access/security");
  const authority = {
    kind: "postgres" as const,
    ready: async () => undefined,
    verify: async (header: string | null) => {
      const found = header === `Bearer ${state.token}` ? state.credentials[0] : undefined;
      if (!found) throw new AgentError("unauthorized", "Supply an unexpired scoped Zenith agent credential.", 401);
      return found;
    },
    listCredentials: async (subject: string, workspaceId: string) => state.credentials.filter((c) => c.subject === subject && c.workspaceId === workspaceId),
  };
  return { credentialAuthority: () => authority, requireCredentialAuthority: async () => authority };
});

const { resetDb } = await import("@/lib/db/store");
const { WORKSPACE_COOKIE } = await import("@/lib/server/workspace");
const { NextRequest } = await import("next/server");
const { createBroker, platformBroker, resetPlatformBrokerForTests, setPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const propose = await import("@/app/api/platform/v1/capabilities/propose/route");
const check = await import("@/app/api/platform/v1/capabilities/check/route");
const operations = await import("@/app/api/platform/v1/operations/route");
const operation = await import("@/app/api/platform/v1/operations/[id]/route");
const events = await import("@/app/api/platform/v1/operations/[id]/events/route");
const approve = await import("@/app/api/platform/v1/operations/[id]/approve/route");
const reject = await import("@/app/api/platform/v1/operations/[id]/reject/route");
const cancel = await import("@/app/api/platform/v1/operations/[id]/cancel/route");
const autonomy = await import("@/app/api/platform/v1/environments/[id]/autonomy/route");
const policy = await import("@/app/api/platform/v1/workspace/policy/route");
const teardownReview = await import("@/app/api/platform/v1/environments/[id]/teardown-review/route");
afterEach(() => setDestroyReviewDispatcherForTests(undefined));

const CANARY = "AKIAIOSFODNN7EXAMPLE";
const ORIGIN = "https://zenith.test";
const AT = "2026-01-01T00:00:00.000Z";

/* ------------------------------ product store seed ------------------------- */

const ws = (id: string): Workspace => ({ id, name: id, slug: id, createdAt: AT }) as Workspace;
const member = (id: string, workspaceId: string, role: Member["role"]): Member => ({ id, workspaceId, role, name: id, email: `${id}@zenith.test` });
const manifest = (): Manifest => ({
  version: 1,
  services: [{ id: "svc-web", name: "web", kind: "web", source: { type: "image", image: "nginx" }, size: "small", replicas: 1, env: [], ownership: "managed" }],
  resources: [],
  routes: [],
  bindings: [],
});
const project = (id: string, workspaceId: string): Project => ({ id, workspaceId, name: id, slug: id, workingManifest: manifest(), createdAt: AT, origin: { type: "blank" } }) as Project;
const env = (id: string, projectId: string, klass: Environment["class"], connectionId: string): Environment =>
  ({ id, projectId, name: id, class: klass, connectionId, region: "us-east-1", policies: { approvalRequired: false, allowStatefulDeletion: false }, baseDomain: "test", createdAt: AT }) as unknown as Environment;
const connection = (id: string, workspaceId: string): CloudConnection => ({ id, workspaceId, provider: "aws", label: id, region: "us-east-1", status: "healthy", grantedPermissions: [], createdAt: AT }) as unknown as CloudConnection;

const sessionUser = (id: string): SessionUser => ({ id, email: `${id}@zenith.test`, name: id });
const signIn = (id: string | null) => {
  state.user = id ? sessionUser(id) : null;
};

function seed() {
  resetDb({
    workspaces: [ws("ws-a"), ws("ws-b")],
    members: [member("ada", "ws-a", "admin"), member("eve", "ws-a", "editor"), member("dan", "ws-a", "editor"), member("vic", "ws-a", "viewer"), member("bo", "ws-b", "admin")],
    projects: [project("pa", "ws-a"), project("pb", "ws-b")],
    environments: [env("env-prod", "pa", "production", "conn-a"), env("env-sbx", "pa", "sandbox", "conn-a"), env("env-b", "pb", "production", "conn-b")],
    connections: [connection("conn-a", "ws-a"), connection("conn-b", "ws-b")],
  });
}

/* --------------------------------- callers --------------------------------- */

interface Options {
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  workspace?: string;
  query?: string;
  /** set false to send no Origin (the default for mutations is the Zenith origin) */
  origin?: string | false;
  id?: string;
}

/** Parsed response bodies are untyped JSON: the tests assert on their shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

type Handler = (req: RequestType, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, method: string, path: string, opts: Options = {}): Promise<{ status: number; body: Json; headers: Headers; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json", cookie: `${WORKSPACE_COOKIE}=${opts.workspace ?? "ws-a"}`, ...opts.headers };
  if (method !== "GET" && opts.origin !== false) headers.origin = opts.origin ?? ORIGIN;
  const request = new NextRequest(`${ORIGIN}/api/platform/v1/${path}${opts.query ?? ""}`, {
    method,
    headers,
    ...(opts.rawBody !== undefined ? { body: opts.rawBody } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const response = await handler(request, { params: Promise.resolve({ id: opts.id ?? "unused" }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers, text };
}

const restart = (env: "env-prod" | "env-sbx" = "env-prod", extra: Record<string, unknown> = {}) => ({ capability: "service.restart", scope: { workspaceId: "ws-a", projectId: "pa", environmentId: env, resourceId: "svc-web" }, ...extra });

/** Propose over HTTP as `who` and return the operation. */
async function proposeAs(who: string, body: unknown, workspace = "ws-a") {
  signIn(who);
  const res = await call(propose.POST as Handler, "POST", "capabilities/propose", { body, workspace });
  return res;
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  process.env.ZENITH_PLATFORM_BROKER_MEMORY = "1";
  state.supabase = true;
  state.identity.mode = "ok";
  state.credentials = [
    { id: "cred-rw", subject: "eve", workspaceId: "ws-a", projectIds: ["pa"], scopes: ["read", "plan", "logs", "write"], label: "codex", issuedAt: AT, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  ];
  seed();
  resetPlatformBrokerForTests();
  signIn("eve");
});

describe("environment teardown-review REST", () => {
  beforeEach(async () => {
    const broker = await platformBroker();
    setPlatformBrokerForTests(createBroker({ ...broker.deps, signer: { ready: async () => undefined, sign: async () => "contract-test-read-grant" } }));
  });
  it("a viewer starts only a read-only review and polls it without approval", async () => {
    const dispatch = vi.fn(async () => undefined); setDestroyReviewDispatcherForTests(dispatch);
    signIn("vic");
    const result = await call(teardownReview.POST as Handler, "POST", "environments/env-sbx/teardown-review", { id: "env-sbx", body: { idempotencyKey: "rest-review-001" } });
    expect(result.status).toBe(202); expect(result.body).toMatchObject({ status: "approved", replayed: false });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a", operationId: result.body.reviewOperationId });
    const poll = await call(teardownReview.GET as Handler, "GET", "environments/env-sbx/teardown-review", { id: "env-sbx", query: `?reviewId=${result.body.reviewOperationId}` });
    expect(poll.status).toBe(200); expect(poll.body.review).toMatchObject({ reviewOperationId: result.body.reviewOperationId, status: "approved" });
    expect(result.text).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
  });
  it("accepts plan-only bearer access, rejects write-only access and hides foreign ids", async () => {
    const dispatch = vi.fn(async () => undefined); setDestroyReviewDispatcherForTests(dispatch);
    signIn(null); state.credentials[0].scopes = ["plan"];
    const headers = { authorization: `Bearer ${state.token}` };
    const accepted = await call(teardownReview.POST as Handler, "POST", "environments/env-sbx/teardown-review", { id: "env-sbx", headers, body: { idempotencyKey: "bearer-review-001" } });
    expect(accepted.status).toBe(202);
    const foreign = await call(teardownReview.POST as Handler, "POST", "environments/env-b/teardown-review", { id: "env-b", headers, body: { idempotencyKey: "foreign-review-001" } });
    const absent = await call(teardownReview.POST as Handler, "POST", "environments/missing/teardown-review", { id: "missing", headers, body: { idempotencyKey: "missing-review-001" } });
    expect(foreign.status).toBe(404); expect(foreign.body).toEqual(absent.body);
    state.credentials[0].scopes = ["write"];
    const denied = await call(teardownReview.POST as Handler, "POST", "environments/env-sbx/teardown-review", { id: "env-sbx", headers, body: { idempotencyKey: "write-review-001" } });
    expect(denied.status).toBe(403); expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("rejects approval/facts injection and reports unconfirmed dispatch without leaking transport text", async () => {
    const dispatch = vi.fn(async () => { throw new Error("Bearer transport-canary"); }); setDestroyReviewDispatcherForTests(dispatch);
    const injected = await call(teardownReview.POST as Handler, "POST", "environments/env-sbx/teardown-review", { id: "env-sbx", body: { idempotencyKey: "injected-review", approved: true } });
    expect(injected.status).toBe(400); expect(dispatch).not.toHaveBeenCalled();
    const unknown = await call(teardownReview.POST as Handler, "POST", "environments/env-sbx/teardown-review", { id: "env-sbx", body: { idempotencyKey: "unknown-review" } });
    expect(unknown.status).toBe(503); expect(unknown.body.error.details.reviewOperationId).toEqual(expect.any(String));
    expect(unknown.text).not.toContain("transport-canary");
  });
});

/* ---------------------------------- propose -------------------------------- */

describe("POST capabilities/propose and check", () => {
  it("creates an operation (201) with the decision, and replays an idempotent retry (200)", async () => {
    const first = await proposeAs("eve", restart("env-prod", { idempotencyKey: "rest-key-0001" }));
    expect(first.status).toBe(201);
    expect(first.body.replayed).toBe(false);
    expect(first.body.decision).toMatchObject({ outcome: "require_approval", approval: { count: 1, minRole: "editor" } });
    expect(first.body.operation).toMatchObject({ status: "awaiting_approval", capability: "service.restart", principal: { kind: "user", id: "eve" } });
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(first.headers.get("x-request-id")).toBeTruthy();

    const again = await proposeAs("eve", restart("env-prod", { idempotencyKey: "rest-key-0001" }));
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.operation.id).toBe(first.body.operation.id);

    const conflict = await proposeAs("eve", restart("env-prod", { idempotencyKey: "rest-key-0001", input: { other: true } }));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("idempotency_conflict");
  });

  it("allows a sandbox mutation and records it as approved", async () => {
    const res = await proposeAs("eve", restart("env-sbx"));
    expect(res.status).toBe(201);
    expect(res.body.decision.outcome).toBe("allow");
    expect(res.body.operation.status).toBe("approved");
  });

  it("returns a denial as a 201 with the reasons, not as an error", async () => {
    const res = await proposeAs("vic", restart("env-prod"));
    expect(res.status).toBe(201);
    expect(res.body.decision.outcome).toBe("deny");
    expect(res.body.decision.reasons.map((r: { code: string }) => r.code)).toContain("viewer_cannot_mutate");
    expect(res.body.operation.status).toBe("denied");
  });

  it("check answers with the decision only and persists nothing", async () => {
    signIn("eve");
    const res = await call(check.POST as Handler, "POST", "capabilities/check", { body: restart("env-prod", { idempotencyKey: "check-key-0001" }) });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["decision"]);
    expect(res.body.decision.outcome).toBe("require_approval");
    const list = await call(operations.GET as Handler, "GET", "operations");
    expect(list.body.operations).toEqual([]);
  });

  it("reads nothing from the body but the request: no plan facts, no smuggled members", async () => {
    const hostile = await proposeAs("eve", { ...restart("env-sbx"), plan: { destroysData: false } });
    expect(hostile.status).toBe(400);
    expect(hostile.body.error.code).toBe("invalid_request");
    const viaInput = await proposeAs("eve", restart("env-sbx", { input: { plan: { destroysData: false }, costDeltaUsdMonthly: -999 } }));
    const plain = await proposeAs("eve", restart("env-sbx"));
    // the input digest includes the evaluation time, so compare what was decided
    const decided = (r: { body: Json }) => ({ outcome: r.body.decision.outcome, reasons: r.body.decision.reasons, approval: r.body.decision.approval, constraints: r.body.decision.constraints });
    expect(decided(viaInput)).toEqual(decided(plain));
  });

  it("validates the body: malformed JSON, oversized bodies, unknown capabilities, incomplete scope", async () => {
    signIn("eve");
    const post = (opts: Options) => call(propose.POST as Handler, "POST", "capabilities/propose", opts);
    expect((await post({ rawBody: "{not json" })).body.error.code).toBe("invalid_request");
    const big = await post({ rawBody: JSON.stringify({ ...restart("env-sbx"), reason: "x".repeat(70 * 1024) }) });
    expect(big.status).toBe(400);
    expect(big.body.error.message).toContain("too large");
    expect((await post({ body: { capability: "no.such", scope: { workspaceId: "ws-a" } } })).status).toBe(400);
    const incomplete = await post({ body: { capability: "service.restart", scope: { workspaceId: "ws-a", environmentId: "env-sbx" } } });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.code).toBe("scope_incomplete");
  });

  it("refuses secret-shaped input with a 400 that does not echo it", async () => {
    signIn("eve");
    const res = await call(propose.POST as Handler, "POST", "capabilities/propose", { body: restart("env-sbx", { input: { api: CANARY }, reason: CANARY }) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("secret_material");
    expect(res.text).not.toContain(CANARY);
    expect((await call(operations.GET as Handler, "GET", "operations")).body.operations).toEqual([]);
  });
});

describe("authentication", () => {
  it("requires a session when auth is configured (never the demo admin)", async () => {
    signIn(null);
    for (const [handler, path, method, body] of [
      [propose.POST, "capabilities/propose", "POST", restart()],
      [check.POST, "capabilities/check", "POST", restart()],
      [operations.GET, "operations", "GET", undefined],
      [autonomy.GET, "environments/env-prod/autonomy", "GET", undefined],
      [policy.GET, "workspace/policy", "GET", undefined],
    ] as const) {
      const res = await call(handler as Handler, method, path, { body, id: "env-prod" });
      expect(res.status, path).toBe(401);
      expect(res.body.error.code, path).toBe("unauthenticated");
    }
  });

  it("serves the one local user in demo mode (no auth configured)", async () => {
    state.supabase = false;
    signIn(null);
    const res = await call(propose.POST as Handler, "POST", "capabilities/propose", { body: restart("env-sbx") });
    expect(res.status).toBe(201);
    expect(res.body.operation.principal.id).toBe("local");
  });

  it("authenticates an integration by bearer credential, bound to its workspace and subject", async () => {
    signIn(null);
    const bearer = { authorization: `Bearer ${state.token}` };
    const res = await call(propose.POST as Handler, "POST", "capabilities/propose", { body: restart("env-sbx"), headers: bearer });
    expect(res.status).toBe(201);
    expect(res.body.operation.principal).toMatchObject({ kind: "integration", id: "cred-rw", onBehalfOf: "eve" });
    expect(res.body.decision.outcome).toBe("allow");

    // a credential cannot reach another workspace, however the request names it
    const other = await call(propose.POST as Handler, "POST", "capabilities/propose", { body: { capability: "service.restart", scope: { workspaceId: "ws-b", projectId: "pb", environmentId: "env-b", resourceId: "svc-web" } }, headers: bearer });
    expect(other.status).toBe(404);
    const named = await call(operations.GET as Handler, "GET", "operations", { headers: { ...bearer, "x-zenith-workspace": "ws-b" } });
    expect(named.status).toBe(404);

    // a bad or unknown token is a 401 from the credential authority
    const bad = await call(propose.POST as Handler, "POST", "capabilities/propose", { body: restart("env-sbx"), headers: { authorization: "Bearer za_nope" } });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("unauthorized");
  });

  it("stops serving an integration when its credential is revoked", async () => {
    signIn(null);
    state.credentials = [];
    // the authority no longer verifies it
    const res = await call(propose.POST as Handler, "POST", "capabilities/propose", { body: restart("env-sbx"), headers: { authorization: `Bearer ${state.token}` } });
    expect(res.status).toBe(401);
  });
});

/* -------------------------------- approve / reject ------------------------- */

async function awaiting(requester = "eve") {
  const res = await proposeAs(requester, restart("env-prod"));
  expect(res.body.operation.status).toBe("awaiting_approval");
  return { id: res.body.operation.id as string, digest: res.body.operation.proposalDigest as string };
}

describe.each([
  ["approve", approve.POST],
  ["reject", reject.POST],
] as const)("POST operations/:id/%s — browser only", (verb, handler) => {
  const go = (op: { id: string; digest: string }, opts: Options = {}) => call(handler as Handler, "POST", `operations/${op.id}/${verb}`, { id: op.id, body: { proposalDigest: op.digest }, ...opts });

  it("a signed-in person with the same origin succeeds", async () => {
    const op = await awaiting();
    signIn("dan");
    const res = await go(op, { body: { proposalDigest: op.digest, reason: "looks right" } });
    expect(res.status).toBe(200);
    expect(res.body.operation.status).toBe(verb === "approve" ? "approved" : "rejected");
    expect(res.body.approval).toMatchObject({ decision: verb, approverId: "dan", approverRole: "editor" });
    expect(res.body.finalized).toBe(true);
  });

  it("refuses ANY Authorization header, even alongside a valid session", async () => {
    const op = await awaiting();
    signIn("dan");
    for (const value of [`Bearer ${state.token}`, "Bearer anything", "Basic abc", "x"]) {
      const res = await go(op, { headers: { authorization: value } });
      expect(res.status, value).toBe(403);
      expect(res.body.error.code).toBe("browser_session_required");
    }
    const after = await call(operation.GET as Handler, "GET", `operations/${op.id}`, { id: op.id });
    expect(after.body.operation.status).toBe("awaiting_approval");
  });

  it("refuses the Navigator's actor headers", async () => {
    const op = await awaiting();
    signIn("dan");
    const res = await go(op, { headers: { "x-zenith-actor": "navigator", "x-zenith-actor-key": "whatever" } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("browser_session_required");
  });

  it("requires the exact same origin", async () => {
    const op = await awaiting();
    signIn("dan");
    for (const origin of [false, "https://evil.test", "https://zenith.test.evil.test", "http://zenith.test", "https://sub.zenith.test", "https://zenith.test:8443", "null", "https://ZENITH.test"] as const) {
      const res = await go(op, { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.body.error.code).toBe("browser_session_required");
    }
    // Sec-Fetch-Site, when the browser sends it, must say same-origin
    for (const site of ["cross-site", "same-site", "none"]) {
      expect((await go(op, { headers: { "sec-fetch-site": site } })).status, site).toBe(403);
    }
    expect((await go(op, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });

  it("verifies identity live: signed out, unverified e-mail, a different subject, provider down", async () => {
    const op = await awaiting();
    signIn("dan");
    state.identity.mode = "signed_out";
    expect((await go(op)).status).toBe(401);
    state.identity.mode = "unverified";
    expect((await go(op)).status).toBe(401);
    state.identity.mode = "other_subject";
    expect((await go(op)).status).toBe(401);
    state.identity.mode = "down";
    const down = await go(op);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("policy_unavailable");
    state.identity.mode = "ok";
    signIn(null);
    expect((await go(op)).status).toBe(401);
    const after = await call(operation.GET as Handler, "GET", `operations/${op.id}`, { id: op.id });
    expect(after.status).toBe(401); // still not signed in; the operation is untouched, checked below
    signIn("eve");
    expect((await call(operation.GET as Handler, "GET", `operations/${op.id}`, { id: op.id })).body.operation.status).toBe("awaiting_approval");
  });

  it("answers a viewer with 403 and a non-member with the not-found body", async () => {
    const op = await awaiting();
    signIn("vic");
    const viewer = await go(op);
    expect(viewer.status).toBe(403);
    expect(viewer.body.error.code).toBe("approver_role_insufficient");
    signIn("bo");
    const outsider = await go(op, { workspace: "ws-b", headers: { "x-zenith-workspace": "ws-a" } });
    const missing = await go({ id: "op_missing", digest: op.digest }, { workspace: "ws-b", headers: { "x-zenith-workspace": "ws-a" } });
    expect(outsider.status).toBe(404);
    expect(outsider.body).toEqual(missing.body);
  });

  it("validates the body and the digest", async () => {
    const op = await awaiting();
    signIn("dan");
    expect((await go(op, { body: { proposalDigest: "not-a-digest" } })).status).toBe(400);
    expect((await go(op, { body: {} })).status).toBe(400);
    expect((await go(op, { body: { proposalDigest: op.digest, approve: true } })).status).toBe(400);
    const wrong = await go(op, { body: { proposalDigest: "0".repeat(64) } });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("digest_mismatch");
    expect((await go(op, { id: "../../etc/passwd" })).status).toBe(404);
  });
});

describe("separation of duties over HTTP", () => {
  it("refuses the requester approving their own change once workspace policy demands two people", async () => {
    signIn("ada");
    const set = await call(policy.PUT as Handler, "PUT", "workspace/policy", { body: { overrides: { twoPersonProduction: true } } });
    expect(set.status).toBe(200);
    const op = await awaiting("eve");
    signIn("eve");
    const self = await call(approve.POST as Handler, "POST", `operations/${op.id}/approve`, { id: op.id, body: { proposalDigest: op.digest } });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("separation_of_duties");
    signIn("dan");
    expect((await call(approve.POST as Handler, "POST", `operations/${op.id}/approve`, { id: op.id, body: { proposalDigest: op.digest } })).status).toBe(200);
  });

  it("never lets an integration approve: no Authorization header is accepted on approve", async () => {
    const op = await awaiting("eve");
    signIn(null);
    const res = await call(approve.POST as Handler, "POST", `operations/${op.id}/approve`, { id: op.id, body: { proposalDigest: op.digest }, headers: { authorization: `Bearer ${state.token}` } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("browser_session_required");
  });
});

/* ---------------------------- operations: read / cancel -------------------- */

describe("GET operations, detail and events; POST cancel", () => {
  it("lists newest first, paginates with an opaque cursor, and filters", async () => {
    for (let i = 0; i < 3; i++) await proposeAs("eve", restart("env-prod", { input: { n: i } }));
    await proposeAs("eve", restart("env-sbx"));
    signIn("vic");
    const page1 = await call(operations.GET as Handler, "GET", "operations", { query: "?limit=2" });
    expect(page1.status).toBe(200);
    expect(page1.body.operations).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await call(operations.GET as Handler, "GET", "operations", { query: `?limit=2&cursor=${page1.body.nextCursor}` });
    expect(page2.body.operations).toHaveLength(2);
    expect(page2.body.nextCursor).toBeUndefined();
    const ids = [...page1.body.operations, ...page2.body.operations].map((o: { id: string }) => o.id);
    expect(new Set(ids).size).toBe(4);

    const awaitingOnly = await call(operations.GET as Handler, "GET", "operations", { query: "?status=awaiting_approval" });
    expect(awaitingOnly.body.operations).toHaveLength(3);
    const sbx = await call(operations.GET as Handler, "GET", "operations", { query: "?environmentId=env-sbx&capability=service.restart" });
    expect(sbx.body.operations).toHaveLength(1);
    expect((await call(operations.GET as Handler, "GET", "operations", { query: "?status=bogus" })).status).toBe(400);
    expect((await call(operations.GET as Handler, "GET", "operations", { query: "?capability=nope.nope" })).status).toBe(400);
    expect((await call(operations.GET as Handler, "GET", "operations", { query: "?cursor=!!!" })).status).toBe(400);
    expect((await call(operations.GET as Handler, "GET", "operations", { query: "?projectId=" + "x".repeat(300) })).status).toBe(400);
    // limit is clamped, not trusted
    expect((await call(operations.GET as Handler, "GET", "operations", { query: "?limit=100000" })).status).toBe(200);
  });

  it("shows one operation with its decision and approvals, and its events", async () => {
    const op = await awaiting();
    signIn("dan");
    await call(approve.POST as Handler, "POST", `operations/${op.id}/approve`, { id: op.id, body: { proposalDigest: op.digest } });
    signIn("vic");
    const detail = await call(operation.GET as Handler, "GET", `operations/${op.id}`, { id: op.id });
    expect(detail.status).toBe(200);
    expect(detail.body.operation).toMatchObject({ id: op.id, status: "approved", proposalDigest: op.digest });
    expect(detail.body.decision.outcome).toBe("require_approval");
    expect(detail.body.approvals).toHaveLength(1);
    const ev = await call(events.GET as Handler, "GET", `operations/${op.id}/events`, { id: op.id });
    expect(ev.status).toBe(200);
    expect(ev.body.events.map((e: { type: string }) => e.type)).toEqual(["operation.proposed", "policy.evaluated", "operation.approved"]);
    const tail = await call(events.GET as Handler, "GET", `operations/${op.id}/events`, { id: op.id, query: `?afterSeq=${ev.body.events[1].seq}` });
    expect(tail.body.events.map((e: { type: string }) => e.type)).toEqual(["operation.approved"]);
  });

  it("cancels for the requester and for staff, not for an unrelated viewer", async () => {
    const op = await awaiting("eve");
    signIn("vic");
    const refused = await call(cancel.POST as Handler, "POST", `operations/${op.id}/cancel`, { id: op.id, body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("role_insufficient");
    signIn("eve");
    const done = await call(cancel.POST as Handler, "POST", `operations/${op.id}/cancel`, { id: op.id, body: { reason: "wrong env" } });
    expect(done.status).toBe(200);
    expect(done.body.operation.status).toBe("cancelled");
    const again = await call(cancel.POST as Handler, "POST", `operations/${op.id}/cancel`, { id: op.id, body: {} });
    expect(again.status).toBe(409);
    expect((await call(cancel.POST as Handler, "POST", `operations/${op.id}/cancel`, { id: op.id, body: { reason: 5 } })).status).toBe(400);
  });

  it("lets an integration cancel only what it proposed", async () => {
    const mine = await awaiting("eve"); // proposed by the person
    signIn(null);
    const bearer = { authorization: `Bearer ${state.token}` };
    const created = await call(propose.POST as Handler, "POST", "capabilities/propose", { body: restart("env-prod"), headers: bearer });
    expect(created.status).toBe(201);
    const agentOp = created.body.operation.id as string;
    const foreign = await call(cancel.POST as Handler, "POST", `operations/${mine.id}/cancel`, { id: mine.id, body: {}, headers: bearer });
    expect(foreign.status).toBe(403);
    const own = await call(cancel.POST as Handler, "POST", `operations/${agentOp}/cancel`, { id: agentOp, body: {}, headers: bearer });
    expect(own.status).toBe(200);
    expect(own.body.operation.status).toBe("cancelled");
  });
});

/* ------------------------------- tenant isolation -------------------------- */

describe("tenant isolation over HTTP", () => {
  it("answers a foreign operation id exactly like a missing one, from every endpoint", async () => {
    const op = await awaiting("eve");
    signIn("bo"); // admin of workspace B only
    const paths: [Handler, string, string, unknown?][] = [
      [operation.GET as Handler, "GET", "operations/ID"],
      [events.GET as Handler, "GET", "operations/ID/events"],
      [cancel.POST as Handler, "POST", "operations/ID/cancel", {}],
      [approve.POST as Handler, "POST", "operations/ID/approve", { proposalDigest: op.digest }],
      [reject.POST as Handler, "POST", "operations/ID/reject", { proposalDigest: op.digest }],
    ];
    for (const workspace of ["ws-a", "ws-b"]) {
      for (const [handler, method, path, body] of paths) {
        const asked = (id: string) =>
          call(handler, method, path.replace("ID", id), { id, body, workspace: "ws-b", headers: workspace === "ws-a" ? { "x-zenith-workspace": "ws-a" } : {} });
        const foreign = await asked(op.id);
        const missing = await asked("op_does_not_exist");
        expect({ path, workspace, status: foreign.status }).toEqual({ path, workspace, status: 404 });
        expect(foreign.body, `${method} ${path} in ${workspace}`).toEqual(missing.body);
      }
    }
    // B's own list never shows A's operation
    const own = await call(operations.GET as Handler, "GET", "operations", { workspace: "ws-b" });
    expect(own.status).toBe(200);
    expect(own.body.operations).toEqual([]);
    // and naming A's workspace from B is the same 404
    const named = await call(operations.GET as Handler, "GET", "operations", { workspace: "ws-b", headers: { "x-zenith-workspace": "ws-a" } });
    expect(named.status).toBe(404);
    const queried = await call(operations.GET as Handler, "GET", "operations", { workspace: "ws-b", query: "?workspace=ws-a" });
    expect(queried.status).toBe(404);
    expect(queried.body).toEqual(named.body);
    const conflict = await call(operations.GET as Handler, "GET", "operations", { workspace: "ws-b", headers: { "x-zenith-workspace": "ws-a" }, query: "?workspace=ws-b" });
    expect(conflict.status).toBe(400);
    const weird = await call(operations.GET as Handler, "GET", "operations", { workspace: "ws-b", headers: { "x-zenith-workspace": "../ws-a" } });
    expect(weird.status).toBe(404);
    expect(weird.body).toEqual(named.body);
  });

  it("answers foreign scope ids in propose and check exactly like missing ones", async () => {
    signIn("eve");
    const ask = (scope: Record<string, string>, handler: Handler = propose.POST as Handler, path = "capabilities/propose") =>
      call(handler, "POST", path, { body: { capability: "service.restart", scope } });
    const cases = [
      { workspaceId: "ws-b", projectId: "pb", environmentId: "env-b", resourceId: "svc-web" },
      { workspaceId: "ws-a", projectId: "pb", environmentId: "env-prod", resourceId: "svc-web" },
      { workspaceId: "ws-a", projectId: "pa", environmentId: "env-b", resourceId: "svc-web" },
      { workspaceId: "ws-nope", projectId: "p", environmentId: "e", resourceId: "r" },
    ];
    const bodies = [];
    for (const scope of cases) {
      const a = await ask(scope);
      const b = await ask(scope, check.POST as Handler, "capabilities/check");
      expect([a.status, b.status]).toEqual([404, 404]);
      bodies.push(a.body, b.body);
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect((await call(operations.GET as Handler, "GET", "operations")).body.operations).toEqual([]);
  });

  it("does not let a member of A read or write B's settings", async () => {
    signIn("ada");
    const readEnv = await call(autonomy.GET as Handler, "GET", "environments/env-b/autonomy", { id: "env-b" });
    const missingEnv = await call(autonomy.GET as Handler, "GET", "environments/env-nope/autonomy", { id: "env-nope" });
    expect(readEnv.status).toBe(404);
    expect(readEnv.body).toEqual(missingEnv.body);
    expect((await call(autonomy.PUT as Handler, "PUT", "environments/env-b/autonomy", { id: "env-b", body: { level: 5 } })).status).toBe(404);
    expect((await call(policy.GET as Handler, "GET", "workspace/policy", { headers: { "x-zenith-workspace": "ws-b" } })).status).toBe(404);
    expect((await call(policy.PUT as Handler, "PUT", "workspace/policy", { headers: { "x-zenith-workspace": "ws-b" }, body: { overrides: { twoPersonProduction: true } } })).status).toBe(404);
    const broker = await platformBroker();
    expect((await broker.deps.store.getEnvironmentSettings("ws-b", "env-b")).isDefault).toBe(true);
    expect((await broker.deps.store.getWorkspacePolicy("ws-b")).isDefault).toBe(true);
  });
});

/* ---------------------------------- settings ------------------------------- */

describe("environments/:id/autonomy", () => {
  it("lets any member read, with the class default until set", async () => {
    signIn("vic");
    const res = await call(autonomy.GET as Handler, "GET", "environments/env-prod/autonomy", { id: "env-prod" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ environmentId: "env-prod", level: 2, defaulted: true, environmentClass: "production", defaultForClass: 2, navigator: "approve" });
  });

  it("lets an admin in a browser change it, and records who", async () => {
    signIn("ada");
    const res = await call(autonomy.PUT as Handler, "PUT", "environments/env-prod/autonomy", { id: "env-prod", body: { level: 3 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ level: 3, defaulted: false, version: 1, updatedBy: "ada" });
    const conflict = await call(autonomy.PUT as Handler, "PUT", "environments/env-prod/autonomy", { id: "env-prod", body: { level: 4, expectedVersion: 0 } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("conflict");
  });

  it("refuses editors, agents, other origins and bad levels", async () => {
    signIn("eve");
    const editor = await call(autonomy.PUT as Handler, "PUT", "environments/env-prod/autonomy", { id: "env-prod", body: { level: 5 } });
    expect(editor.status).toBe(403);
    expect(editor.body.error.code).toBe("admin_required");

    signIn("ada");
    const put = (opts: Options) => call(autonomy.PUT as Handler, "PUT", "environments/env-prod/autonomy", { id: "env-prod", body: { level: 5 }, ...opts });
    const agent = await put({ headers: { authorization: `Bearer ${state.token}` } });
    expect(agent.status).toBe(403);
    expect(agent.body.error.code).toBe("browser_session_required");
    expect((await put({ origin: "https://evil.test" })).status).toBe(403);
    expect((await put({ origin: false })).status).toBe(403);
    expect((await put({ body: { level: 9 } })).status).toBe(400);
    expect((await put({ body: { level: "5" } })).status).toBe(400);
    expect((await put({ body: { level: 5, extra: 1 } })).status).toBe(400);
    expect((await call(autonomy.GET as Handler, "GET", "environments/env-prod/autonomy", { id: "env-prod" })).body.defaulted).toBe(true);
  });

  it("changes what propose decides", async () => {
    signIn("ada");
    await call(autonomy.PUT as Handler, "PUT", "environments/env-prod/autonomy", { id: "env-prod", body: { level: 4 } });
    const res = await proposeAs("eve", restart("env-prod"));
    expect(res.body.decision.outcome).toBe("allow");
  });
});

describe("workspace/policy", () => {
  it("reads defaults, then an admin's validated overrides", async () => {
    signIn("vic");
    const before = await call(policy.GET as Handler, "GET", "workspace/policy");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ isDefault: true, overrides: {}, effective: { costApprovalThresholdUsd: 50 } });
    signIn("ada");
    const saved = await call(policy.PUT as Handler, "PUT", "workspace/policy", { body: { overrides: { costApprovalThresholdUsd: 5, approvedRegions: ["us-east-1"] } } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, effective: { costApprovalThresholdUsd: 5, approvedRegions: ["us-east-1"] } });
  });

  it("refuses invalid policy with the fields listed", async () => {
    signIn("ada");
    const put = (overrides: unknown) => call(policy.PUT as Handler, "PUT", "workspace/policy", { body: { overrides } });
    const unknown = await put({ notAKnob: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("invalid_request");
    expect(unknown.body.error.details.issues.length).toBeGreaterThan(0);
    expect((await put({ deniedCapabilities: ["typo"] })).status).toBe(400);
    expect((await call(policy.PUT as Handler, "PUT", "workspace/policy", { body: { overrides: { twoPersonProduction: true }, extra: 1 } })).status).toBe(400);
    expect((await call(policy.PUT as Handler, "PUT", "workspace/policy", { body: { overrides: "nope" } })).status).toBe(400);
    expect((await call(policy.GET as Handler, "GET", "workspace/policy")).body.isDefault).toBe(true);
  });

  it("refuses editors, agents and cross-origin requests", async () => {
    signIn("eve");
    const editor = await call(policy.PUT as Handler, "PUT", "workspace/policy", { body: { overrides: { twoPersonProduction: true } } });
    expect(editor.status).toBe(403);
    expect(editor.body.error.code).toBe("admin_required");
    signIn("ada");
    const send = (opts: Options) => call(policy.PUT as Handler, "PUT", "workspace/policy", { body: { overrides: { twoPersonProduction: true } }, ...opts });
    expect((await send({ headers: { authorization: `Bearer ${state.token}` } })).status).toBe(403);
    expect((await send({ origin: "https://evil.test" })).status).toBe(403);
    expect((await send({ origin: false })).status).toBe(403);
    state.identity.mode = "signed_out";
    expect((await send({})).status).toBe(401);
  });
});

/* ---------------------------- the store is never guessed -------------------- */

describe("which store answers", () => {
  it("refuses with platform_store_unavailable when no store is connected and memory is not explicitly enabled", async () => {
    delete process.env.ZENITH_PLATFORM_BROKER_MEMORY;
    vi.stubEnv("ZENITH_PLATFORM_DB", "postgres"); // configured for Postgres, but no URL: the store cannot open
    vi.stubEnv("ZENITH_PLATFORM_DB_URL", "");
    vi.stubEnv("SUPABASE_DB_URL", "");
    resetPlatformBrokerForTests();
    signIn("eve");
    const res = await call(propose.POST as Handler, "POST", "capabilities/propose", { body: restart("env-sbx") });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("platform_store_unavailable");
    expect(res.body.error.fix).toContain("ZENITH_PLATFORM_BROKER_MEMORY=1");
    const list = await call(operations.GET as Handler, "GET", "operations");
    expect(list.status).toBe(503);
  });

  it("does not default a production build to a local PGlite directory", async () => {
    delete process.env.ZENITH_PLATFORM_BROKER_MEMORY;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ZENITH_PLATFORM_DB", "");
    vi.stubEnv("ZENITH_PLATFORM_DB_URL", "");
    vi.stubEnv("SUPABASE_DB_URL", "");
    resetPlatformBrokerForTests();
    signIn("eve");
    const res = await call(propose.POST as Handler, "POST", "capabilities/propose", { body: restart("env-sbx") });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("platform_store_unavailable");
    expect(res.body.error.message).toContain("will not default to a local PGlite directory");
  });

  it("uses the in-memory store only when ZENITH_PLATFORM_BROKER_MEMORY=1", async () => {
    const broker = await platformBroker();
    expect(broker.deps.store.constructor.name).toBe("MemoryBrokerStore");
  });
});

/* ------------------------------- nothing secret ---------------------------- */

describe("no response carries a secret-looking value", () => {
  it("scrubs executor output and never returns a grant or token", async () => {
    const created = await proposeAs("eve", restart("env-sbx", { input: { note: "ok", secretRef: "vault:pa/svc-web/KEY" } }));
    const id = created.body.operation.id as string;
    const broker = await platformBroker();
    const begun = await broker.beginExecution({ workspaceId: "ws-a", operationId: id, holder: "w", audience: "worker" }).catch((e: unknown) => e);
    // no signing key is configured in this process: the grant cannot be issued, and that is fine here
    expect((begun as { code?: string }).code).toBe("signer_unavailable");
    await broker.deps.store.claimForExecution({ workspaceId: "ws-a", id, expectedDigest: created.body.operation.proposalDigest, holder: "w" });
    await broker.completeExecution({ workspaceId: "ws-a", operationId: id, outcome: "failed", result: { log: `key ${CANARY}` }, error: `bad credentials ${CANARY}` });

    signIn("vic");
    const bodies = [
      (await call(operation.GET as Handler, "GET", `operations/${id}`, { id })).text,
      (await call(operations.GET as Handler, "GET", "operations")).text,
      (await call(events.GET as Handler, "GET", `operations/${id}/events`, { id })).text,
      created.text,
    ];
    for (const text of bodies) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./);
      expect(text).not.toContain("za_aaaa");
      expect(text.toLowerCase()).not.toContain("authorization");
    }
    expect(bodies[0]).toContain("[redacted]");
  });

  it("sets no-store on every answer, errors included", async () => {
    signIn("eve");
    for (const res of [
      await call(operations.GET as Handler, "GET", "operations"),
      await call(operation.GET as Handler, "GET", "operations/op_nope", { id: "op_nope" }),
      await call(propose.POST as Handler, "POST", "capabilities/propose", { rawBody: "{" }),
      await call(approve.POST as Handler, "POST", "operations/x/approve", { id: "x", body: {}, headers: { authorization: "Bearer x" } }),
    ]) {
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("x-request-id")).toBeTruthy();
    }
  });

  it("answers an unexpected failure with a generic 500 that leaks nothing", async () => {
    signIn("eve");
    const broker = await platformBroker();
    setPlatformBrokerForTests({
      ...broker,
      listOperations: async () => {
        throw new Error(`database exploded near ${CANARY} at /etc/secret/path`);
      },
    });
    const res = await call(operations.GET as Handler, "GET", "operations");
    setPlatformBrokerForTests(null);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(CANARY);
    expect(res.text).not.toContain("/etc/secret");
  });
});
