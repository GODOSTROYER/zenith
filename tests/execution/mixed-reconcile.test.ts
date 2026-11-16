/**
 * Recording a reconciliation of an indeterminate mixed-run child (PROD-MIX-04 recovery): the service function and the
 * browser-only operator route over the in-memory run store. Contract level: no provider is read; the operator's evidence is
 * a digest, and the run ledger keeps ids and digests only.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerError } from "@/lib/capabilities/errors";
import { MixedOrchestrationError } from "@/lib/execution/mixed-orchestration/errors";
import { MemoryMixedRunStore } from "@/lib/execution/mixed-orchestration/run-store";
import { openMixedRun, readMixedRun, reconcileChild, recordChildEvent, type MixedRunDeps } from "@/lib/execution/mixed-orchestration/service";
import { MemoryPreauthorizationStore } from "@/lib/execution/mixed-orchestration/preauthorization";
import { allowDecision, makeHarness, proposeOk, requestFor, scriptedEngine, user, type Harness } from "../capabilities/support";
import { at, H, NOW, start, world, type World } from "./fakes/mixed-fixture";

const state = vi.hoisted(() => ({ caller: undefined as unknown, context: undefined as unknown }));
vi.mock("@/lib/server/request", async (original) => ({
  ...await original<typeof import("@/lib/server/request")>(),
  route: (_options: unknown, handler: (req: unknown, params: unknown) => Promise<Response>) => (req: unknown, ctx: { params: Promise<unknown> }) => ctx.params.then((params) => handler(req, params)),
}));
vi.mock("@/app/api/platform/v1/_lib/browser", () => ({
  assertBrowserSession: async () => {
    if (state.caller instanceof Error) throw state.caller;
    return state.caller;
  },
}));
vi.mock("@/app/api/platform/v1/_lib/mixed-run", async (original) => ({
  ...await original<typeof import("@/app/api/platform/v1/_lib/mixed-run")>(),
  mixedContext: async () => state.context,
}));
const { POST } = await import("@/app/api/platform/v1/operations/[id]/mixed-run/reconcile/route");

const EVIDENCE = H("provider-readback");
const caller = (workspaceId: string, id: string) => ({ principal: user(id), session: { method: "browser_session", subject: id, verifiedAtMs: Date.now() }, workspaceId });

interface Rig { h: Harness; store: MemoryMixedRunStore; deps: MixedRunDeps; w: World; op: string; ws: string }

async function rig(): Promise<Rig> {
  const h = await makeHarness({ kind: "memory", engine: scriptedEngine("mix-reconcile", () => allowDecision()) });
  const proposed = await proposeOk(h, requestFor(h, "service.restart", "prod", { reason: "mix" }), user("alice"));
  const store = new MemoryMixedRunStore();
  const deps: MixedRunDeps = {
    runs: store, preauthorizations: new MemoryPreauthorizationStore(), now: () => NOW,
    parentReview: { approvedParentDigest: async () => null }, teardownApprovals: { lookup: async () => null }, roles: h.broker.deps.roles,
  };
  const w = world();
  const view = { ...w.view, workspaceId: h.ids.wsA };
  await openMixedRun(deps, { workspaceId: h.ids.wsA, parentOperationId: proposed.id, view, expiresAt: at(120), childTimeoutMs: 600_000 });
  state.context = { broker: h.broker, sql: {}, deps };
  return { h, store, deps, w: { ...w, view }, op: proposed.id, ws: h.ids.wsA };
}

const send = (r: Rig, event: unknown) => recordChildEvent(r.deps, { workspaceId: r.ws, parentOperationId: r.op, event, view: r.w.view });
/** The database child started and then failed with possible effects: reconciliation is required. */
const indeterminate = async (r: Rig) => {
  await send(r, start(r.w.ids.db, r.w.state, 1));
  await send(r, { kind: "fail", childId: r.w.ids.db, reason: "provider_error", effects: "possible", at: at(2) });
};
const call = async (r: Rig, body: unknown, id = r.op) => {
  const response = await POST(new NextRequest(`https://zenith.test/api/platform/v1/operations/${id}/mixed-run/reconcile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() as { summary?: Record<string, unknown>; error?: { code: string } } };
};
const ok = (r: Rig, over: Record<string, unknown> = {}) => ({ childId: r.w.ids.db, outcome: "no_effects", evidenceDigest: EVIDENCE, ...over });
const child = async (r: Rig) => (await readMixedRun(r.deps, r.ws, r.op))!.state.children[r.w.ids.db];

describe("reconcileChild", () => {
  it("clears the reconciliation flag, sets what the evidence says and records who and which digest, never a value", async () => {
    const r = await rig();
    await indeterminate(r);
    expect(await child(r)).toMatchObject({ status: "failed", effects: "possible", reconciliationRequired: true });
    const summary = await reconcileChild(r.deps, { workspaceId: r.ws, parentOperationId: r.op, childId: r.w.ids.db, outcome: "effects_present", evidenceDigest: EVIDENCE, reconciledBy: "alice" });
    expect(summary.indeterminate).toEqual([]);
    expect(await child(r)).toMatchObject({ status: "failed", effects: "present", reconciliationRequired: false });
    const entry = (await r.store.events(r.ws, r.op)).find((event) => event.kind === "reconciled")!;
    expect(entry.childId).toBe(r.w.ids.db);
    expect(entry.data).toMatchObject({ kind: "reconciled", childId: r.w.ids.db, outcome: "effects_present", evidenceDigest: EVIDENCE, reconciledBy: "alice" });
  });

  it("refuses a child that needs no reconciliation, an unknown child, an unknown run, another workspace and a malformed digest", async () => {
    const r = await rig();
    const input = { workspaceId: r.ws, parentOperationId: r.op, childId: r.w.ids.db, outcome: "no_effects" as const, evidenceDigest: EVIDENCE, reconciledBy: "alice" };
    const code = (promise: Promise<unknown>) => promise.then(() => "accepted", (error: unknown) => (error as MixedOrchestrationError).code);
    expect(await code(reconcileChild(r.deps, input))).toBe("illegal_transition");
    await indeterminate(r);
    expect(await code(reconcileChild(r.deps, { ...input, childId: "missing" }))).toBe("unknown_child");
    expect(await code(reconcileChild(r.deps, { ...input, parentOperationId: "op_none" }))).toBe("unknown_child");
    expect(await code(reconcileChild(r.deps, { ...input, workspaceId: r.h.ids.wsB }))).toBe("unknown_child");
    expect(await code(reconcileChild(r.deps, { ...input, evidenceDigest: "sha256:nope" }))).toBe("invalid_input");
    expect((await child(r)).reconciliationRequired).toBe(true);
    expect(await code(reconcileChild(r.deps, input))).toBe("accepted");
    expect(await code(reconcileChild(r.deps, input))).toBe("illegal_transition");
  });
});

describe("POST /operations/:id/mixed-run/reconcile", () => {
  beforeEach(() => { state.caller = undefined; });

  it("records the operator's reconciliation and answers with the run summary", async () => {
    const r = await rig();
    await indeterminate(r);
    state.caller = caller(r.ws, "alice");
    const answer = await call(r, ok(r));
    expect(answer.status).toBe(200);
    expect(answer.body.summary).toMatchObject({ indeterminate: [], atomicity: "none", automaticCompensation: "never" });
    expect(await child(r)).toMatchObject({ effects: "none", reconciliationRequired: false });
    expect((await r.store.events(r.ws, r.op)).at(-1)).toMatchObject({ kind: "reconciled", data: { reconciledBy: "alice", outcome: "no_effects", evidenceDigest: EVIDENCE } });
  });

  it("lets an editor reconcile and refuses a viewer, with the run untouched", async () => {
    const r = await rig();
    await indeterminate(r);
    state.caller = caller(r.ws, "carol");
    const refused = await call(r, ok(r));
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe("role_insufficient");
    expect((await child(r)).reconciliationRequired).toBe(true);
    state.caller = caller(r.ws, "bob");
    expect((await call(r, ok(r))).status).toBe(200);
  });

  it("is browser-only: an agent or foreign-origin request is refused before anything else is read", async () => {
    const r = await rig();
    await indeterminate(r);
    state.caller = new BrokerError("browser_session_required", "needs a person");
    const answer = await call(r, ok(r));
    expect(answer.status).toBe(403);
    expect(answer.body.error?.code).toBe("browser_session_required");
    expect((await child(r)).reconciliationRequired).toBe(true);
  });

  it("answers a typed 409 with the reducer's reason when nothing needs reconciling, and never twice", async () => {
    const r = await rig();
    state.caller = caller(r.ws, "alice");
    const idle = await call(r, ok(r));
    expect(idle).toMatchObject({ status: 409, body: { error: { code: "invalid_state", details: { reason: "illegal_transition", ids: [r.w.ids.db] } } } });
    await indeterminate(r);
    expect((await call(r, ok(r))).status).toBe(200);
    expect((await call(r, ok(r))).status).toBe(409);
  });

  it("answers typed 4xx for bad bodies, unknown children, foreign workspaces, missing runs and bad ids; never 500", async () => {
    const r = await rig();
    await indeterminate(r);
    state.caller = caller(r.ws, "alice");
    for (const body of [{}, ok(r, { outcome: "maybe" }), ok(r, { evidenceDigest: "abc" }), ok(r, { evidenceDigest: H("x").toUpperCase() }), ok(r, { extra: 1 }), ok(r, { childId: "" }), { childId: r.w.ids.db, outcome: "no_effects" }]) {
      expect((await call(r, body)).status).toBe(400);
    }
    expect((await call(r, ok(r, { childId: "missing" }))).status).toBe(404);
    expect((await call(r, ok(r), "op_missing")).status).toBe(404);
    expect((await call(r, ok(r), "bad/id")).status).toBe(404);
    state.caller = caller(r.h.ids.wsB, "alice");
    expect((await call(r, ok(r))).status).toBe(404);
    expect((await child(r)).reconciliationRequired).toBe(true);
  });
});
