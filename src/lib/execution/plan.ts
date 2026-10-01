/**
 * The planning side of the deploy journey:
 *
 *   validateDesiredState → planInfrastructure → evaluatePolicy → checkApproval → finalPlan
 *
 * `validateDesiredState` reports PROBLEMS (unexecutable graph) and the workflow
 * fails fast on any; it persists the desired nodes only when there are none, so
 * an invalid revision never overwrites what the store believes is desired.
 *
 * `planInfrastructure` compiles every managed node through its driver,
 * assembles the pinned workspace, and — inside a brokered `observe` session —
 * runs `tofu plan`. It persists EVIDENCE (digests, counts, policy facts, cost,
 * bounded model-safe plan view; never the plan file or a value) and records the
 * plan digest on the operation. The binary plan file stays in `planDir`.
 *
 * `evaluatePolicy` never takes facts from its caller: the facts were extracted
 * from our own normalized plan (`extractPlanFacts`) by `planInfrastructure` and
 * sit in the evidence row it wrote; a plan digest with no such row is refused.
 *
 * `finalPlan` re-plans immediately before apply and compares with the approved
 * digest: a moved digest is `TofuPlanChangedError` (non-retryable `plan_changed`,
 * nothing applied, re-approval required). The re-plan's evidence is kept either
 * way so an operator can see what moved.
 */
import { rm } from "node:fs/promises";
import type { PlanFacts } from "@/lib/policy/types";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import type { ExecutionActivities } from "@/lib/workflows/types";
import { mapLimit } from "./concurrency";
import { loadExecContext, loadOperation, resolveConnection, type ExecContext } from "./context";
import { assertLeaseFor, costOf, requireExecutable, tofuSession } from "./desired";
import { buildWorkspace } from "./compile";
import { errorCode, StepFailedError, TofuPlanChangedError } from "./errors";
import { buildDesiredState, findGraphProblems } from "./graph";
import { withKeepAlive } from "./keepalive";
import { planEvidence, readPlanEvidence, toPlanSummary, type PlanCost } from "./plan-evidence";
import type { Runtime } from "./runtime";
import { environmentIdProblem, LONG_SESSION_SEC, PLAN_CAPABILITY, withProviderSession } from "./session";
import { safeList, safeText } from "./text";
import type { NormalizedPlan } from "@/lib/tofu/types";

type PlanActivities = Pick<ExecutionActivities, "validateDesiredState" | "planInfrastructure" | "evaluatePolicy" | "checkApproval" | "finalPlan">;

interface PlanStage {
  plan: NormalizedPlan;
  planFilePath?: string;
  facts: PlanFacts;
  cost: PlanCost;
  graphDigest: string;
}

/** Plan or re-plan under the operation's lease and return the normalized plan with what was derived from it. */
async function runPlanStage(rt: Runtime, ec: ExecContext, lease: Parameters<ExecutionActivities["planInfrastructure"]>[0]["lease"], detail: string): Promise<PlanStage> {
  assertLeaseFor(ec, lease);
  const { graph } = requireExecutable(rt, ec);
  const connection = await resolveConnection(rt, ec);
  const { ws } = buildWorkspace({ ec, graph, connection, drivers: rt.drivers, overrides: rt.d.tofuWorkspace });

  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  const result = await withKeepAlive(rt, { lease, detail, operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
    withProviderSession(rt, ec, { purpose: "observe", capability: PLAN_CAPABILITY, fence: lease, connection, durationSec: LONG_SESSION_SEC }, (session) =>
      // lock: false — the read-only observe role cannot write the S3 state-lock object; the fenced env lease
      // (held, renewed and asserted around this call) is what serialises work on the environment. Apply always locks.
      rt.tofu.planWorkspace(ws, tofuSession(session), { signal, planDir: rt.d.planDir, lock: false, normalize: { fingerprintKey: rt.d.fingerprintKey } })
    )
  );
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);

  // Facts come from the plan we just produced, here, and nowhere else.
  const facts = extractPlanFacts(result.plan);
  const cost = await costOf(rt, ec, graph);
  return { plan: result.plan, planFilePath: result.planFilePath, facts, cost, graphDigest: graph.graphDigest };
}

export function createPlanActivities(rt: Runtime): PlanActivities {
  return {
    async validateDesiredState({ operationId }) {
      const ec = await loadExecContext(rt, operationId);
      const desired = buildDesiredState(ec.product);
      if (!desired.graph) return { graphDigest: "", nodes: 0, problems: desired.problems };

      const { graph } = desired;
      const problems = findGraphProblems(graph, ec.product.environment.provider, rt.drivers);
      const idProblem = environmentIdProblem(ec.environmentId);
      if (idProblem) problems.unshift(idProblem);
      if (problems.length === 0) {
        // Persist the desired nodes (idempotent upserts). An ownership change is a conflict the
        // store refuses; it becomes a problem the person can act on, not a crash.
        const results = await mapLimit(graph.nodes, rt.limits.concurrency, async (node): Promise<string | undefined> => {
          try {
            await rt.d.resources.upsertDesired({ workspaceId: ec.workspaceId, projectId: ec.product.project.id, environmentId: ec.environmentId, node, revisionId: ec.product.revision?.id });
            return undefined;
          } catch (err) {
            if (errorCode(err) === "conflict") return safeText(`${node.address}: ${err instanceof Error ? err.message : "the stored resource conflicts with the desired one"}`, 300);
            throw err;
          }
        });
        for (const r of results) if (r) problems.push(r);
      }
      return { graphDigest: graph.graphDigest, nodes: graph.nodes.length, problems: problems.slice(0, 50) };
    },

    async planInfrastructure({ operationId, lease }) {
      const ec = await loadExecContext(rt, operationId);
      const stage = await runPlanStage(rt, ec, lease, "tofu plan");
      const evidence = planEvidence({ plan: stage.plan, facts: stage.facts, cost: stage.cost, graphDigest: stage.graphDigest, stage: "plan" });
      await rt.evidence(ec.scope, { kind: "tofu_plan", digest: evidence.digest, summary: evidence.summary, simulated: false, key: evidence.key }, { critical: false });
      await rt.d.ops.setPlanDigest({ workspaceId: ec.workspaceId, operationId: ec.op.id, planDigest: stage.plan.planDigest });
      await rt.emit(ec.scope, "resource.planned", `plan:${stage.plan.planDigest}`, {
        planDigest: stage.plan.planDigest,
        create: stage.plan.summary.create,
        update: stage.plan.summary.update,
        delete: stage.plan.summary.delete,
        replace: stage.plan.summary.replace,
        empty: stage.plan.empty,
      });
      return toPlanSummary(stage.plan, stage.facts, stage.cost);
    },

    async evaluatePolicy({ operationId, planDigest }) {
      const op = await loadOperation(rt, operationId);
      let decision;
      if (planDigest === undefined) {
        decision = await rt.d.broker.reevaluate(op.id);
      } else {
        const row = await rt.d.evidence.find({ workspaceId: op.workspaceId, operationId: op.id, kind: "tofu_plan", digest: planDigest });
        const derived = row ? readPlanEvidence(row.summary) : undefined;
        if (!row || !derived) {
          throw new StepFailedError(`No plan evidence was recorded for plan ${planDigest.slice(0, 12)} of this operation; plan again before evaluating policy.`);
        }
        decision = await rt.d.broker.reevaluate(op.id, {
          ...derived.facts,
          ...(derived.cost.deltaUsdMonthly !== undefined ? { costDeltaUsdMonthly: derived.cost.deltaUsdMonthly } : {}),
          ...(derived.cost.projectedMonthlyUsd !== undefined ? { projectedMonthlyUsd: derived.cost.projectedMonthlyUsd } : {}),
        });
      }
      await rt.d.ops.setPolicyDecision({ workspaceId: op.workspaceId, operationId: op.id, decisionId: decision.decisionId });
      return { outcome: decision.outcome, decisionId: decision.decisionId, reasons: safeList(decision.reasons, 20) };
    },

    async checkApproval({ operationId }) {
      const status = await rt.d.broker.approvalStatus(operationId);
      return { approved: status.approved === true, rejected: status.rejected === true, ...(status.approvalId ? { approvalId: safeText(status.approvalId, 100) } : {}) };
    },

    async finalPlan({ operationId, approvedPlanDigest, lease }) {
      const ec = await loadExecContext(rt, operationId);
      const stage = await runPlanStage(rt, ec, lease, "tofu plan (final)");
      const evidence = planEvidence({ plan: stage.plan, facts: stage.facts, cost: stage.cost, graphDigest: stage.graphDigest, stage: "final_plan", approvedDigest: approvedPlanDigest });
      await rt.evidence(ec.scope, { kind: "tofu_plan", digest: evidence.digest, summary: evidence.summary, simulated: false, key: evidence.key }, { critical: false });
      if (stage.plan.planDigest !== approvedPlanDigest) {
        // The plan that just moved was never approved: do not leave its file around.
        if (stage.planFilePath) await rm(stage.planFilePath, { force: true }).catch(() => undefined);
        throw new TofuPlanChangedError(approvedPlanDigest, stage.plan.planDigest);
      }
      return toPlanSummary(stage.plan, stage.facts, stage.cost);
    },
  };
}
