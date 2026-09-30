/**
 * What the broker shows the outside world: projections of operations and
 * decisions with nothing internal in them and no secret shape in any string.
 *
 * `OperationRecord` carries lease holders' fence tokens, workflow and runner
 * ids and the raw idempotency key; none of that is an API concern. Every string
 * that originated outside Zenith (an executor's `result` and `error`, the
 * approver-facing `input`) passes through `scrubSecrets` on the way out —
 * defence in depth behind the refusals on the way in.
 */
import type { OperationRecord, PolicyDecisionRecord } from "@/lib/controlplane/types";
import type { CapabilityRisk } from "./catalog";
import { scrubSecrets } from "./secret-guard";
import type { BrokerProposal, DecisionView, OperationView } from "./types";

export function operationView(op: OperationRecord): OperationView {
  const proposal = op.proposal as BrokerProposal;
  return {
    id: op.id,
    workspaceId: op.workspaceId,
    projectId: op.projectId,
    environmentId: op.environmentId,
    resourceId: op.resourceId,
    capability: op.capability,
    status: op.status,
    principal: { kind: op.principal.kind, id: op.principal.id, name: op.principal.name, ...(op.principal.onBehalfOf ? { onBehalfOf: op.principal.onBehalfOf } : {}) },
    proposal: {
      summary: scrubSecrets(proposal.summary),
      details: scrubSecrets(proposal.details),
      risk: proposal.risk,
      scope: proposal.scope,
      input: scrubSecrets(proposal.input),
      planDigest: proposal.planDigest,
      costDeltaUsd: proposal.costDeltaUsd,
      requestedConstraints: proposal.broker?.requestedConstraints,
      requestedDurationSec: proposal.broker?.requestedDurationSec,
    },
    proposalDigest: op.proposalDigest,
    planDigest: op.planDigest,
    policyDecisionId: op.policyDecisionId,
    approvalRequired: op.approvalRequired,
    correlationId: op.correlationId,
    result: op.result === undefined ? undefined : scrubSecrets(op.result),
    error: op.error === undefined ? undefined : scrubSecrets(op.error),
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    startedAt: op.startedAt,
    finishedAt: op.finishedAt,
    expiresAt: op.expiresAt,
  };
}

export function decisionView(
  record: Pick<PolicyDecisionRecord, "outcome" | "reasons" | "approval" | "constraints" | "policyVersion" | "inputDigest" | "evaluatedAt"> & { id?: string },
  extra: { risk: CapabilityRisk; environment?: DecisionView["environment"] }
): DecisionView {
  return {
    outcome: record.outcome,
    reasons: record.reasons,
    ...(record.approval ? { approval: record.approval } : {}),
    ...(record.constraints ? { constraints: record.constraints } : {}),
    policyVersion: record.policyVersion,
    inputDigest: record.inputDigest,
    evaluatedAt: record.evaluatedAt,
    ...(record.id ? { decisionId: record.id } : {}),
    ...(extra.environment ? { environment: extra.environment } : {}),
    risk: extra.risk,
  };
}
