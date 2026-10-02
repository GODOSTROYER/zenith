/**
 * The repair policy: which drift may be PROPOSED for repair, and the proposing.
 *
 * Two hard rules and everything else follows from them:
 *
 *   1. The controller never executes a repair. It builds a `drift.repair`
 *      capability request and submits it to the capability broker with origin
 *      `reconciler`; the broker and policy decide allow / approval / deny. Only
 *      an ALLOWED operation is handed to `startRepair`, and that starts the
 *      durable day-two workflow — execution, credentials and leases are not
 *      here.
 *   2. Drift is never repaired merely because it exists. A finding is a
 *      candidate only when ALL of these hold: the drift module marked it
 *      repairable and auto-repair eligible; the node is `managed` in the graph
 *      AND in the stored row; it is not stateful-and-missing, not an identity,
 *      not a firewall that now admits more than desired, not high severity;
 *      the observation is real (not simulated); the environment is not
 *      observe-only. The drift module already encodes most of this — the checks
 *      here are independent, so a wrong or tampered report still cannot widen
 *      what is proposed.
 *
 * Pacing: at most `maxRepairProposals` per environment per window, never a new
 * proposal for a resource that has an open `drift.repair` operation, and a
 * cooldown after any proposal (longer after a rejection or denial), so a
 * failing or refused repair is not retried in a loop. The idempotency key
 * buckets by cooldown window, so a crash between `propose` and bookkeeping
 * cannot double-propose.
 */
import type { CapabilityRequest } from "@/lib/capabilities/catalog";
import { TERMINAL_OPERATION_STATUSES } from "@/lib/controlplane/types";
import { canonical, digest } from "@/lib/controlplane/digest";
import { STATEFUL_KINDS, type DriftFinding, type DriftReport, type ResourceNode } from "@/lib/resources/types";
import { correlationIdFor, findingKey } from "./diff";
import { describeError, redactText } from "./redact";
import {
  RECONCILER_PRINCIPAL,
  type ReconcileEnvironment,
  type FenceRef,
  type ReconcileEvent,
  type ReconcilePorts,
  type RepairDecision,
  type RepairOperationRef,
  type RepairProposalResult,
  type RepairSkipReason,
  type ResolvedReconcileOptions,
  type StoredResourceRef,
} from "./types";

/** The `input` of the `drift.repair` request: names and digests only, never a desired or observed value. */
export interface RepairInput {
  action: "reapply_desired_state";
  address: string;
  kind: string;
  findingClass: "missing" | "changed";
  severity: DriftFinding["severity"];
  /** names of the drifted attributes (`changed`); empty for `missing` */
  attributes: string[];
  graphDigest: string;
  /** the `computedAt` of the report that justifies this proposal */
  reportComputedAt: string;
}

const isStateful = (node: ResourceNode): boolean => (STATEFUL_KINDS as readonly string[]).includes(node.kind);
const OPEN = /^(0\.0\.0\.0\/0|::\/0|\*|any|all|-1|0-65535|1-65535)$/i;
const flatten = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(flatten) : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? [String(v)] : v === null || v === undefined ? [] : [canonical(v)]);

/** Independent re-check of "this firewall now admits something the desired rule did not" from the finding's own fields. */
function firewallOpened(f: DriftFinding): boolean {
  return (f.fields ?? []).some((field) => {
    const wanted = new Set(flatten(field.desired).map((s) => s.toLowerCase()));
    return flatten(field.observed).some((o) => OPEN.test(o) && !wanted.has(o.toLowerCase()));
  });
}

// Uncertain is terminal for workflow bookkeeping, but unresolved for mutation exclusion.
const isOpen = (status: RepairOperationRef["status"]): boolean => status === "uncertain" || !(TERMINAL_OPERATION_STATUSES as readonly string[]).includes(status);

export interface Candidate {
  finding: DriftFinding;
  node: ResourceNode;
  resource: StoredResourceRef;
}

export interface CandidateSelection {
  candidates: Candidate[];
  skipped: RepairDecision[];
}

export interface SelectInput {
  report: DriftReport;
  nodes: ReadonlyMap<string, ResourceNode>;
  resources: ReadonlyMap<string, StoredResourceRef>;
  environment: ReconcileEnvironment;
  options: ResolvedReconcileOptions;
  /** finding keys present in the previous report(s), for `minConfirmations` */
  previousKeys: ReadonlySet<string>;
  /** Supplied by the core from a real native handler or shared declarative recipe. */
  supportsRepair?: (node: ResourceNode, finding: DriftFinding) => boolean;
}

/**
 * Pure: which findings could be proposed, and why every other finding was not.
 * Pacing (open operations, cooldown, rate limit) is applied separately, because
 * it needs the operations ledger.
 */
export function selectRepairCandidates(input: SelectInput): CandidateSelection {
  const { report, nodes, resources, environment, options, previousKeys } = input;
  const candidates: Candidate[] = [];
  const skipped: RepairDecision[] = [];
  const skip = (f: DriftFinding, reason: RepairSkipReason): void => {
    skipped.push({ address: f.address, class: f.class, status: "skipped", reason });
  };

  const environmentWide: RepairSkipReason | undefined = !options.autoRepair
    ? "auto_repair_disabled"
    : environment.autonomyLevel === 0
      ? "autonomy_observe_only"
      : report.simulated
        ? "simulated_observation"
        : undefined;

  for (const f of report.findings) {
    if (environmentWide) {
      // Reported, but only findings that could ever be repaired are worth listing per environment.
      if (f.repairable) skip(f, environmentWide);
      continue;
    }
    const node = nodes.get(f.address);
    if (!node || (f.class !== "missing" && f.class !== "changed")) {
      skip(f, node && node.ownership !== "managed" ? "not_managed" : "not_repairable");
      continue;
    }
    if (node.ownership !== "managed") {
      skip(f, "not_managed");
      continue;
    }
    // Specific high-risk reasons first, independent of what the drift module claimed.
    if (isStateful(node) && f.class === "missing") skip(f, "stateful_missing");
    else if (isStateful(node)) skip(f, "stateful");
    else if (node.kind === "identity") skip(f, "identity");
    else if (node.kind === "firewall" && firewallOpened(f)) skip(f, "firewall_opened");
    else if (f.severity === "high") skip(f, "high_severity");
    else if (!f.repairable || !f.autoRepairEligible) skip(f, f.repairable ? "not_auto_eligible" : "not_repairable");
    else if (input.supportsRepair && !input.supportsRepair(node, f)) skip(f, "repair_not_supported");
    else {
      const resource = resources.get(f.address);
      if (!resource) skip(f, "no_resource_row");
      else if (resource.ownership !== "managed") skip(f, "ownership_mismatch");
      else if (options.minConfirmations > 1 && !previousKeys.has(findingKey(f))) skip(f, "awaiting_confirmation");
      else candidates.push({ finding: f, node, resource });
    }
  }
  return { candidates, skipped };
}

/** The exact request the broker evaluates. Deterministic for a (finding, time window). */
export function buildRepairRequest(input: { environment: ReconcileEnvironment; candidate: Candidate; report: DriftReport; options: ResolvedReconcileOptions; now: Date }): CapabilityRequest {
  const { environment, candidate, report, options, now } = input;
  const { finding, node, resource } = candidate;
  const attributes = [...new Set((finding.fields ?? []).map((f) => f.attribute))].sort();
  const body: RepairInput = {
    action: "reapply_desired_state",
    address: node.address,
    kind: node.kind,
    findingClass: finding.class as "missing" | "changed",
    severity: finding.severity,
    attributes,
    graphDigest: report.graphDigest,
    reportComputedAt: report.computedAt,
  };
  const bucket = Math.floor(now.getTime() / Math.max(1, options.repairCooldownMs));
  const what = finding.class === "missing" ? "is missing from the provider" : `differs from the desired graph on ${attributes.join(", ") || "its configuration"}`;
  return {
    capability: "drift.repair",
    scope: {
      workspaceId: environment.workspaceId,
      ...(environment.projectId ? { projectId: environment.projectId } : {}),
      environmentId: environment.environmentId,
      resourceId: resource.id,
    },
    input: body,
    reason: redactText(`Reconciliation found that ${node.address} ${what}. Proposed repair: re-apply the desired state of this one resource. Nothing has been changed yet.`, 600),
    idempotencyKey: `reconcile-repair-${digest({ environmentId: environment.environmentId, address: node.address, bucket }).slice(0, 32)}`,
  };
}

interface ProposeInput {
  environment: ReconcileEnvironment;
  report: DriftReport;
  selection: CandidateSelection;
  ports: Pick<ReconcilePorts, "now" | "broker" | "startRepair" | "store">;
  options: ResolvedReconcileOptions;
  findingSince: Readonly<Record<string, string>>;
  assertCurrent?: () => Promise<void>;
  fence?: FenceRef;
  signal?: AbortSignal;
}

export interface ProposeOutcome {
  decisions: RepairDecision[];
  events: ReconcileEvent[];
}

/**
 * Apply pacing to the candidates, propose, and start what policy allowed.
 *
 * A candidate whose resource already has an open operation is never proposed
 * again. If that open operation was proposed by THIS controller, policy
 * allowed it, and it is still only `approved` (a crash or an outage fell
 * between `propose` and `startRepair`), it is handed to the workflow again:
 * `startRepair` is idempotent. Operations of findings that have since cleared
 * are never started — resuming only looks at current candidates.
 */
export async function proposeRepairs(input: ProposeInput): Promise<ProposeOutcome> {
  const { environment, report, selection, ports, options, findingSince } = input;
  const now = ports.now();
  const decisions: RepairDecision[] = [...selection.skipped];
  const events: ReconcileEvent[] = [];
  if (selection.candidates.length === 0) return { decisions, events };

  const since = new Date(now.getTime() - Math.max(options.repairWindowMs, options.repairCooldownMs, options.rejectedCooldownMs)).toISOString();
  let ops = await ports.store.listRepairOperations(environment, since);
  const correlation = (address: string, class_: DriftFinding["class"]): string => {
    const key = findingKey({ class: class_, address });
    return correlationIdFor(environment.environmentId, key, findingSince[key] ?? report.computedAt);
  };
  const start = async (operationId: string, correlationId: string): Promise<void> => {
    await input.assertCurrent?.();
    await ports.startRepair({ operationId, workspaceId: environment.workspaceId, ...(environment.projectId ? { projectId: environment.projectId } : {}), environmentId: environment.environmentId, correlationId, fence: input.fence, signal: input.signal });
  };

  const windowStart = now.getTime() - options.repairWindowMs;
  let budget = Math.max(0, options.maxRepairProposals - ops.filter((o) => o.byReconciler && Date.parse(o.createdAt) >= windowStart).length);

  for (const candidate of selection.candidates) {
    await input.assertCurrent?.();
    const { finding, node, resource } = candidate;
    const correlationId = correlation(node.address, finding.class);
    const mine = ops.filter((o) => o.resourceId === resource.id || o.blocksEnvironment || (o.status === "uncertain" && !o.resourceId));

    const uncertain = mine.find((o) => o.status === "uncertain");
    if (uncertain) {
      decisions.push({ address: node.address, class: finding.class, status: "skipped", reason: "repair_uncertain", operationId: uncertain.operationId });
      continue;
    }

    const open = mine.filter((o) => isOpen(o.status));
    if (open.length > 0) {
      const decision: RepairDecision = { address: node.address, class: finding.class, status: "skipped", reason: "repair_open", operationId: open[0].operationId };
      const stranded = open.find((o) => o.byReconciler && o.status === "approved");
      if (stranded) {
        try {
          await start(stranded.operationId, correlationId);
          decision.started = true;
        } catch (err) {
          await input.assertCurrent?.();
          decision.started = false;
          decision.error = describeError(err);
        }
      }
      decisions.push(decision);
      continue;
    }

    const latest = [...mine].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (latest) {
      const refused = latest.status === "rejected" || latest.status === "denied";
      if (now.getTime() - Date.parse(latest.createdAt) < (refused ? options.rejectedCooldownMs : options.repairCooldownMs)) {
        decisions.push({ address: node.address, class: finding.class, status: "skipped", reason: "cooldown" });
        continue;
      }
    }
    if (budget <= 0) {
      decisions.push({ address: node.address, class: finding.class, status: "skipped", reason: "rate_limited" });
      continue;
    }

    let result: RepairProposalResult;
    await input.assertCurrent?.();
    try {
      result = await ports.broker.propose({
        request: buildRepairRequest({ environment, candidate, report, options, now }),
        origin: "reconciler",
        principal: RECONCILER_PRINCIPAL,
        correlationId,
      });
    } catch (err) {
      await input.assertCurrent?.();
      decisions.push({ address: node.address, class: finding.class, status: "failed", reason: "broker_error", error: describeError(err) });
      continue;
    }
    budget--;
    if (result.operationId)
      ops = [
        ...ops,
        { operationId: result.operationId, resourceId: resource.id, status: result.outcome === "allow" ? "approved" : result.outcome === "deny" ? "denied" : "awaiting_approval", createdAt: now.toISOString(), byReconciler: true },
      ];

    const decision: RepairDecision = { address: node.address, class: finding.class, status: "proposed", outcome: result.outcome, ...(result.operationId ? { operationId: result.operationId } : {}) };
    if (result.outcome === "allow") {
      try {
        await start(result.operationId, correlationId);
        decision.started = true;
      } catch (err) {
        await input.assertCurrent?.();
        decision.started = false;
        decision.reason = "start_failed";
        decision.error = describeError(err);
      }
    } else if (result.outcome === "deny" && result.reason) decision.error = redactText(result.reason);
    decisions.push(decision);

    if (result.operationId)
      events.push({
        id: `evt_rec_${digest({ environmentId: environment.environmentId, type: "remediation.proposed", operationId: result.operationId }).slice(0, 32)}`,
        type: "remediation.proposed",
        workspaceId: environment.workspaceId,
        ...(environment.projectId ? { projectId: environment.projectId } : {}),
        environmentId: environment.environmentId,
        resourceId: resource.id,
        operationId: result.operationId,
        correlationId,
        actor: RECONCILER_PRINCIPAL,
        data: { source: "reconciler", capability: "drift.repair", address: node.address, class: finding.class, outcome: result.outcome, started: decision.started ?? false },
      });
  }
  return { decisions, events };
}
