/**
 * Audit export ledger (PROD-OPS-09; migration 47, `platform.audit_exports`).
 *
 * Workspace-owned and append-only. Every function filters on `workspace_id`; there is no cross-workspace read.
 * No event content is stored, only chain facts (genesis, head, count), the digest of the signed header and links to
 * the previous export of the same workspace.
 */
import { ControlStoreError, requireText } from "@/lib/controlplane/db/errors";
import type { Sql } from "@/lib/controlplane/types";

export interface AuditExportRecord {
  id: string;
  workspaceId: string;
  rangeFrom: string | null;
  rangeTo: string | null;
  eventCount: number;
  genesis: string;
  head: string;
  previousExportId: string | null;
  previousHead: string | null;
  keyId: string;
  signatureDigest: string;
  createdBy: string;
  createdAt: string;
}

interface Row {
  id: string; workspace_id: string; range_from: string | null; range_to: string | null; event_count: number; genesis: string; head: string;
  previous_export_id: string | null; previous_head: string | null; key_id: string; signature_digest: string; created_by: string; created_at: string;
}
const COLUMNS = "id, workspace_id, range_from::text as range_from, range_to::text as range_to, event_count, genesis, head, previous_export_id, previous_head, key_id, signature_digest, created_by, created_at::text as created_at";
const toRecord = (r: Row): AuditExportRecord => ({
  id: r.id, workspaceId: r.workspace_id, rangeFrom: r.range_from, rangeTo: r.range_to, eventCount: r.event_count, genesis: r.genesis, head: r.head,
  previousExportId: r.previous_export_id, previousHead: r.previous_head, keyId: r.key_id, signatureDigest: r.signature_digest, createdBy: r.created_by, createdAt: r.created_at,
});

/** The workspace's newest export (the end of its chain), or undefined for a workspace that never exported. */
export async function latestExport(db: Sql, workspaceId: string): Promise<AuditExportRecord | undefined> {
  const rows = await db.query<Row>(`select ${COLUMNS} from platform.audit_exports where workspace_id = $1 order by seq desc limit 1`, [requireText("workspaceId", workspaceId, 128)]);
  return rows[0] ? toRecord(rows[0]) : undefined;
}

export async function listExports(db: Sql, workspaceId: string, limit = 50): Promise<AuditExportRecord[]> {
  const n = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = await db.query<Row>(`select ${COLUMNS} from platform.audit_exports where workspace_id = $1 order by seq desc limit ${n}`, [requireText("workspaceId", workspaceId, 128)]);
  return rows.map(toRecord);
}

export interface NewAuditExport {
  id: string;
  workspaceId: string;
  rangeFrom: string | null;
  rangeTo: string | null;
  eventCount: number;
  genesis: string;
  head: string;
  /** the end of the chain the export was built on; must still be the end when the row is written */
  previous: { id: string; head: string } | null;
  keyId: string;
  signatureDigest: string;
  createdBy: string;
}

/**
 * Append the export. Serialised per workspace; if another export landed after the one this one was chained to, the
 * insert is refused with `conflict` (the caller rebuilds on the new head), so the ledger never forks.
 */
export async function recordExport(db: Sql, input: NewAuditExport): Promise<AuditExportRecord> {
  const workspaceId = requireText("workspaceId", input.workspaceId, 128);
  return db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1::text))", [`audit-export:${workspaceId}`]);
    const [current] = await tx.query<{ id: string; head: string }>("select id, head from platform.audit_exports where workspace_id = $1 order by seq desc limit 1", [workspaceId]);
    if ((current?.id ?? null) !== (input.previous?.id ?? null) || (current?.head ?? null) !== (input.previous?.head ?? null))
      throw new ControlStoreError("conflict", "Another audit export of this workspace was recorded first; export again to chain onto it.");
    const rows = await tx.query<Row>(
      `insert into platform.audit_exports (id, workspace_id, range_from, range_to, event_count, genesis, head, previous_export_id, previous_head, key_id, signature_digest, created_by)
       values ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12) returning ${COLUMNS}`,
      [input.id, workspaceId, input.rangeFrom, input.rangeTo, input.eventCount, input.genesis, input.head, input.previous?.id ?? null, input.previous?.head ?? null, input.keyId, input.signatureDigest, input.createdBy]);
    return toRecord(rows[0]);
  });
}
