/**
 * Hash chain for tamper-evident audit exports (PROD-OPS-09).
 *
 * An export is an ordered list of audit events. Each entry's hash commits to the previous hash and the canonical
 * bytes of its event, so editing, removing, inserting or re-ordering any event changes every later hash and the
 * `head`. The head, the count and the genesis are signed (see service.ts); the offline verifier
 * (scripts/supply-chain/zenith-verify-audit-export.mjs) is an independent implementation of exactly these rules and a
 * test cross-checks both.
 *
 *   genesis  = sha256("zenith.audit-export/v1\ngenesis\n<workspaceId>\n<previousHead or empty>")
 *   hash(i)  = sha256("zenith.audit-export/v1\nentry\n<hash(i-1), genesis for i=0>\n<canonical(event i)>")
 *
 * Honest scope: the chain starts at export time. It proves an exported range was not altered after export and that
 * successive exports of a workspace are linked; it does not prove the live log was complete before export (the log is
 * append-only by convention in the product store, not hash-chained at write time).
 */
import { canonical, sha256Hex } from "@/lib/controlplane/digest";
import type { AuditEvent } from "@/lib/domain/types";

export const AUDIT_EXPORT_SCHEMA = "zenith.audit-export/v1";
export const AUDIT_EXPORT_JWS_TYP = "zenith-audit-export+jwt";
export const AUDIT_EXPORT_ORDER = "ts,id ascending";

export interface ChainedEntry {
  event: AuditEvent;
  hash: string;
}

export function genesisHash(workspaceId: string, previousHead: string | null): string {
  return sha256Hex(`${AUDIT_EXPORT_SCHEMA}\ngenesis\n${workspaceId}\n${previousHead ?? ""}`);
}

export function entryHash(previous: string, event: AuditEvent): string {
  return sha256Hex(`${AUDIT_EXPORT_SCHEMA}\nentry\n${previous}\n${canonical(event)}`);
}

/** Total order every export uses: timestamp, then id as the tiebreak. Plain code-unit comparison, no locale. */
export function compareEvents(a: AuditEvent, b: AuditEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function chainEvents(
  workspaceId: string,
  previousHead: string | null,
  events: readonly AuditEvent[],
): { genesis: string; head: string; entries: ChainedEntry[] } {
  const ordered = [...events].sort(compareEvents);
  const genesis = genesisHash(workspaceId, previousHead);
  let previous = genesis;
  const entries = ordered.map((event) => {
    const hash = entryHash(previous, event);
    previous = hash;
    return { event, hash };
  });
  return { genesis, head: previous, entries };
}
