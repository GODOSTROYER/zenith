/**
 * Evidence: durable proof of what happened (plans, applies, probes, log and
 * metric queries), referenced from operations and incidents. Rows hold a
 * content digest, a redacted bounded summary and an optional blob reference —
 * never the artifact itself when it could contain secrets.
 */
import type { EvidenceRecord, Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { clampLimit, json, newId, opt, requireDigest } from "../sql";

interface EvidenceRow {
  id: string;
  workspace_id: string;
  operation_id: string | null;
  incident_id: string | null;
  kind: EvidenceRecord["kind"];
  digest: string;
  summary: Record<string, unknown>;
  blob_ref: string | null;
  simulated: boolean;
  created_at: string;
}

const COLUMNS = "id, workspace_id, operation_id, incident_id, kind, digest, summary, blob_ref, simulated, created_at";
const MAX_SUMMARY_BYTES = 64 * 1024;

const toEvidence = (row: EvidenceRow): EvidenceRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  operationId: opt(row.operation_id),
  incidentId: opt(row.incident_id),
  kind: row.kind,
  digest: row.digest,
  summary: row.summary,
  blobRef: opt(row.blob_ref),
  simulated: row.simulated,
  createdAt: row.created_at,
});

export type InsertEvidenceInput = Omit<EvidenceRecord, "id" | "createdAt"> & { id?: string };

export async function insert(sql: Sql, input: InsertEvidenceInput): Promise<EvidenceRecord> {
  const summary = json(input.summary ?? {});
  if (summary.length > MAX_SUMMARY_BYTES) throw new ControlStoreError("invalid_input", "evidence summary is too large (max 64 KiB); keep a digest and a blob reference.");
  assertNoSecretValues(input.summary, "summary");
  const rows = await sql.query<EvidenceRow>(
    `insert into platform.evidence (id, workspace_id, operation_id, incident_id, kind, digest, summary, blob_ref, simulated)
     values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9::boolean)
     returning ${COLUMNS}`,
    [
      input.id ?? newId("evd"),
      requireText("workspaceId", input.workspaceId),
      input.operationId ?? null,
      input.incidentId ?? null,
      requireText("kind", input.kind, 64),
      requireDigest("digest", input.digest),
      summary,
      input.blobRef ?? null,
      input.simulated,
    ]
  );
  return toEvidence(rows[0]);
}

export async function get(sql: Sql, workspaceId: string, id: string): Promise<EvidenceRecord | null> {
  const rows = await sql.query<EvidenceRow>(
    `select ${COLUMNS} from platform.evidence where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toEvidence(rows[0]) : null;
}

export async function list(
  sql: Sql,
  workspaceId: string,
  filter: { operationId?: string; incidentId?: string; limit?: number } = {}
): Promise<EvidenceRecord[]> {
  const rows = await sql.query<EvidenceRow>(
    `select ${COLUMNS} from platform.evidence
      where workspace_id = $1 and ($2::text is null or operation_id = $2::text) and ($3::text is null or incident_id = $3::text)
      order by created_at desc, id limit $4::bigint`,
    [requireText("workspaceId", workspaceId), filter.operationId ?? null, filter.incidentId ?? null, clampLimit(filter.limit, 100, 500)]
  );
  return rows.map(toEvidence);
}
