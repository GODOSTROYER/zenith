/**
 * The Postgres backend: `public.secrets`, keyed `(workspace_id, ref)`.
 *
 * **Postgres never sees a plaintext value.** The row holds the three sealed
 * parts the migration declares — `iv`, `auth_tag`, `ciphertext`, base64, the
 * lossless split of what the file store keeps as one dotted string — plus
 * `key_version`, the `meta` bag (createdAt/createdBy/updatedAt/updatedBy) and
 * `version`, which doubles as the rotation counter. The key stays in
 * `ZENITH_SECRET_KEY` on the server, so a database dump is ciphertext and a
 * restore into a project with a different key opens nothing. That is stated in
 * the migration next to the table, in the same words.
 *
 * Reads are single rows, not a whole file: the file backend parses the entire
 * store to answer "what is under this one reference", which is fine for a file
 * measured in kilobytes and is the wrong shape for a table. `get` is a primary
 * key lookup and `list` is one filtered select.
 *
 * The compatibility object below blocks the calling thread for one round trip
 * — see `@/lib/db/pg/sync-rest`. Request/provider code must use
 * `PostgresSecretsAsync`, which is defined beside it and never parks the
 * event loop.
 */
import { eq, restAsync, restSync } from "@/lib/db/pg/sync-rest";
import type { AsyncSecretsBackend, SecretRecord, SecretsBackend } from "./backend";

const TABLE = "secrets";

/** The metadata half of a record, as the `meta` jsonb column holds it. */
interface SecretMetaColumn {
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

function fromRow(row: Record<string, unknown>): SecretRecord {
  const meta = (row.meta ?? {}) as SecretMetaColumn;
  const updatedAt = meta.updatedAt ?? String(row.updated_at ?? "");
  return {
    ref: String(row.ref),
    createdAt: meta.createdAt ?? updatedAt,
    createdBy: meta.createdBy ?? "",
    updatedAt,
    updatedBy: meta.updatedBy ?? "",
    version: Number(row.version ?? 1),
    // A row written before `key_version` had a meaning was written by scheme 1,
    // which is the only scheme there has ever been.
    keyVersion: Number(row.key_version ?? 1) || 1,
    iv: String(row.iv ?? ""),
    authTag: String(row.auth_tag ?? ""),
    ciphertext: String(row.ciphertext ?? ""),
  };
}

const toRow = (workspaceId: string, record: SecretRecord): Record<string, unknown> => ({
  workspace_id: workspaceId,
  ref: record.ref,
  iv: record.iv,
  auth_tag: record.authTag,
  ciphertext: record.ciphertext,
  key_version: record.keyVersion,
  meta: {
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  },
  version: record.version,
  updated_at: record.updatedAt,
});

/** `workspace_id=eq.…&ref=eq.…` — the primary key, as PostgREST filters. */
const key = (workspaceId: string, ref: string): string =>
  `${eq("workspace_id", workspaceId)}&${eq("ref", ref)}`;

export const PostgresSecrets: SecretsBackend = {
  kind: "postgres",

  get(workspaceId, ref) {
    const { rows } = restSync({
      method: "GET",
      table: TABLE,
      op: "read",
      path: `${TABLE}?select=*&${key(workspaceId, ref)}&limit=1`,
    });
    return rows.length > 0 ? fromRow(rows[0]) : undefined;
  },

  list(workspaceId) {
    const { rows } = restSync({
      method: "GET",
      table: TABLE,
      op: "read",
      path: `${TABLE}?select=*&${eq("workspace_id", workspaceId)}`,
    });
    return rows.map(fromRow);
  },

  /**
   * Create or rotate in place. An upsert rather than a read-then-write: the
   * primary key is the identity, the caller has already decided what the row
   * should say, and two rotations racing must leave one whole row, not a mix.
   */
  put(workspaceId, record) {
    restSync({
      method: "POST",
      table: TABLE,
      op: "write",
      path: `${TABLE}?on_conflict=workspace_id,ref`,
      body: [toRow(workspaceId, record)],
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  },

  /** One round trip: PostgREST hands back what it deleted. */
  remove(workspaceId, ref) {
    const { rows } = restSync({
      method: "DELETE",
      table: TABLE,
      op: "delete from",
      path: `${TABLE}?${key(workspaceId, ref)}`,
      prefer: "return=representation",
    });
    return rows.length > 0 ? fromRow(rows[0]) : undefined;
  },
};

/**
 * Non-blocking Postgres secret backend. Keep this beside the compatibility
 * backend so a caller cannot accidentally select the worker-thread bridge for
 * a request path that can await.
 */
export const PostgresSecretsAsync: AsyncSecretsBackend = {
  kind: "postgres",

  async get(workspaceId, ref) {
    const { rows } = await restAsync({
      method: "GET",
      table: TABLE,
      op: "read",
      path: `${TABLE}?select=*&${key(workspaceId, ref)}&limit=1`,
    });
    return rows.length > 0 ? fromRow(rows[0]) : undefined;
  },

  async list(workspaceId) {
    const { rows } = await restAsync({
      method: "GET",
      table: TABLE,
      op: "read",
      path: `${TABLE}?select=*&${eq("workspace_id", workspaceId)}`,
    });
    return rows.map(fromRow);
  },

  async put(workspaceId, record) {
    await restAsync({
      method: "POST",
      table: TABLE,
      op: "write",
      path: `${TABLE}?on_conflict=workspace_id,ref`,
      body: [toRow(workspaceId, record)],
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  },

  async remove(workspaceId, ref) {
    const { rows } = await restAsync({
      method: "DELETE",
      table: TABLE,
      op: "delete from",
      path: `${TABLE}?${key(workspaceId, ref)}`,
      prefer: "return=representation",
    });
    return rows.length > 0 ? fromRow(rows[0]) : undefined;
  },
};
