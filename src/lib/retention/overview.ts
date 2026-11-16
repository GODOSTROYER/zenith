/**
 * The operator's retention overview (PROD-OPS-07): what policy is in force, whether deletion is possible at all, where
 * archives go, active holds, recent archives and the dry-run preview. Read-only; shared by the admin API and the page.
 * Nothing here exposes row payloads, secrets or the archive key.
 */
import type { Sql } from "@/lib/controlplane/types";
import { archiveTargetFromEnv } from "./archive";
import { backupKeyConfigured } from "@/lib/hosted/backup/crypto";
import { APPROVED_LOG_RETENTION_DAYS, APPROVED_PAYLOAD_RETENTION_HOURS, AUDIT_MINIMUM_RETENTION_DAYS, DEFAULT_RETENTION_POLICY, loadRetentionPolicy, retentionApplyGate, type ApplyGate, type RetentionPolicy } from "./policy";
import { countScrubbable, minimizeGate, type MinimizeGate } from "@/lib/sensitivedata/minimize";
import { listArchives, listHolds, previewRetention, type ArchiveRecord, type LegalHold, type RetentionPreview } from "./store";

/** The approved DEC-RETENTION baseline and the two gaps Zenith cannot close yet, stated plainly for operators. */
export interface RetentionBaseline {
  decision: "DEC-RETENTION";
  logDays: number;
  payloadHours: number;
  auditMinimumDays: number;
  approvedBy: string;
  approvedAt: string;
  notices: readonly string[];
}

export const RETENTION_NOTICES: readonly string[] = Object.freeze([
  "Zenith does not expire archive objects. The lifecycle rules of the destination bucket decide how long archive copies live.",
  "Backups taken before a deletion still contain the deleted rows until the backup itself expires. Zenith does not track backup expiry yet.",
]);

export interface RetentionOverview {
  baseline: RetentionBaseline;
  payloadMinimizer: { gate: MinimizeGate; hours: number; eligible: number; held: number };
  policy: { source: "default" | "file" | "inline" | "both"; valid: boolean; problems: readonly string[]; digest: string; approved: boolean; approvedBy: string | null; value: RetentionPolicy; retainsEverything: boolean };
  gate: ApplyGate;
  archiveStorage: { configured: boolean; detail: string; sealingKeyConfigured: boolean };
  holds: LegalHold[];
  archives: ArchiveRecord[];
  preview: RetentionPreview;
}

export async function retentionOverview(sql: Sql, env: Readonly<Record<string, string | undefined>> = process.env, now: Date = new Date()): Promise<RetentionOverview> {
  const load = loadRetentionPolicy(env);
  const gate = retentionApplyGate(env, load);
  const storage = archiveTargetFromEnv(env);
  const minimizer = minimizeGate(env, load);
  const windows = Object.values(load.policy.classes).concat(...Object.values(load.policy.workspaces).map((w) => Object.values(w)));
  const approval = DEFAULT_RETENTION_POLICY.approval!;
  const retainsEverything = !windows.some((w) => w && (typeof w.archiveAfterDays === "number" || typeof w.pruneAfterDays === "number"));
  const [runnerScrub, machineScrub] = await Promise.all([countScrubbable(sql, "runner_jobs", minimizer.hours, 100_000), countScrubbable(sql, "machine_requests", minimizer.hours, 100_000)]);
  return {
    baseline: { decision: "DEC-RETENTION", logDays: APPROVED_LOG_RETENTION_DAYS, payloadHours: APPROVED_PAYLOAD_RETENTION_HOURS, auditMinimumDays: AUDIT_MINIMUM_RETENTION_DAYS, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, notices: RETENTION_NOTICES },
    payloadMinimizer: { gate: minimizer, hours: minimizer.hours, eligible: runnerScrub.scrubbed + machineScrub.scrubbed, held: runnerScrub.held + machineScrub.held },
    policy: {
      source: load.source, valid: load.ok, problems: load.ok ? [] : load.problems, digest: load.digest, value: load.policy,
      approved: load.ok && !!load.policy.approval, approvedBy: load.ok ? (load.policy.approval?.approvedBy ?? null) : null, retainsEverything,
    },
    gate,
    archiveStorage: { configured: storage.ok, detail: storage.ok ? storage.label : storage.reason, sealingKeyConfigured: backupKeyConfigured() },
    holds: await listHolds(sql, { activeOnly: true, limit: 100 }),
    archives: await listArchives(sql, { limit: 25 }),
    preview: await previewRetention(sql, load.policy, now),
  };
}
