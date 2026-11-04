/** Emit the signed version reference into the broker's immutable proposal input (DUR-03). */
import { RunbookReference } from "@/lib/execution/semantics/collect";
import type { RunbookVersionRecord } from "@/lib/machines/runbooks/ports";

export function runbookProposalInput(args: Record<string, unknown>, version: Pick<RunbookVersionRecord, "runbookId" | "version" | "definitionDigest">): Record<string, unknown> {
  // The caller verifies the stored signature. A step argument can never supply this reference.
  return { ...args, runbook: RunbookReference.parse({ runbookId: version.runbookId, version: version.version, definitionDigest: version.definitionDigest }) };
}
