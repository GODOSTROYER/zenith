/**
 * Runbook audit chain. Each subject (`runbook:`, `schedule:`, `run:`) has its own
 * append-only hash chain: every entry's digest covers the previous digest, so a
 * deleted or edited entry is detectable by `verifyAuditChain`. Entries carry ids,
 * digests, codes and counts only: never command arguments, output or credentials.
 */
import { digest } from "@/lib/controlplane/digest";
import { credentialPatternsIn } from "@/lib/credentials/redact";
import type { RunbookAuditRecord } from "./ports";

export const AUDIT_GENESIS = "0".repeat(64);

export function auditEntryDigest(prevDigest: string, e: { workspaceId: string; subject: string; seq: number; event: string; actor: string; detail: Record<string, unknown>; createdAt: string }): string {
  return digest({ prev: prevDigest, ws: e.workspaceId, subject: e.subject, seq: e.seq, event: e.event, actor: e.actor, detail: e.detail, at: e.createdAt });
}

/** Detail is bounded and scrubbed before it is hashed and stored. */
export function boundedAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(detail);
  if (text.length > 4096 || credentialPatternsIn(text).length) return { truncated: true, size: text.length };
  return JSON.parse(text) as Record<string, unknown>;
}

export function verifyAuditChain(entries: readonly RunbookAuditRecord[]): boolean {
  let prev = AUDIT_GENESIS;
  let seq = 0;
  for (const e of entries) {
    seq += 1;
    if (e.seq !== seq || e.prevDigest !== prev || e.entryDigest !== auditEntryDigest(prev, e)) return false;
    prev = e.entryDigest;
  }
  return true;
}
