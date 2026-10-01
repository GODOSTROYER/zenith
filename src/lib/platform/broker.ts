/**
 * Worker adapter over the capability broker's SAME evaluation/signing pipeline.
 * Read grants may only attenuate to plan/observe. Mutation grants require a
 * running operation, current authorization, live fence and digest-bound human
 * approvals. Proposal approvals authorize planning; only a later approval round
 * can authorize its concrete, write-once plan. Proposals remain immutable.
 */
import { randomUUID } from "node:crypto";
import { platformBroker, type Broker } from "@/lib/capabilities/platform";
import { capability, isCapability } from "@/lib/capabilities/catalog";
import { evaluate } from "@/lib/capabilities/evaluate";
import { requestFromOperation } from "@/lib/capabilities/reevaluate";
import { ROLE_RANK } from "@/lib/capabilities/ports";
import { repos } from "@/lib/controlplane/db";
import { approvalRoundOf, operationPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import type { ApprovalRequirement, CapabilityGrantClaims, OperationRecord, Sql } from "@/lib/controlplane/types";
import { createOperationsPort, workerStoreScope, StepFailedError, type BrokerPort, type PlanPolicyInput } from "@/lib/execution";
import { readPlanEvidence } from "@/lib/execution/plan-evidence";

type BrokerFactory = () => Promise<Broker>;

export function createExecutionBroker(db: Sql, getBroker: BrokerFactory = platformBroker): BrokerPort {
  const ops = createOperationsPort(db);
  const load = async (id: string): Promise<OperationRecord> => {
    const op = await ops.get(id);
    if (!op) throw new StepFailedError("Operation not found.");
    return op;
  };
  const latestFacts = async (op: OperationRecord): Promise<PlanPolicyInput | undefined> => {
    if (!op.planDigest) return undefined;
    const reviewed = await repos.operations.get(db, op.workspaceId, op.id);
    const review = reviewed ? operationPlanReview(reviewed) : undefined;
    const parsed = review ? readPlanEvidence({ ...review }) : undefined;
    if (!parsed) throw new StepFailedError("The operation's plan has no authoritative evidence.");
    return { ...parsed.facts, ...(parsed.cost.deltaUsdMonthly !== undefined ? { costDeltaUsdMonthly: parsed.cost.deltaUsdMonthly } : {}), ...(parsed.cost.projectedMonthlyUsd !== undefined ? { projectedMonthlyUsd: parsed.cost.projectedMonthlyUsd } : {}) };
  };
  const decisionFor = async (broker: Broker, op: OperationRecord, facts?: PlanPolicyInput, cap = op.capability) => {
    const req = requestFromOperation(op);
    return evaluate(broker.deps, { ...req, def: capability(cap), risk: cap === op.capability ? req.risk : capability(cap).risk, ...(facts ? { plan: facts, planDigest: op.planDigest } : {}) });
  };
  const approvals = async (broker: Broker, op: OperationRecord, requirement?: ApprovalRequirement) => {
    const all = await broker.deps.store.listApprovals(op.workspaceId, op.id);
    const time = broker.deps.clock.now().getTime();
    const round = approvalRoundOf(op);
    const live = all.filter((a) => approvalRoundOf(a) === round && a.proposalDigest === op.proposalDigest && Date.parse(a.expiresAt) > time);
    const rejected = live.some((a) => a.decision === "reject") || ["rejected", "cancelled", "denied"].includes(op.status);
    if (!requirement) return { approved: !rejected, rejected };
    // Round zero cannot authorize the subsequently gated concrete plan.
    if (op.planDigest && round === 0) return { approved: false, rejected };
    const users = new Set<string>();
    let approvalId: string | undefined;
    for (const a of live) {
      if (a.decision !== "approve" || a.approver.kind !== "user") continue;
      if (a.consumedAt && op.status !== "running") continue;
      if (requirement.separationOfDuties && a.approver.id === (op.principal.onBehalfOf ?? op.principal.id)) continue;
      const access = await broker.deps.roles.resolve(a.approver, op.workspaceId);
      if (ROLE_RANK[access.role] < ROLE_RANK[requirement.minRole]) continue;
      users.add(a.approver.id); approvalId = a.id;
    }
    return { approved: !rejected && users.size >= requirement.count, rejected, approvalId };
  };
  return {
    reevaluate: (id, facts) => workerStoreScope(async () => {
      const op = await load(id);
      const broker = await getBroker();
      const evaluation = await decisionFor(broker, op, facts);
      const decision = evaluation.decision;
      const recorded = await broker.deps.store.recordPolicyDecision({ workspaceId: op.workspaceId, operationId: op.id, policyVersion: evaluation.evaluated.policyVersion, inputDigest: evaluation.evaluated.inputDigest, ...decision });
      return { outcome: decision.outcome, decisionId: recorded.id, reasons: decision.reasons.map((r) => r.code) };
    }),
    approvalStatus: (id) => workerStoreScope(async () => {
      const op = await load(id);
      const broker = await getBroker();
      const facts = await latestFacts(op);
      const { decision } = await decisionFor(broker, op, facts);
      if (decision.outcome === "deny") return { approved: false, rejected: true };
      if (decision.outcome === "require_approval" && !decision.approval) throw new StepFailedError("Current policy did not specify an approval requirement.");
      return approvals(broker, op, decision.approval);
    }),
    issueGrant: (id, audience, fence, opts) => workerStoreScope(async () => {
      const op = await load(id);
      if (op.status !== "running") throw new StepFailedError("Only a running operation can receive an activity grant.");
      const cap = opts?.capability ?? op.capability;
      if (!isCapability(cap) || (cap !== op.capability && !["infrastructure.plan", "infrastructure.observe"].includes(cap))) throw new StepFailedError("Requested grant does not attenuate this operation.");
      if (cap !== op.capability && (!op.environmentId || !capability(op.capability).mutates)) throw new StepFailedError("This operation cannot issue an environment read grant.");
      const broker = await getBroker();
      const facts = cap === op.capability ? await latestFacts(op) : undefined;
      const { decision } = await decisionFor(broker, op, facts, cap);
      if (decision.outcome === "deny") throw new StepFailedError("Current policy denies this activity grant.");
      if (decision.outcome === "require_approval") {
        if (!decision.approval || !(await approvals(broker, op, decision.approval)).approved) throw new StepFailedError("Current policy requires human approval of this exact proposal and plan in the current round.");
      }
      if (capability(cap).mutates && !fence) throw new StepFailedError("Mutating activity grants require an environment fence.");
      if (fence) {
        if (fence.scope !== `env:${op.environmentId}`) throw new StepFailedError("Grant fence does not protect this environment.");
        await repos.leases.assertFence(db, fence.scope, fence.fenceToken);
      }
      const iat = Math.floor(broker.deps.clock.now().getTime() / 1000);
      const requested = opts?.durationSec ?? 900;
      const policySec = typeof decision.constraints?.grantDurationSec === "number" ? decision.constraints.grantDurationSec : 900;
      if (!Number.isInteger(requested) || requested < 1 || !Number.isFinite(policySec) || policySec < 1) throw new StepFailedError("Grant duration is invalid.");
      const exp = Math.min(iat + Math.max(1, Math.min(3600, requested, policySec)), Math.floor(Date.parse(op.expiresAt) / 1000));
      if (exp <= iat) throw new StepFailedError("Operation expired before grant issuance.");
      const claims: CapabilityGrantClaims = { jti: randomUUID(), iss: broker.deps.issuer ?? "zenith-control", aud: audience, sub: op.principal.onBehalfOf ?? op.principal.id, iat, exp, cap, op: op.id, digest: op.proposalDigest, ws: op.workspaceId, proj: op.projectId, env: op.environmentId, res: op.resourceId, fence: fence?.fenceToken, constraints: decision.constraints };
      await broker.deps.signer.ready();
      const jws = await broker.deps.signer.sign(claims);
      await broker.deps.store.insertGrant({ jti: claims.jti, workspaceId: op.workspaceId, operationId: op.id, capability: cap, audience, issuedAt: new Date(iat * 1000).toISOString(), expiresAt: new Date(exp * 1000).toISOString() });
      // The signed bearer remains local; it never enters evidence or workflow history.
      return { jws, claims };
    }),
  };
}
