/**
 * Report-to-report diff and the drift events it produces. Pure.
 *
 * A finding's identity is `(class, address)`. A finding that persists keeps its
 * identity, its first-seen instant and therefore its correlation id for its
 * whole life, so `drift.detected`, the repair proposal made for it and the
 * eventual `drift.cleared` are one joinable flow. If a persisting finding's
 * RISK SIGNATURE moves (severity, repairability, the set of drifted attribute
 * names) it is reported again as an update: a firewall rule that went from
 * "changed" to "opened to the world" must not be silent because the finding
 * already existed. Values are never part of the signature or of any event.
 *
 * `drift.cleared` is only claimed when the finding's node was actually read
 * again and no longer drifts (`resolved`). A finding whose node is no longer
 * reconciled at all (being re-provisioned, deleted) is closed with reason
 * `no_longer_reconciled`, which does not assert that anything was fixed.
 */
import { digest } from "@/lib/controlplane/digest";
import type { DriftFinding, DriftReport } from "@/lib/resources/types";
import { redactText } from "./redact";
import { cmp } from "./util";
import { RECONCILER_PRINCIPAL, type ReconcileEnvironment, type ReconcileEvent, type StoredResourceRef } from "./types";

export const findingKey = (f: Pick<DriftFinding, "class" | "address">): string => `${f.class}|${f.address}`;

const attributeNames = (f: DriftFinding): string[] => [...new Set((f.fields ?? []).map((x) => x.attribute))].sort(cmp);

/** What would make a person look again: severity, repairability and which attributes drifted. */
export function findingSignature(f: DriftFinding): string {
  return digest({ severity: f.severity, repairable: f.repairable, auto: f.autoRepairEligible, attributes: attributeNames(f) }).slice(0, 16);
}

export interface FindingDiff {
  detected: { finding: DriftFinding; transition: "new" | "updated" }[];
  cleared: { finding: DriftFinding; reason: "resolved" | "no_longer_reconciled" }[];
  unchanged: number;
}

/**
 * `reconciledAddresses` is every address whose node was part of THIS pass's
 * reconciliation; a previous finding on an address outside it cannot have been
 * "resolved" by anything we observed.
 */
export function diffFindings(previous: readonly DriftFinding[] | null, next: readonly DriftFinding[], reconciledAddresses: ReadonlySet<string>): FindingDiff {
  const before = new Map((previous ?? []).map((f) => [findingKey(f), f]));
  const after = new Map(next.map((f) => [findingKey(f), f]));
  const detected: FindingDiff["detected"] = [];
  const cleared: FindingDiff["cleared"] = [];
  let unchanged = 0;

  for (const [key, finding] of after) {
    const prev = before.get(key);
    if (!prev) detected.push({ finding, transition: "new" });
    else if (findingSignature(prev) !== findingSignature(finding)) detected.push({ finding, transition: "updated" });
    else unchanged++;
  }
  for (const [key, finding] of before) {
    if (after.has(key)) continue;
    cleared.push({ finding, reason: reconciledAddresses.has(finding.address) ? "resolved" : "no_longer_reconciled" });
  }
  const order = (a: { finding: DriftFinding }, b: { finding: DriftFinding }): number => cmp(findingKey(a.finding), findingKey(b.finding));
  detected.sort(order);
  cleared.sort(order);
  return { detected, cleared, unchanged };
}

/**
 * The first-seen map after this pass: findings that persist keep their
 * instant, new ones start now, resolved ones drop out. A persisting finding
 * whose first-seen instant was lost (the map is empty after a store reset)
 * falls back to the previous report's time, which is at least stable.
 */
export function nextFindingSince(previous: { report: DriftReport; findingSince: Record<string, string> } | null, report: DriftReport): Record<string, string> {
  const before = new Set((previous?.report.findings ?? []).map(findingKey));
  const out: Record<string, string> = {};
  for (const f of report.findings) {
    const key = findingKey(f);
    out[key] = before.has(key) ? (previous?.findingSince[key] ?? previous?.report.computedAt ?? report.computedAt) : report.computedAt;
  }
  return out;
}

/** One id for a finding's whole lifecycle; deterministic in (environment, finding, first seen). */
export const correlationIdFor = (environmentId: string, key: string, since: string): string =>
  `drift-${digest({ environmentId, key, since }).slice(0, 24)}`;

const eventId = (environmentId: string, type: string, key: string, computedAt: string): string =>
  `evt_rec_${digest({ environmentId, type, key, computedAt }).slice(0, 32)}`;

export interface DriftEventInput {
  environment: ReconcileEnvironment;
  report: DriftReport;
  diff: FindingDiff;
  previous: { report: DriftReport; findingSince: Record<string, string> } | null;
  /** first-seen map AFTER this pass (for detected) */
  findingSince: Record<string, string>;
  resources: ReadonlyMap<string, StoredResourceRef>;
}

/**
 * `drift.detected` for new/updated findings and `drift.cleared` for resolved
 * ones. `data` holds names, classes, severities and the finding's own scrubbed
 * explanation — never a desired or observed VALUE.
 */
export function driftEvents(input: DriftEventInput): ReconcileEvent[] {
  const { environment, report, diff, previous, findingSince, resources } = input;
  const base = (type: ReconcileEvent["type"], f: DriftFinding, correlationId: string, key: string): Omit<ReconcileEvent, "data"> => ({
    id: eventId(environment.environmentId, type, key, report.computedAt),
    type,
    workspaceId: environment.workspaceId,
    ...(environment.projectId ? { projectId: environment.projectId } : {}),
    environmentId: environment.environmentId,
    ...(resources.get(f.address) ? { resourceId: resources.get(f.address)?.id } : {}),
    correlationId,
    actor: RECONCILER_PRINCIPAL,
  });

  const events: ReconcileEvent[] = [];
  for (const { finding, transition } of diff.detected) {
    const key = findingKey(finding);
    const since = findingSince[key] ?? report.computedAt;
    events.push({
      ...base("drift.detected", finding, correlationIdFor(environment.environmentId, key, since), `${key}|${findingSignature(finding)}`),
      data: {
        address: finding.address,
        class: finding.class,
        severity: finding.severity,
        transition,
        repairable: finding.repairable,
        autoRepairEligible: finding.autoRepairEligible,
        attributes: attributeNames(finding),
        explanation: redactText(finding.explanation, 400),
        since,
        graphDigest: report.graphDigest,
        simulated: report.simulated,
      },
    });
  }
  for (const { finding, reason } of diff.cleared) {
    const key = findingKey(finding);
    const since = previous?.findingSince[key] ?? previous?.report.computedAt ?? report.computedAt;
    events.push({
      ...base("drift.cleared", finding, correlationIdFor(environment.environmentId, key, since), key),
      data: {
        address: finding.address,
        class: finding.class,
        severity: finding.severity,
        reason,
        since,
        graphDigest: report.graphDigest,
        simulated: report.simulated,
      },
    });
  }
  return events;
}
