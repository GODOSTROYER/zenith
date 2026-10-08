/**
 * The plan/apply side of the deploy journey for `zenith`-provider (Zenith-managed)
 * environments (PROD-MAN-01), entered from the SAME activities the workflow already
 * calls (`planInfrastructure`, `finalPlan`, `applyInfrastructure`) exactly as
 * `direct-kubernetes.ts` is, so the lease, fence, policy, human approval, digest
 * comparison and evidence trail are unchanged.
 *
 *   plan        render the managed environment (tenancy baseline + workloads + routes),
 *               plan its managed databases, server-side dry-run the rendered objects
 *               against the live tenant namespace, and fold the rendered bytes and each
 *               object's action into a plan digest. Nothing is written.
 *   final plan  the same, right before apply, compared with the approved digest.
 *   apply       re-renders and re-dry-runs under the deploy grant, refuses unless the
 *               digest is still the approved one and the approval is still current, then
 *               runs the provider's own pipeline (`applyZenithEnvironment`): databases,
 *               tenancy baseline, platform TLS, workloads, in that order, stopping at the
 *               first phase that does not fully succeed.
 *
 * Differences from the Kubernetes direct path, all deliberate:
 *   - the session is the managed substrate's tenant-pinned session (credentials are the
 *     platform's own), not a customer connection;
 *   - the tenancy isolation gate (`assertTenantObjects`) runs inside the render, so an
 *     unsafe object never reaches the cluster;
 *   - Secret objects carry only a vault reference. They are excluded from the plan diff
 *     (no secret value is resolved while planning) and are written at apply through a
 *     resolver scoped to exactly this workspace, project and environment;
 *   - a brand-new tenant namespace cannot be dry-run (server-side dry-run of a namespaced
 *     object needs its namespace), so the plan reports every object as `create` and says
 *     it was not server-validated; the apply preflight is all-or-nothing per phase.
 *   - it does not delete (a node removed from the manifest leaves its objects; teardown
 *     is `infrastructure.destroy`) and it does not build: builds and digest rollouts are
 *     the release steps (`createZenithBuildPort`, `createZenithWorkloadsPort`). A workload
 *     with no digest yet is applied with an inert bootstrap image, and an already released
 *     digest is kept, so a re-apply never rolls a release back.
 */
import { digest } from "@/lib/controlplane/digest";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import type { PlanFacts } from "@/lib/policy/types";
import { diff } from "@/lib/providers/kubernetes/apply";
import { targetFor } from "@/lib/providers/kubernetes/target";
import { ANNOTATION, type SupportedKind } from "@/lib/providers/kubernetes/types";
import { dig } from "@/lib/providers/kubernetes/util";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { ensureManagedDatabases } from "@/lib/providers/zenith/database-lifecycle";
import type { K8sObject } from "@/lib/providers/zenith/k8s-port";
import { ManagedSubstrateError, type ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import { renderZenithEnvironment, zenithNodeView, ZENITH_BOOTSTRAP_IMAGE, type ZenithRenderResult } from "@/lib/providers/zenith/render";
import type { ZenithSession } from "@/lib/providers/zenith/session";
import { ZenithError } from "@/lib/providers/zenith/types";
import type { ArtifactSpec } from "@/lib/resources/specs";
import type { ResourceGraph } from "@/lib/resources/types";
import type { NormalizedPlan } from "@/lib/tofu/types";
import type { ExecutionActivities, LeaseRef } from "@/lib/workflows/types";
import { loadExecContext, resolveConnection, type ExecContext } from "./context";
import { assertLeaseFor, costOf, requireExecutable } from "./desired";
import { StepFailedError, TofuPlanChangedError } from "./errors";
import { withKeepAlive } from "./keepalive";
import { planEvidence, toPlanSummary, type PlanCost } from "./plan-evidence";
import type { Runtime } from "./runtime";
import { LONG_SESSION_SEC, PLAN_CAPABILITY, withManagedSession } from "./session";
import { assertApprovedSemantics, recordReviewedSemantics } from "./semantics/dispatch";
import { zenithSemanticsArgs } from "./semantics/zenith";
import { planLimits } from "@/lib/providers/zenith/plans";
import { provisionObjectStores, refuseObjectStores, OBJECT_STORAGE_UNCONFIGURED_REASON } from "@/lib/managed-serving/storage";
import { approvedSources } from "./source-snapshot";
import { errorText, safeText } from "./text";

export const isDirectZenith = (ec: Pick<ExecContext, "product">): boolean => ec.product.environment.provider === "zenith";

const IMAGE_BEARING: ReadonlySet<string> = new Set(["container_service", "scheduled_job", "static_site"]);
const PRIMARY: Record<string, SupportedKind> = { container_service: "Deployment", static_site: "Deployment", scheduled_job: "CronJob" };
const ENGINE = "zenith-managed-apply/Z1";

type Runtimeish = ReturnType<ManagedSubstratePort["databaseRuntime"]>;

interface DirectStage {
  graph: ResourceGraph;
  plan: NormalizedPlan;
  facts: PlanFacts;
  cost: PlanCost;
  graphDigest: string;
  objects: K8sObject[];
  builtImages: Record<string, string>;
}

const refAddress = (o: { kind: string; metadata: { name: string; namespace?: string } }): string => `${o.kind}/${o.metadata.namespace ?? ""}/${o.metadata.name}`;

function managedOf(rt: Runtime): ManagedSubstratePort {
  if (!rt.d.managed) throw new StepFailedError("This worker has no Zenith-managed substrate composed, so a managed environment cannot be planned or applied.");
  return rt.d.managed;
}

/** A refusal from the managed substrate or the isolation gate is a definitive, non-retried failure with a safe message. */
function refusal(err: unknown): never {
  if (err instanceof ManagedSubstrateError || err instanceof ZenithError) throw new StepFailedError(safeText(err.message, 500));
  throw err;
}

function liveImage(live: Record<string, unknown> | undefined, kind: SupportedKind): string | undefined {
  const path = kind === "CronJob" ? ["spec", "jobTemplate", "spec", "template", "spec", "containers", 0, "image"] : ["spec", "template", "spec", "containers", 0, "image"];
  const image = dig(live, ...path);
  return typeof image === "string" && image !== ZENITH_BOOTSTRAP_IMAGE ? image : undefined;
}

/** The image each built workload runs now (keyed by its pipeline address, the key the renderer reads). */
async function builtImagesOf(managed: ManagedSubstratePort, session: ZenithSession, graph: ResourceGraph, signal: AbortSignal): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const node of graph.nodes) {
    if (node.provider !== "zenith" || node.ownership !== "managed" || !IMAGE_BEARING.has(node.kind)) continue;
    const artifact = node.spec.artifact as ArtifactSpec | undefined;
    if (!artifact || artifact.type !== "built") continue;
    const kind = PRIMARY[node.kind];
    const ref = targetFor(kind, zenithNodeView(node, session.tenant, session.substrate), session.tenant.environmentId);
    // Absence is returned as undefined. Transport/authorization failures must not turn a released image
    // into a bootstrap declaration or downgrade the plan's server validation.
    const live = await managed.toolkit.read(session.kubernetes, ref, signal);
    out[artifact.pipeline] = liveImage(live, kind) ?? ZENITH_BOOTSTRAP_IMAGE;
  }
  return out;
}

async function dryRun(rt: Runtime, ec: ExecContext, graph: ResourceGraph, managed: ManagedSubstratePort, session: ZenithSession, signal: AbortSignal): Promise<Omit<DirectStage, "cost" | "graph">> {
  const builtImages = await builtImagesOf(managed, session, graph, signal);
  let rendered: ZenithRenderResult;
  try {
    rendered = renderZenithEnvironment({ tenant: session.tenant, substrate: session.substrate, nodes: graph.nodes, toolkit: managed.toolkit, builtImages,
      verifiedDomains: session.customDomains, autoscaling: planLimits(session.tenant.planTier).maxAutoscaleReplicas > 0 });
  } catch (err) { return refusal(err); }

  const databases = await ensureManagedDatabases(rendered.databases, session.databases, { dryRun: true, signal });
  const blocked = databases.find((d) => d.status === "failed");
  if (blocked) throw new StepFailedError(`The managed database ${safeText(blocked.address, 80)} cannot be planned: ${safeText(blocked.error?.message ?? "unavailable", 300)}`);
  const storage = session.storage
    ? await provisionObjectStores(rendered.storage, { ...session.storage, signal }, { dryRun: true })
    : refuseObjectStores(rendered.storage, OBJECT_STORAGE_UNCONFIGURED_REASON);
  const blockedStorage = storage.find((s) => s.status === "failed");
  if (blockedStorage) throw new StepFailedError(`The managed object store ${safeText(blockedStorage.address, 80)} cannot be planned: ${safeText(blockedStorage.error?.message ?? "unavailable", 300)}`);

  const all = [...rendered.baseline, ...rendered.workloads];
  // Secret values are never resolved while planning; their objects are written at apply.
  const diffable = all.filter((o) => o.kind !== "Secret");
  const namespace = await managed.toolkit.read(session.kubernetes, { apiVersion: "v1", kind: "Namespace", name: rendered.namespace }, signal);
  const validated = namespace !== undefined;
  const changes = validated ? await diff(diffable, session.kubernetes, { environmentId: session.tenant.environmentId, signal }) : [];
  const problem = changes.find((c) => ["conflict", "ownership_conflict", "error"].includes(c.action));
  if (problem) {
    const why = problem.action === "ownership_conflict" ? "an object exists that Zenith does not own" : problem.action === "conflict" ? "another field manager owns a field" : "the cluster refused it";
    throw new StepFailedError(`The managed plan cannot be made: ${refAddress({ kind: problem.ref.kind, metadata: { name: problem.ref.name, namespace: problem.ref.namespace } })}: ${why}. ${safeText(problem.message ?? "", 300)}`);
  }
  const byRef = new Map(changes.map((c) => [`${c.ref.kind}|${c.ref.namespace ?? ""}|${c.ref.name}`, c]));
  const objectChanges = all.map((o) => {
    const c = byRef.get(`${o.kind}|${o.metadata.namespace ?? ""}|${o.metadata.name}`);
    const action = o.kind === "Secret" ? "no-op" : !validated || !c || c.action === "create" ? "create" : c.action === "update" ? "update" : "no-op";
    return {
      address: refAddress(o), nodeAddress: String(o.metadata.annotations?.[ANNOTATION.resource] ?? ""), type: o.kind, providerName: "zenith", action,
      changes: (c?.changedPaths ?? []).slice(0, 50).map((path) => ({ path })), destroysData: false,
    };
  });
  const databaseChanges = rendered.databases.map((d) => ({
    address: `ManagedPostgres/${rendered.namespace}/${d.address}`, nodeAddress: d.address, type: "ManagedPostgres", providerName: "zenith", action: "create" as const, changes: [], destroysData: false,
  }));
  const storageChanges = rendered.storage.map((s) => ({
    address: `ManagedObjectStore/${rendered.namespace}/${s.address}`, nodeAddress: s.address, type: "ManagedObjectStore", providerName: "zenith", action: "create" as const, changes: [], destroysData: false,
  }));
  const resourceChanges = [...databaseChanges, ...storageChanges, ...objectChanges];
  const count = (a: string) => resourceChanges.filter((r) => r.action === a).length;
  const summary = { create: count("create"), update: count("update"), delete: 0, replace: 0, noop: count("no-op") };
  // The digest binds what would be sent (the rendered bytes, including platform TLS and database intents) and what it would do now.
  const planDigest = digest({
    engine: ENGINE, graphDigest: graph.graphDigest, objects: all, platformTls: rendered.platformTls,
    databases: rendered.databases.map((d) => [d.address, d.spec]), storage: rendered.storage, retiredDomains: session.retiredDomains ?? [],
    actions: resourceChanges.map((r) => [r.address, r.action, r.changes]),
  });
  const diagnostics = [
    ...(validated ? [] : [{ severity: "warning" as const, summary: "The tenant namespace does not exist yet, so objects were not server-side validated; every object is reported as a create.", detail: "" }]),
    { severity: "warning" as const, summary: "Secret values are written at apply from vault references and are not compared in the plan.", detail: "" },
    ...rendered.notes.slice(0, 10).map((n) => ({ severity: "warning" as const, summary: safeText(n, 300), detail: "" })),
  ];
  const plan = {
    tofuVersion: ENGINE, formatVersion: "Z1", configDigest: graph.graphDigest, lockDigest: digest({ provider: "zenith", contract: "Z1" }), planDigest,
    resourceChanges, outputChanges: [], summary, empty: summary.create === 0 && summary.update === 0, diagnostics, createdAt: rt.now().toISOString(),
  } as unknown as NormalizedPlan;
  const facts: PlanFacts = { ...extractPlanFacts(plan), statefulDeletes: [], dnsDeletes: [], destroysData: false, destroyedStatefulAddresses: [] } as PlanFacts;
  return { plan, facts, graphDigest: graph.graphDigest, objects: all, builtImages };
}

function runtimeFor(managed: ManagedSubstratePort, ec: ExecContext, graph: ResourceGraph): Runtimeish {
  try { return managed.databaseRuntime({ workspaceId: ec.workspaceId, projectId: ec.product.project.id, environmentId: ec.environmentId, nodes: graph.nodes }); }
  catch (err) { return refusal(err); }
}

async function stage(rt: Runtime, ec: ExecContext, lease: LeaseRef, detail: string, expected?: string): Promise<DirectStage> {
  assertLeaseFor(ec, lease);
  const { graph } = requireExecutable(rt, ec);
  const managed = managedOf(rt);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  const runtime = runtimeFor(managed, ec, graph);
  const result = await withKeepAlive(rt, { lease, detail, operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
    await approvedSources(rt, ec, graph, lease, !expected, signal);
    return withManagedSession(rt, ec, { capability: PLAN_CAPABILITY, fence: lease, durationSec: LONG_SESSION_SEC, workspaceId: ec.workspaceId, environmentId: ec.environmentId, databases: runtime.databases, storage: runtime.storage },
      (session) => dryRun(rt, ec, graph, managed, session, signal));
  });
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  return { ...result, graph, cost: await costOf(rt, ec, graph) };
}

export async function planDirectZenith(rt: Runtime, ec: ExecContext, lease: LeaseRef): ReturnType<ExecutionActivities["planInfrastructure"]> {
  const s = await stage(rt, ec, lease, "zenith managed plan");
  if (ec.op.planDigest && ec.op.planDigest !== s.plan.planDigest) throw new TofuPlanChangedError(ec.op.planDigest, s.plan.planDigest);
  const evidence = planEvidence({ plan: s.plan, facts: s.facts, cost: s.cost, graphDigest: s.graphDigest, stage: "plan", approvedSources: ec.approvedSourceSnapshots });
  // PROD-DUR-03: the executable semantics the approver is shown, recorded write-once BEFORE the plan evidence exists, and
  // recomputed at final plan, apply, build, rollout and migration dispatch.
  const semantics = await recordReviewedSemantics(rt, ec, await zenithSemanticsArgs(managedOf(rt), ec, s.graph, await resolveConnection(rt, ec), s.plan.planDigest));
  await rt.evidence(ec.scope, { kind: "tofu_plan", digest: evidence.digest, key: evidence.key, summary: { ...evidence.summary, semantics, engine: "zenith-managed-apply", statefulDeletes: [], dnsDeletes: [], retained: [] }, simulated: false }, { critical: true });
  if (!ec.op.planDigest) await rt.d.ops.setPlanDigest({ workspaceId: ec.workspaceId, operationId: ec.op.id, planDigest: s.plan.planDigest });
  await rt.emit(ec.scope, "resource.planned", `plan:${s.plan.planDigest}`, { planDigest: s.plan.planDigest, create: s.plan.summary.create, update: s.plan.summary.update, delete: 0, replace: 0, empty: s.plan.empty });
  return toPlanSummary(s.plan, s.facts, s.cost);
}

export async function finalDirectZenith(rt: Runtime, ec: ExecContext, lease: LeaseRef, approved: string): ReturnType<ExecutionActivities["finalPlan"]> {
  const s = await stage(rt, ec, lease, "zenith managed plan (final)", approved);
  const evidence = planEvidence({ plan: s.plan, facts: s.facts, cost: s.cost, graphDigest: s.graphDigest, stage: "final_plan", approvedDigest: approved, approvedSources: ec.approvedSourceSnapshots });
  await rt.evidence(ec.scope, { kind: "tofu_plan", digest: evidence.digest, key: evidence.key, summary: { ...evidence.summary, engine: "zenith-managed-apply", statefulDeletes: [], dnsDeletes: [] }, simulated: false }, { critical: false });
  if (s.plan.planDigest !== approved) throw new TofuPlanChangedError(approved, s.plan.planDigest);
  await assertApprovedSemantics(rt, ec, await zenithSemanticsArgs(managedOf(rt), ec, s.graph, await resolveConnection(rt, ec), approved), "final plan");
  return toPlanSummary(s.plan, s.facts, s.cost);
}

export async function applyDirectZenith(rt: Runtime, ec: ExecContext, lease: LeaseRef, planDigest: string): ReturnType<ExecutionActivities["applyInfrastructure"]> {
  assertLeaseFor(ec, lease);
  const { graph } = requireExecutable(rt, ec);
  const managed = managedOf(rt);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  await rt.emit(ec.scope, "resource.applying", `apply:${planDigest}`, { planDigest });
  const runtime = runtimeFor(managed, ec, graph);
  let started = false;
  try {
    const applied = await withKeepAlive(rt, { lease, detail: "zenith managed apply", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
      await approvedSources(rt, ec, graph, lease, false, signal);
      return withManagedSession(rt, ec, { fence: lease, durationSec: LONG_SESSION_SEC, workspaceId: ec.workspaceId, environmentId: ec.environmentId, databases: runtime.databases, storage: runtime.storage }, async (session) => {
        // Everything the reviewed plan depended on must be unchanged, and the plan must still be the approved one.
        const current = await loadExecContext(rt, ec.op.id);
        const currentGraph = requireExecutable(rt, current).graph;
        if (currentGraph.graphDigest !== graph.graphDigest) throw new StepFailedError("The reviewed desired state changed; a new review is required.");
        const fresh = await dryRun(rt, current, currentGraph, managed, session, signal);
        if (fresh.plan.planDigest !== planDigest) throw new TofuPlanChangedError(planDigest, fresh.plan.planDigest);
        await assertApprovedSemantics(rt, current, await zenithSemanticsArgs(managedOf(rt), current, currentGraph, await resolveConnection(rt, current), planDigest), "apply");
        const authority = await rt.d.broker.approvalStatus(ec.op.id);
        if (!authority.approved || authority.rejected || (current.op.approvalRequired && !authority.approvalId)) throw new StepFailedError("Current policy or human approval changed before the reviewed plan was applied.");
        await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
        started = true;
        const report = await applyZenithEnvironment({
          session, expect: { workspaceId: ec.workspaceId, environmentId: ec.environmentId }, toolkit: managed.toolkit, nodes: currentGraph.nodes,
          builtImages: fresh.builtImages, resolveSecret: runtime.resolveSecret, dryRun: false, signal,
          verifiedDomains: session.customDomains, retiredDomains: session.retiredDomains,
          autoscaling: planLimits(session.tenant.planTier).maxAutoscaleReplicas > 0,
        });
        if (!report.ok) {
          const phase = report.blockedBy ?? "apply";
          const phaseReport = report.blockedBy === "database" ? undefined : report.blockedBy === "baseline" ? report.baseline : report.blockedBy === "tls" ? report.tls : report.workloads;
          const refused = phaseReport && "refused" in phaseReport && (phaseReport as { refused?: boolean }).refused === true;
          const note = report.blockedBy === "database" ? (report.databases.find((d) => d.status === "failed")?.error?.message ?? "a managed database failed") : `phase ${phase}`;
          if (refused) throw new StepFailedError(`The managed apply was refused before ${phase} wrote anything (${safeText(note, 200)}). A managed database from an earlier phase may already exist.`);
          throw new Error(`The managed apply stopped at ${phase} (${safeText(note, 200)}); partial apply; reconcile will observe the environment.`);
        }
        return { report, plan: fresh.plan, objects: fresh.objects };
      });
    });
    const counts = applied.plan.summary;
    const count = counts.create + counts.update;
    const outputsDigest = digest({
      engine: ENGINE,
      applied: [...(applied.report.baseline?.results ?? []), ...(applied.report.workloads?.results ?? [])].map((r) => [r.ref.kind, r.ref.namespace, r.ref.name, r.status]),
      databases: applied.report.databases.map((d) => [d.address, d.status]),
    });
    await rt.evidence(ec.scope, { kind: "tofu_apply", digest: digest({ planDigest, outputsDigest, applied: count }), key: `apply:${planDigest}`, simulated: false,
      summary: { planDigest, engine: "zenith-managed-apply", applied: { create: counts.create, update: counts.update, delete: 0, replace: 0 }, outputsDigest, outputs: [], exitCode: 0, durationMs: 0 } }, { critical: true });
    await markActive(rt, ec, applied.objects);
    await rt.emit(ec.scope, "resource.applied", `apply:${planDigest}`, { planDigest, applied: count, outputsDigest });
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    return { applied: count, outputsDigest };
  } catch (err) {
    if (err instanceof TofuPlanChangedError || err instanceof StepFailedError) throw err;
    if (started) {
      await rt.d.ops.markUncertain({ workspaceId: ec.workspaceId, operationId: ec.op.id, reason: safeText("The managed apply ended without a confirmed outcome.", 300) }).catch(() => undefined);
      throw err instanceof Error && /partial apply/.test(err.message) ? err : new Error(`The managed apply ended without a confirmed outcome (${errorText(err, 200)}); partial apply; reconcile will observe the environment.`);
    }
    throw new StepFailedError(`The apply did not start; nothing was changed: ${errorText(err)}`);
  }
}

/** Mark the nodes that were applied. A projection only: the cluster is the truth. */
async function markActive(rt: Runtime, ec: ExecContext, objects: readonly K8sObject[]): Promise<void> {
  try {
    const stored = new Map((await rt.d.resources.list(ec.workspaceId, ec.environmentId)).map((r) => [r.address, r.id]));
    const addresses = new Set(objects.map((o) => String(o.metadata.annotations?.[ANNOTATION.resource] ?? "")));
    for (const address of addresses) {
      const id = stored.get(address);
      if (id) await rt.d.resources.setStatus({ workspaceId: ec.workspaceId, resourceId: id, status: "active" });
    }
  } catch (err) {
    rt.log("warn", "could not update resource statuses after the managed apply", { error: errorText(err) });
  }
}
