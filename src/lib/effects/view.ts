/**
 * Client-safe projection of ledger effects (no database, no provider, no secrets).
 * The one place the UX-01 operator journey and the effects API take their
 * words and state from, so a lost response is never shown as a failure.
 */
import { projectedState, resolutionOptions, type ResolutionOption } from "./binding";
import type { EffectEvent, EffectFamily, EffectRecord, EffectResolution, EffectState, Readback } from "./types";

export interface EffectView {
  effectId: string;
  operationId: string;
  environmentId: string | null;
  family: EffectFamily;
  familyLabel: string;
  provider: string;
  /** What to show. A tombstoned effect that later received a provider receipt is shown as `conflict`. */
  state: EffectState;
  /** What is stored. */
  storedState: EffectState;
  stateLabel: string;
  headline: string;
  reason: string | null;
  needsOperator: boolean;
  receipt: { resourceId: string | null; requestIds: string[] } | null;
  lateReceipt: { resourceId: string | null; requestIds: string[]; receivedAt: string; staleFence: boolean } | null;
  readback: Pick<Readback, "outcome" | "source" | "observedAt" | "facts" | "reason" | "digest" | "resourceId"> | null;
  idempotency: { supported: boolean; tokenSent: boolean };
  fence: { scope: string | null; epoch: number | null; live: boolean };
  resolutionOptions: ResolutionOption[];
  version: number;
  createdAt: string;
  updatedAt: string;
  uncertainAt: string | null;
  events?: EffectEvent[];
  resolutions?: EffectResolution[];
}

const FAMILY: Record<EffectFamily, string> = {
  build_launch: "Build launch",
  cleanup_apply: "Cleanup",
};

const STATE_LABEL: Record<EffectState, string> = {
  pending: "In flight",
  accepted: "Accepted by the provider",
  confirmed: "Confirmed",
  uncertain: "Outcome uncertain",
  conflict: "Evidence conflicts",
  tombstoned: "Retired",
};

const HEADLINE: Record<EffectState, string> = {
  pending: "Zenith sent this to the provider and is waiting for the reply. It will not be sent again.",
  accepted: "The provider accepted this. Zenith will confirm it with an independent read.",
  confirmed: "An independent read confirmed this happened.",
  uncertain: "Zenith cannot prove whether this happened. It will not retry it. Read it back, review the evidence, and authorize a resolution.",
  conflict: "The provider's replies and Zenith's reads disagree. Nothing will be retried; review the evidence.",
  tombstoned: "This attempt is closed and will not be repeated. A new operation is needed to try again.",
};

export const effectNeedsOperator = (state: EffectState): boolean => state === "uncertain" || state === "conflict";

export function effectView(effect: EffectRecord, opts: { fenceLive?: boolean; events?: EffectEvent[]; resolutions?: EffectResolution[] } = {}): EffectView {
  const shown = projectedState(effect);
  const fenceLive = opts.fenceLive ?? false;
  return {
    effectId: effect.effectId,
    operationId: effect.operationId,
    environmentId: effect.environmentId,
    family: effect.family,
    familyLabel: FAMILY[effect.family],
    provider: effect.provider,
    state: shown,
    storedState: effect.state,
    stateLabel: STATE_LABEL[shown],
    headline: shown === "conflict" && effect.state === "tombstoned"
      ? "This attempt was closed as not applied, but the provider later answered that it was. Nothing will be retried; investigate what exists."
      : HEADLINE[shown],
    reason: effect.stateReason,
    needsOperator: effectNeedsOperator(shown),
    receipt: effect.providerReceipt ? { resourceId: effect.providerReceipt.resourceId ?? null, requestIds: effect.providerReceipt.requestIds } : null,
    lateReceipt: effect.lateReceipt ? { resourceId: effect.lateReceipt.resourceId ?? null, requestIds: effect.lateReceipt.requestIds, receivedAt: effect.lateReceipt.receivedAt, staleFence: effect.lateReceipt.staleFence } : null,
    readback: effect.readback ? { outcome: effect.readback.outcome, source: effect.readback.source, observedAt: effect.readback.observedAt, facts: effect.readback.facts, reason: effect.readback.reason, digest: effect.readback.digest, resourceId: effect.readback.resourceId } : null,
    idempotency: { supported: effect.idempotencySupported, tokenSent: effect.idempotencySupported && effect.idempotencyToken !== null },
    fence: { scope: effect.fenceScope, epoch: effect.fenceEpoch, live: fenceLive },
    resolutionOptions: resolutionOptions(effect, fenceLive),
    version: effect.version,
    createdAt: effect.createdAt,
    updatedAt: effect.updatedAt,
    uncertainAt: effect.uncertainAt,
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.resolutions ? { resolutions: opts.resolutions } : {}),
  };
}

/** True when the operation's outcome cannot be called known because an effect needs an operator or is still in flight. */
export function effectsLeaveOutcomeUnknown(effects: readonly Pick<EffectView, "state">[]): boolean {
  return effects.some((e) => e.state === "uncertain" || e.state === "conflict" || e.state === "pending");
}
