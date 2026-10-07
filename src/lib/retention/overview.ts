/**
 * The operator's retention overview (PROD-OPS-07): what policy is in force, whether deletion is possible at all, where
 * archives go, active holds, recent archives and the dry-run preview. Read-only; shared by the admin API and the page.
 * Nothing here exposes row payloads, secrets or the archive key.
 */
import type { Sql } from "@/lib/controlplane/types";
import { archiveTargetFromEnv } from "./archive";
import { backupKeyConfigured } from "@/lib/hosted/backup/crypto";
import { loadRetentionPolicy, retentionApplyGate, type ApplyGate, type RetentionPolicy } from "./policy";
import { listArchives, listHolds, previewRetention, type ArchiveRecord, type LegalHold, type RetentionPreview } from "./store";

export interface RetentionOverview {
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
  const windows = Object.values(load.policy.classes).concat(...Object.values(load.policy.workspaces).map((w) => Object.values(w)));
  const retainsEverything = !windows.some((w) => w && (typeof w.archiveAfterDays === "number" || typeof w.pruneAfterDays === "number"));
  return {
    policy: {
      source: load.source, valid: load.ok, problems: load.ok ? [] : load.problems, digest: load.digest, value: load.policy,
      approved: !!load.policy.approval, approvedBy: load.policy.approval?.approvedBy ?? null, retainsEverything,
    },
    gate,
    archiveStorage: { configured: storage.ok, detail: storage.ok ? storage.label : storage.reason, sealingKeyConfigured: backupKeyConfigured() },
    holds: await listHolds(sql, { activeOnly: true, limit: 100 }),
    archives: await listArchives(sql, { limit: 25 }),
    preview: await previewRetention(sql, load.policy, now),
  };
}
