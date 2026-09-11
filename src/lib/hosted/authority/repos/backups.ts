/**
 * `backup_manifests` — what each backup contained, so a restore can be checked
 * rather than hoped for.
 *
 * A manifest records the digest and size of the encrypted payload, the per-file
 * hashes inside it, the key it was sealed under and — the field that makes
 * reconciliation possible — the last revocation sequence number included. A
 * restore compares that number against the off-host ledger and knows exactly
 * which revocations postdate the snapshot it just wrote.
 */
import type { DatabaseSync } from "node:sqlite";
import type { BackupManifest } from "@/lib/hosted/contracts";
import { nowIso, readJson, readNumber, readText, statements, writeJson, type Prepare, type SqlRow } from "../sql";

/** What the caller supplies to record a backup. */
export interface NewBackupManifest {
  id: string;
  /** SHA-256 of the encrypted payload. */
  digest: string;
  byteSize: number;
  files: BackupManifest["files"];
  /** The highest revocation sequence number this snapshot contains. */
  revocationSeq: number;
  /** Which key sealed it — never the key itself. */
  keyId: string;
  createdAt?: string;
}

/** Reads and writes of the `backup_manifests` table. */
export interface BackupsRepo {
  insert(input: NewBackupManifest): BackupManifest;
  /** The newest manifest, or null when nothing has ever been backed up. */
  latest(): BackupManifest | null;
  list(opts?: { limit?: number }): BackupManifest[];
}

const COLUMNS = "id, created_at, digest, byte_size, files, revocation_seq, key_id";

/** The one place a row of `backup_manifests` becomes a `BackupManifest`. */
function map(row: SqlRow): BackupManifest {
  return {
    id: readText(row, "id"),
    createdAt: readText(row, "created_at"),
    digest: readText(row, "digest"),
    byteSize: readNumber(row, "byte_size"),
    files: readJson<BackupManifest["files"]>(row, "files"),
    revocationSeq: readNumber(row, "revocation_seq"),
    keyId: readText(row, "key_id"),
  };
}

/** Bind the `backup_manifests` repository to one connection. */
export function createBackupsRepo(db: DatabaseSync): BackupsRepo {
  const sql: Prepare = statements(db);

  return {
    insert(input) {
      const manifest: BackupManifest = {
        id: input.id,
        createdAt: input.createdAt ?? nowIso(),
        digest: input.digest,
        byteSize: input.byteSize,
        files: input.files,
        revocationSeq: input.revocationSeq,
        keyId: input.keyId,
      };
      sql(`INSERT INTO backup_manifests (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        manifest.id,
        manifest.createdAt,
        manifest.digest,
        manifest.byteSize,
        writeJson(manifest.files),
        manifest.revocationSeq,
        manifest.keyId
      );
      return manifest;
    },

    latest() {
      const row = sql(
        `SELECT ${COLUMNS} FROM backup_manifests ORDER BY created_at DESC, id DESC LIMIT 1`
      ).get();
      return row ? map(row) : null;
    },

    list(opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      return sql(
        `SELECT ${COLUMNS} FROM backup_manifests ORDER BY created_at DESC, id DESC LIMIT ?`
      )
        .all(limit)
        .map(map);
    },
  };
}
