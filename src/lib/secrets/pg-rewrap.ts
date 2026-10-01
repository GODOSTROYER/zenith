/**
 * Direct SQL rotation of the PRODUCT vault, public.secrets, not platform data.
 * Workspace-scoped keyset pages bound memory; row locks prevent overwriting a
 * newer ciphertext. Each batch and its count-only audit event commit together.
 * Uses the existing SQL executor (Postgres in the CLI, PGlite in local tests).
 * There are no migrations, PostgREST transactions, or live verification claims.
 */
import type { Sql } from "@/lib/controlplane/types";
import { secretRecordFromRow } from "./pg-backend";
import type { VaultRewrapStore } from "./rewrap";

export function postgresVaultRewrapStore(db: Sql): VaultRewrapStore {
  const page = async (sql: Sql, workspaceId: string, after: string, limit: number, lock = false) => {
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT * FROM public.secrets WHERE workspace_id = $1 AND ($2::text IS NULL OR ref COLLATE "C" > $2)
       ORDER BY ref COLLATE "C" LIMIT $3${lock ? " FOR UPDATE" : ""}`, [workspaceId, after || null, limit]);
    return rows.map(secretRecordFromRow);
  };
  return {
    listBatch: (workspaceId, after, limit) => page(db, workspaceId, after, limit),
    applyBatch: (workspaceId, after, limit, transform, audit) => db.tx(async (sql) => {
      const records = await page(sql, workspaceId, after, limit, true);
      // Authenticate the complete locked batch before issuing the first UPDATE.
      const changed = records.map(transform).filter((record) => record !== undefined);
      for (const record of changed) {
        const written = await sql.query(
          `UPDATE public.secrets SET iv = $3, auth_tag = $4, ciphertext = $5
           WHERE workspace_id = $1 AND ref = $2 RETURNING ref`,
          [workspaceId, record.ref, record.iv, record.authTag, record.ciphertext]);
        if (written.length !== 1) throw new Error("The vault batch did not update its locked row.");
      }
      if (changed.length) {
        const event = audit(changed.length);
        const recorded = await sql.query(
          `INSERT INTO public.audit_events (id, workspace_id, ts, actor_type, action_id, result, data)
           VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7::text::jsonb) RETURNING id`,
          [event.id, workspaceId, event.ts, event.actor.type, event.actionId, event.result,
            JSON.stringify({ actor: event.actor, input: event.input, summary: event.summary })]);
        if (recorded.length !== 1) throw new Error("The vault batch did not record its audit event.");
      }
      return { records, rewrapped: changed.length };
    }),
    async flushAudit() { /* SQL audit is already committed with each batch. */ },
  };
}
