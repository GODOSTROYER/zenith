/** Pure DRV-3 planning/receipt inventory. This file starts no engine. */
import { z } from "zod";

export const OPERATED_LABEL = "local_operated_rehearsal";
export const OPERATED_CHECKS = {
  upgrade: ["preconditions", "compatibility-gates", "browser-review-in-flight", "expand-worker-api", "candidate-readback", "api-failure-injected", "rollback-readback", "approved-execution-readback", "source-bound", "cleanup"],
  restore: ["preconditions", "browser-approved-snapshot", "backup-verified", "post-snapshot-consumption", "damaged-backup-refused", "missing-keys-refused", "nonempty-target-refused", "fresh-restore", "epoch-and-ledger-readback", "old-approval-refused", "browser-continuation", "fresh-approval-readback", "source-bound", "cleanup"],
} as const;
export function operatedScenario(id: string): id is keyof typeof OPERATED_CHECKS { return id === "upgrade" || id === "restore"; }
const image = z.string().regex(/^localhost:5000\/zenith-[a-f0-9]{24}\/(api|worker|migration)@sha256:[a-f0-9]{64}$/);
export const UpgradeImages = z.object({ schema: z.literal(1), api: image, worker: image, migration: image }).strict();
export type Images = Omit<z.infer<typeof UpgradeImages>, "schema">;
export function upgradeImages(raw: unknown, owner: string, previous: Images): Images {
  const parsed = UpgradeImages.parse(raw);
  for (const service of ["api", "worker", "migration"] as const) {
    if (!parsed[service].startsWith(`localhost:5000/zenith-${owner}/${service}@sha256:`)) throw new Error("operated:image-owner");
    if (parsed[service] === previous[service]) throw new Error("operated:candidate-must-change");
  }
  return { api: parsed.api, worker: parsed.worker, migration: parsed.migration };
}
export function restoreDatabaseName(runId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{3,19}$/.test(runId)) throw new Error("operated:run-id");
  return `j15_restore_${runId.replaceAll("-", "_")}`;
}
export const RESTORE_ORDER = ["backup", "consume-after-snapshot", "stop-writers", "fault-refusals", "restore-fresh", "epoch-readback", "start-api", "refuse-old-approval", "browser-continuation", "start-worker", "fresh-approval", "cleanup"] as const;
