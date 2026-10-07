/**
 * PROD-MIX-03/04 service layer: precise output preauthorizations created by a person in a browser, durable
 * run operations over the in-memory store (same rules as the SQL repo: tenant filter, version compare-and-set,
 * append-only ledger), the housekeeping-style sweep, teardown through a verified human destroy approval, and the
 * route helpers. Contract level: no cloud API is called.
 */
import { describe, expect, it } from "vitest";
import { asBrokerError, authorizeRunControl } from "@/app/api/platform/v1/_lib/mixed";
import { BrokerError } from "@/lib/capabilities/errors";
import type { BrokerDeps } from "@/lib/capabilities/ports";
import { MixedOrchestrationError, type MixedOrchestrationErrorCode } from "@/lib/execution/mixed-orchestration/errors";
import {
  createOutputPreauthorization, listOutputPreauthorizations, MemoryPreauthorizationStore, resolveLivePreauthorizations, revokeOutputPreauthorization,
  type NewOutputPreauthorization,
} from "@/lib/execution/mixed-orchestration/preauthorization";
import { MemoryMixedRunStore } from "@/lib/execution/mixed-orchestration/run-store";
import {
  cancelMixedRun, consumeOutputs, openMixedRun, proposeTeardown, readMixedRun, recordChildEvent, releaseTeardown, sweepDueMixedRuns, syncTeardownStep, tickMixedRun,
  type MixedRunDeps, type ParentReviewPort,
} from "@/lib/execution/mixed-orchestration/service";
import { brokerTeardownApprovalPort, type DestroyApprovalFact } from "@/lib/execution/mixed-orchestration/teardown";
import { allowDecision, expectBrokerError, integrationOf, makeHarness, proposeOk, requestFor, scriptedEngine, sessionFor, user } from "../capabilities/support";
import { at, complete, consume, DB, ENV, finish, FN, H, NOW, outputFor, PARENT, start, throughWeb, WEB, WS, world, type World } from "./fakes/mixed-fixture";

function refusedCode(promise: Promise<unknown>): Promise<MixedOrchestrationErrorCode> {
  return promise.then(
    () => { throw new Error("expected a refusal, but the call succeeded"); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(MixedOrchestrationError);
      return (error as MixedOrchestrationError).code;
    },
  );
}

/* ----------------------------- preauthorization ---------------------------- */

describe("output preauthorizations are a person's precise, bounded decision", () => {
  const engine = scriptedEngine("mix-test", () => allowDecision());
  const base = (h: Awaited<ReturnType<typeof makeHarness>>, over: Record<string, unknown> = {}) => ({
    workspaceId: h.ids.wsA, actor: user("alice"), session: sessionFor("alice"), parentOperationId: PARENT, environmentId: h.ids.envAProd,
    desiredDigest: H("desired"), referenceId: "db-host", contractDigest: H("contract"), consumerSubplanDigest: H("consumer"), producerSubplanDigest: H("producer"),
    valueType: "endpoint" as const, maxUses: 2, lifetimeMs: 3_600_000, ...over,
  });

  it("is created by a human admin with their own browser session, with every bound recorded and audited", async () => {
    const h = await makeHarness({ kind: "memory", engine });
    const store = new MemoryPreauthorizationStore();
    const row = await createOutputPreauthorization(h.deps, store, base(h));
    expect(row).toMatchObject({ createdBy: "alice", parentOperationId: PARENT, referenceId: "db-host", valueType: "endpoint", maxUses: 2, uses: 0, status: "active" });
    expect(Date.parse(row.expiresAt) - Date.parse(row.createdAt)).toBe(3_600_000);
    const events = await h.store.listEvents(h.ids.wsA, { environmentId: h.ids.envAProd });
    expect(events.find((event) => event.data.kind === "mixed_output_preauthorization_created")?.data).toMatchObject({ preauthorizationId: row.id, parentOperationId: PARENT, maxUses: 2 });
  });

  it("refuses editors, viewers, agents, a borrowed session and strangers", async () => {
    const h = await makeHarness({ kind: "memory", engine });
    const store = new MemoryPreauthorizationStore();
    await expectBrokerError(createOutputPreauthorization(h.deps, store, { ...base(h), actor: user("bob"), session: sessionFor("bob") }), "admin_required");
    await expectBrokerError(createOutputPreauthorization(h.deps, store, { ...base(h), actor: user("carol"), session: sessionFor("carol") }), "admin_required");
    await expectBrokerError(createOutputPreauthorization(h.deps, store, { ...base(h), actor: integrationOf(h, "intRW") }), "approver_not_human");
    await expectBrokerError(createOutputPreauthorization(h.deps, store, { ...base(h), session: sessionFor("erin") }), "browser_session_required");
    await expectBrokerError(createOutputPreauthorization(h.deps, store, { ...base(h), actor: user("mallory"), session: sessionFor("mallory") }), "not_found");
    await expectBrokerError(createOutputPreauthorization(h.deps, store, base(h, { environmentId: "env_missing" })), "not_found");
    expect(await store.list(h.ids.wsA)).toHaveLength(0);
  });

  it.each([
    ["more than ten uses", { maxUses: 11 }],
    ["no uses", { maxUses: 0 }],
    ["a lifetime under five minutes", { lifetimeMs: 1000 }],
    ["a lifetime over seven days", { lifetimeMs: 8 * 24 * 3_600_000 }],
    ["a secret reference on a non-secret type", { secretRef: "vault:project/service/password" }],
    ["a secret type without a reference", { valueType: "secret_ref" }],
    ["a non-vault secret reference", { valueType: "secret_ref", secretRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x" }],
    ["a malformed digest", { contractDigest: "not-a-digest" }],
    ["an unknown field such as a wildcard or a value", { value: "canary-secret-value" }],
    ["a list of references", { referenceId: ["a", "b"] }],
  ])("refuses %s", async (_label, over) => {
    const h = await makeHarness({ kind: "memory", engine });
    const store = new MemoryPreauthorizationStore();
    await expectBrokerError(createOutputPreauthorization(h.deps, store, base(h, over) as never), "invalid_request");
    expect(await store.list(h.ids.wsA)).toHaveLength(0);
  });

  it("revokes at once, only by its creator or an admin, and a revoked grant no longer resolves", async () => {
    const h = await makeHarness({ kind: "memory", engine });
    const store = new MemoryPreauthorizationStore();
    const row = await createOutputPreauthorization(h.deps, store, base(h));
    await expectBrokerError(revokeOutputPreauthorization(h.deps, store, { workspaceId: h.ids.wsA, id: row.id, actor: user("bob"), session: sessionFor("bob") }), "role_insufficient");
    await expectBrokerError(revokeOutputPreauthorization(h.deps, store, { workspaceId: h.ids.wsA, id: row.id, actor: integrationOf(h, "intRW"), session: sessionFor("bob") }), "approver_not_human");
    expect((await resolveLivePreauthorizations(h.deps, store, h.ids.wsA, [row.id], new Date())).map((item) => item.id)).toEqual([row.id]);
    const revoked = await revokeOutputPreauthorization(h.deps, store, { workspaceId: h.ids.wsA, id: row.id, actor: user("alice"), session: sessionFor("alice"), reason: "no longer needed" });
    expect(revoked).toMatchObject({ status: "revoked", revokedBy: "alice" });
    expect(await resolveLivePreauthorizations(h.deps, store, h.ids.wsA, [row.id], new Date())).toEqual([]);
    expect(await listOutputPreauthorizations(h.deps, store, { workspaceId: h.ids.wsA, principal: user("alice"), activeOnly: true })).toEqual([]);
    expect(await listOutputPreauthorizations(h.deps, store, { workspaceId: h.ids.wsA, principal: user("alice") })).toHaveLength(1);
  });

  it("stops resolving when the creator is no longer an admin, the grant expired or its uses are spent; another workspace sees nothing", async () => {
    const h = await makeHarness({ kind: "memory", engine });
    const store = new MemoryPreauthorizationStore();
    const row = await createOutputPreauthorization(h.deps, store, base(h));
    const demoted = { roles: { resolve: async () => ({ role: "viewer" as const }) } } as unknown as Pick<BrokerDeps, "roles">;
    expect(await resolveLivePreauthorizations(demoted, store, h.ids.wsA, [row.id], new Date())).toEqual([]);
    expect(await resolveLivePreauthorizations(h.deps, store, h.ids.wsA, [row.id], new Date(Date.parse(row.expiresAt) + 1))).toEqual([]);
    expect(await resolveLivePreauthorizations(h.deps, store, h.ids.wsB, [row.id], new Date())).toEqual([]);
    expect(await store.reserveUse({ workspaceId: h.ids.wsA, id: row.id, now: new Date() })).not.toBeNull();
    expect(await store.reserveUse({ workspaceId: h.ids.wsA, id: row.id, now: new Date() })).not.toBeNull();
    expect(await store.reserveUse({ workspaceId: h.ids.wsA, id: row.id, now: new Date() })).toBeNull();
    expect(await resolveLivePreauthorizations(h.deps, store, h.ids.wsA, [row.id], new Date())).toEqual([]);
  });
});

/* ------------------------------ run operations ----------------------------- */

interface Rig {
  deps: MixedRunDeps;
  clock: { now: Date };
  store: MemoryMixedRunStore;
  preauth: MemoryPreauthorizationStore;
  review: { approved: Map<string, string> };
  facts: Record<string, DestroyApprovalFact | null>;
}

function rig(): Rig {
  const store = new MemoryMixedRunStore();
  const preauth = new MemoryPreauthorizationStore();
  const clock = { now: NOW };
  const review = { approved: new Map<string, string>() };
  const facts: Record<string, DestroyApprovalFact | null> = {};
  const parentReview: ParentReviewPort = { approvedParentDigest: async (_ws, _parent, approvalId) => review.approved.get(approvalId) ?? null };
  const deps: MixedRunDeps = {
    runs: store, preauthorizations: preauth, parentReview, now: () => clock.now,
    roles: { resolve: async (principal: { id: string }) => ({ role: principal.id === "alice" ? "admin" : "viewer" }) } as unknown as MixedRunDeps["roles"],
    teardownApprovals: { lookup: async (_ws, id) => facts[id] ?? null },
  };
  return { deps, clock, store, preauth, review, facts };
}

function newGrant(w: World, over: Partial<NewOutputPreauthorization> = {}, referenceId = "db-host"): NewOutputPreauthorization {
  const reference = w.view.references.find((item) => item.id === referenceId)!;
  return {
    id: "mop_1", workspaceId: WS, environmentId: ENV, parentOperationId: PARENT, createdBy: "alice", createdByName: "alice", desiredDigest: w.plan.desiredDigest,
    referenceId, contractDigest: reference.contractDigest, consumerSubplanDigest: w.view.children.find((child) => child.id === reference.consumerChildId)!.subplanDigest,
    producerSubplanDigest: w.view.children.find((child) => child.id === reference.producerChildId)!.subplanDigest, valueType: reference.type,
    maxUses: 2, expiresAt: at(60), createdAt: at(0), ...over,
  };
}

const open = async (r: Rig, w: World, over: { expiresAt?: string; childTimeoutMs?: number } = {}) =>
  openMixedRun(r.deps, { workspaceId: WS, parentOperationId: PARENT, view: w.view, expiresAt: over.expiresAt ?? at(120), childTimeoutMs: over.childTimeoutMs ?? 600_000 });
const send = (r: Rig, w: World, event: unknown, signals?: Parameters<typeof recordChildEvent>[1]["signals"]) =>
  recordChildEvent(r.deps, { workspaceId: WS, parentOperationId: PARENT, event, view: w.view, signals });

describe("durable run operations", () => {
  it("opens one run per parent operation, hides it from other workspaces and keeps an append-only ledger", async () => {
    const r = rig();
    const w = world();
    const summary = await open(r, w);
    expect(summary).toMatchObject({ outcome: "in_progress", atomicity: "none", automaticCompensation: "never", notStarted: [w.ids.db, w.ids.web, w.ids.fn] });
    expect(await refusedCode(open(r, w))).toBe("conflict");
    expect(await readMixedRun(r.deps, "ws-other", PARENT)).toBeNull();
    expect(await readMixedRun(r.deps, WS, "op-other")).toBeNull();
    await send(r, w, start(w.ids.db, w.state, 1));
    const ledger = await r.store.events(WS, PARENT);
    expect(ledger.map((event) => event.kind)).toEqual(["run_created", "start"]);
    expect(ledger.map((event) => event.seq)).toEqual([0, 1]);
    expect(await r.store.events("ws-other", PARENT)).toEqual([]);
  });

  it("refuses a view of another workspace, malformed events and unknown runs", async () => {
    const r = rig();
    const w = world();
    expect(await refusedCode(openMixedRun(r.deps, { workspaceId: "ws-other", parentOperationId: PARENT, view: w.view, expiresAt: at(60), childTimeoutMs: 600_000 }))).toBe("scope_mismatch");
    await open(r, w);
    expect(await refusedCode(send(r, w, { kind: "start", childId: w.ids.db }))).toBe("invalid_input");
    expect(await refusedCode(send(r, w, { kind: "rebind", decision: {}, at: at(1) }))).toBe("invalid_input");
    expect(await refusedCode(recordChildEvent(r.deps, { workspaceId: WS, parentOperationId: "op-other", event: { kind: "tick", at: at(1) } }))).toBe("unknown_child");
  });

  it("refuses a start while a producer has unresolved drift", async () => {
    const r = rig();
    const w = world();
    await open(r, w);
    await send(r, w, start(w.ids.db, w.state, 1));
    await send(r, w, { kind: "succeed", childId: w.ids.db, receiptDigest: H("receipt-db"), at: at(2) });
    const stored = (await r.store.get(WS, PARENT))!;
    // db-host is not materialized yet: even with no drift the start is refused for that reason.
    expect(await refusedCode(send(r, w, start(w.ids.web, stored.state, 3)))).toBe("ordering_blocked");
    const drifted = await recordChildEvent(r.deps, { workspaceId: WS, parentOperationId: PARENT, view: w.view, event: start(w.ids.web, stored.state, 3), signals: { drift: [{ childId: w.ids.db, klass: "unauthorized_change" }], migrationChildIds: [] } }).catch((error: unknown) => error);
    expect(drifted).toBeInstanceOf(MixedOrchestrationError);
    expect((drifted as MixedOrchestrationError).detail).toEqual([`producer_drift_unresolved:${w.ids.db}`]);
  });

  it("one of two racing starts wins; the other re-reads and is refused", async () => {
    const r = rig();
    const w = world();
    await open(r, w);
    const event = start(w.ids.db, w.state, 1);
    const results = await Promise.allSettled([send(r, w, event), send(r, w, event)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect((failure.reason as MixedOrchestrationError).code).toBe("illegal_transition");
    expect((await r.store.get(WS, PARENT))!.state.children[w.ids.db].attempts).toBe(1);
  });

  it("ticks child timeouts and approval expiry from the clock, and the sweep finds only due runs", async () => {
    const r = rig();
    const w = world({ childTimeoutMs: 60_000 });
    await open(r, w, { childTimeoutMs: 60_000 });
    await send(r, w, start(w.ids.db, w.state, 1));
    r.clock.now = new Date(Date.parse(at(1)));
    expect(await sweepDueMixedRuns(r.deps)).toEqual({ swept: 0, failed: 0 });
    r.clock.now = new Date(Date.parse(at(2)));
    expect(await sweepDueMixedRuns(r.deps)).toEqual({ swept: 1, failed: 0 });
    const run = (await readMixedRun(r.deps, WS, PARENT))!;
    expect(run.state.children[w.ids.db]).toMatchObject({ status: "timed_out", reconciliationRequired: true });
    expect(run.state.children[w.ids.web].status).toBe("blocked");
    expect(run.summary.outcome).toBe("indeterminate");
    expect(await sweepDueMixedRuns(r.deps)).toEqual({ swept: 0, failed: 0 });
    r.clock.now = new Date(Date.parse(at(121)));
    expect(await sweepDueMixedRuns(r.deps)).toEqual({ swept: 1, failed: 0 });
    expect((await readMixedRun(r.deps, WS, PARENT))!.state.children[w.ids.web].status).toBe("expired");
    expect(await sweepDueMixedRuns(r.deps)).toEqual({ swept: 0, failed: 0 });
    expect((await r.store.events(WS, PARENT)).filter((event) => event.kind === "tick")).toHaveLength(2);
  });

  it("tick is idempotent and cancel propagates without claiming running children stopped", async () => {
    const r = rig();
    const w = world();
    await open(r, w);
    expect((await tickMixedRun(r.deps, WS, PARENT)).outcome).toBe("in_progress");
    expect(await cancelMixedRun(r.deps, "ws-other", PARENT)).toBeNull();
    expect(await cancelMixedRun(r.deps, WS, "op-other")).toBeNull();
    await send(r, w, start(w.ids.db, w.state, 1));
    const summary = (await cancelMixedRun(r.deps, WS, PARENT))!;
    expect(summary).toMatchObject({ cancelled: true, inFlight: [w.ids.db], outcome: "in_progress" });
    expect(summary.failed.map((item) => item.childId)).toEqual([w.ids.web, w.ids.fn]);
    expect(await refusedCode(send(r, w, start(w.ids.web, w.state, 3)))).toBe("run_terminal");
  });
});

describe("consuming outputs: review unless precisely preauthorized", () => {
  async function ready(r: Rig, w: World) {
    await open(r, w);
    await send(r, w, start(w.ids.db, w.state, 1));
    await send(r, w, { kind: "succeed", childId: w.ids.db, receiptDigest: H(`receipt-${w.ids.db}`), at: at(2) });
    return (await r.store.get(WS, PARENT))!;
  }
  const consumeInput = (w: World, state: Awaited<ReturnType<typeof ready>>["state"], extra: Partial<Parameters<typeof consumeOutputs>[1]> = {}) => ({
    workspaceId: WS, parentOperationId: PARENT, view: w.view, approvedInput: w.input, outputs: [outputFor({ ...w, state }, "db-host")], ...extra,
  });

  it("leaves the run untouched and returns the exact digest to review when nothing covers the change", async () => {
    const r = rig();
    const w = world();
    const before = await ready(r, w);
    const result = await consumeOutputs(r.deps, consumeInput(w, before.state));
    expect(result.applied).toBe(false);
    expect(result.decision).toMatchObject({ classification: "review_required", uncovered: ["db-host"] });
    expect((await r.store.get(WS, PARENT))!.version).toBe(before.version);
    expect(await refusedCode(send(r, w, start(w.ids.web, before.state, 3)))).toBe("ordering_blocked");
  });

  it("applies after a person's review of exactly the new parent digest, and not for any other digest", async () => {
    const r = rig();
    const w = world();
    const before = await ready(r, w);
    const first = await consumeOutputs(r.deps, consumeInput(w, before.state));
    r.review.approved.set("appr-1", H("some-other-digest"));
    expect((await consumeOutputs(r.deps, consumeInput(w, before.state, { review: { approvalId: "appr-1" } }))).applied).toBe(false);
    r.review.approved.set("appr-1", first.decision.requiredParentDigest);
    const result = await consumeOutputs(r.deps, consumeInput(w, before.state, { review: { approvalId: "appr-1" } }));
    expect(result.applied).toBe(true);
    expect(result.nextInput).toBeDefined();
    const state = (await r.store.get(WS, PARENT))!.state;
    expect(state.children[w.ids.web].rebinds[0]).toMatchObject({ authority: "review", authorityRef: "appr-1" });
    await send(r, w, start(w.ids.web, state, 4));
    expect((await r.store.events(WS, PARENT)).map((event) => event.kind)).toEqual(["run_created", "start", "succeed", "rebind", "start"]);
  });

  it("applies without review only under a live precise preauthorization, and spends one use", async () => {
    const r = rig();
    const w = world();
    const before = await ready(r, w);
    await r.preauth.create(newGrant(w));
    const result = await consumeOutputs(r.deps, consumeInput(w, before.state, { preauthorizationIds: ["mop_1"] }));
    expect(result.applied).toBe(true);
    expect(result.decision.classification).toBe("preauthorized");
    expect((await r.preauth.get(WS, "mop_1"))!.uses).toBe(1);
    const state = (await r.store.get(WS, PARENT))!.state;
    expect(state.children[w.ids.web].rebinds[0]).toMatchObject({ authority: "preauthorization", authorityRef: "mop_1" });
    const rebind = (await r.store.events(WS, PARENT)).find((event) => event.kind === "rebind")!;
    expect(rebind.data).toMatchObject({ classification: "preauthorized", preauthorizationIds: ["mop_1"] });
  });

  it("a single-use preauthorization cannot cover a second consumption, and a revoked or lapsed one covers nothing", async () => {
    const w = world();
    const single = rig();
    const beforeSingle = await ready(single, w);
    await single.preauth.create(newGrant(w, { maxUses: 1 }));
    expect((await consumeOutputs(single.deps, consumeInput(w, beforeSingle.state, { preauthorizationIds: ["mop_1"] }))).applied).toBe(true);
    const again = await consumeOutputs(single.deps, consumeInput(w, beforeSingle.state, { preauthorizationIds: ["mop_1"] }));
    expect(again.applied).toBe(false);
    expect(again.decision.classification).toBe("review_required");

    const revoked = rig();
    const beforeRevoked = await ready(revoked, w);
    await revoked.preauth.create(newGrant(w));
    await revoked.preauth.revoke({ workspaceId: WS, id: "mop_1", revokedBy: "alice", at: NOW });
    expect((await consumeOutputs(revoked.deps, consumeInput(w, beforeRevoked.state, { preauthorizationIds: ["mop_1"] }))).decision.classification).toBe("review_required");

    const lapsed = rig();
    const beforeLapsed = await ready(lapsed, w);
    await lapsed.preauth.create(newGrant(w, { createdBy: "bob" }));
    expect((await consumeOutputs(lapsed.deps, consumeInput(w, beforeLapsed.state, { preauthorizationIds: ["mop_1"] }))).decision.classification).toBe("review_required");

    const wrongRef = rig();
    const beforeWrong = await ready(wrongRef, w);
    await wrongRef.preauth.create(newGrant(w, { referenceId: "web-host" }));
    expect((await consumeOutputs(wrongRef.deps, consumeInput(w, beforeWrong.state, { preauthorizationIds: ["mop_1"] }))).applied).toBe(false);
  });

  it("refuses outputs of a producer that has not succeeded and outputs for another workspace's view", async () => {
    const r = rig();
    const w = world();
    await open(r, w);
    const state = (await r.store.get(WS, PARENT))!.state;
    expect(await refusedCode(consumeOutputs(r.deps, consumeInput(w, state)))).toBe("producer_not_succeeded");
    expect(await refusedCode(consumeOutputs(r.deps, { ...consumeInput(w, state), workspaceId: "ws-other" }))).toBe("unknown_child");
  });

  it("an output equal to the reviewed one is unchanged and applies as such", async () => {
    const r = rig();
    const w = world();
    const before = await ready(r, w);
    const first = await consumeOutputs(r.deps, consumeInput(w, before.state, { review: { approvalId: "appr-1" } }));
    r.review.approved.set("appr-1", first.decision.requiredParentDigest);
    const applied = await consumeOutputs(r.deps, consumeInput(w, before.state, { review: { approvalId: "appr-1" } }));
    const state = (await r.store.get(WS, PARENT))!.state;
    const again = await consumeOutputs(r.deps, { ...consumeInput(w, state), approvedInput: applied.nextInput! });
    expect(again.decision.classification).toBe("unchanged");
    expect(again.applied).toBe(true);
  });
});

/* -------------------------------- teardown -------------------------------- */

describe("teardown through the service", () => {
  const owners = new Map([[DB, "db"], [WEB, "web"], [FN, "fn"]] as const);
  async function applied(r: Rig, w: World) {
    const done = complete(w).state;
    await r.store.create(done, { kind: "run_created", data: {} });
    return done;
  }
  const plan = (w: World) => ({
    owners: new Map([...owners].map(([address, key]): [string, { parentOperationId: string; childId: string }] => [address, { parentOperationId: PARENT, childId: w.ids[key as "db" | "web" | "fn"] }])),
    externalDependents: () => [] as string[],
  });
  const fact = (address: string, status = "approved"): DestroyApprovalFact => ({
    operationId: `op-destroy-${address}`, workspaceId: WS, environmentId: ENV, capability: "infrastructure.destroy", status, destroyAddresses: [address], proposalDigest: H("proposal"),
    approvals: [{ id: "appr-1", decision: "approve", proposalDigest: H("proposal"), approverKind: "user", humanOnly: true, approverRole: "admin", expiresAt: at(600), consumed: false }],
  });

  it("proposes, releases only on a verified human approval, and syncs the outcome from the destroy operation itself", async () => {
    const r = rig();
    const w = world();
    await applied(r, w);
    const report = await proposeTeardown(r.deps, { workspaceId: WS, parentOperationId: PARENT, plan: plan(w) });
    expect(report.state.teardown!.steps.map((step) => step.childId)).toEqual([w.ids.fn, w.ids.web, w.ids.db]);
    // No approval on record: refused and nothing changes.
    expect(await refusedCode(releaseTeardown(r.deps, { workspaceId: WS, parentOperationId: PARENT, childId: w.ids.fn, destroyOperationId: `op-destroy-${FN}`, signals: { drift: [], migrationChildIds: [] } }))).toBe("approval_invalid");
    expect((await r.store.get(WS, PARENT))!.state.teardown!.steps[0].status).toBe("planned");
    r.facts[`op-destroy-${FN}`] = fact(FN);
    await releaseTeardown(r.deps, { workspaceId: WS, parentOperationId: PARENT, childId: w.ids.fn, destroyOperationId: `op-destroy-${FN}`, signals: { drift: [], migrationChildIds: [] } });
    expect((await r.store.get(WS, PARENT))!.state.teardown!.steps[0]).toMatchObject({ status: "released", approvalId: "appr-1" });
    // The destroy is still approved, not finished: there is no outcome to record, and the caller cannot supply one.
    expect(await refusedCode(syncTeardownStep(r.deps, { workspaceId: WS, parentOperationId: PARENT, childId: w.ids.fn }))).toBe("illegal_transition");
    r.facts[`op-destroy-${FN}`] = fact(FN, "succeeded");
    const synced = await syncTeardownStep(r.deps, { workspaceId: WS, parentOperationId: PARENT, childId: w.ids.fn });
    expect(synced.appliedWithoutRunCompletion).toEqual([]);
    expect((await r.store.get(WS, PARENT))!.state.children[w.ids.fn].effects).toBe("none");
    expect((await r.store.events(WS, PARENT)).map((event) => event.kind)).toEqual(["run_created", "teardown_planned", "teardown_released", "teardown_result"]);
    expect(await refusedCode(releaseTeardown(r.deps, { workspaceId: WS, parentOperationId: PARENT, childId: w.ids.db, destroyOperationId: `op-destroy-${DB}`, signals: { drift: [], migrationChildIds: [] } }))).toBe("approval_invalid");
  });

  it("records a failed or uncertain destroy as such", async () => {
    const w = world();
    for (const status of ["failed", "uncertain"] as const) {
      const r = rig();
      await applied(r, w);
      await proposeTeardown(r.deps, { workspaceId: WS, parentOperationId: PARENT, plan: plan(w) });
      r.facts[`op-destroy-${FN}`] = fact(FN);
      await releaseTeardown(r.deps, { workspaceId: WS, parentOperationId: PARENT, childId: w.ids.fn, destroyOperationId: `op-destroy-${FN}`, signals: { drift: [], migrationChildIds: [] } });
      r.facts[`op-destroy-${FN}`] = fact(FN, status);
      await syncTeardownStep(r.deps, { workspaceId: WS, parentOperationId: PARENT, childId: w.ids.fn });
      const state = (await r.store.get(WS, PARENT))!.state;
      expect(state.teardown!.steps[0].status).toBe(status);
      expect(state.children[w.ids.fn].reconciliationRequired).toBe(true);
    }
  });

  it("refuses to propose teardown for an unknown run", async () => {
    const r = rig();
    const w = world();
    expect(await refusedCode(proposeTeardown(r.deps, { workspaceId: WS, parentOperationId: "op-other", plan: plan(w) }))).toBe("unknown_child");
  });
});

describe("broker approval port", () => {
  const evidence = (over: Record<string, unknown> = {}) => ({ simulated: false, summary: { destroy: true, destroyAddresses: [FN] }, ...over });
  const deps = (op: Record<string, unknown> | null, ev: Record<string, unknown> | null, approvals: Record<string, unknown>[]) => ({
    store: { getOperation: async () => op, getPlanEvidence: async () => ev, listApprovals: async () => approvals },
  }) as unknown as Pick<BrokerDeps, "store">;
  const op = { id: "op-destroy", environmentId: ENV, planDigest: H("plan"), capability: "infrastructure.destroy", status: "approved", proposalDigest: H("proposal") };
  const approval = (principal: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ id: "appr-1", decision: "approve", proposalDigest: H("proposal"), approver: principal, approverRole: "admin", expiresAt: at(60), ...over });

  it("reads the destroy operation, its recorded evidence and who approved it", async () => {
    const port = brokerTeardownApprovalPort(deps(op, evidence(), [approval({ kind: "user", id: "alice", name: "Alice" }), approval({ kind: "integration", id: "agent", name: "Agent", onBehalfOf: "alice", integrationId: "link" }, { id: "appr-2" })]));
    const fact = (await port.lookup(WS, "op-destroy"))!;
    expect(fact).toMatchObject({ operationId: "op-destroy", capability: "infrastructure.destroy", destroyAddresses: [FN], proposalDigest: H("proposal") });
    expect(fact.approvals.map((item) => [item.id, item.approverKind, item.humanOnly])).toEqual([["appr-1", "user", true], ["appr-2", "integration", false]]);
  });

  it("returns nothing for a missing operation, simulated or non-destroy evidence", async () => {
    expect(await brokerTeardownApprovalPort(deps(null, evidence(), [])).lookup(WS, "x")).toBeNull();
    expect(await brokerTeardownApprovalPort(deps({ ...op, planDigest: undefined }, evidence(), [])).lookup(WS, "x")).toBeNull();
    expect(await brokerTeardownApprovalPort(deps(op, evidence({ simulated: true }), [])).lookup(WS, "x")).toBeNull();
    expect(await brokerTeardownApprovalPort(deps(op, evidence({ summary: { destroy: false, destroyAddresses: [FN] } }), [])).lookup(WS, "x")).toBeNull();
    expect(await brokerTeardownApprovalPort(deps(op, null, [])).lookup(WS, "x")).toBeNull();
  });
});

/* ------------------------------- route helpers ----------------------------- */

describe("route helpers", () => {
  it("maps orchestration refusals to typed errors that name codes and ids, never values", () => {
    const stale = asBrokerError(new MixedOrchestrationError("stale_digest", ["child-1"])) as BrokerError;
    expect(stale).toBeInstanceOf(BrokerError);
    expect(stale).toMatchObject({ code: "plan_changed", status: 409 });
    expect(stale.details).toEqual({ reason: "stale_digest", ids: ["child-1"] });
    expect(asBrokerError(new MixedOrchestrationError("approval_invalid"))).toMatchObject({ code: "approval_required" });
    expect(asBrokerError(new MixedOrchestrationError("secret_value"))).toMatchObject({ code: "secret_material" });
    expect(asBrokerError(new MixedOrchestrationError("unavailable"))).toMatchObject({ code: "platform_store_unavailable", status: 503 });
    expect(asBrokerError(new MixedOrchestrationError("unknown_child", ["op-1"]))).toMatchObject({ code: "not_found", status: 404 });
    const other = new Error("not ours");
    expect(asBrokerError(other)).toBe(other);
  });

  it("lets the requester steer a run, any editor or admin too, and staff-only actions need staff", async () => {
    const h = await makeHarness({ kind: "memory", engine: scriptedEngine("mix-route", () => allowDecision()) });
    const agent = integrationOf(h, "intRW", "bob");
    const proposed = await proposeOk(h, requestFor(h, "service.restart", "prod", { reason: "mix" }), agent);
    await authorizeRunControl(h.broker, h.ids.wsA, proposed.id, agent);
    await authorizeRunControl(h.broker, h.ids.wsA, proposed.id, user("bob"));
    await authorizeRunControl(h.broker, h.ids.wsA, proposed.id, user("alice"));
    await expectBrokerError(authorizeRunControl(h.broker, h.ids.wsA, proposed.id, agent, { staffOnly: true }), "role_insufficient");
    await authorizeRunControl(h.broker, h.ids.wsA, proposed.id, user("alice"), { staffOnly: true });
    await expectBrokerError(authorizeRunControl(h.broker, h.ids.wsA, proposed.id, user("carol")), "role_insufficient");
    await expectBrokerError(authorizeRunControl(h.broker, h.ids.wsA, "op_missing", user("alice")), "not_found");
    await expectBrokerError(authorizeRunControl(h.broker, h.ids.wsB, proposed.id, user("alice")), "not_found");
  });
});

/** Referenced so the fixture helpers used only by sibling suites stay type-checked here. */
void [consume, finish, throughWeb];
