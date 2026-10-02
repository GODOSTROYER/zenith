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
 *
 * Normal deploy deletions use trusted historical nodes and live DNS ownership
 * reads inside broker callbacks. Cloud behavior is contract-tested, not live.
 */
import { rm } from "node:fs/promises";
import type { PlanFacts } from "@/lib/policy/types";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import type { ExecutionActivities } from "@/lib/workflows/types";
import { mapLimit } from "./concurrency";
import { loadExecContext, loadOperation, resolveConnection, type ExecContext } from "./context";
import { assertLeaseFor, costOf, requireExecutable, tofuSession } from "./desired";
import { buildWorkspace, compileGraph } from "./compile";
import { errorCode, StepFailedError, TofuPlanChangedError } from "./errors";
import { buildDesiredState, findGraphProblems } from "./graph";
import { withKeepAlive } from "./keepalive";
import { planEvidence, readPlanEvidence, toPlanSummary, type PlanCost } from "./plan-evidence";
import type { Runtime } from "./runtime";
import { baseTags, driverContext, environmentIdProblem, LONG_SESSION_SEC, PLAN_CAPABILITY, withProviderSession } from "./session";
import { safeList, safeText } from "./text";
import type { NormalizedPlan } from "@/lib/tofu/types";
import type { ProviderSession } from "@/lib/credentials/types";
import { PORTABLE_KINDS, STATEFUL_KINDS, type ResourceGraph, type ResourceNode } from "@/lib/resources/types";
import { resolvePolicies } from "@/lib/resources/manifest-v2";
import { assessRecordDeletion } from "@/lib/providers/aws/drivers/network/route53-record";
import { assessRecordDeletion as assessGcpRecordDeletion } from "@/lib/providers/gcp/dns-ownership";
import { assessRecordDeletion as assessAzureRecordDeletion } from "@/lib/providers/azure/dns-ownership";
import { assessRecordDeletion as assessOciRecordDeletion } from "@/lib/providers/oci/dns-ownership";
import { assertDeletionAllowed, TofuDeletionRefusedError } from "@/lib/tofu/plan";
import type { PlanInspector } from "@/lib/tofu/runner";
import type { LeaseRef } from "@/lib/workflows/types";
import { assertEcsReplicaRepairPlan, prepareEcsReplicaRepair } from "./ecs-replica-repair";
import type { EcsReplicaRepairBindingV1 } from "./ecs-replica-repair-binding";

type PlanActivities = Pick<ExecutionActivities, "validateDesiredState" | "planInfrastructure" | "evaluatePolicy" | "checkApproval" | "finalPlan">;

interface PlanStage {
  plan: NormalizedPlan;
  planFilePath?: string;
  facts: PlanFacts;
  cost: PlanCost;
  graphDigest: string;
  deletions: DeployDeletionFacts;
  repairBinding?: EcsReplicaRepairBindingV1;
}

/** Additive policy facts, kept alongside the legacy facts schema in evidence. */
export interface DeployDeletionFacts {
  statefulDeletes: string[];
  dnsDeletes: string[];
}

const DNS_TYPE = /^(?:aws_route53_record|google_dns_record_set|azurerm_dns_[a-z0-9_]+_record|oci_dns_rrset)$/;
const deleting = (action: string): boolean => action === "delete" || action === "replace";

export function deployDeletionFacts(plan: NormalizedPlan, nodes: readonly ResourceNode[]): DeployDeletionFacts {
  const byAddress = new Map(nodes.map((node) => [node.address, node]));
  const stateful = new Set(extractPlanFacts(plan).destroyedStatefulAddresses);
  const dns = new Set<string>();
  for (const change of plan.resourceChanges) {
    if (!deleting(change.action)) continue;
    const node = byAddress.get(change.nodeAddress ?? change.address);
    if (node && (STATEFUL_KINDS as readonly string[]).includes(node.kind)) stateful.add(change.address);
    if (node?.kind === "dns_record" || DNS_TYPE.test(change.type)) dns.add(change.address);
  }
  return { statefulDeletes: [...stateful].sort(), dnsDeletes: [...dns].sort() };
}

/**
 * Keep removed nodes' policies and address mappings, never their resource blocks.
 * Deployed revision nodes win over desired-store rows, which validation may have
 * overwritten already. Rows from older revisions cover partial/failed deploys.
 */
export async function buildDeployWorkspace(rt: Runtime, ec: ExecContext, graph: ResourceGraph, connection: Awaited<ReturnType<typeof resolveConnection>>) {
  const { ws } = buildWorkspace({ ec, graph, connection, drivers: rt.drivers, overrides: rt.d.tofuWorkspace });
  let previous = graph;
  let previousProduct = ec.product;
  const deployedId = ec.product.environment.deployedRevisionId;
  if (deployedId && deployedId !== ec.product.revision?.id) {
    const revision = await rt.d.product.loadRevision({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, revisionId: deployedId });
    if (!revision) throw new StepFailedError("The deployed revision could not be loaded; refusing to plan resource deletion.");
    previousProduct = { ...ec.product, revision };
    previous = requireExecutable(rt, { product: previousProduct }).graph;
  }
  const desiredPolicy = buildDesiredState(ec.product).manifest;
  const previousPolicy = buildDesiredState(previousProduct).manifest;
  const withDnsPolicy = (node: ResourceNode, manifest: typeof desiredPolicy): ResourceNode => node.kind === "dns_record"
    ? { ...node, spec: { ...node.spec, deletionPolicy: node.spec.deletionPolicy ?? (manifest ? resolvePolicies(manifest).deletion : undefined) } }
    : node;
  const prior = new Map(previous.nodes.map((node) => [node.address, withDnsPolicy(node, previousPolicy)]));
  for (const row of await rt.d.resources.list(ec.workspaceId, ec.environmentId)) {
    if (row.workspaceId !== ec.workspaceId || row.environmentId !== ec.environmentId) throw new StepFailedError("A stored deletion resource is outside this operation's scope.");
    if (row.status === "deleted" || prior.has(row.address)) continue;
    if (![...PORTABLE_KINDS, "provider_native"].includes(row.kind as ResourceNode["kind"]) || row.provider !== ec.product.environment.provider) throw new StepFailedError("A stored resource cannot be safely mapped for deletion.");
    prior.set(row.address, { address: row.address, kind: row.kind as ResourceNode["kind"], provider: ec.product.environment.provider, region: row.region ?? ec.product.environment.region, nativeType: row.nativeType, ownership: row.ownership, spec: row.spec, origin: row.origin, dependsOn: row.dependsOn, specDigest: row.specDigest, labels: row.labels, ...(row.externalId ? { externalRef: row.externalId } : {}) });
  }
  const nodes = new Map(prior);
  for (const node of graph.nodes) {
    const old = prior.get(node.address);
    if (old && old.ownership !== node.ownership) throw new StepFailedError("Resource ownership cannot change as a side effect of a deployment.");
    // A replacement destroys the old object too: a new kind/policy must not
    // erase its stateful classification or its deployed deletion restriction.
    if (!old) {
      const desired = withDnsPolicy(node, desiredPolicy);
      nodes.set(node.address, desired);
      prior.set(node.address, desired);
    }
  }
  // Compile the historical graph solely to recover the driver's exact address
  // list (including auxiliary resources). No names are guessed from tofu output.
  const { fragments } = compileGraph({ graph: { ...previous, nodes: [...prior.values()] }, environmentId: ec.environmentId, region: ec.product.environment.region, tags: baseTags(ec), drivers: rt.drivers, connection });
  const owner = new Map<string, string>();
  const addressMap: Record<string, string[]> = {};
  const add = (nodeAddress: string, addresses: readonly string[]): void => {
    for (const address of addresses) {
      if (owner.has(address) && owner.get(address) !== nodeAddress) throw new StepFailedError("A deletion address maps to more than one resource; refusing ambiguous ownership.");
      owner.set(address, nodeAddress);
      addressMap[nodeAddress] = [...new Set([...(addressMap[nodeAddress] ?? []), address])].sort();
    }
  };
  for (const [address, fragment] of fragments) add(address, fragment.addresses);
  for (const [address, addresses] of Object.entries(ws.addressMap)) add(address, addresses);
  return { ws: { ...ws, addressMap }, deletionNodes: [...nodes.values()], dnsNodes: [...prior.values()] };
}

/** Only deleted/replaced DNS records need a live read; provider strings are data. */
export function inspectDeployDeletions(rt: Runtime, ec: ExecContext, nodes: readonly ResourceNode[], dnsNodes: readonly ResourceNode[], session: ProviderSession, signal: AbortSignal, lease: LeaseRef): PlanInspector {
  return async (plan) => {
    try { assertDeletionAllowed(plan, nodes); }
    catch (err) { if (err instanceof TofuDeletionRefusedError) throw new StepFailedError(err.message); throw err; }
    const byAddress = new Map(dnsNodes.map((node) => [node.address, node]));
    for (const address of deployDeletionFacts(plan, nodes).dnsDeletes) {
      const change = plan.resourceChanges.find((c) => c.address === address)!;
      const node = byAddress.get(change.nodeAddress ?? change.address);
      if (!node || node.kind !== "dns_record" || node.ownership !== "managed") throw new StepFailedError("DNS deletion has no trusted managed resource node.");
      if (!["allow", "approval"].includes(String(node.spec.deletionPolicy))) throw new StepFailedError("DNS deletion is refused by its deletionPolicy.");
      const ctx = driverContext(rt, ec, session, signal, { node, fence: lease });
      // Dispatch only exact mapped native types with a matching broker session.
      // Never surface guard reasons or external exception payloads.
      let result: { safe: boolean; reason: string };
      try {
        if (node.provider === "aws" && node.nativeType === "aws:route53_record" && session.provider === "aws") {
          result = await assessRecordDeletion({ ...ctx, session }, node);
        } else if (node.provider === "gcp" && node.nativeType === "gcp:dns_record_set" && session.provider === "gcp") {
          result = await assessGcpRecordDeletion({ ...ctx, session }, node, dnsNodes);
        } else if (node.provider === "azure" && node.nativeType === "azure:dns_record_set" && session.provider === "azure") {
          result = await assessAzureRecordDeletion({ ...ctx, session }, node, dnsNodes);
        } else if (node.provider === "oci" && node.nativeType === "oci:dns_rrset" && session.provider === "oci") {
          result = await assessOciRecordDeletion({ ...ctx, session }, node, dnsNodes);
        } else {
          throw new StepFailedError("DNS deletion is unsupported without a provider target ownership guard.");
        }
      } catch (err) {
        if (err instanceof StepFailedError) throw err;
        throw new StepFailedError("DNS record target ownership could not be confirmed; refusing deletion.");
      }
      if (!result.safe) throw new StepFailedError("DNS record target ownership could not be confirmed; refusing deletion.");
    }
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  };
}

function readDeletionFacts(summary: Record<string, unknown>): DeployDeletionFacts | undefined {
  const list = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10_000 && value.every((v) => typeof v === "string" && v.length <= 500);
  if (!list(summary.statefulDeletes) || !list(summary.dnsDeletes)) return undefined;
  return { statefulDeletes: summary.statefulDeletes, dnsDeletes: summary.dnsDeletes };
}

/** A mutating grant alone must not authorize destructive deploy changes. */
export async function assertDeployDeletionApproval(rt: Runtime, ec: ExecContext, plan: NormalizedPlan, nodes: readonly ResourceNode[], approvedDigest: string): Promise<void> {
  const facts = deployDeletionFacts(plan, nodes);
  if (facts.statefulDeletes.length === 0 && facts.dnsDeletes.length === 0) return;
  const op = await loadOperation(rt, ec.op.id);
  if (op.workspaceId !== ec.workspaceId || op.environmentId !== ec.environmentId || op.planDigest !== approvedDigest || plan.planDigest !== approvedDigest) throw new StepFailedError("Deletion requires this operation's reviewed plan digest.");
  const row = await rt.d.evidence.find({ workspaceId: ec.workspaceId, operationId: op.id, kind: "tofu_plan", digest: approvedDigest });
  // Evidence is scoped by workspace + operation; the operation carries the
  // environment. EvidenceRecord deliberately has no environmentId field.
  const trusted = row && !row.simulated && row.workspaceId === ec.workspaceId && row.operationId === op.id && row.digest === approvedDigest && row.summary.planDigest === approvedDigest;
  const reviewed = trusted && readPlanEvidence(row.summary) && readDeletionFacts(row.summary);
  if (!reviewed || JSON.stringify(reviewed) !== JSON.stringify(facts)) throw new StepFailedError("No reviewed plan evidence covers these resource deletions.");
  const status = await rt.d.broker.approvalStatus(op.id);
  if (!status.approved || status.rejected || typeof status.approvalId !== "string" || status.approvalId.trim().length === 0) throw new StepFailedError("Resource deletion requires a current digest-bound human approval.");
}

/** Plan or re-plan under the operation's lease and return the normalized plan with what was derived from it. */
async function runPlanStage(rt: Runtime, ec: ExecContext, lease: Parameters<ExecutionActivities["planInfrastructure"]>[0]["lease"], detail: string, expectedDigest?: string): Promise<PlanStage> {
  assertLeaseFor(ec, lease);
  const { graph } = requireExecutable(rt, ec);
  const connection = await resolveConnection(rt, ec);
  const { ws: baseWorkspace, deletionNodes, dnsNodes } = await buildDeployWorkspace(rt, ec, graph, connection);
  let ws = baseWorkspace;
  let repairBinding: EcsReplicaRepairBindingV1 | undefined;

  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  const result = await withKeepAlive(rt, { lease, detail, operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
    withProviderSession(rt, ec, { purpose: "observe", capability: PLAN_CAPABILITY, fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
      if (ec.op.capability === "drift.repair") {
        const repair = await prepareEcsReplicaRepair(rt, ec, graph, baseWorkspace, connection, session, signal, lease);
        ws = repair.ws; repairBinding = repair.binding;
      }
      const deletionGuard = inspectDeployDeletions(rt, ec, deletionNodes, dnsNodes, session, signal, lease);
      // lock: false — the read-only observe role cannot write the S3 state-lock object; the fenced env lease
      // (held, renewed and asserted around this call) is what serialises work on the environment. Apply always locks.
      return rt.tofu.planWorkspace(ws, tofuSession(session), { signal, planDir: rt.d.planDir, lock: false, expectedDigest, deletionNodes, inspectPlan: async (plan, raw) => {
        await deletionGuard(plan, raw);
        if (repairBinding) {
          await prepareEcsReplicaRepair(rt, ec, graph, baseWorkspace, connection, session, signal, lease);
          assertEcsReplicaRepairPlan(plan, raw, repairBinding, ws);
        }
      }, normalize: { fingerprintKey: rt.d.fingerprintKey } });
    })
  );
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);

  // Facts come from the plan we just produced, here, and nowhere else.
  const deletions = deployDeletionFacts(result.plan, deletionNodes);
  const extracted = extractPlanFacts(result.plan);
  const facts: PlanFacts = {
    ...extracted,
    ...deletions,
    destroysData: deletions.statefulDeletes.length > 0,
    destroyedStatefulAddresses: deletions.statefulDeletes,
    dnsChanges: [...new Set([...extracted.dnsChanges, ...deletions.dnsDeletes])].sort(),
  };
  const cost = await costOf(rt, ec, graph);
  return { plan: result.plan, planFilePath: result.planFilePath, facts, cost, graphDigest: graph.graphDigest, deletions, repairBinding };
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
      const evidence = planEvidence({ plan: stage.plan, facts: stage.facts, cost: stage.cost, graphDigest: stage.graphDigest, stage: "plan", repairBinding: stage.repairBinding });
      await rt.evidence(ec.scope, { kind: "tofu_plan", digest: evidence.digest, summary: { ...evidence.summary, ...stage.deletions }, simulated: false, key: evidence.key }, { critical: false });
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
        if (op.planDigest !== planDigest) throw new StepFailedError("plan_changed: policy must evaluate the operation's recorded plan.");
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
      const stage = await runPlanStage(rt, ec, lease, "tofu plan (final)", approvedPlanDigest);
      const evidence = planEvidence({ plan: stage.plan, facts: stage.facts, cost: stage.cost, graphDigest: stage.graphDigest, stage: "final_plan", approvedDigest: approvedPlanDigest, repairBinding: stage.repairBinding });
      await rt.evidence(ec.scope, { kind: "tofu_plan", digest: evidence.digest, summary: { ...evidence.summary, ...stage.deletions }, simulated: false, key: evidence.key }, { critical: false });
      if (stage.plan.planDigest !== approvedPlanDigest) {
        // The plan that just moved was never approved: do not leave its file around.
        if (stage.planFilePath) await rm(stage.planFilePath, { force: true }).catch(() => undefined);
        throw new TofuPlanChangedError(approvedPlanDigest, stage.plan.planDigest);
      }
      return toPlanSummary(stage.plan, stage.facts, stage.cost);
    },
  };
}
