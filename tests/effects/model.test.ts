/**
 * Pure model of the external-effect ledger (PROD-DUR-07 / PROD-DUR-08): transition tables, evidence binding,
 * the operator-facing projection (UX-01) and the activity failure mapping. No database, no provider.
 */
import { describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import { buildReadback, projectedState, receiptDigest, receiptFromReadback, resolutionBinding, resolutionOptions } from "@/lib/effects/binding";
import {
  AUTOMATIC_TRANSITIONS, ABSENCE_SETTLE_MS, BLOCKING_STATES, EFFECT_STATES, RESOLUTION_TRANSITIONS, TERMINAL_STATES, UNRESOLVED_STATES,
  canTransitionAutomatically, canTransitionByResolution, type EffectRecord,
} from "@/lib/effects/types";
import { EffectTombstonedError, EffectUnresolvedError } from "@/lib/effects/ledger";
import { effectNeedsOperator, effectView, effectsLeaveOutcomeUnknown } from "@/lib/effects/view";
import { projectLegacyDeployment, projectPlatformOperation, unresolvedEffects, type EffectLike } from "@/lib/platform/operator-journey";
import { toTemporalFailure } from "@/lib/workflows/activities/failures";
import { FAILURE_TYPES } from "@/lib/workflows/types";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function effect(over: Partial<EffectRecord> = {}): EffectRecord {
  return {
    workspaceId: "ws_1", effectId: "fx_1", family: "build_launch", operationId: "op_1", environmentId: "env_1", provider: "aws", dedupKey: "build:op_1:svc",
    requestDigest: "a".repeat(64), target: {}, idempotencyToken: "zn-1", idempotencySupported: true, fenceScope: "env:env_1", fenceEpoch: 3,
    state: "uncertain", stateReason: "timeout", providerReceipt: null, lateReceipt: null, readback: null, tombstoneReason: null, version: 4,
    createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 3_000_000), uncertainAt: iso(NOW - 3_000_000), ...over,
  };
}
const rb = (over: Partial<Parameters<typeof buildReadback>[0]> = {}) => buildReadback({ outcome: "present", source: "t", observedAt: iso(NOW), resourceId: "b-1", requestIds: ["r"], facts: {}, ...over });

describe("state model", () => {
  it("terminal states have no exits and uncertain/conflict leave only through resolution", () => {
    for (const s of TERMINAL_STATES) {
      expect(AUTOMATIC_TRANSITIONS[s]).toEqual([]);
      expect(RESOLUTION_TRANSITIONS[s]).toEqual([]);
    }
    expect(AUTOMATIC_TRANSITIONS.uncertain).toEqual(["conflict"]);
    expect(AUTOMATIC_TRANSITIONS.conflict).toEqual([]);
    for (const to of ["confirmed", "tombstoned"] as const) {
      expect(canTransitionAutomatically("uncertain", to)).toBe(false);
      expect(canTransitionByResolution("uncertain", to)).toBe(true);
      expect(canTransitionByResolution("conflict", to)).toBe(true);
    }
    expect(canTransitionByResolution("pending", "confirmed")).toBe(false);
    expect(canTransitionAutomatically("pending", "confirmed")).toBe(false);
  });

  it("an unknown outcome is never automatically promoted back into the happy path", () => {
    for (const from of ["uncertain", "conflict"] as const) for (const to of ["pending", "accepted", "confirmed", "tombstoned"] as const) expect(canTransitionAutomatically(from, to)).toBe(false);
  });

  it("classifies every state and covers all six", () => {
    expect([...EFFECT_STATES].sort()).toEqual(["accepted", "confirmed", "conflict", "pending", "tombstoned", "uncertain"]);
    expect(UNRESOLVED_STATES).toEqual(expect.arrayContaining(["pending", "accepted", "uncertain", "conflict"]));
    expect(BLOCKING_STATES).toEqual(["pending", "uncertain", "conflict"]);
  });
});

describe("evidence binding", () => {
  it("a readback digest changes with what was observed, and is stable for the same observation", () => {
    expect(rb().digest).toBe(rb().digest);
    expect(rb({ observedAt: iso(NOW + 1000) }).digest).not.toBe(rb().digest);
    expect(rb({ outcome: "absent" }).digest).not.toBe(rb().digest);
    expect(rb({ resourceId: "other" }).digest).not.toBe(rb().digest);
  });

  it("a resolution binding covers workspace, effect, family, request, version, decision and readback", () => {
    const e = effect({ readback: rb() });
    const base = resolutionBinding(e, "confirm_applied", e.readback!.digest);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(resolutionBinding({ ...e, version: e.version + 1 }, "confirm_applied", e.readback!.digest)).not.toBe(base);
    expect(resolutionBinding(e, "confirm_not_applied", e.readback!.digest)).not.toBe(base);
    expect(resolutionBinding(e, "confirm_applied", rb({ resourceId: "z" }).digest)).not.toBe(base);
    expect(resolutionBinding({ ...e, workspaceId: "ws_2" }, "confirm_applied", e.readback!.digest)).not.toBe(base);
    expect(resolutionBinding({ ...e, effectId: "fx_2" }, "confirm_applied", e.readback!.digest)).not.toBe(base);
    expect(resolutionBinding({ ...e, requestDigest: "c".repeat(64) }, "confirm_applied", e.readback!.digest)).not.toBe(base);
  });

  it("a receipt digest ignores request id order", () => {
    expect(receiptDigest({ resourceId: "x", requestIds: ["b", "a"] })).toBe(receiptDigest({ resourceId: "x", requestIds: ["a", "b"] }));
    expect(receiptFromReadback(rb({ requestIds: ["q"] }))).toEqual({ resourceId: "b-1", requestIds: ["q"] });
  });

  describe("resolution options", () => {
    it("offers nothing without a readback, and says why", () => {
      const [applied, notApplied] = resolutionOptions(effect(), false);
      expect(applied).toMatchObject({ available: false });
      expect(applied.blockedBy).toMatch(/readback/i);
      expect(notApplied.available).toBe(false);
    });
    it("a present readback allows only 'applied'", () => {
      const e = effect({ readback: rb() });
      const [applied, notApplied] = resolutionOptions(e, false);
      expect(applied).toMatchObject({ available: true, bindingDigest: resolutionBinding(e, "confirm_applied", e.readback!.digest) });
      expect(notApplied.available).toBe(false);
    });
    it("a present readback of a different object than the receipt allows nothing", () => {
      const e = effect({ state: "conflict", providerReceipt: { resourceId: "recorded", requestIds: [] }, readback: rb({ resourceId: "different" }) });
      expect(resolutionOptions(e, false)[0].available).toBe(false);
    });
    it("an absent readback allows 'not applied' only after the fence is gone and the settle window passed", () => {
      const absent = rb({ outcome: "absent", resourceId: undefined, observedAt: iso(NOW) });
      const e = effect({ readback: absent });
      expect(resolutionOptions(e, true)[1]).toMatchObject({ available: false });
      expect(resolutionOptions(e, true)[1].blockedBy).toMatch(/still live/);
      expect(resolutionOptions(effect({ readback: absent, createdAt: iso(NOW - 60_000), uncertainAt: iso(NOW - 60_000) }), false)[1].blockedBy).toMatch(/settle window/);
      const ok = resolutionOptions(e, false)[1];
      expect(ok).toMatchObject({ available: true, bindingDigest: resolutionBinding(e, "confirm_not_applied", absent.digest) });
      expect(effect().uncertainAt && Date.parse(effect().uncertainAt!) + ABSENCE_SETTLE_MS < NOW).toBe(true);
    });
    it("a late receipt, mismatch or unavailable read allows no resolution", () => {
      const absent = rb({ outcome: "absent", resourceId: undefined });
      expect(resolutionOptions(effect({ readback: absent, lateReceipt: { requestIds: [], receivedAt: iso(NOW), staleFence: true, digest: "d".repeat(64) } }), false)[1].available).toBe(false);
      for (const outcome of ["mismatch", "unavailable"] as const) {
        const [a, n] = resolutionOptions(effect({ readback: rb({ outcome, resourceId: undefined }) }), false);
        expect(a.available || n.available).toBe(false);
      }
    });
    it("a confirmed or retired effect needs no resolution", () => {
      for (const state of ["confirmed", "tombstoned", "pending", "accepted"] as const) {
        const [a, n] = resolutionOptions(effect({ state, tombstoneReason: state === "tombstoned" ? "provider_rejected" : null }), false);
        expect(a.available || n.available).toBe(false);
      }
    });
  });
});

describe("projection (UX-01)", () => {
  it("shows a tombstone that later received a provider receipt as a conflict, and keeps the stored state", () => {
    const late = { requestIds: ["x"], receivedAt: iso(NOW), staleFence: false, digest: "d".repeat(64) };
    const e = effect({ state: "tombstoned", tombstoneReason: "provider_rejected", lateReceipt: late });
    expect(projectedState(e)).toBe("conflict");
    const v = effectView(e);
    expect(v).toMatchObject({ state: "conflict", storedState: "tombstoned", needsOperator: true });
    expect(v.headline).toMatch(/later answered/);
    expect(projectedState(effect({ state: "tombstoned", tombstoneReason: "provider_rejected" }))).toBe("tombstoned");
  });

  it("words every state without a retry affordance", () => {
    for (const state of EFFECT_STATES) {
      const v = effectView(effect({ state, tombstoneReason: state === "tombstoned" ? "provider_rejected" : null }));
      expect(v.headline.length).toBeGreaterThan(10);
      expect(JSON.stringify(v).toLowerCase()).not.toContain("retry now");
    }
    expect(effectView(effect({ state: "uncertain" })).headline).toMatch(/will not retry/);
  });

  it("never exposes the provider token, only whether one was sent", () => {
    const v = effectView(effect({ idempotencyToken: "zn-secret-looking-token" }));
    expect(JSON.stringify(v)).not.toContain("zn-secret-looking-token");
    expect(v.idempotency).toEqual({ supported: true, tokenSent: true });
  });

  it("flags an operation outcome as unknown while an effect needs an operator or is in flight", () => {
    expect(effectsLeaveOutcomeUnknown([{ state: "uncertain" }])).toBe(true);
    expect(effectsLeaveOutcomeUnknown([{ state: "pending" }])).toBe(true);
    expect(effectsLeaveOutcomeUnknown([{ state: "confirmed" }, { state: "tombstoned" }, { state: "accepted" }])).toBe(false);
    expect(effectNeedsOperator("uncertain") && effectNeedsOperator("conflict") && !effectNeedsOperator("pending")).toBe(true);
  });

  describe("operation journey", () => {
    const eff = (state: EffectLike["state"]): EffectLike => ({ effectId: `fx_${state}`, state, familyLabel: "Build launch" });

    it("a failed operation with an uncertain effect is shown as uncertain with effect-specific next steps", () => {
      const v = projectPlatformOperation({ id: "op_1", status: "failed", effects: [eff("uncertain")] });
      expect(v.stage).toBe("uncertain");
      expect(v.outcomeKnown).toBe(false);
      expect(v.steps.at(-1)).toMatchObject({ id: "effects", state: "uncertain", detail: "1 need review" });
      expect(v.nextSteps.join(" ")).toMatch(/Do not retry/);
      expect(v.nextSteps.join(" ")).toMatch(/readback/i);
    });
    it("a succeeded or running operation is not called either while an effect conflicts", () => {
      expect(projectPlatformOperation({ id: "op_1", status: "succeeded", effects: [eff("conflict")] }).stage).toBe("uncertain");
      expect(projectPlatformOperation({ id: "op_1", status: "running", effects: [eff("uncertain")] }).stage).toBe("uncertain");
    });
    it("settled effects change nothing", () => {
      for (const state of ["confirmed", "tombstoned", "accepted", "pending"] as const) expect(projectPlatformOperation({ id: "op_1", status: "failed", effects: [eff(state)] }).stage).toBe("failed");
      expect(projectPlatformOperation({ id: "op_1", status: "failed" }).stage).toBe("failed");
      expect(projectPlatformOperation({ id: "op_1", status: "succeeded", effects: [] }).stage).toBe("succeeded");
    });
    it("never revives an operation that was cancelled, rejected or denied", () => {
      for (const status of ["cancelled", "rejected", "denied", "expired"] as const) expect(projectPlatformOperation({ id: "op_1", status, effects: [eff("uncertain")] }).stage).not.toBe("uncertain");
    });
    it("the legacy deployment view carries the same uncertainty", () => {
      const v = projectLegacyDeployment(
        { id: "dep_1", status: "failed", executor: "workflow", operationId: "op_1", steps: [{ id: "s1", seq: 1, title: "Build", status: "running" }] },
        { id: "op_1", status: "failed", effects: [eff("uncertain")] }
      );
      expect(v.stage).toBe("uncertain");
      expect(v.nextSteps.join(" ")).toMatch(/Do not retry/);
    });
    it("lists only the effects that need an operator", () => {
      expect(unresolvedEffects([eff("uncertain"), eff("confirmed"), eff("conflict"), eff("pending")]).map((e) => e.state)).toEqual(["uncertain", "conflict"]);
    });
  });
});

describe("activity failure mapping", () => {
  it("an unresolved or retired effect is a non-retryable step failure (the ledger refuses every replay)", () => {
    for (const err of [new EffectUnresolvedError("fx_1", "uncertain"), new EffectTombstonedError("fx_1")]) {
      const mapped = toTemporalFailure(err);
      expect(mapped).toBeInstanceOf(ApplicationFailure);
      expect(mapped).toMatchObject({ type: FAILURE_TYPES.stepFailed, nonRetryable: true });
    }
  });
  it("other errors keep their existing mapping", () => {
    const plain = new Error("boom");
    expect(toTemporalFailure(plain)).toBe(plain);
  });
});
