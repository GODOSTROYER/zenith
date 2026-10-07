/**
 * PROD-MIX-03 (typed scoped dependency outputs) and PROD-MIX-04 (distributed failure and teardown order),
 * contract level: pure reducers and the in-memory stores. The fixture is a logical three-child chain
 * (azure db <- gcp web <- aws functions); no cloud API is called and nothing here proves provider behaviour.
 */
import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { parentViewOf } from "@/lib/execution/mixed-orchestration/child-view";
import { isIssuedDecision } from "@/lib/execution/mixed-orchestration/decision";
import { MixedOrchestrationError, type MixedOrchestrationErrorCode } from "@/lib/execution/mixed-orchestration/errors";
import { findCycle, orderChildren } from "@/lib/execution/mixed-orchestration/order";
import { evaluateOrdering, type OrderingSignals } from "@/lib/execution/mixed-orchestration/ordering-rules";
import { assessOutputConsumption, preauthorizationCovers, validateOutput, type TypedOutput } from "@/lib/execution/mixed-orchestration/outputs";
import type { OutputPreauthorization } from "@/lib/execution/mixed-orchestration/preauthorization";
import { createRunState, nextDeadline, nextRunnable, summarizeRun, type AnyRunEvent, type MixedRunState } from "@/lib/execution/mixed-orchestration/run";
import { parseRunState } from "@/lib/execution/mixed-orchestration/run-store";
import {
  planTeardown, recordTeardownResult, releaseTeardownStep, verifyTeardownApproval, type DestroyApprovalFact, type ResourceOwner, type TeardownApprovalPort,
} from "@/lib/execution/mixed-orchestration/teardown";
import { planMixedPartitions } from "@/lib/execution/mixed-partitions";
import {
  at, complete, consume, DB, drive, ENV, finish, FN, fixture, H, NOW, outputFor, PARENT, start, succeed, throughWeb, WEB, WS, world, type World,
} from "./fakes/mixed-fixture";

const NONE: OrderingSignals = { drift: [], migrationChildIds: [] };

function refused(fn: () => unknown): MixedOrchestrationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MixedOrchestrationError);
    return error as MixedOrchestrationError;
  }
  throw new Error("expected a refusal, but the call succeeded");
}
const code = (fn: () => unknown): MixedOrchestrationErrorCode => refused(fn).code;

/** A world whose db producer has already succeeded. */
function afterDb(options: { secret?: boolean } = {}): { w: World; state: MixedRunState } {
  const w = world(options);
  return { w, state: finish(w.state, w.view, w.ids.db, 1) };
}

describe("dependency order and cycles", () => {
  it("orders producers first and tears down in reverse", () => {
    const w = world();
    expect(w.state.order).toEqual([w.ids.db, w.ids.web, w.ids.fn]);
    expect(orderChildren(w.view.children).teardown).toEqual([w.ids.fn, w.ids.web, w.ids.db]);
  });

  it("refuses a cycle and names its members, before anything is recorded", () => {
    const cyclic = [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: [] }];
    expect(findCycle(cyclic)).toEqual(["a", "b"]);
    const error = refused(() => orderChildren(cyclic));
    expect(error.code).toBe("dependency_cycle");
    expect(error.detail).toEqual(["a", "b"]);
    const w = world();
    const view = { ...w.view, children: w.view.children.map((child) => (child.id === w.ids.db ? { ...child, dependsOn: [w.ids.fn] } : child)) };
    expect(code(() => createRunState(view, { parentOperationId: PARENT, expiresAt: at(60), childTimeoutMs: 600_000, now: NOW }))).toBe("dependency_cycle");
  });

  it("refuses unknown and self dependencies and duplicate children", () => {
    const w = world();
    const mutate = (dependsOn: string[]) => ({ ...w.view, children: w.view.children.map((child) => (child.id === w.ids.web ? { ...child, dependsOn } : child)) });
    const make = (view: ReturnType<typeof mutate>) => () => createRunState(view, { parentOperationId: PARENT, expiresAt: at(60), childTimeoutMs: 600_000, now: NOW });
    expect(code(make(mutate(["ghost"])))).toBe("unknown_child");
    expect(code(make(mutate([w.ids.web])))).toBe("dependency_cycle");
    expect(code(() => orderChildren([{ id: "a", dependsOn: [] }, { id: "a", dependsOn: [] }]))).toBe("invalid_input");
  });

  it("bounds the run: child timeout and expiry must be sane", () => {
    const w = world();
    const make = (over: Partial<{ expiresAt: string; childTimeoutMs: number }>) => () => createRunState(w.view, { parentOperationId: PARENT, expiresAt: at(60), childTimeoutMs: 600_000, now: NOW, ...over });
    expect(code(make({ childTimeoutMs: 10 }))).toBe("invalid_input");
    expect(code(make({ expiresAt: at(-1) }))).toBe("invalid_input");
    expect(code(make({ expiresAt: at(60 * 24 * 40) }))).toBe("invalid_input");
  });

  it("derives the child view from the partition plan and refuses a substituted contract", () => {
    const input = fixture();
    const plan = planMixedPartitions(input);
    const view = parentViewOf(plan, input.references);
    expect(view.children).toHaveLength(3);
    expect(view.references.map((reference) => reference.id)).toEqual(["db-host", "web-host"]);
    expect(view.references.every((reference) => reference.materialized === false)).toBe(true);
    input.references[0].producer.output = "other_output";
    expect(code(() => parentViewOf(plan, input.references))).toBe("contract_mismatch");
  });
});

describe("typed output contracts carry type, scope and provenance", () => {
  it("accepts an output of the declared type, in scope, from a producer that succeeded with that receipt", () => {
    const { w, state } = afterDb();
    const output = validateOutput(outputFor({ ...w, state }, "db-host"), state, w.view);
    expect(output).toMatchObject({ referenceId: "db-host", type: "endpoint" });
    expect(output.provenance.receiptDigest).toBe(state.children[w.ids.db].receiptDigest);
    expect(Object.isFrozen(output)).toBe(true);
  });

  const cases: [string, (output: TypedOutput, w: World) => void, MixedOrchestrationErrorCode][] = [
    ["a different type", (o) => { o.type = "number"; }, "contract_mismatch"],
    ["an unknown reference", (o) => { o.referenceId = "nope"; }, "contract_mismatch"],
    ["another workspace", (o) => { o.scope.workspaceId = "ws-other"; }, "scope_mismatch"],
    ["another environment", (o) => { o.scope.environmentId = "env-other"; }, "scope_mismatch"],
    ["another consumer connection", (o) => { o.scope.consumerConnectionId = "conn-other"; }, "scope_mismatch"],
    ["another consumer child", (o, w) => { o.scope.consumerChildId = w.ids.fn; }, "scope_mismatch"],
    ["another producer address", (o) => { o.provenance.producerAddress = "resource/other"; }, "output_provenance"],
    ["another producer output name", (o) => { o.provenance.producerOutput = "other"; }, "output_provenance"],
    ["another producer connection", (o) => { o.provenance.producerConnectionId = "conn-other"; }, "output_provenance"],
    ["another producer subplan digest", (o) => { o.provenance.producerSubplanDigest = H("other-subplan"); }, "output_provenance"],
    ["another producer effect digest", (o) => { o.provenance.producerEffectDigest = H("other-effect"); }, "output_provenance"],
    ["another receipt", (o) => { o.provenance.receiptDigest = H("other-receipt"); }, "output_provenance"],
  ];
  it.each(cases)("refuses %s", (_label, mutate, expected) => {
    const { w, state } = afterDb();
    const output = structuredClone(outputFor({ ...w, state }, "db-host"));
    mutate(output, w);
    expect(code(() => validateOutput(output, state, w.view))).toBe(expected);
  });

  it("gives nothing to consume until the producer has succeeded", () => {
    const w = world();
    const pending = outputFor(w, "db-host");
    expect(code(() => validateOutput(pending, w.state, w.view))).toBe("producer_not_succeeded");
    const failed = drive(w.state, w.view, start(w.ids.db, w.state, 1), { kind: "fail", childId: w.ids.db, reason: "provider_error", effects: "possible", at: at(2) });
    expect(code(() => validateOutput(outputFor({ ...w, state: failed }, "db-host"), failed, w.view))).toBe("producer_not_succeeded");
    const timedOut = drive(w.state, w.view, start(w.ids.db, w.state, 1), { kind: "tick", at: at(20) });
    expect(timedOut.children[w.ids.db].status).toBe("timed_out");
    expect(code(() => validateOutput(outputFor({ ...w, state: timedOut }, "db-host"), timedOut, w.view))).toBe("producer_not_succeeded");
  });

  describe("secret references", () => {
    it("carries a vault reference and a version digest, never a value", () => {
      const { w, state } = afterDb({ secret: true });
      const output = validateOutput(outputFor({ ...w, state }, "db-secret"), state, w.view);
      expect(output.type).toBe("secret_ref");
      expect(output.secret?.ref).toBe("vault:project/service/password");
      expect(JSON.stringify(output)).not.toContain("canary");
    });

    it("refuses inline values, non-vault references and mismatched shapes without echoing them", () => {
      const { w, state } = afterDb({ secret: true });
      const good = outputFor({ ...w, state }, "db-secret");
      const inline = refused(() => validateOutput({ ...good, secret: { ...good.secret, value: "canary-secret-value" } }, state, w.view));
      expect(inline.code).toBe("secret_value");
      expect(inline.message).not.toContain("canary");
      expect(JSON.stringify(inline.detail)).not.toContain("canary");
      expect(code(() => validateOutput({ ...good, password: "canary-secret-value" }, state, w.view))).toBe("secret_value");
      expect(code(() => validateOutput({ ...good, secret: { ref: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x", versionDigest: good.secret?.versionDigest } }, state, w.view))).toBe("invalid_input");
      const missing = structuredClone(good);
      delete missing.secret;
      expect(code(() => validateOutput(missing, state, w.view))).toBe("contract_mismatch");
      expect(code(() => validateOutput({ ...good, valueDigest: H("not-the-secret-digest") }, state, w.view))).toBe("output_provenance");
    });

    it("refuses a secret attached to a non-secret type", () => {
      const { w, state } = afterDb();
      const plain = outputFor({ ...w, state }, "db-host");
      expect(code(() => validateOutput({ ...plain, secret: { ref: "vault:project/service/password", versionDigest: H("v") } }, state, w.view))).toBe("secret_value");
    });
  });
});

function grant(w: World, over: Partial<OutputPreauthorization> = {}, referenceId = "db-host"): OutputPreauthorization {
  const reference = w.view.references.find((item) => item.id === referenceId)!;
  return {
    id: "mop_1", workspaceId: WS, environmentId: ENV, parentOperationId: PARENT, createdBy: "alice", createdByName: "alice",
    desiredDigest: w.plan.desiredDigest, referenceId, contractDigest: reference.contractDigest,
    consumerSubplanDigest: w.view.children.find((child) => child.id === reference.consumerChildId)!.subplanDigest,
    producerSubplanDigest: w.view.children.find((child) => child.id === reference.producerChildId)!.subplanDigest,
    valueType: reference.type, maxUses: 2, uses: 0, expiresAt: at(60), createdAt: at(0), status: "active", ...over,
  };
}

describe("a new materialization needs review unless precisely preauthorized (DUR-B digest)", () => {
  const assess = (w: World, outputs: TypedOutput[], preauthorizations: OutputPreauthorization[] = [], approvedInput = w.input) =>
    assessOutputConsumption({ approvedInput, parentOperationId: PARENT, outputs, preauthorizations, now: NOW });

  it("a newly materialized output changes the consumer's effect and requires review", () => {
    const { w, state } = afterDb();
    const output = validateOutput(outputFor({ ...w, state }, "db-host"), state, w.view);
    const decision = assess(w, [output]);
    expect(decision.classification).toBe("review_required");
    expect(decision.reasons).toEqual(expect.arrayContaining(["materialized_effects_changed", "output_custody_changed"]));
    expect(decision.uncovered).toEqual(["db-host"]);
    expect(decision.consumers).toHaveLength(1);
    expect(decision.consumers[0]).toMatchObject({ childId: w.ids.web, previousEffectDigest: w.plan.partitions.find((p) => p.id === w.ids.web)!.effectDigest, referenceIds: ["db-host"] });
    expect(decision.consumers[0].newEffectDigest).not.toBe(decision.consumers[0].previousEffectDigest);
    expect(decision.requiredParentDigest).not.toBe(w.plan.parentDigest);
    expect(decision.desiredDigest).toBe(w.plan.desiredDigest);
    expect(isIssuedDecision(decision)).toBe(true);
    expect(isIssuedDecision({ ...decision })).toBe(false);
  });

  it("is unchanged when the outputs equal what was reviewed, and a rotated value needs review again", () => {
    const { w, state } = afterDb();
    const first = consume(w, state, w.input, "db-host", 3);
    const output = validateOutput(outputFor({ ...w, state: first.state }, "db-host"), first.state, w.view);
    expect(assess(w, [output], [], first.input).classification).toBe("unchanged");
    const rotated = validateOutput(outputFor({ ...w, state: first.state }, "db-host", { value: "2" }), first.state, w.view);
    const decision = assess(w, [rotated], [], first.input);
    expect(decision.classification).toBe("review_required");
    expect(decision.consumers.map((consumer) => consumer.childId)).toEqual([w.ids.web]);
  });

  it("is preauthorized only when a live grant covers exactly that reference", () => {
    const { w, state } = afterDb();
    const output = validateOutput(outputFor({ ...w, state }, "db-host"), state, w.view);
    const decision = assess(w, [output], [grant(w)]);
    expect(decision.classification).toBe("preauthorized");
    expect(decision.preauthorizationIds).toEqual(["mop_1"]);
    expect(decision.uncovered).toEqual([]);
  });

  const widened: [string, Partial<OutputPreauthorization>][] = [
    ["another parent operation", { parentOperationId: "op-other" }],
    ["another reference", { referenceId: "web-host" }],
    ["another contract digest", { contractDigest: H("other-contract") }],
    ["another consumer subplan", { consumerSubplanDigest: H("other-consumer") }],
    ["another producer subplan", { producerSubplanDigest: H("other-producer") }],
    ["other desired inputs", { desiredDigest: H("other-desired") }],
    ["another value type", { valueType: "string" }],
    ["another workspace", { workspaceId: "ws-other" }],
    ["another environment", { environmentId: "env-other" }],
    ["an expired grant", { expiresAt: at(-1) }],
    ["an exhausted grant", { uses: 2 }],
    ["a revoked grant", { status: "revoked" }],
    ["a different pinned value", { valueDigest: H("other-value") }],
    ["a secret reference on a non-secret type", { secretRef: "vault:project/service/password" }],
  ];
  it.each(widened)("falls back to review for %s", (_label, over) => {
    const { w, state } = afterDb();
    const output = validateOutput(outputFor({ ...w, state }, "db-host"), state, w.view);
    const decision = assess(w, [output], [grant(w, over)]);
    expect(decision.classification).toBe("review_required");
    expect(decision.preauthorizationIds).toEqual([]);
    expect(decision.uncovered).toEqual(["db-host"]);
  });

  it("honours a value pin that matches", () => {
    const { w, state } = afterDb();
    const output = validateOutput(outputFor({ ...w, state }, "db-host"), state, w.view);
    expect(assess(w, [output], [grant(w, { valueDigest: output.valueDigest })]).classification).toBe("preauthorized");
  });

  it("covers a secret only for the exact vault reference, and any version of it", () => {
    const { w, state } = afterDb({ secret: true });
    const output = validateOutput(outputFor({ ...w, state }, "db-secret"), state, w.view);
    const secretGrant = (over: Partial<OutputPreauthorization> = {}) => grant(w, { valueType: "secret_ref", secretRef: "vault:project/service/password", ...over }, "db-secret");
    expect(assess(w, [output], [secretGrant()]).classification).toBe("preauthorized");
    expect(assess(w, [output], [secretGrant({ secretRef: "vault:project/service/other" })]).classification).toBe("review_required");
    expect(assess(w, [output], [secretGrant({ secretRef: undefined })]).classification).toBe("review_required");
    expect(assess(w, [output], [secretGrant({ valueType: "endpoint" })]).classification).toBe("review_required");
    const rotated = validateOutput(outputFor({ ...w, state }, "db-secret", { value: "2" }), state, w.view);
    expect(assess(w, [rotated], [secretGrant()]).classification).toBe("preauthorized");
  });

  it("preauthorizationCovers is false for every field that does not match", () => {
    const { w, state } = afterDb();
    const output = validateOutput(outputFor({ ...w, state }, "db-host"), state, w.view);
    const reference = w.view.references.find((item) => item.id === "db-host")!;
    const ctx = { workspaceId: WS, environmentId: ENV, parentOperationId: PARENT, desiredDigest: w.plan.desiredDigest, contractDigest: reference.contractDigest,
      consumerSubplanDigest: w.view.children.find((child) => child.id === w.ids.web)!.subplanDigest, output, now: NOW };
    expect(preauthorizationCovers(grant(w), ctx)).toBe(true);
    expect(preauthorizationCovers(grant(w), { ...ctx, parentOperationId: "op-other" })).toBe(false);
    expect(preauthorizationCovers(grant(w), { ...ctx, now: new Date(Date.parse(at(61))) })).toBe(false);
  });
});

describe("run state machine: failure never becomes a transaction", () => {
  it("starts a child only after its producers succeeded and its inputs are materialized and rebound", () => {
    const w = world();
    expect(refused(() => drive(w.state, w.view, start(w.ids.web, w.state, 1))).detail).toEqual([w.ids.db]);
    const afterFirst = finish(w.state, w.view, w.ids.db, 1);
    expect(refused(() => drive(afterFirst, w.view, start(w.ids.web, afterFirst, 3))).detail).toEqual(["input:db-host"]);
    const bound = consume(w, afterFirst, w.input, "db-host", 3);
    const running = drive(bound.state, w.view, start(w.ids.web, bound.state, 4));
    expect(running.children[w.ids.web]).toMatchObject({ status: "running", attempts: 1, effects: "possible" });
    expect(bound.state.children[w.ids.web].rebinds).toHaveLength(1);
    expect(bound.state.children[w.ids.web].rebinds[0]).toMatchObject({ authority: "review", authorityRef: "appr-review" });
  });

  it("refuses a start for a stale effect digest and a repeated start", () => {
    const w = world();
    expect(code(() => drive(w.state, w.view, { ...start(w.ids.db, w.state, 1), approvedEffectDigest: H("old") } as AnyRunEvent))).toBe("stale_digest");
    const running = drive(w.state, w.view, start(w.ids.db, w.state, 1));
    expect(code(() => drive(running, w.view, start(w.ids.db, running, 2)))).toBe("illegal_transition");
    expect(code(() => drive(w.state, w.view, { kind: "start", childId: "ghost", attemptId: "attempt-1", approvedEffectDigest: H("x"), at: at(1) }))).toBe("unknown_child");
  });

  it("records partial success without claiming atomicity and never compensates automatically", () => {
    const w = world();
    const step = throughWeb(w);
    const failed = drive(step.state, w.view, start(w.ids.fn, step.state, 7), { kind: "fail", childId: w.ids.fn, reason: "provider_error", effects: "possible", at: at(8) });
    const summary = summarizeRun(failed);
    expect(summary.atomicity).toBe("none");
    expect(summary.automaticCompensation).toBe("never");
    expect(summary.outcome).toBe("partial");
    expect(summary.completed.map((item) => item.childId)).toEqual([w.ids.db, w.ids.web]);
    expect(summary.failed).toEqual([{ childId: w.ids.fn, status: "failed", reason: "provider_error" }]);
    expect(summary.indeterminate).toEqual([w.ids.fn]);
    expect(summary.appliedWithoutRunCompletion).toEqual([w.ids.db, w.ids.web]);
    expect(summary.nextSteps).toEqual(["propose_teardown_for_human_approval", "reconcile_before_retry", "review_replan"]);
    expect(failed.children[w.ids.db].status).toBe("succeeded");
    expect(failed.children[w.ids.web].status).toBe("succeeded");
  });

  it("needs a recorded reconciliation before an indeterminate child is retried", () => {
    const w = world();
    const step = throughWeb(w);
    const failed = drive(step.state, w.view, start(w.ids.fn, step.state, 7), { kind: "fail", childId: w.ids.fn, reason: "provider_error", effects: "possible", at: at(8) });
    expect(code(() => drive(failed, w.view, { kind: "retry", childId: w.ids.fn, at: at(9) }))).toBe("illegal_transition");
    expect(code(() => drive(failed, w.view, { kind: "reconciled", childId: w.ids.web, outcome: "no_effects", evidenceDigest: H("e"), at: at(9) }))).toBe("illegal_transition");
    const reconciled = drive(failed, w.view, { kind: "reconciled", childId: w.ids.fn, outcome: "effects_present", evidenceDigest: H("readback"), at: at(9) });
    expect(reconciled.children[w.ids.fn]).toMatchObject({ effects: "present", reconciliationRequired: false });
    const retried = drive(reconciled, w.view, { kind: "retry", childId: w.ids.fn, at: at(10) });
    expect(retried.children[w.ids.fn].status).toBe("pending");
    const done = drive(retried, w.view, start(w.ids.fn, retried, 11), succeed(w.ids.fn, 12));
    expect(done.children[w.ids.fn]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(summarizeRun(done).outcome).toBe("complete");
    expect(summarizeRun(done).appliedWithoutRunCompletion).toEqual([]);
  });

  it("a failure that provably applied nothing can be retried at once", () => {
    const w = world();
    const failed = drive(w.state, w.view, start(w.ids.db, w.state, 1), { kind: "fail", childId: w.ids.db, reason: "validation_error", effects: "none", at: at(2) });
    expect(failed.children[w.ids.db]).toMatchObject({ effects: "none", reconciliationRequired: false });
    expect(summarizeRun(failed).outcome).toBe("nothing_applied");
    expect(drive(failed, w.view, { kind: "retry", childId: w.ids.db, at: at(3) }).children[w.ids.db].status).toBe("pending");
  });

  it("blocks dependents of a failed child with the root cause and releases them on recovery", () => {
    const w = world();
    const failed = drive(w.state, w.view, start(w.ids.db, w.state, 1), { kind: "fail", childId: w.ids.db, reason: "provider_error", effects: "possible", at: at(2) });
    expect(failed.children[w.ids.web]).toMatchObject({ status: "blocked", blockedBy: [w.ids.db] });
    expect(failed.children[w.ids.fn]).toMatchObject({ status: "blocked", blockedBy: [w.ids.db] });
    expect(code(() => drive(failed, w.view, start(w.ids.web, failed, 3)))).toBe("illegal_transition");
    expect(nextRunnable(failed, NOW)).toEqual([]);
    const summary = summarizeRun(failed);
    expect(summary.outcome).toBe("indeterminate");
    expect(summary.blocked.map((item) => item.childId)).toEqual([w.ids.web, w.ids.fn]);
    const recovered = drive(failed, w.view, { kind: "reconciled", childId: w.ids.db, outcome: "no_effects", evidenceDigest: H("e"), at: at(3) }, { kind: "retry", childId: w.ids.db, at: at(4) });
    expect(recovered.children[w.ids.web].status).toBe("pending");
    expect(nextRunnable(recovered, new Date(Date.parse(at(4))))).toEqual([w.ids.db]);
  });

  it("a timeout is indeterminate, blocks dependents and accepts a late receipt as evidence", () => {
    const w = world({ childTimeoutMs: 60_000 });
    const running = drive(w.state, w.view, start(w.ids.db, w.state, 1));
    expect(drive(running, w.view, { kind: "tick", at: at(1) }).children[w.ids.db].status).toBe("running");
    const timedOut = drive(running, w.view, { kind: "tick", at: at(2) });
    expect(timedOut.children[w.ids.db]).toMatchObject({ status: "timed_out", reason: "child_timeout", effects: "possible", reconciliationRequired: true });
    expect(timedOut.children[w.ids.web].status).toBe("blocked");
    expect(code(() => drive(timedOut, w.view, { kind: "retry", childId: w.ids.db, at: at(3) }))).toBe("illegal_transition");
    const late = drive(timedOut, w.view, succeed(w.ids.db, 3));
    expect(late.children[w.ids.db]).toMatchObject({ status: "succeeded", reconciliationRequired: false });
    expect(late.children[w.ids.web].status).toBe("pending");
  });

  it("expiry stops new starts but never withdraws in-flight work", () => {
    const w = world({ expiresInMinutes: 10, childTimeoutMs: 60 * 60_000 });
    const running = drive(w.state, w.view, start(w.ids.db, w.state, 1));
    const expired = drive(running, w.view, { kind: "tick", at: at(11) });
    expect(expired.children[w.ids.db].status).toBe("running");
    expect(expired.children[w.ids.web]).toMatchObject({ status: "expired", reason: "approval_expired" });
    expect(expired.children[w.ids.fn].status).toBe("expired");
    expect(summarizeRun(expired)).toMatchObject({ expired: true, inFlight: [w.ids.db], outcome: "in_progress" });
    expect(nextRunnable(expired, new Date(Date.parse(at(11))))).toEqual([]);
    expect(code(() => drive(w.state, w.view, start(w.ids.db, w.state, 11)))).toBe("run_terminal");
    expect(nextDeadline(running)).toBe(at(10)); // approval expiry is the earliest deadline while children wait
    expect(nextDeadline(expired)).toBe(at(61));
  });

  it("cancellation cancels what has not started, asks running children to stop and never claims they stopped", () => {
    const w = world();
    const step = consume(w, finish(w.state, w.view, w.ids.db, 1), w.input, "db-host", 3);
    const running = drive(step.state, w.view, start(w.ids.web, step.state, 4));
    const cancelled = drive(running, w.view, { kind: "cancel", at: at(5) });
    expect(cancelled.children[w.ids.web].status).toBe("cancel_requested");
    expect(cancelled.children[w.ids.fn]).toMatchObject({ status: "cancelled", reason: "cancelled_before_start" });
    expect(cancelled.children[w.ids.db].status).toBe("succeeded");
    expect(summarizeRun(cancelled)).toMatchObject({ cancelled: true, inFlight: [w.ids.web], outcome: "in_progress" });
    expect(code(() => drive(cancelled, w.view, start(w.ids.fn, cancelled, 6)))).toBe("run_terminal");
    expect(drive(cancelled, w.view, { kind: "cancel", at: at(6) }).cancelRequestedAt).toBe(at(5));
    const confirmed = drive(cancelled, w.view, { kind: "cancel_confirmed", childId: w.ids.web, effects: "possible", at: at(7) });
    expect(confirmed.children[w.ids.web]).toMatchObject({ status: "cancelled", effects: "possible", reconciliationRequired: true });
    expect(summarizeRun(confirmed).nextSteps).toContain("reconcile_before_retry");
    expect(code(() => drive(confirmed, w.view, { kind: "retry", childId: w.ids.web, at: at(8) }))).toBe("run_terminal");
    // A child that finishes anyway is recorded as succeeded: cancel did not undo it.
    const finished = drive(cancelled, w.view, succeed(w.ids.web, 7));
    expect(finished.children[w.ids.web].status).toBe("succeeded");
    expect(summarizeRun(finished).appliedWithoutRunCompletion).toEqual([w.ids.db, w.ids.web]);
  });

  it("cancelling before anything started applies nothing", () => {
    const w = world();
    const summary = summarizeRun(drive(w.state, w.view, { kind: "cancel", at: at(1) }));
    expect(summary).toMatchObject({ cancelled: true, outcome: "nothing_applied", inFlight: [], appliedWithoutRunCompletion: [] });
    expect(summary.failed.map((item) => item.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("an outage is indeterminate: reconcile, then retry; dependents stay blocked meanwhile", () => {
    const w = world();
    const step = consume(w, finish(w.state, w.view, w.ids.db, 1), w.input, "db-host", 3);
    const running = drive(step.state, w.view, start(w.ids.web, step.state, 4));
    const out = drive(running, w.view, { kind: "outage", childId: w.ids.web, at: at(5) });
    expect(out.children[w.ids.web]).toMatchObject({ status: "outage", effects: "possible", reconciliationRequired: true });
    expect(out.children[w.ids.fn]).toMatchObject({ status: "blocked", blockedBy: [w.ids.web] });
    expect(code(() => drive(out, w.view, { kind: "outage", childId: w.ids.db, at: at(6) }))).toBe("illegal_transition");
    const ready = drive(out, w.view, { kind: "reconciled", childId: w.ids.web, outcome: "no_effects", evidenceDigest: H("readback"), at: at(6) }, { kind: "retry", childId: w.ids.web, at: at(7) });
    expect(ready.children[w.ids.fn].status).toBe("pending");
    expect(ready.children[w.ids.web].status).toBe("pending");
  });

  it("refuses a rebind that was not issued by an assessment or lacks the exact review", () => {
    const { w, state } = afterDb();
    const output = validateOutput(outputFor({ ...w, state }, "db-host"), state, w.view);
    const decision = assessOutputConsumption({ approvedInput: w.input, parentOperationId: PARENT, outputs: [output], preauthorizations: [], now: NOW });
    expect(code(() => drive(state, w.view, { kind: "rebind", decision: { ...decision }, at: at(3) }))).toBe("preauthorization");
    expect(code(() => drive(state, w.view, { kind: "rebind", decision, at: at(3) }))).toBe("stale_digest");
    expect(code(() => drive(state, w.view, { kind: "rebind", decision, review: { approvalId: "appr-1", approvedParentDigest: H("another-digest") }, at: at(3) }))).toBe("stale_digest");
    const applied = drive(state, w.view, { kind: "rebind", decision, review: { approvalId: "appr-1", approvedParentDigest: decision.requiredParentDigest }, at: at(3) });
    expect(applied.parentDigest).toBe(decision.requiredParentDigest);
    expect(applied.children[w.ids.web].effectDigest).toBe(decision.consumers[0].newEffectDigest);
    // A consumer that already started can never be silently rebound.
    const bound = consume(w, state, w.input, "db-host", 3);
    const started = drive(bound.state, w.view, start(w.ids.web, bound.state, 4));
    expect(code(() => drive(started, w.view, { kind: "rebind", decision, review: { approvalId: "appr-1", approvedParentDigest: decision.requiredParentDigest }, at: at(5) }))).toBe("illegal_transition");
    const cancelled = drive(state, w.view, { kind: "cancel", at: at(4) });
    expect(code(() => drive(cancelled, w.view, { kind: "rebind", decision, review: { approvalId: "appr-1", approvedParentDigest: decision.requiredParentDigest }, at: at(5) }))).toBe("run_terminal");
  });

  it("records a preauthorized rebind with the preauthorization as its authority", () => {
    const { w, state } = afterDb();
    const output = validateOutput(outputFor({ ...w, state }, "db-host"), state, w.view);
    const decision = assessOutputConsumption({ approvedInput: w.input, parentOperationId: PARENT, outputs: [output], preauthorizations: [grant(w)], now: NOW });
    const applied = drive(state, w.view, { kind: "rebind", decision, at: at(3) });
    expect(applied.children[w.ids.web].rebinds).toEqual([{ effectDigest: decision.consumers[0].newEffectDigest, authority: "preauthorization", authorityRef: "mop_1", at: at(3) }]);
  });

  it("refuses an event for a different plan and validates persisted state", () => {
    const w = world();
    const other = { ...w.view, desiredDigest: H("another-plan") };
    expect(code(() => drive(w.state, other, start(w.ids.db, w.state, 1)))).toBe("stale_digest");
    expect(parseRunState(JSON.parse(JSON.stringify(w.state)))).toEqual(w.state);
    const broken = JSON.parse(JSON.stringify(w.state)) as { children: Record<string, { status: string }> };
    broken.children[w.ids.db].status = "bogus";
    expect(code(() => parseRunState(broken))).toBe("invalid_input");
    expect(code(() => parseRunState({ ...w.state, extra: true }))).toBe("invalid_input");
  });

  it("summarises a completed run as complete and still not atomic", () => {
    const w = world();
    const summary = summarizeRun(complete(w).state);
    expect(summary).toMatchObject({ outcome: "complete", atomicity: "none", automaticCompensation: "never", appliedWithoutRunCompletion: [], nextSteps: ["none"] });
    expect(summary.stateDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("drift and migration ordering", () => {
  const w = world();
  const step = throughWeb(w);

  it("allows a step when nothing blocks it", () => {
    expect(evaluateOrdering(step.state, { kind: "start_child", childId: w.ids.fn }, NONE)).toEqual({ allowed: true, blocks: [] });
  });

  it("blocks a consumer while a producer has unresolved drift, but not for expected variance", () => {
    const blocked = evaluateOrdering(step.state, { kind: "start_child", childId: w.ids.fn }, { drift: [{ childId: w.ids.db, klass: "unauthorized_change" }], migrationChildIds: [] });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blocks).toContainEqual({ rule: "producer_drift_unresolved", childId: w.ids.fn, blockedBy: w.ids.db });
    expect(evaluateOrdering(step.state, { kind: "start_child", childId: w.ids.fn }, { drift: [{ childId: w.ids.db, klass: "expected_variance" }], migrationChildIds: [] }).allowed).toBe(true);
    expect(evaluateOrdering(step.state, { kind: "start_child", childId: w.ids.fn }, { drift: [{ childId: w.ids.web, klass: "native_divergence" }], migrationChildIds: [] }).allowed).toBe(false);
  });

  it("holds dependents until a migration child succeeded, and allows one migration at a time", () => {
    const fresh = world();
    const signals = { drift: [], migrationChildIds: [fresh.ids.db] };
    expect(evaluateOrdering(fresh.state, { kind: "start_child", childId: fresh.ids.web }, signals).blocks).toContainEqual({ rule: "migration_incomplete", childId: fresh.ids.web, blockedBy: fresh.ids.db });
    const running = drive(fresh.state, fresh.view, start(fresh.ids.db, fresh.state, 1));
    const second = evaluateOrdering(running, { kind: "start_child", childId: fresh.ids.web }, { drift: [], migrationChildIds: [fresh.ids.db, fresh.ids.web] });
    expect(second.blocks).toContainEqual({ rule: "one_migration_at_a_time", childId: fresh.ids.web, blockedBy: fresh.ids.db });
    expect(evaluateOrdering(running, { kind: "migration", childId: fresh.ids.web }, { drift: [], migrationChildIds: [fresh.ids.db, fresh.ids.web] }).blocks.map((b) => b.rule)).toEqual(expect.arrayContaining(["producers_incomplete", "one_migration_at_a_time"]));
    const dependentsRunning = drive(step.state, w.view, start(w.ids.fn, step.state, 7));
    expect(evaluateOrdering(dependentsRunning, { kind: "migration", childId: w.ids.web }, NONE).blocks).toContainEqual({ rule: "dependents_in_flight", childId: w.ids.web, blockedBy: w.ids.fn });
  });

  it("refuses drift repair while a neighbour is in flight or unreconciled, and repairs producers first", () => {
    const running = drive(step.state, w.view, start(w.ids.fn, step.state, 7));
    expect(evaluateOrdering(running, { kind: "drift_repair", childId: w.ids.web }, NONE).blocks).toContainEqual({ rule: "neighbour_in_flight", childId: w.ids.web, blockedBy: w.ids.fn });
    const failed = drive(running, w.view, { kind: "fail", childId: w.ids.fn, reason: "provider_error", effects: "possible", at: at(8) });
    expect(evaluateOrdering(failed, { kind: "drift_repair", childId: w.ids.web }, NONE).blocks).toContainEqual({ rule: "neighbour_needs_reconciliation", childId: w.ids.web, blockedBy: w.ids.fn });
    const producerFirst = evaluateOrdering(step.state, { kind: "drift_repair", childId: w.ids.web }, { drift: [{ childId: w.ids.db, klass: "unauthorized_change" }], migrationChildIds: [] });
    expect(producerFirst.blocks).toContainEqual({ rule: "repair_producers_first", childId: w.ids.web, blockedBy: w.ids.db });
    expect(evaluateOrdering(step.state, { kind: "drift_repair", childId: w.ids.db }, { drift: [{ childId: w.ids.db, klass: "unauthorized_change" }], migrationChildIds: [] }).allowed).toBe(true);
  });

  it("allows teardown only consumers first and never during a migration", () => {
    const all = complete(w).state;
    expect(evaluateOrdering(all, { kind: "teardown", childId: w.ids.fn }, NONE).allowed).toBe(true);
    expect(evaluateOrdering(all, { kind: "teardown", childId: w.ids.web }, NONE).blocks).toContainEqual({ rule: "teardown_consumers_first", childId: w.ids.web, blockedBy: w.ids.fn });
    const migrating = drive(step.state, w.view, start(w.ids.fn, step.state, 7));
    expect(evaluateOrdering(migrating, { kind: "teardown", childId: w.ids.db }, { drift: [], migrationChildIds: [w.ids.fn] }).blocks).toContainEqual({ rule: "migration_in_flight", childId: w.ids.db, blockedBy: w.ids.fn });
    expect(evaluateOrdering(all, { kind: "start_child", childId: "ghost" }, NONE).blocks[0].rule).toBe("unknown_child");
  });
});

describe("teardown: reverse order, ownership, human destructive approval", () => {
  const w = world();
  const done = complete(w).state;
  const addresses: Record<string, string> = { [w.ids.db]: DB, [w.ids.web]: WEB, [w.ids.fn]: FN };
  const owners = (): Map<string, ResourceOwner | null> => new Map(Object.entries(addresses).map(([childId, address]): [string, ResourceOwner | null] => [address, { parentOperationId: PARENT, childId }]));
  const input = (over: Partial<Parameters<typeof planTeardown>[1]> = {}) => ({ owners: owners(), externalDependents: () => [] as string[], now: NOW, ...over });
  const plan = () => planTeardown(done, input());

  const port = (facts: Record<string, DestroyApprovalFact | null>): TeardownApprovalPort => ({ lookup: async (_ws, id) => facts[id] ?? null });
  const fact = (address: string, over: Partial<DestroyApprovalFact> = {}): DestroyApprovalFact => ({
    operationId: `op-destroy-${address}`, workspaceId: WS, environmentId: ENV, capability: "infrastructure.destroy", status: "approved", destroyAddresses: [address],
    proposalDigest: H("proposal"), approvals: [{ id: "appr-1", decision: "approve", proposalDigest: H("proposal"), approverKind: "user", humanOnly: true, approverRole: "admin", expiresAt: at(60), consumed: false }], ...over,
  });
  const verify = (state: MixedRunState, childId: string, destroyed: DestroyApprovalFact | null) =>
    verifyTeardownApproval(port({ [`op-destroy-${addresses[childId]}`]: destroyed }), state, childId, `op-destroy-${addresses[childId]}`, NOW);

  it("proposes one step per applied child, consumers first, with explicit ordering edges", () => {
    const report = plan();
    const steps = report.state.teardown!.steps;
    expect(steps.map((step) => step.childId)).toEqual([w.ids.fn, w.ids.web, w.ids.db]);
    expect(steps.map((step) => step.addresses)).toEqual([[FN], [WEB], [DB]]);
    expect(steps[0].after).toEqual([]);
    expect(steps[1].after).toEqual([w.ids.fn]);
    expect(steps[2].after).toEqual([w.ids.web, w.ids.fn].sort());
    expect(steps.every((step) => step.status === "planned" && /^[a-f0-9]{64}$/.test(step.stepDigest))).toBe(true);
    expect(report.state.teardown!.planDigest).toBe(digest({ parentOperationId: PARENT, steps: steps.map((step) => step.stepDigest) }));
    expect(planTeardown(report.state, input()).state.teardown!.steps).toHaveLength(3);
    expect(summarizeRun(report.state).outcome).toBe("complete");
  });

  it("only lists children that applied something", () => {
    const partial = throughWeb(w).state;
    const steps = planTeardown(partial, input()).state.teardown!.steps;
    expect(steps.map((step) => step.childId)).toEqual([w.ids.web, w.ids.db]);
    expect(steps[0].after).toEqual([]);
    expect(planTeardown(drive(w.state, w.view, { kind: "cancel", at: at(1) }), input()).state.teardown!.steps).toEqual([]);
  });

  it("refuses while a child is in flight or unreconciled", () => {
    const step = throughWeb(w);
    const running = drive(step.state, w.view, start(w.ids.fn, step.state, 7));
    expect(refused(() => planTeardown(running, input())).detail).toEqual(["children_in_flight"]);
    const failed = drive(running, w.view, { kind: "fail", childId: w.ids.fn, reason: "provider_error", effects: "possible", at: at(8) });
    expect(refused(() => planTeardown(failed, input()))).toMatchObject({ code: "ordering_blocked", detail: [w.ids.fn] });
  });

  it("refuses an address the run does not own", () => {
    const missing = owners();
    missing.delete(DB);
    expect(refused(() => planTeardown(done, input({ owners: missing })))).toMatchObject({ code: "ownership", detail: [DB] });
    const foreign = owners();
    foreign.set(WEB, { parentOperationId: "op-other", childId: w.ids.web });
    expect(code(() => planTeardown(done, input({ owners: foreign })))).toBe("ownership");
    const wrongChild = owners();
    wrongChild.set(FN, { parentOperationId: PARENT, childId: w.ids.db });
    expect(code(() => planTeardown(done, input({ owners: wrongChild })))).toBe("ownership");
    const unowned = owners();
    unowned.set(FN, null);
    expect(code(() => planTeardown(done, input({ owners: unowned })))).toBe("ownership");
  });

  it("refuses when something outside the run depends on a resource", () => {
    const error = refused(() => planTeardown(done, input({ externalDependents: (address) => (address === DB ? ["resource/outside"] : []) })));
    expect(error).toMatchObject({ code: "teardown_refused", detail: [DB, "resource/outside"] });
  });

  it("never proposes referenced or external nodes", () => {
    const extra = structuredClone(done);
    extra.children[w.ids.web].nodes.push({ address: "resource/shared", ownership: "referenced" }, { address: "resource/legacy", ownership: "external" });
    const report = planTeardown(extra, input());
    expect(report.retained).toEqual([{ childId: w.ids.web, address: "resource/shared", ownership: "referenced" }, { childId: w.ids.web, address: "resource/legacy", ownership: "external" }]);
    expect(report.state.teardown!.steps.find((step) => step.childId === w.ids.web)!.addresses).toEqual([WEB]);
  });

  describe("release needs a verified human destructive approval of exactly this step", () => {
    const planned = plan().state;

    it("accepts a human admin approval bound to the step's addresses", async () => {
      const approval = await verify(planned, w.ids.fn, fact(FN));
      expect(approval).toMatchObject({ approvalId: "appr-1", destroyOperationId: `op-destroy-${FN}`, destroyAddresses: [FN] });
      const released = releaseTeardownStep(planned, w.ids.fn, approval, NONE, NOW);
      expect(released.teardown!.steps[0]).toMatchObject({ status: "released", approvalId: "appr-1", destroyOperationId: `op-destroy-${FN}` });
    });

    const bad: [string, Partial<DestroyApprovalFact> | null][] = [
      ["no such destroy operation", null],
      ["another capability", { capability: "infrastructure.apply" }],
      ["a finished destroy", { status: "succeeded" }],
      ["a rejected destroy", { status: "rejected" }],
      ["another workspace", { workspaceId: "ws-other" }],
      ["another environment", { environmentId: "env-other" }],
      ["a different address list", { destroyAddresses: [FN, WEB] }],
      ["an empty address list", { destroyAddresses: [] }],
      ["an agent approver", { approvals: [{ id: "a", decision: "approve", proposalDigest: H("proposal"), approverKind: "integration", humanOnly: false, approverRole: "admin", expiresAt: at(60), consumed: false }] }],
      ["an agent acting for a person", { approvals: [{ id: "a", decision: "approve", proposalDigest: H("proposal"), approverKind: "user", humanOnly: false, approverRole: "admin", expiresAt: at(60), consumed: false }] }],
      ["an editor", { approvals: [{ id: "a", decision: "approve", proposalDigest: H("proposal"), approverKind: "user", humanOnly: true, approverRole: "editor", expiresAt: at(60), consumed: false }] }],
      ["an approval of another proposal", { approvals: [{ id: "a", decision: "approve", proposalDigest: H("other"), approverKind: "user", humanOnly: true, approverRole: "admin", expiresAt: at(60), consumed: false }] }],
      ["an expired approval", { approvals: [{ id: "a", decision: "approve", proposalDigest: H("proposal"), approverKind: "user", humanOnly: true, approverRole: "admin", expiresAt: at(-1), consumed: false }] }],
      ["a consumed approval", { approvals: [{ id: "a", decision: "approve", proposalDigest: H("proposal"), approverKind: "user", humanOnly: true, approverRole: "admin", expiresAt: at(60), consumed: true }] }],
      ["no approval at all", { approvals: [] }],
      ["an approval alongside a rejection", { approvals: [
        { id: "a", decision: "approve", proposalDigest: H("proposal"), approverKind: "user", humanOnly: true, approverRole: "admin", expiresAt: at(60), consumed: false },
        { id: "b", decision: "reject", proposalDigest: H("proposal"), approverKind: "user", humanOnly: true, approverRole: "admin", expiresAt: at(60), consumed: false }] }],
    ];
    it.each(bad)("refuses %s", async (_label, over) => {
      await expect(verify(planned, w.ids.fn, over === null ? null : fact(FN, over))).rejects.toMatchObject({ code: "approval_invalid" });
    });

    it("refuses a step that is not in the proposal and a forged approval object", async () => {
      await expect(verifyTeardownApproval(port({}), done, w.ids.fn, "op-x", NOW)).rejects.toMatchObject({ code: "teardown_refused" });
      const forged = { workspaceId: WS, environmentId: ENV, destroyOperationId: "op-x", approvalId: "appr-1", destroyAddresses: [FN] };
      expect(code(() => releaseTeardownStep(planned, w.ids.fn, forged, NONE, NOW))).toBe("approval_invalid");
    });

    it("walks the whole order: one step at a time, consumers first, a failed step blocks the producers behind it", async () => {
      const approvals = { fn: await verify(planned, w.ids.fn, fact(FN)), web: await verify(planned, w.ids.web, fact(WEB)), db: await verify(planned, w.ids.db, fact(DB)) };
      let state = planned;
      // db cannot go first.
      expect(code(() => releaseTeardownStep(state, w.ids.db, approvals.db, NONE, NOW))).toBe("ordering_blocked");
      state = releaseTeardownStep(state, w.ids.fn, approvals.fn, NONE, NOW);
      // Only one step is released at a time.
      expect(refused(() => releaseTeardownStep(state, w.ids.web, approvals.web, NONE, NOW)).detail).toEqual(["one_teardown_step_at_a_time"]);
      state = recordTeardownResult(state, w.ids.fn, "destroyed", NOW);
      expect(state.children[w.ids.fn].effects).toBe("none");
      expect(code(() => planTeardown(state, input()))).toBe("conflict");
      state = releaseTeardownStep(state, w.ids.web, approvals.web, NONE, NOW);
      state = recordTeardownResult(state, w.ids.web, "failed", NOW);
      expect(state.children[w.ids.web].reconciliationRequired).toBe(true);
      // A failed step does not count as destroyed: the producer behind it stays protected.
      expect(code(() => releaseTeardownStep(state, w.ids.db, approvals.db, NONE, NOW))).toBe("ordering_blocked");
      expect(code(() => recordTeardownResult(state, w.ids.db, "destroyed", NOW))).toBe("illegal_transition");
      expect(state.teardown!.steps.map((step) => step.status)).toEqual(["destroyed", "failed", "planned"]);
    });

    it("an uncertain destroy also blocks the producers behind it", async () => {
      const approvals = { fn: await verify(planned, w.ids.fn, fact(FN)), web: await verify(planned, w.ids.web, fact(WEB)) };
      let state = releaseTeardownStep(planned, w.ids.fn, approvals.fn, NONE, NOW);
      state = recordTeardownResult(state, w.ids.fn, "uncertain", NOW);
      expect(state.children[w.ids.fn].reconciliationRequired).toBe(true);
      expect(code(() => releaseTeardownStep(state, w.ids.web, approvals.web, NONE, NOW))).toBe("ordering_blocked");
      expect(code(() => planTeardown(state, input()))).toBe("ordering_blocked");
    });
  });
});
