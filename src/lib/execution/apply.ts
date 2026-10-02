/**
 * applyInfrastructure — the one step that changes declarative infrastructure.
 *
 * Sequence (ADR-0005, ADR-0007):
 *   1. the lease is this operation's, and its fence is live (`assertFence`)
 *   2. inside a brokered DEPLOY session, `applyVerifiedPlan(ws, { approvedDigest })`:
 *      the engine re-plans, refuses with `TofuPlanChangedError` if the digest
 *      moved, and applies exactly the plan file it just verified
 *   3. while tofu runs, a keep-alive ticker heartbeats and renews the lease; a
 *      lost lease aborts tofu and the activity ends with `LeaseLostError`
 *   4. the fence is asserted again after the call (before and after)
 *   5. evidence `tofu_apply` — counts, digests, output NAMES; never a value
 *
 * How a failure is reported (the workflow's classification depends on it):
 *   - before tofu started (grant or credential refused, workspace refused):
 *     `StepFailedError`, "the apply did not start; nothing was changed";
 *   - `TofuPlanChangedError`: rethrown untouched (nothing was applied);
 *   - tofu ran `apply` and exited non-zero: `StepFailedError` whose message says
 *     "partial apply; reconcile will observe the environment" — the apply began,
 *     so the environment may be half-changed, and the operator is told so;
 *   - tofu timed out, was aborted or overflowed: a PLAIN error with the same
 *     warning — the outcome is unknown, which the workflow finalizes `uncertain`
 *     (and the operation is marked uncertain here too, best effort);
 *   - lease lost: `LeaseLostError`.
 * Nothing is rolled back and nothing is destroyed on failure: reconcile observes.
 *
 * The plan file written by planning is deleted at the end (success or failure).
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { digest } from "@/lib/controlplane/digest";
import { TofuCommandError } from "@/lib/tofu/runner";
import type { ExecutionActivities } from "@/lib/workflows/types";
import { loadExecContext, resolveConnection, type ExecContext } from "./context";
import { assertLeaseFor, requireExecutable, tofuSession } from "./desired";
import { assertDeployDeletionApproval, buildDeployWorkspace, inspectDeployDeletions } from "./plan";
import { LeaseLostError, StepFailedError, TofuPlanChangedError } from "./errors";
import { withKeepAlive } from "./keepalive";
import { outputsDigest } from "./plan-evidence";
import type { Runtime } from "./runtime";
import { LONG_SESSION_SEC, OBSERVE_CAPABILITY, withProviderSession } from "./session";
import { assertEcsReplicaRepairPlan, prepareEcsReplicaRepair, recordEcsReplicaRepairReadback } from "./ecs-replica-repair";
import { readRepairBinding, repairBindingDigest } from "./ecs-replica-repair-binding";
import { approvalRoundOf } from "@/lib/controlplane/db/repos/operation-review";
import { errorText, safeText } from "./text";
import type { ApplyVerifiedResult } from "@/lib/tofu/engine";
import type { NormalizedPlan } from "@/lib/tofu/types";
import { TofuDeletionRefusedError } from "@/lib/tofu/plan";

const HEX64 = /^[0-9a-f]{64}$/;

const PARTIAL = "partial apply; reconcile will observe the environment";

/** Mark the touched resources after a verified apply. Best effort: the store's rows are a projection, not the truth. */
async function recordResourceStatuses(rt: Runtime, ec: ExecContext, plan: NormalizedPlan): Promise<void> {
  try {
    const stored = new Map((await rt.d.resources.list(ec.workspaceId, ec.environmentId)).map((r) => [r.address, r.id]));
    const final = new Map<string, "active" | "deleted">();
    for (const change of plan.resourceChanges) {
      if (!change.nodeAddress) continue;
      if (change.action === "create" || change.action === "update" || change.action === "replace") final.set(change.nodeAddress, "active");
      else if (change.action === "delete" && !final.has(change.nodeAddress)) final.set(change.nodeAddress, "deleted");
    }
    for (const [address, status] of final) {
      const id = stored.get(address);
      if (id) await rt.d.resources.setStatus({ workspaceId: ec.workspaceId, resourceId: id, status });
    }
  } catch (err) {
    rt.log("warn", "could not update resource statuses after apply", { error: errorText(err) });
  }
}

export function createApplyActivities(rt: Runtime): Pick<ExecutionActivities, "applyInfrastructure"> {
  return {
    async applyInfrastructure({ operationId, planDigest, lease }) {
      if (!HEX64.test(planDigest)) throw new StepFailedError("The plan digest is not a SHA-256 hex digest; refusing to apply.");
      const ec = await loadExecContext(rt, operationId);
      const planFile = path.join(rt.d.planDir, `${planDigest}.tfplan`);
      let toolStarted = false;
      let finished: ApplyVerifiedResult | undefined;

      /** What happened is recorded whether or not the lease survived the call: an apply that ran is evidence either way. */
      const record = async (result: ApplyVerifiedResult): Promise<{ applied: number; outputsDigest: string }> => {
        const counts = result.plan.summary;
        const applied = counts.create + counts.update + counts.delete + counts.replace;
        const digestOfOutputs = outputsDigest(result.outputs);
        await rt.evidence(
          ec.scope,
          {
            kind: "tofu_apply",
            digest: digest({ planDigest, outputsDigest: digestOfOutputs, applied }),
            summary: {
              planDigest,
              configDigest: result.plan.configDigest,
              lockDigest: result.plan.lockDigest,
              tofuVersion: result.plan.tofuVersion,
              applied: { create: counts.create, update: counts.update, delete: counts.delete, replace: counts.replace },
              outputsDigest: digestOfOutputs,
              // names and sensitivity only: output values are never stored, and sensitive ones were already dropped by the engine
              outputs: Object.entries(result.outputs).slice(0, 200).map(([name, o]) => ({ name, sensitive: o.sensitive })),
              exitCode: result.apply.exitCode,
              durationMs: result.apply.durationMs,
            },
            simulated: false,
            key: `apply:${planDigest}`,
          },
          { critical: true }
        );
        await recordResourceStatuses(rt, ec, result.plan);
        await rt.emit(ec.scope, "resource.applied", `apply:${planDigest}`, { planDigest, applied, outputsDigest: digestOfOutputs });
        return { applied, outputsDigest: digestOfOutputs };
      };

      try {
        assertLeaseFor(ec, lease);
        const { graph } = requireExecutable(rt, ec);
        const connection = await resolveConnection(rt, ec);
        const { ws: baseWorkspace, deletionNodes, dnsNodes } = await buildDeployWorkspace(rt, ec, graph, connection);
        let ws = baseWorkspace;

        await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
        await rt.emit(ec.scope, "resource.applying", `apply:${planDigest}`, { planDigest });

        const result = await withKeepAlive(rt, { lease, detail: "tofu apply", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
          const readRepair = () => withProviderSession(rt, ec, { purpose: "observe", capability: OBSERVE_CAPABILITY, fence: lease, connection },
            (session) => prepareEcsReplicaRepair(rt, ec, graph, baseWorkspace, connection, session, signal, lease));
          const repair = ec.op.capability === "drift.repair" ? await readRepair() : undefined;
          if (repair) {
            if (ec.op.planDigest !== planDigest || approvalRoundOf(ec.op) === 0) throw new StepFailedError("Replica repair requires this operation's concrete current-round plan.");
            const row = await rt.d.evidence.find({ workspaceId: ec.workspaceId, operationId, kind: "tofu_plan", digest: planDigest });
            const reviewed = row ? readRepairBinding(row.summary.repairBinding) : undefined;
            const approval = await rt.d.broker.approvalStatus(operationId);
            if (!row || row.simulated || row.workspaceId !== ec.workspaceId || row.operationId !== operationId || row.summary.planDigest !== planDigest
              || !reviewed || repairBindingDigest(reviewed) !== repairBindingDigest(repair.binding)
              || !approval.approved || approval.rejected || !approval.approvalId) throw new StepFailedError("Replica repair requires its exact immutable target and digest-bound human approval.");
            ws = repair.ws;
          }
          const applied = await withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session, claims) => {
            if (repair && (claims.constraints?.repairPlanDigest !== planDigest || claims.constraints?.repairBindingDigest !== repairBindingDigest(repair.binding))) throw new StepFailedError("Replica repair grant does not bind this reviewed plan and target.");
            toolStarted = true;
            const guard = inspectDeployDeletions(rt, ec, deletionNodes, dnsNodes, session, signal, lease);
            finished = await rt.tofu.applyVerifiedPlan(ws, { approvedDigest: planDigest, session: tofuSession(session), signal, deletionNodes, normalize: { fingerprintKey: rt.d.fingerprintKey }, inspectPlan: async (plan, raw) => {
              await guard(plan, raw);
              await assertDeployDeletionApproval(rt, ec, plan, deletionNodes, planDigest);
              if (repair) {
                await readRepair();
                assertEcsReplicaRepairPlan(plan, raw, repair.binding, ws);
                const approval = await rt.d.broker.approvalStatus(operationId);
                if (!approval.approved || approval.rejected || !approval.approvalId) throw new StepFailedError("Replica repair approval expired or changed before the exact saved-plan apply.");
              }
              await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
            } });
            return finished;
          });
          if (repair) {
            try {
              await withProviderSession(rt, ec, { purpose: "observe", capability: OBSERVE_CAPABILITY, fence: lease, connection },
                (session) => recordEcsReplicaRepairReadback(rt, ec, repair.binding, repair.node, connection, session, signal, lease, planDigest));
            } catch {
              throw new Error("ECS replica repair may have applied, but readback authority or evidence is unavailable. Inspect this operation before any further write.");
            }
          }
          return applied;
        });
        const summary = await record(result);
        await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
        return summary;
      } catch (err) {
        if (finished && (err instanceof LeaseLostError || ec.op.capability === "drift.repair")) await record(finished).catch((e) => rt.log("error", "could not record an apply that completed", { error: errorText(e) }));
        throw await classifyApplyFailure(rt, ec, err, toolStarted);
      } finally {
        await rm(planFile, { force: true }).catch(() => undefined);
      }
    },
  };
}

async function classifyApplyFailure(rt: Runtime, ec: ExecContext, err: unknown, toolStarted: boolean): Promise<unknown> {
  if (err instanceof TofuPlanChangedError || err instanceof StepFailedError) return err;
  if (err instanceof TofuDeletionRefusedError) return new StepFailedError(err.message);
  if (err instanceof LeaseLostError) {
    if (toolStarted) await markUncertain(rt, ec, "The environment lease was lost while OpenTofu was applying.");
    return err;
  }
  if (!toolStarted) {
    return new StepFailedError(`The apply did not start; nothing was changed: ${errorText(err)}`);
  }
  if (err instanceof TofuCommandError) {
    const command = err.result.command;
    if (err.code === "tofu_command_failed") {
      if (command === "apply" || command === "output") {
        if (ec.op.capability === "drift.repair") {
          await markUncertain(rt, ec, "OpenTofu reported failure after the replica repair apply began; the exact field outcome is unconfirmed.");
          return new Error("ECS replica repair may have applied despite the command failure. Inspect this operation before any further write.");
        }
        return new StepFailedError(`OpenTofu ${command} failed (exit code ${err.result.exitCode}) after it began applying: ${PARTIAL}.`);
      }
      return new StepFailedError(`OpenTofu ${command} failed (exit code ${err.result.exitCode}) before anything was applied; nothing was changed.`);
    }
    // timeout / abort / output overflow: what tofu did before stopping is unknown
    await markUncertain(rt, ec, `OpenTofu ${command} did not finish (${err.code}).`);
    return new Error(`OpenTofu ${command} did not finish (${err.code}); ${PARTIAL}.`);
  }
  await markUncertain(rt, ec, "The apply ended with an unclassified error.");
  return new Error(`The apply ended with an unclassified error (${errorText(err, 200)}); ${PARTIAL}.`);
}

async function markUncertain(rt: Runtime, ec: ExecContext, reason: string): Promise<void> {
  try {
    await rt.d.ops.markUncertain({ workspaceId: ec.workspaceId, operationId: ec.op.id, reason: safeText(reason, 300) });
  } catch (err) {
    rt.log("warn", "could not mark the operation uncertain; the reconciler will", { error: errorText(err) });
  }
}
