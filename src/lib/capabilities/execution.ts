/**
 * Execution: the gate between "approved" and "a grant exists".
 *
 * `beginExecution` is called by the execution side (a Temporal activity, a
 * runner dispatcher) — never by a model and never over REST. It does, in order:
 *
 *  1. Re-load the operation (workspace-scoped: a wrong workspace is `not_found`).
 *  2. Require `approved`/`queued`, and not expired.
 *  3. Optionally compare a REGENERATED plan with the one that was approved
 *     (`plan_changed`): the executor's job is to re-plan right before apply,
 *     and the broker refuses to let a different plan ride on an old approval.
 *  4. Re-evaluate policy with the CURRENT bundle and current facts (roles,
 *     scope, autonomy, workspace policy data). Deny → the operation is ended
 *     (`denied`, tied to a persisted denial) and nothing is issued.
 *  5. If the current decision requires approval, the UNCONSUMED, UNEXPIRED
 *     approvals for this digest must satisfy the CURRENT requirement — count of
 *     distinct approvers, each still holding at least `minRole`, and separation
 *     of duties — else `approval_required` (none exist: the proposal was
 *     approved only because policy said allow) or `reapproval_required`
 *     (they exist but policy changed under them). A bundle change alone does
 *     not invalidate an approval the new requirement still covers.
 *  6. Check the signer can sign BEFORE anything is consumed.
 *  7. `claimForExecution`: atomically verify the digest, consume the approvals
 *     (each exactly once) and move to `running`. Of N concurrent callers exactly
 *     one succeeds; the rest get `already_claimed`.
 *  8. Issue the capability grant: audience, subject, capability, operation,
 *     digest, scope, fence token (when a lease was given), the decision's
 *     constraints, lifetime = min(policy `grantDurationSec` or 900 s, 900 s,
 *     the operation's own expiry). Record it (single-use) and return the compact
 *     JWS with its claims.
 *
 * `completeExecution` ends a running operation with a conditional transition
 * (running → succeeded | failed | uncertain), scrubs what the executor reports,
 * and revokes any grant still live. `uncertain` is terminal for automation.
 */
import { digest } from "@/lib/controlplane/digest";
import { approvalRoundOf } from "@/lib/controlplane/db/repos/operation-review";
import type { ApprovalRecord, CapabilityGrantClaims, OperationRecord, PolicyDecisionRecord } from "@/lib/controlplane/types";
import type { NormalizedPlan } from "@/lib/tofu/types";
import { BrokerError, isBrokerError, notFound } from "./errors";
import { buildPlanFacts, evaluate } from "./evaluate";
import { capability } from "./catalog";
import { newId, requesterOf } from "./internal";
import { ROLE_RANK, type BrokerDeps } from "./ports";
import { reevaluate, requestFromOperation } from "./reevaluate";
import { scrubSecrets } from "./secret-guard";
import type { BrokerProposal, OperationView } from "./types";
import { operationView } from "./views";

/** Default and ceiling of an execution grant's lifetime. The grant is verified when execution starts; work then runs under the environment lease. */
export const EXECUTION_GRANT_DEFAULT_SEC = 900;
export const EXECUTION_GRANT_MAX_SEC = 900;
const MAX_RESULT_JSON = 64 * 1024;

export interface BeginExecutionInput {
  workspaceId: string;
  operationId: string;
  /** who will execute: recorded as the execution lease holder */
  holder: string;
  /** who may present the grant: `worker`, `runner:<id>`, `machine:<id>` */
  audience: string;
  /** the environment lease this execution runs under; its fence token is carried in the grant */
  lease?: { scope: string; fenceToken: number };
  /** the plan the executor regenerated right before apply; compared with the approved one */
  plan?: NormalizedPlan;
  /** execution heartbeat window (default 60 s) */
  leaseMs?: number;
}

export interface BeginExecutionResult {
  /** compact EdDSA JWS — a bearer credential for the executing surface; never log it */
  grant: string;
  claims: CapabilityGrantClaims;
  operation: OperationView;
}

const codes = (reasons: { code: string }[]): string[] => reasons.slice(0, 20).map((r) => r.code);

const eventBase = (op: OperationRecord) => ({
  workspaceId: op.workspaceId,
  projectId: op.projectId,
  environmentId: op.environmentId,
  resourceId: op.resourceId,
  operationId: op.id,
  correlationId: op.correlationId,
});

async function tryAppend(deps: BrokerDeps, event: Parameters<BrokerDeps["store"]["appendEvent"]>[0]): Promise<void> {
  try {
    await deps.store.appendEvent(event);
  } catch {
    // An audit append that fails AFTER the ledger moved must not strand the
    // operation or hide the answer; the operation/grant rows are authoritative.
  }
}

/** Facts without the cost numbers, for comparing a regenerated plan with the approved one. */
function structuralFacts(facts: object | undefined): string {
  if (!facts) return "none";
  const { costDeltaUsdMonthly: _d, projectedMonthlyUsd: _p, ...rest } = facts as Record<string, unknown>;
  return digest(rest);
}

/** The approvals that still cover `op` under the CURRENT requirement, or why they do not. */
async function checkApprovals(
  deps: BrokerDeps,
  op: OperationRecord,
  requirement: { count: number; minRole: "editor" | "admin"; separationOfDuties: boolean }
): Promise<void> {
  if (!op.approvalRequired) {
    throw new BrokerError(
      "approval_required",
      "Policy now requires an approval for this change, but it was approved only because policy allowed it unattended.",
      "Propose it again; it will wait for a person this time."
    );
  }
  const now = deps.clock.now().getTime();
  const all: ApprovalRecord[] = await deps.store.listApprovals(op.workspaceId, op.id);
  const live = all.filter((a) => approvalRoundOf(a) === approvalRoundOf(op) && a.approver.kind === "user" && a.decision === "approve" && a.proposalDigest === op.proposalDigest && !a.consumedAt && Date.parse(a.expiresAt) > now);
  if (live.length === 0) {
    throw new BrokerError("approval_required", "No unconsumed, unexpired approval covers this operation.", "Have an editor or admin approve the exact proposal.");
  }
  const requester = requesterOf(op.principal);
  const qualifying = new Set<string>();
  for (const approval of live) {
    if (requirement.separationOfDuties && approval.approver.id === requester) continue;
    const access = await deps.roles.resolve(approval.approver, op.workspaceId);
    if (ROLE_RANK[access.role] < ROLE_RANK[requirement.minRole]) continue;
    qualifying.add(approval.approver.id);
  }
  if (qualifying.size < requirement.count) {
    throw new BrokerError(
      "reapproval_required",
      "The approvals on this operation no longer satisfy the current policy requirement (policy, roles or autonomy changed after they were given).",
      "Propose again so the current requirement can be approved.",
      { need: requirement, have: qualifying.size }
    );
  }
}

export async function beginExecution(deps: BrokerDeps, input: BeginExecutionInput): Promise<BeginExecutionResult> {
  const { workspaceId, operationId } = input;
  if (!input.holder || !input.audience) throw new BrokerError("invalid_request", "holder and audience are required.");

  const op = await deps.store.getOperation(workspaceId, operationId);
  if (!op) throw notFound();
  if (op.status === "running") throw new BrokerError("already_claimed", "This operation is already being executed.", undefined, { status: op.status });
  if (op.status !== "approved" && op.status !== "queued") {
    throw new BrokerError("invalid_state", `This operation is ${op.status}; only an approved operation can begin execution.`, undefined, { status: op.status });
  }
  if (Date.parse(op.expiresAt) <= deps.clock.now().getTime()) {
    await deps.store.expireOperation({ workspaceId, id: op.id });
    throw new BrokerError("operation_expired", "The operation expired before it could be executed.", "Propose it again.");
  }
  const proposal = op.proposal as BrokerProposal;

  if (input.plan) {
    const fresh = buildPlanFacts(input.plan);
    if ((proposal.planDigest && input.plan.planDigest !== proposal.planDigest) || structuralFacts(fresh) !== structuralFacts(proposal.broker?.plan)) {
      throw new BrokerError("plan_changed", "The plan regenerated for execution differs from the plan that was reviewed.", "Propose the new plan and have it approved.", {
        approvedPlanDigest: proposal.planDigest ?? null,
      });
    }
  }

  // Current policy, current facts. A denial here ends the operation.
  const re = await reevaluate(deps, op);
  if (re.gone || re.evaluation.decision.outcome === "deny") {
    const reasons = re.gone
      ? [{ code: "access_or_scope_gone", message: "The requester no longer has access, or the target no longer exists." }]
      : re.evaluation.decision.reasons;
    const denial = await deps.store.recordPolicyDecision({
        workspaceId,
        operationId: op.id,
        policyVersion: re.gone ? "broker:access_or_scope_gone" : re.evaluation.evaluated.policyVersion,
        inputDigest: re.gone ? digest({ operationId: op.id, proposalDigest: op.proposalDigest, reasons }) : re.evaluation.evaluated.inputDigest,
        outcome: "deny",
        reasons,
      });
    const ended = await deps.store.denyOperation({ workspaceId, id: op.id, decisionId: denial.id });
    if (!ended) throw new BrokerError("invalid_state", "The operation changed before its execution denial could be recorded.");
    const base = eventBase(op);
    await tryAppend(deps, { ...base, type: "policy.evaluated", data: { kind: "execution_refused", outcome: "deny", reasons: codes(reasons) } });
    throw new BrokerError("policy_denied", "Current policy denies this operation; it was not executed.", "Review the reasons and propose again if the change is still wanted.", { reasons: codes(reasons) });
  }

  const { evaluation } = re;
  const decision = evaluation.decision;
  if (decision.outcome === "require_approval") {
    if (!decision.approval) throw new BrokerError("policy_unavailable", "Policy returned a require_approval decision without a requirement.");
    try {
      await checkApprovals(deps, op, decision.approval);
    } catch (error) {
      if (isBrokerError(error) && (error.code === "approval_required" || error.code === "reapproval_required")) {
        // A concurrent executor may have claimed the operation (and so consumed its approvals) since we read it:
        // that is "already claimed", not a missing approval.
        const fresh = await deps.store.getOperation(workspaceId, op.id);
        if (fresh && fresh.status !== "approved" && fresh.status !== "queued") {
          throw new BrokerError("already_claimed", "Another executor claimed this operation first.", undefined, { status: fresh.status });
        }
      }
      if (isBrokerError(error)) {
        await tryAppend(deps, { ...eventBase(op), type: "policy.evaluated", data: { kind: "execution_refused", outcome: "require_approval", code: error.code, policyVersion: evaluation.evaluated.policyVersion } });
      }
      throw error;
    }
  }

  // Claiming a repair or destroy starts read-only planning, including after a
  // browser approval wakes its workflow. It never mints early write authority.
  // Repair writes need the worker's binding/digest/current-round gate; destroy
  // writes also need the private authenticated held original-plan attempt.
  let grantCapability = op.capability;
  let grantDecision = decision;
  if (op.capability === "drift.repair" || op.capability === "infrastructure.destroy") {
    const planning = capability("infrastructure.plan");
    const read = await evaluate(deps, { ...requestFromOperation(op), def: planning, risk: planning.risk, plan: undefined, planDigest: undefined });
    if (read.decision.outcome !== "allow") throw new BrokerError("policy_denied", op.capability === "drift.repair"
      ? "Current policy does not allow this repair's read-only planning claim; no grant was issued."
      : "Current policy does not allow this destroy's read-only planning claim; no grant was issued.");
    grantCapability = planning.name;
    grantDecision = read.decision;
  }

  // Refuse before consuming anything if a grant cannot be signed.
  await deps.signer.ready();

  let claimed: OperationRecord;
  try {
    claimed = await deps.store.claimForExecution({
      workspaceId,
      id: op.id,
      expectedDigest: op.proposalDigest,
      holder: input.holder,
      leaseMs: input.leaseMs,
      lease: input.lease,
    });
  } catch (error) {
    if (isBrokerError(error) && error.code === "invalid_state") {
      throw new BrokerError("already_claimed", "Another executor claimed this operation first.", undefined, error.details);
    }
    throw error;
  }

  // The operation is `running` and its approvals are consumed from here on.
  const stored: PolicyDecisionRecord | null = op.policyDecisionId ? await deps.store.getPolicyDecision(workspaceId, op.policyDecisionId) : null;
  const changed =
    !stored ||
    stored.policyVersion !== evaluation.evaluated.policyVersion ||
    digest({ o: stored.outcome, a: stored.approval ?? null, c: stored.constraints ?? null }) !== digest({ o: decision.outcome, a: decision.approval ?? null, c: decision.constraints ?? null });
  if (changed) {
    try {
      await deps.store.recordPolicyDecision({
        workspaceId,
        operationId: op.id,
        policyVersion: evaluation.evaluated.policyVersion,
        inputDigest: evaluation.evaluated.inputDigest,
        outcome: decision.outcome,
        reasons: decision.reasons,
        ...(decision.approval ? { approval: decision.approval } : {}),
        ...(decision.constraints ? { constraints: decision.constraints } : {}),
      });
    } catch {
      // The re-evaluation row is audit evidence; the claim already happened and the grant below is what matters.
    }
  }

  const now = deps.clock.now();
  const iat = Math.floor(now.getTime() / 1000);
  const policySec = Math.min(
    typeof decision.constraints?.grantDurationSec === "number" ? decision.constraints.grantDurationSec : EXECUTION_GRANT_DEFAULT_SEC,
    typeof grantDecision.constraints?.grantDurationSec === "number" ? grantDecision.constraints.grantDurationSec : EXECUTION_GRANT_DEFAULT_SEC);
  const lifetime = Math.max(1, Math.min(policySec, EXECUTION_GRANT_MAX_SEC));
  const exp = Math.min(iat + lifetime, Math.floor(Date.parse(claimed.expiresAt) / 1000));
  const jti = newId(deps, "grt");
  const claims: CapabilityGrantClaims = {
    jti,
    iss: deps.issuer ?? "zenith-control",
    aud: input.audience,
    sub: requesterOf(claimed.principal),
    iat,
    exp,
    cap: grantCapability,
    op: claimed.id,
    digest: claimed.proposalDigest,
    ws: claimed.workspaceId,
    ...(claimed.projectId ? { proj: claimed.projectId } : {}),
    ...(claimed.environmentId ? { env: claimed.environmentId } : {}),
    ...(claimed.resourceId ? { res: claimed.resourceId } : {}),
    ...(input.lease ? { fence: input.lease.fenceToken } : {}),
    ...(grantDecision.constraints ? { constraints: grantDecision.constraints } : {}),
  };

  try {
    if (exp <= iat) throw new BrokerError("grant_issue_failed", "The operation has no time left to execute.");
    const grant = await deps.signer.sign(claims);
    await deps.store.insertGrant({
      jti,
      workspaceId: claims.ws,
      operationId: claims.op,
      capability: claims.cap,
      audience: claims.aud,
      issuedAt: new Date(iat * 1000).toISOString(),
      expiresAt: new Date(exp * 1000).toISOString(),
    });
    // The store appended operation.started with the claim; this records what was handed out.
    await tryAppend(deps, {
      ...eventBase(claimed),
      type: "policy.evaluated",
      actor: claimed.principal,
      data: { kind: "grant_issued", grantId: jti, audience: input.audience, expiresAt: new Date(exp * 1000).toISOString(), policyVersion: evaluation.evaluated.policyVersion, fence: input.lease?.fenceToken ?? null },
    });
    return { grant, claims, operation: operationView(claimed) };
  } catch (error) {
    // Nothing has run: no executor ever received a grant. Say so truthfully.
    await deps.store
      .completeOperation({ workspaceId, id: op.id, outcome: "failed", error: "Grant issuance failed before any execution began; nothing was executed." })
      .catch(() => null);
    await deps.store.revokeGrantsForOperation(workspaceId, op.id).catch(() => 0);
    if (isBrokerError(error)) throw new BrokerError("grant_issue_failed", error.message, "Propose again once the signing key is available.");
    throw new BrokerError("grant_issue_failed", "The capability grant could not be issued.", "Propose again once the signing key is available.");
  }
}

/* -------------------------------- completion -------------------------------- */

export interface CompleteExecutionInput {
  workspaceId: string;
  operationId: string;
  outcome: "succeeded" | "failed" | "uncertain";
  /** redacted, bounded summary from the executor; scrubbed again here */
  result?: unknown;
  error?: string;
  /** the fence the execution ran under; a stale fence changes nothing */
  fence?: { scope: string; fenceToken: number };
}

function boundedResult(result: unknown): unknown {
  if (result === undefined) return undefined;
  const scrubbed = scrubSecrets(result);
  let text: string | undefined;
  try {
    text = JSON.stringify(scrubbed);
  } catch {
    text = undefined;
  }
  if (text === undefined) return { unserializable: true };
  if (text.length > MAX_RESULT_JSON) return { truncated: true, bytes: text.length, digest: digest(scrubbed) };
  return scrubbed;
}

/** End a running operation. Idempotent for a repeated identical outcome; any other terminal state is `invalid_state`. */
export async function completeExecution(deps: BrokerDeps, input: CompleteExecutionInput): Promise<OperationView> {
  const { workspaceId, operationId, outcome } = input;
  if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "uncertain") throw new BrokerError("invalid_request", "outcome must be succeeded, failed or uncertain.");
  const op = await deps.store.getOperation(workspaceId, operationId);
  if (!op) throw notFound();
  if (op.status === outcome) return operationView(op);

  const error = input.error === undefined ? undefined : String(scrubSecrets(input.error)).slice(0, 4000);
  const moved = await deps.store.completeOperation({
    workspaceId,
    id: operationId,
    outcome,
    result: boundedResult(input.result),
    error,
    fence: input.fence,
    actor: op.principal,
  });
  if (!moved) {
    throw new BrokerError("invalid_state", `This operation is ${op.status}; only a running operation can be completed.`, undefined, { status: op.status });
  }
  // The store appended operation.succeeded / failed / uncertain with the change.
  await deps.store.revokeGrantsForOperation(workspaceId, operationId);
  return operationView(moved);
}

/** The executor cannot prove whether the side effect happened (crash, lost lease, timeout). Terminal for automation. */
export function markUncertain(deps: BrokerDeps, input: { workspaceId: string; operationId: string; reason: string; fence?: { scope: string; fenceToken: number } }): Promise<OperationView> {
  return completeExecution(deps, { workspaceId: input.workspaceId, operationId: input.operationId, outcome: "uncertain", error: input.reason, fence: input.fence });
}
