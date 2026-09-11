/**
 * `hosted.backup_manifests` — the Postgres twin of `authority/repos/backups.ts`.
 *
 * Append-only and read in one direction: a restore wants the newest manifest,
 * and an operator wants the last few. Both orders are `created_at desc, id
 * desc` and not `created_at desc` alone — two manifests written in the same
 * millisecond would otherwise come back in whatever order the plan happened to
 * produce, and "the latest backup" would be a coin toss.
 *
 * `byte_size` and `revocation_seq` are `bigint` and arrive as decimal strings;
 * `readNumber` in `../rows.ts` refuses anything past `Number.MAX_SAFE_INTEGER`
 * rather than rounding it. `revocation_seq` in particular is the number a
 * restore reconciles against the off-host ledger, so a rounded one would be a
 * silently wrong answer about which revocations postdate the snapshot.
 */
import type { BackupManifest } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { BackupsRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import { readJson, readNumber, readText, writeJson, type PgRow } from "../rows";

/** The one place a row of `backup_manifests` becomes a `BackupManifest`. */
function map(row: PgRow): BackupManifest {
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

/** Bind the `backup_manifests` repository to one connection or transaction. */
export function createPgBackupsRepo(sql: Sql | TransactionSql): BackupsRepo {
  return {
    async insert(input) {
      const manifest: BackupManifest = {
        id: input.id,
        createdAt: input.createdAt ?? nowIso(),
        digest: input.digest,
        byteSize: input.byteSize,
        files: input.files,
        revocationSeq: input.revocationSeq,
        keyId: input.keyId,
      };
      await sql`
        insert into hosted.backup_manifests
          (id, created_at, digest, byte_size, files, revocation_seq, key_id)
        values
          (${manifest.id}, ${manifest.createdAt}, ${manifest.digest}, ${manifest.byteSize},
           ${writeJson(manifest.files)}, ${manifest.revocationSeq}, ${manifest.keyId})
      `;
      return manifest;
    },

    async latest() {
      const rows = (await sql`
        select * from hosted.backup_manifests order by created_at desc, id desc limit 1
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async list(opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      const rows = (await sql`
        select * from hosted.backup_manifests order by created_at desc, id desc limit ${limit}
      `) as unknown as PgRow[];
      return rows.map(map);
    },
  };
}
