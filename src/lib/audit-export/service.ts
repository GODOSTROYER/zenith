/**
 * Signed, hash-chained export of a range of a workspace's audit log (PROD-OPS-09).
 *
 * The export is signed with the control-plane signing key (purpose `signing:audit-export`, independent of capability grants; `signing:release` is verify-only here by design). No signer configured means no export: there is no
 * unsigned fallback. The signed claims (a compact EdDSA JWS) carry the chain genesis and head, the event count, the
 * range and the link to the workspace's previous export, so the offline verifier can detect any edit, removal,
 * insertion or re-ordering of events, a swapped header, and (with the ledger) a dropped or forked earlier export.
 *
 * Reads go through an injected reader so the same code serves the Postgres and file stores. A range that is larger
 * than MAX_EXPORT_EVENTS is refused rather than silently truncated.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import type { JwtSigner } from "@/lib/credentials/signing/types";
import type { AuditEvent } from "@/lib/domain/types";
import { AUDIT_EXPORT_JWS_TYP, AUDIT_EXPORT_ORDER, AUDIT_EXPORT_SCHEMA, chainEvents, type ChainedEntry } from "./chain";
import { latestExport, recordExport, type AuditExportRecord } from "./store";

export const MAX_EXPORT_EVENTS = 10_000;
const PAGE = 500;
const MAX_PAGES = Math.ceil(MAX_EXPORT_EVENTS / PAGE) + 2;

export type AuditExportErrorCode = "signer_unavailable" | "range_invalid" | "range_too_large";
export class AuditExportError extends Error {
  constructor(readonly code: AuditExportErrorCode, message: string) {
    super(message);
    this.name = "AuditExportError";
  }
}

export interface AuditReadFilter {
  workspaceId: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}
export type AuditReader = (filter: AuditReadFilter) => Promise<{ events: AuditEvent[]; nextCursor?: string }>;

export interface AuditExportDocument {
  schema: typeof AUDIT_EXPORT_SCHEMA;
  /** compact EdDSA JWS whose payload is the claims below; the only part a verifier trusts for count, head and genesis */
  jws: string;
  entries: ChainedEntry[];
}

export interface AuditExportClaims {
  schema: typeof AUDIT_EXPORT_SCHEMA;
  exportId: string;
  workspaceId: string;
  range: { from: string | null; to: string | null };
  order: typeof AUDIT_EXPORT_ORDER;
  createdAt: string;
  count: number;
  genesis: string;
  head: string;
  previousExport: { id: string; head: string } | null;
  firstEvent: { id: string; ts: string } | null;
  lastEvent: { id: string; ts: string } | null;
}

export interface AuditExportDeps {
  db: Sql;
  signer: JwtSigner | undefined;
  read: AuditReader;
  now?: () => Date;
}

function isoBound(name: string, raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new AuditExportError("range_invalid", `${name} is not a date.`);
  return at.toISOString();
}

async function collect(read: AuditReader, workspaceId: string, from: string | null, to: string | null): Promise<AuditEvent[]> {
  const byId = new Map<string, AuditEvent>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await read({ workspaceId, from: from ?? undefined, to: to ?? undefined, limit: PAGE, cursor });
    for (const event of result.events) {
      // Defence in depth: a reader that ignored the tenant filter must not leak another workspace's rows.
      if (event.workspaceId !== workspaceId) continue;
      byId.set(event.id, event);
      if (byId.size > MAX_EXPORT_EVENTS) throw new AuditExportError("range_too_large", `The range holds more than ${MAX_EXPORT_EVENTS} events; export a narrower range.`);
    }
    if (result.nextCursor === undefined) return [...byId.values()];
    cursor = result.nextCursor;
  }
  throw new AuditExportError("range_too_large", `The range holds more than ${MAX_EXPORT_EVENTS} events; export a narrower range.`);
}

export async function createAuditExport(
  deps: AuditExportDeps,
  input: { workspaceId: string; createdBy: string; from?: string; to?: string },
): Promise<{ document: AuditExportDocument; record: AuditExportRecord }> {
  if (!deps.signer) throw new AuditExportError("signer_unavailable", "No audit export signing key is configured, so an audit export cannot be signed; nothing was exported.");
  const from = isoBound("from", input.from);
  const to = isoBound("to", input.to);
  if (from && to && from > to) throw new AuditExportError("range_invalid", "from is after to.");

  const previous = await latestExport(deps.db, input.workspaceId);
  const events = await collect(deps.read, input.workspaceId, from, to);
  const previousLink = previous ? { id: previous.id, head: previous.head } : null;
  const chain = chainEvents(input.workspaceId, previousLink?.head ?? null, events);
  const first = chain.entries[0]?.event;
  const last = chain.entries[chain.entries.length - 1]?.event;
  const exportId = `ae_${randomUUID()}`;
  const claims: AuditExportClaims = {
    schema: AUDIT_EXPORT_SCHEMA,
    exportId,
    workspaceId: input.workspaceId,
    range: { from, to },
    order: AUDIT_EXPORT_ORDER,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    count: chain.entries.length,
    genesis: chain.genesis,
    head: chain.head,
    previousExport: previousLink,
    firstEvent: first ? { id: first.id, ts: first.ts } : null,
    lastEvent: last ? { id: last.id, ts: last.ts } : null,
  };
  const jws = await deps.signer.sign({ typ: AUDIT_EXPORT_JWS_TYP }, claims as unknown as Record<string, unknown>);
  const record = await recordExport(deps.db, {
    id: exportId,
    workspaceId: input.workspaceId,
    rangeFrom: from,
    rangeTo: to,
    eventCount: claims.count,
    genesis: chain.genesis,
    head: chain.head,
    previous: previousLink,
    keyId: deps.signer.kid,
    signatureDigest: createHash("sha256").update(jws).digest("hex"),
    createdBy: input.createdBy,
  });
  return { document: { schema: AUDIT_EXPORT_SCHEMA, jws, entries: chain.entries }, record };
}

