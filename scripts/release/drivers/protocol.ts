/** Closed, sanitized evidence for DRV-4. Importing this module starts no engines. */
import { z } from "zod";

export const OPERATED_LABEL = "local_operated_rehearsal";
export const DRIVER_CHECKS = {
  "two-tenants": ["preconditions", "independent-tenants", "browser-approved-deployments", "provider-readback", "browser-read-isolation", "browser-write-isolation", "mcp-isolation", "foreign-approval-refused", "no-cross-tenant-effects", "source-stable", "owned-cleanup"],
  export: ["preconditions", "browser-approved-deployment", "provider-readback", "revision-export", "working-copy-divergence", "export-file-readback", "credential-absence", "browser-approved-teardown", "portable-plan", "portable-apply-readback", "source-stable", "owned-cleanup"],
} as const;
export type DriverScenario = keyof typeof DRIVER_CHECKS;
const READBACKS: Record<DriverScenario, readonly string[]> = { "two-tenants": ["tenant-a", "tenant-b"], export: ["source", "bundle", "portable-plan", "portable"] };
export type CheckStatus = "passed" | "failed" | "skipped";
const Receipt = z.object({
  schema: z.literal(1), evidenceLabel: z.literal(OPERATED_LABEL),
  scenarioId: z.enum(["two-tenants", "export"]), runId: z.string().regex(/^[a-z0-9][a-z0-9-]{3,19}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checks: z.array(z.object({ id: z.string(), status: z.enum(["passed", "failed", "skipped"]) }).strict()),
  readbacks: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,60}$/), z.string().regex(/^[a-f0-9]{64}$/)),
  limits: z.array(z.string().min(1).max(300)).min(1),
}).strict();
export type OperatedReceipt = z.infer<typeof Receipt>;
export function validateOperatedReceipt(raw: unknown, expected: { scenarioId: string; runId: string; sourceCommit: string }): OperatedReceipt {
  const receipt = Receipt.parse(raw);
  for (const key of ["scenarioId", "runId", "sourceCommit"] as const) if (receipt[key] !== expected[key]) throw new Error("Operated receipt binding mismatch");
  const required: readonly string[] = DRIVER_CHECKS[receipt.scenarioId];
  if (receipt.checks.length !== required.length || receipt.checks.some((check, index) => check.id !== required[index])) throw new Error("Operated receipt check inventory mismatch");
  const keys = Object.keys(receipt.readbacks), readbacks = READBACKS[receipt.scenarioId];
  if (keys.some(key => !readbacks.includes(key)) || (receipt.checks.every(check => check.status === "passed") && readbacks.some(key => !keys.includes(key)))) throw new Error("Independent readback inventory mismatch");
  return receipt;
}
/** Register before mutation. Attempt every owned cleanup even after one fails. */
export class OwnedCleanup {
  private jobs: (() => Promise<void>)[] = [];
  add(work: () => Promise<void>): void { this.jobs.push(work); }
  async settle(): Promise<boolean> {
    let clean = true;
    for (const work of this.jobs.splice(0).reverse()) {
      try { await work(); } catch { clean = false; }
    }
    return clean;
  }
}
export function receiptExit(receipt: OperatedReceipt): number {
  return receipt.checks.some(check => check.status === "failed") ? 1 : receipt.checks.some(check => check.status === "skipped") ? 3 : 0;
}
