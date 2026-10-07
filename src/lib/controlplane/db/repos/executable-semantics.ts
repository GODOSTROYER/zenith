/**
 * Postgres `SemanticsStore` (PROD-DUR-03). Every statement filters on `workspace_id`; the table is
 * write-once (trigger). Deliberately NOT added to `repos/index.ts`: constructed by
 * `createPlatformSemanticsStore(db)` in the execution composition root, like the release store.
 */
import { readExecutableSemantics } from "@/lib/execution/semantics/digest";
import { SemanticsStoreError, validateRecordInput, type ApprovedSemanticsRecord, type RecordSemanticsInput, type SemanticsStore } from "@/lib/execution/semantics/store";
import type { Sql } from "@/lib/controlplane/types";
import { json } from "../sql";

type Row = { workspace_id: string; operation_id: string; plan_digest: string; semantics: unknown; created_at: unknown };

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function recordOf(row: Row): ApprovedSemanticsRecord {
  const semantics = readExecutableSemantics(typeof row.semantics === "string" ? JSON.parse(row.semantics) : row.semantics);
  // A stored document that does not verify is treated as absent evidence, never as a pass.
  if (!semantics) throw new SemanticsStoreError("invalid_input", "The stored executable semantics are malformed.");
  return { workspaceId: row.workspace_id, operationId: row.operation_id, planDigest: row.plan_digest, semantics, createdAt: iso(row.created_at) };
}

const COLS = "workspace_id, operation_id, plan_digest, semantics, created_at";

export function createPlatformSemanticsStore(db: Sql): SemanticsStore {
  return {
    async record(input: RecordSemanticsInput): Promise<ApprovedSemanticsRecord> {
      validateRecordInput(input);
      const inserted = await db.query<Row>(
        `insert into platform.approved_semantics(workspace_id, operation_id, plan_digest, semantics_digest, semantics)
         values ($1,$2,$3,$4,$5::text::jsonb)
         on conflict (workspace_id, operation_id, plan_digest) do nothing
         returning ${COLS}`,
        [input.workspaceId, input.operationId, input.planDigest, input.semantics.digest, json(input.semantics)]
      );
      if (inserted[0]) return recordOf(inserted[0]);
      const existing = await db.query<Row>(`select ${COLS} from platform.approved_semantics where workspace_id = $1 and operation_id = $2 and plan_digest = $3`, [input.workspaceId, input.operationId, input.planDigest]);
      if (!existing[0]) throw new SemanticsStoreError("conflict", "The executable semantics could not be recorded.");
      const row = recordOf(existing[0]);
      if (row.semantics.digest !== input.semantics.digest) throw new SemanticsStoreError("conflict", "The reviewed executable semantics of this plan are write-once and differ from what is recorded.");
      return row;
    },
    async get(workspaceId: string, operationId: string, planDigest: string): Promise<ApprovedSemanticsRecord | null> {
      const rows = await db.query<Row>(`select ${COLS} from platform.approved_semantics where workspace_id = $1 and operation_id = $2 and plan_digest = $3`, [workspaceId, operationId, planDigest]);
      return rows[0] ? recordOf(rows[0]) : null;
    },
  };
}
