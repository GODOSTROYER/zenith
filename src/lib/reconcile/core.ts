/**
 * `reconcileEnvironment`: one observe → diff → policy → (propose) pass over one
 * environment. The pure core of the reconciliation controller.
 *
 *   desired   the `ResourceGraph` the caller passes in
 *   observe   every reconcilable node read through its driver, inside one
 *             read-only credential session per provider (`observe.ts`)
 *   diff      `computeDriftV2` with each driver's `expectedAttributes`, then a
 *             diff against the previous stored report → `drift.detected` /
 *             `drift.cleared` events (`diff.ts`)
 *   persist   observations, runtime, report, events and the first-seen map in
 *             ONE `store.commit`
 *   policy    repair CANDIDATES chosen deterministically, each submitted to the
 *             capability broker as `drift.repair` with origin `reconciler`; the
 *             broker decides, and only an allowed operation is handed to
 *             `startRepair` (`repair.ts`). This function never repairs.
 *
 * Commit happens BEFORE any proposal: a repair is only ever proposed for drift
 * that is already on the record.
 *
 * Both the cron-driven pass (`pass.ts`) and a single-operation observe step
 * (`observeEnvironment` in the execution activities) call this; every
 * dependency is an injected port, it reads no env var and imports no store.
 *
 * Which nodes are reconciled: `managed` and `referenced` nodes that have a
 * stored resource row in an observable lifecycle state. `external` nodes have
 * no cloud presence; nodes that are `planned`/`provisioning` (never applied)
 * or `deleting`/`deleted` are listed in `skippedNodes` with the reason and are
 * not reported as drift — "not deployed yet" is not "missing". Every other
 * node that cannot be read is reported as `unknown`/`inaccessible`, never
 * skipped.
 */
import { findDriver } from "@/lib/drivers/types";
import { computeDriftV2, defaultExpectedAttributes } from "@/lib/resources/drift";
import type { DriftClass, DriftReport, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { diffFindings, driftEvents, findingKey, nextFindingSince } from "./diff";
import { ReconcileError } from "./errors";
import { observeNodes, type ObservableNode } from "./observe";
import { proposeRepairs, selectRepairCandidates } from "./repair";
import {
  DEFAULT_RECONCILE_OPTIONS,
  type FenceRef,
  type ReconcileEnvironment,
  type ReconcileOptions,
  type ReconcilePorts,
  type ReconcileResult,
  type ResolvedReconcileOptions,
  type SkippedNode,
  type StoredResourceRef,
} from "./types";
import { cmp } from "./util";

const MAX_TIMEOUT_MS = 10 * 60_000;

const positive = (v: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.trunc(v), max) : fallback;

export function resolveOptions(o: ReconcileOptions | undefined): ResolvedReconcileOptions {
  const d = DEFAULT_RECONCILE_OPTIONS;
  return {
    nodeConcurrency: positive(o?.nodeConcurrency, d.nodeConcurrency, 64),
    nodeTimeoutMs: positive(o?.nodeTimeoutMs, d.nodeTimeoutMs, MAX_TIMEOUT_MS),
    environmentTimeoutMs: positive(o?.environmentTimeoutMs, d.environmentTimeoutMs, MAX_TIMEOUT_MS),
    deadlineAt: typeof o?.deadlineAt === "number" && Number.isFinite(o.deadlineAt) ? o.deadlineAt : undefined,
    observeRuntime: o?.observeRuntime ?? d.observeRuntime,
    autoRepair: o?.autoRepair ?? d.autoRepair,
    maxRepairProposals: typeof o?.maxRepairProposals === "number" && o.maxRepairProposals >= 0 ? Math.trunc(o.maxRepairProposals) : d.maxRepairProposals,
    repairWindowMs: positive(o?.repairWindowMs, d.repairWindowMs),
    repairCooldownMs: positive(o?.repairCooldownMs, d.repairCooldownMs),
    rejectedCooldownMs: positive(o?.rejectedCooldownMs, d.rejectedCooldownMs),
    minConfirmations: positive(o?.minConfirmations, d.minConfirmations, 10),
  };
}

const EMPTY_COUNTS = (): Record<DriftClass, number> => ({ missing: 0, changed: 0, extra: 0, unknown: 0, inaccessible: 0 });

interface Partitioned {
  reconcile: { node: ResourceNode; resource: StoredResourceRef }[];
  skipped: SkippedNode[];
}

/** Decide, node by node, what is reconciled and what is listed as skipped (and why). */
function partition(nodes: readonly ResourceNode[], resources: ReadonlyMap<string, StoredResourceRef>): Partitioned {
  const reconcile: Partitioned["reconcile"] = [];
  const skipped: SkippedNode[] = [];
  for (const node of [...nodes].sort((a, b) => cmp(a.address, b.address))) {
    if (node.ownership === "external") {
      skipped.push({ address: node.address, reason: "external" });
      continue;
    }
    const resource = resources.get(node.address);
    if (!resource) skipped.push({ address: node.address, reason: "no_resource_row" });
    else if (resource.status === "planned" || resource.status === "provisioning") skipped.push({ address: node.address, reason: "not_applied" });
    else if (resource.status === "deleting" || resource.status === "deleted") skipped.push({ address: node.address, reason: "being_deleted" });
    else reconcile.push({ node, resource });
  }
  return { reconcile, skipped };
}

export interface ReconcileEnvironmentInput {
  environment: ReconcileEnvironment;
  graph: ResourceGraph;
  ports: ReconcilePorts;
  options?: ReconcileOptions;
  /** the `reconcile:<environmentId>` lease this pass holds, if any: asserted at commit */
  fence?: FenceRef;
  /** aborts when the lease is lost: outstanding reads are cancelled and the rest are reported unread */
  signal?: AbortSignal;
}

export async function reconcileEnvironment(input: ReconcileEnvironmentInput): Promise<ReconcileResult> {
  const { environment, graph, ports } = input;
  const options = resolveOptions(input.options);
  if (graph.environmentId !== environment.environmentId)
    throw new ReconcileError("invalid_input", `The graph is for environment ${graph.environmentId}, not ${environment.environmentId}; refusing to reconcile a graph against another environment.`);

  const startedAt = ports.now();
  const driverFor = ports.driverFor ?? ((node: ResourceNode) => findDriver(node.provider, node.nativeType));
  const storedRows = await ports.store.listResources(environment);
  const resources = new Map(storedRows.map((r) => [r.address, r]));
  const { reconcile, skipped } = partition(graph.nodes, resources);

  const counts = EMPTY_COUNTS();
  if (reconcile.length === 0)
    return {
      workspaceId: environment.workspaceId,
      environmentId: environment.environmentId,
      status: "nothing_to_reconcile",
      observed: 0,
      unread: 0,
      skippedNodes: skipped,
      counts,
      detected: 0,
      cleared: 0,
      changed: false,
      openFindings: 0,
      repairs: [],
      startedAt: startedAt.toISOString(),
      finishedAt: ports.now().toISOString(),
    };

  const previous = await ports.store.loadPrevious(environment);
  const deadlineAt = Math.min(options.deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + options.environmentTimeoutMs);
  const items: ObservableNode[] = reconcile.map(({ node, resource }) => ({ node, resource, driver: driverFor(node) }));

  // A shared id for this pass's observation session (credential audit joins on it).
  const observeCorrelation = `reconcile-${environment.environmentId}-${startedAt.toISOString()}`;
  const observed = await observeNodes({ environment, items, ports, options, correlationId: observeCorrelation, deadlineAt, ...(input.signal ? { signal: input.signal } : {}) });

  const reconciledGraph: ResourceGraph = { ...graph, nodes: reconcile.map((r) => r.node) };
  const drivers = new Map(items.map((i) => [i.node.address, i.driver]));
  const report: DriftReport = computeDriftV2(
    reconciledGraph,
    observed.map((o) => o.observation),
    {
      expectedAttributes: (node) => drivers.get(node.address)?.expectedAttributes?.(node) ?? defaultExpectedAttributes(node),
      computedAt: ports.now().toISOString(),
    }
  );

  const reconciledAddresses = new Set(reconcile.map((r) => r.node.address));
  const diff = diffFindings(previous?.report.findings ?? null, report.findings, reconciledAddresses);
  const findingSince = nextFindingSince(previous, report);
  const events = driftEvents({ environment, report, diff, previous, findingSince, resources });

  await ports.store.commit({
    environment,
    ...(input.fence ? { fence: input.fence } : {}),
    observations: observed.map((o) => ({ resourceId: o.resource.id, observation: o.observation })),
    runtime: observed.flatMap((o) => (o.runtime ? [{ resourceId: o.resource.id, runtime: o.runtime }] : [])),
    report,
    events,
    findingSince,
  });

  // From here on the drift is on the record; only now may a repair be proposed.
  const previousKeys = new Set((previous?.report.findings ?? []).map(findingKey));
  const selection = selectRepairCandidates({
    report,
    nodes: new Map(reconcile.map((r) => [r.node.address, r.node])),
    resources,
    environment,
    options,
    previousKeys,
  });
  const proposed = await proposeRepairs({ environment, report, selection, ports, options, findingSince });
  if (proposed.events.length > 0) {
    try {
      await ports.store.appendEvents(environment, proposed.events);
    } catch {
      // The proposals themselves are durable in the operations ledger; a lost
      // timeline event must not turn a completed reconciliation into a failure.
    }
  }

  for (const f of report.findings) counts[f.class]++;
  const presenceRead = observed.filter((o) => o.observation.presence === "present" || o.observation.presence === "missing").length;
  return {
    workspaceId: environment.workspaceId,
    environmentId: environment.environmentId,
    status: "reconciled",
    report,
    observed: presenceRead,
    unread: observed.length - presenceRead,
    skippedNodes: skipped,
    counts,
    detected: diff.detected.length,
    cleared: diff.cleared.length,
    changed: previous === null || previous.report.graphDigest !== report.graphDigest || diff.detected.length > 0 || diff.cleared.length > 0,
    openFindings: report.findings.length,
    repairs: proposed.decisions,
    startedAt: startedAt.toISOString(),
    finishedAt: ports.now().toISOString(),
  };
}
