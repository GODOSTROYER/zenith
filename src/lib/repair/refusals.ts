/**
 * Typed refusals of the observation-to-repair lifecycle (PROD-OBS-01).
 *
 * Every reason the lifecycle can decline to repair something is an explicit
 * code with the stage it happened at, whether a later pass may succeed
 * without a person, and a reason a human can read. There is no generic
 * "not implemented": a repair kind without a driver handler or declarative
 * recipe is `repair_not_supported` and says what is missing.
 *
 * The table is a total `Record` over `RepairSkipReason`, so adding a skip
 * reason to the controller without deciding its refusal does not compile.
 */
import type { RepairDecision, RepairSkipReason } from "@/lib/reconcile/types";

export type LifecycleStage = "observe" | "diagnose" | "propose" | "policy" | "approval" | "remediate" | "verify";

export type RepairRefusalCode = RepairSkipReason | "broker_error" | "start_failed" | "policy_denied";

export interface RepairRefusal {
  code: RepairRefusalCode;
  stage: LifecycleStage;
  /** true: a later pass can proceed with no human action (cooldowns, hysteresis, pacing) */
  retryable: boolean;
  reason: string;
}

type Entry = Omit<RepairRefusal, "code">;

const TABLE: Record<RepairSkipReason, Entry> = {
  auto_repair_disabled: { stage: "observe", retryable: false, reason: "Automatic repair was not requested for this pass; drift is reported and nothing is proposed." },
  autonomy_observe_only: { stage: "observe", retryable: false, reason: "The environment autonomy level is observe-only; no repair is proposed." },
  simulated_observation: { stage: "observe", retryable: false, reason: "The observation was simulated, so it cannot justify changing a real resource." },
  not_repairable: { stage: "diagnose", retryable: false, reason: "The finding is unknown, inaccessible, extra, or has no automatic repair path; a person must decide." },
  not_managed: { stage: "diagnose", retryable: false, reason: "Zenith does not own this resource (referenced or external), so it is reported and never repaired." },
  ownership_mismatch: { stage: "diagnose", retryable: false, reason: "The stored ownership of the resource is not managed, although the graph says it is." },
  no_resource_row: { stage: "diagnose", retryable: true, reason: "The resource has no stored row yet, so a scoped repair cannot be addressed." },
  stateful_missing: { stage: "diagnose", retryable: false, reason: "A stateful resource is missing; recreating it could lose data, so a person must decide." },
  stateful: { stage: "diagnose", retryable: false, reason: "The resource holds state; automatic re-apply is refused." },
  identity: { stage: "diagnose", retryable: false, reason: "Identity and permission resources are never repaired automatically." },
  firewall_opened: { stage: "diagnose", retryable: false, reason: "The firewall now admits more than desired; closing it is a security decision for a person." },
  high_severity: { stage: "diagnose", retryable: false, reason: "High-severity drift is escalated rather than repaired automatically." },
  not_auto_eligible: { stage: "diagnose", retryable: false, reason: "The drift module marked this finding repairable only with a person deciding." },
  awaiting_confirmation: { stage: "diagnose", retryable: true, reason: "The finding has not yet been seen in enough consecutive passes." },
  stability_unconfirmed: { stage: "diagnose", retryable: true, reason: "The drift is not yet a confirmed incident (hysteresis); it must persist before a repair is proposed." },
  repair_not_supported: { stage: "propose", retryable: false, reason: "No registered drift.repair driver handler or declarative repair recipe covers this resource kind and drift; it is reported, not repaired." },
  repair_open: { stage: "propose", retryable: true, reason: "A repair operation for this resource is already open." },
  repair_uncertain: { stage: "propose", retryable: false, reason: "An earlier repair outcome is unknown; settle it against provider evidence before any further mutation." },
  cooldown: { stage: "propose", retryable: true, reason: "A recent repair proposal for this finding is still inside its cooldown." },
  rate_limited: { stage: "propose", retryable: true, reason: "The environment repair proposal budget for this window is used up." },
  stability_blocked: { stage: "propose", retryable: true, reason: "An incident stability limit (cooldown, attempt budget, blast radius or maintenance window) holds this repair." },
  stability_unavailable: { stage: "propose", retryable: true, reason: "The incident stability store could not be consulted, so nothing is proposed (fail closed)." },
};

const EXTRA: Record<Exclude<RepairRefusalCode, RepairSkipReason>, Entry> = {
  broker_error: { stage: "propose", retryable: true, reason: "The capability broker could not evaluate the proposal; nothing was created or changed." },
  start_failed: { stage: "remediate", retryable: false, reason: "The repair was allowed but its workflow could not be started; the operation is claimed and must be inspected, not blindly re-dispatched." },
  policy_denied: { stage: "policy", retryable: false, reason: "Policy denied the repair proposal." },
};

export function refusal(code: RepairRefusalCode, detail?: string): RepairRefusal {
  const entry = code in TABLE ? TABLE[code as RepairSkipReason] : EXTRA[code as keyof typeof EXTRA];
  return { code, ...entry, reason: detail ? `${entry.reason} ${detail}` : entry.reason };
}

/** The refusal behind a decision that did not reach execution, or undefined when it proceeded or awaits a person. */
export function refusalOf(decision: RepairDecision): RepairRefusal | undefined {
  if (decision.status === "skipped" && decision.reason && decision.started !== true)
    return refusal(decision.reason as RepairRefusalCode, decision.reason === "stability_blocked" && decision.error ? `Codes: ${decision.error}.` : undefined);
  if (decision.status === "failed") return refusal(decision.reason === "start_failed" ? "start_failed" : "broker_error");
  if (decision.status === "proposed" && decision.outcome === "deny") return refusal("policy_denied");
  if (decision.status === "proposed" && decision.started === false) return refusal("start_failed");
  return undefined;
}
