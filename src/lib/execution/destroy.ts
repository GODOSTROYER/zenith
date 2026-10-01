/**
 * Explicit teardown, never compensation. Brokered credentials stay inside
 * callbacks; leases fence every plan, apply and observation. Stateful deletion
 * needs explicit allow plus policy approval. DNS ownership is read before plan
 * and apply. Missing proves absence; inaccessible/unknown/simulated never does.
 * Cloud execution is unverified live; tests exercise contracts and local tofu.
 */
import { digest } from "@/lib/controlplane/digest";
import type { ProviderSession } from "@/lib/credentials/types";
import { PORTABLE_KINDS, type ResourceGraph, type ResourceNode } from "@/lib/resources/types";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { assessRecordDeletion } from "@/lib/providers/aws/drivers/network/route53-record";
import { assertDeletionAllowed, TofuDeletionRefusedError } from "@/lib/tofu/plan";
import { TofuCommandError } from "@/lib/tofu/runner";
import type { NormalizedPlan } from "@/lib/tofu/types";
import type { DestroyActivities } from "@/lib/workflows/definitions/destroy";
import type { LeaseRef, PlanSummary } from "@/lib/workflows/types";
import { buildWorkspace } from "./compile";
import { loadExecContext, loadOperation, resolveConnection, type ExecContext } from "./context";
import { assertLeaseFor, requireExecutable, tofuSession } from "./desired";
import { LeaseLostError, StepFailedError, TofuPlanChangedError } from "./errors";
import { withKeepAlive } from "./keepalive";
import { planEvidence, toPlanSummary } from "./plan-evidence";
import type { Runtime } from "./runtime";
import { driverContext, LONG_SESSION_SEC, OBSERVE_CAPABILITY, PLAN_CAPABILITY, withProviderSession } from "./session";
import { safeText } from "./text";

const HEX64 = /^[0-9a-f]{64}$/;

async function context(rt: Runtime, operationId: string, lease: LeaseRef, planning = false): Promise<{ ec: ExecContext; graph: ResourceGraph }> {
  const ec = await loadExecContext(rt, operationId);
  const readOnlyPlan = planning && ec.op.capability === PLAN_CAPABILITY;
  if (ec.op.capability !== "infrastructure.destroy" && !readOnlyPlan) throw new StepFailedError("Teardown requires an infrastructure.destroy operation (or infrastructure.plan for read-only review).");
  assertLeaseFor(ec, lease);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  // Teardown compiles the deployed graph, never a caller's replacement revision.
  const deployed = ec.product.environment.deployedRevisionId;
  if (deployed) {
    const revision = await rt.d.product.loadRevision({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, revisionId: deployed });
    if (!revision) throw new StepFailedError("The deployed revision could not be loaded; refusing teardown.");
    ec.product = { ...ec.product, revision };
  }
  const { graph } = requireExecutable(rt, ec);
  const nodes = new Map(graph.nodes.map((node) => [node.address, node]));
  // Retain removed nodes from earlier revisions, using workspace-scoped rows.
  for (const row of await rt.d.resources.list(ec.workspaceId, ec.environmentId)) {
    if (nodes.has(row.address)) continue;
    if (![...PORTABLE_KINDS, "provider_native"].includes(row.kind as ResourceNode["kind"]) || row.provider !== ec.product.environment.provider) throw new StepFailedError("A stored resource cannot be safely compiled for teardown.");
    nodes.set(row.address, { address: row.address, kind: row.kind as ResourceNode["kind"], provider: ec.product.environment.provider, region: row.region ?? ec.product.environment.region, nativeType: row.nativeType, ownership: row.ownership, spec: row.spec, origin: row.origin, dependsOn: row.dependsOn, specDigest: row.specDigest, labels: row.labels, ...(row.externalId ? { externalRef: row.externalId } : {}) });
  }
  const all = [...nodes.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  return { ec, graph: { ...graph, nodes: all, graphDigest: digest({ graphDigest: graph.graphDigest, nodes: all }) } };
}

function guard(plan: NormalizedPlan, nodes: readonly ResourceNode[]): void {
  if (plan.resourceChanges.some((c) => !["delete", "no-op", "read"].includes(c.action))) throw new StepFailedError("A teardown plan contains a non-deletion mutation.");
  for (const change of plan.resourceChanges.filter((c) => c.action === "delete")) {
    const node = nodes.find((n) => n.address === change.nodeAddress);
    if (!node || node.ownership !== "managed") throw new StepFailedError("A teardown deletion has no managed resource node; refusing to delete unmapped state.");
  }
  try { assertDeletionAllowed(plan, nodes); }
  catch (err) { if (err instanceof TofuDeletionRefusedError) throw new StepFailedError(err.message); throw err; }
}

/** AWS target ownership guard; other providers fail closed pending an equivalent. */
async function guardDns(rt: Runtime, ec: ExecContext, nodes: readonly ResourceNode[], session: ProviderSession, signal: AbortSignal, lease: LeaseRef): Promise<void> {
  for (const node of nodes.filter((n) => n.ownership === "managed" && n.kind === "dns_record")) {
    if (node.provider !== "aws" || session.provider !== "aws") throw new StepFailedError("DNS record teardown is unsupported without a provider target ownership guard.");
    const result = await assessRecordDeletion({ ...driverContext(rt, ec, session, signal, { node, fence: lease }), session }, node);
    if (!result.safe) throw new StepFailedError("DNS record target ownership could not be confirmed; refusing teardown.");
  }
}

async function planStage(rt: Runtime, operationId: string, lease: LeaseRef, approvedDigest?: string): Promise<PlanSummary> {
  if (approvedDigest !== undefined && !HEX64.test(approvedDigest)) throw new StepFailedError("The approved plan digest is invalid.");
  const { ec, graph } = await context(rt, operationId, lease, true);
  const connection = await resolveConnection(rt, ec);
  const { ws } = buildWorkspace({ ec, graph, connection, drivers: rt.drivers, overrides: rt.d.tofuWorkspace });
  const result = await withKeepAlive(rt, { lease, detail: "tofu destroy plan", operation: { workspaceId: ec.workspaceId, operationId } }, (signal) =>
    withProviderSession(rt, ec, { purpose: "observe", capability: PLAN_CAPABILITY, fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
      await guardDns(rt, ec, graph.nodes, session, signal, lease);
      return rt.tofu.planWorkspace(ws, tofuSession(session), { destroy: true, lock: false, signal, deletionNodes: graph.nodes, inspectPlan: (plan) => guard(plan, graph.nodes), normalize: { fingerprintKey: rt.d.fingerprintKey } });
    })
  );
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  guard(result.plan, graph.nodes);
  const facts = extractPlanFacts(result.plan);
  const evidence = planEvidence({ plan: result.plan, facts, cost: {}, graphDigest: graph.graphDigest, stage: approvedDigest ? "final_plan" : "plan", approvedDigest });
  // Even an empty state plan needs observation: an out-of-band resource may
  // still exist, and refresh may already have removed missing resources.
  const destroyAddresses = graph.nodes.filter((node) => node.ownership === "managed").map((node) => node.address).sort();
  await rt.evidence(ec.scope, { kind: "tofu_plan", digest: evidence.digest, key: `destroy:${evidence.key}`, summary: { ...evidence.summary, destroy: true, destroyAddresses, statefulDeletes: facts.destroyedStatefulAddresses }, simulated: false }, { critical: false });
  if (approvedDigest && result.plan.planDigest !== approvedDigest) throw new TofuPlanChangedError(approvedDigest, result.plan.planDigest);
  if (!approvedDigest && ec.op.planDigest && ec.op.planDigest !== result.plan.planDigest) throw new TofuPlanChangedError(ec.op.planDigest, result.plan.planDigest);
  if (!approvedDigest) await rt.d.ops.setPlanDigest({ workspaceId: ec.workspaceId, operationId, planDigest: result.plan.planDigest });
  return toPlanSummary(result.plan, facts, {});
}

async function reviewedPlan(rt: Runtime, ec: ExecContext, planDigest: string): Promise<string[]> {
  if (!HEX64.test(planDigest) || ec.op.planDigest !== planDigest) throw new StepFailedError("The destroy digest does not match this operation's reviewed plan.");
  const row = await rt.d.evidence.find({ workspaceId: ec.workspaceId, operationId: ec.op.id, kind: "tofu_plan", digest: planDigest });
  const addresses = row?.summary.destroyAddresses;
  if (!row || row.summary.destroy !== true || !Array.isArray(addresses) || addresses.some((a) => typeof a !== "string")) throw new StepFailedError("No reviewed destroy plan evidence with a verifiable node list was recorded.");
  return addresses as string[];
}

/** The shared gate must not treat policy's auto-approval as a person's approval. */
export async function checkDestroyApproval(rt: Runtime, operationId: string): Promise<{ approved: boolean; rejected: boolean; approvalId?: string }> {
  const op = await loadOperation(rt, operationId);
  if (op.capability !== "infrastructure.destroy") throw new StepFailedError("This is not a destroy operation.");
  const status = await rt.d.broker.approvalStatus(operationId);
  const approvalId = typeof status.approvalId === "string" && status.approvalId.length > 0 ? safeText(status.approvalId, 100) : undefined;
  return { approved: status.approved === true && !!approvalId && !status.rejected, rejected: status.rejected === true, ...(approvalId ? { approvalId } : {}) };
}

export function createDestroyActivities(rt: Runtime): DestroyActivities {
  return {
    planDestroyInfrastructure: ({ operationId, lease }) => planStage(rt, operationId, lease),
    finalDestroyPlan: ({ operationId, approvedPlanDigest, lease }) => planStage(rt, operationId, lease, approvedPlanDigest),
    async applyDestroyInfrastructure({ operationId, planDigest, lease }) {
      const { ec, graph } = await context(rt, operationId, lease);
      await reviewedPlan(rt, ec, planDigest);
      const approval = await checkDestroyApproval(rt, operationId);
      if (!approval.approved || approval.rejected) throw new StepFailedError("Teardown requires a current digest-bound human approval.");
      const connection = await resolveConnection(rt, ec);
      const { ws } = buildWorkspace({ ec, graph, connection, drivers: rt.drivers, overrides: rt.d.tofuWorkspace });
      let started = false;
      try {
        const result = await withKeepAlive(rt, { lease, detail: "tofu destroy apply", operation: { workspaceId: ec.workspaceId, operationId } }, (signal) =>
          withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
            await guardDns(rt, ec, graph.nodes, session, signal, lease);
            started = true;
            return rt.tofu.applyVerifiedPlan(ws, { approvedDigest: planDigest, destroy: true, deletionNodes: graph.nodes, session: tofuSession(session), signal, normalize: { fingerprintKey: rt.d.fingerprintKey }, inspectPlan: async (plan) => {
              guard(plan, graph.nodes);
              await guardDns(rt, ec, graph.nodes, session, signal, lease);
              await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
            } });
          })
        );
        await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
        await rt.evidence(ec.scope, { kind: "tofu_apply", digest: digest({ destroy: true, planDigest, deleted: result.plan.summary.delete }), key: `destroy:${planDigest}`, summary: { destroy: true, planDigest, deleted: result.plan.summary.delete, exitCode: result.apply.exitCode }, simulated: false }, { critical: true });
        // Resource status stays unconfirmed until observation proves absence.
        return { deleted: result.plan.summary.delete };
      } catch (err) {
        if (err instanceof TofuPlanChangedError || err instanceof StepFailedError) throw err;
        if (err instanceof TofuDeletionRefusedError) throw new StepFailedError(err.message);
        if (started) await rt.d.ops.markUncertain({ workspaceId: ec.workspaceId, operationId, reason: "Teardown did not complete; resource absence is unconfirmed." }).catch(() => undefined);
        if (err instanceof LeaseLostError) throw err;
        if (!started) throw new StepFailedError("Teardown did not start; nothing was applied.");
        if (err instanceof TofuCommandError && err.code === "tofu_command_failed") throw new StepFailedError("OpenTofu teardown failed; partial deletion is possible. Reconcile must observe the environment.");
        throw new Error("Teardown ended without a confirmed outcome; partial deletion is possible.");
      }
    },
    async verifyDestroyedInfrastructure({ operationId, planDigest, lease }) {
      const { ec, graph } = await context(rt, operationId, lease);
      const addresses = await reviewedPlan(rt, ec, planDigest);
      const connection = await resolveConnection(rt, ec);
      let failed = 0, unknown = 0;
      const checks: { address: string; presence: string; simulated: boolean }[] = [];
      await withKeepAlive(rt, { lease, detail: "verify destroy absence", operation: { workspaceId: ec.workspaceId, operationId } }, (signal) =>
        withProviderSession(rt, ec, { purpose: "observe", capability: OBSERVE_CAPABILITY, fence: lease, connection }, async (session) => {
          const stored = new Map((await rt.d.resources.list(ec.workspaceId, ec.environmentId)).map((row) => [row.address, row]));
          for (const address of addresses) {
            const node = graph.nodes.find((n) => n.address === address);
            const driver = node ? rt.drivers(node.provider, node.nativeType) : undefined;
            let presence = "unknown", simulated = false;
            if (node && driver?.observe) {
              try {
                const obs = await driver.observe(driverContext(rt, ec, session, signal, { node, fence: lease }), node, stored.get(address)?.externalId);
                simulated = obs.simulated;
                if (obs.address === address && !simulated) presence = obs.presence;
              } catch { /* An unreadable API cannot prove absence. */ }
            }
            if (presence === "present") failed++;
            else if (presence !== "missing") unknown++;
            checks.push({ address, presence, simulated });
            const row = stored.get(address);
            if (row) await rt.d.resources.setStatus({ workspaceId: ec.workspaceId, resourceId: row.id, status: presence === "missing" ? "deleted" : "unknown" });
          }
        })
      );
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      const status = unknown ? "unknown" : failed ? "failed" : "passed";
      await rt.evidence(ec.scope, { kind: "verification", digest: digest({ destroy: true, planDigest, checks }), key: `destroy:${planDigest}`, summary: { destroy: true, planDigest, status, checks }, simulated: checks.some((c) => c.simulated) }, { critical: false });
      return { status, checks: checks.length, failed };
    },
  };
}
