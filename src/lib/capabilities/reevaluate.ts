/**
 * Re-evaluating a stored operation against CURRENT state.
 *
 * An approval is a statement about one proposal under the policy and the world
 * as they were. By the time anything acts on it, the bundle may have changed,
 * the workspace's policy data may have been edited, the environment's autonomy
 * may have been lowered, the requester may have been removed, the target may be
 * gone. This module rebuilds the evaluation request from what the operation
 * recorded (the catalog capability, the resolved scope, the requested
 * constraints and duration, the plan facts and cost that were evaluated) and
 * runs the SAME pipeline `propose` used, against current roles, scopes,
 * autonomy and policy.
 *
 * `gone` means the pipeline answered `not_found` — the requester lost access or
 * a scope id no longer resolves. Callers treat it as a denial.
 */
import type { OperationRecord } from "@/lib/controlplane/types";
import { capability as catalogEntry } from "./catalog";
import { evaluate, raiseRisk, type Evaluation, type EvaluationRequest } from "./evaluate";
import { isBrokerError } from "./errors";
import type { BrokerDeps } from "./ports";
import type { BrokerProposal } from "./types";

export function requestFromOperation(op: OperationRecord): EvaluationRequest {
  const proposal = op.proposal as BrokerProposal;
  const def = catalogEntry(op.capability);
  return {
    def,
    scope: proposal.scope,
    principal: op.principal,
    risk: raiseRisk(def.risk, proposal.broker?.risk),
    requestedDurationSec: proposal.broker?.requestedDurationSec,
    constraints: proposal.broker?.requestedConstraints,
    plan: proposal.broker?.plan,
    planDigest: proposal.planDigest,
    origin: proposal.broker?.via === "reconciler" && op.principal.kind === "system" ? "reconciler" : undefined,
  };
}

export type Reevaluation = { gone: false; evaluation: Evaluation } | { gone: true };

export async function reevaluate(deps: BrokerDeps, op: OperationRecord): Promise<Reevaluation> {
  try {
    return { gone: false, evaluation: await evaluate(deps, requestFromOperation(op)) };
  } catch (error) {
    if (isBrokerError(error) && error.code === "not_found") return { gone: true };
    throw error;
  }
}
