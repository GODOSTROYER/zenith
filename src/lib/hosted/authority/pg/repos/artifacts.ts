/**
 * `hosted.artifacts` — the Postgres twin of `authority/repos/artifacts.ts`.
 *
 * Create-only, for the reason the SQLite file gives: an artifact is named by
 * the SHA-256 of its own contents, so "update" has no meaning — different bytes
 * are a different row. `INSERT OR IGNORE` is `on conflict (digest) do nothing`
 * here, and `changeCount(result) === 1` still answers the question the caller
 * actually asked, which is whether *this* call was the one that created it.
 *
 * `byte_size` and `file_count` are `bigint` and arrive as decimal strings;
 * `readNumber` in `../rows.ts` refuses anything past `Number.MAX_SAFE_INTEGER`
 * rather than rounding it.
 */
import type { Artifact, ArtifactProvenance } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { ArtifactsRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import {
  changeCount,
  readJson,
  readNumber,
  readOptionalText,
  readText,
  writeJson,
  type PgRow,
} from "../rows";

/** The one place a row of `artifacts` becomes an `Artifact`. */
function map(row: PgRow): Artifact {
  return {
    digest: readText(row, "digest"),
    byteSize: readNumber(row, "byte_size"),
    fileCount: readNumber(row, "file_count"),
    provenance: readJson<ArtifactProvenance>(row, "provenance"),
    createdAt: readText(row, "created_at"),
    verifiedAt: readOptionalText(row, "verified_at"),
  };
}

/** Bind the `artifacts` repository to one connection or transaction. */
export function createPgArtifactsRepo(sql: Sql | TransactionSql): ArtifactsRepo {
  const byDigest = async (digest: string): Promise<Artifact | null> => {
    const rows = (await sql`
      select * from hosted.artifacts where digest = ${digest}
    `) as unknown as PgRow[];
    return rows.length === 1 ? map(rows[0]) : null;
  };

  return {
    async insert(input) {
      const artifact: Artifact = {
        digest: input.digest,
        byteSize: input.byteSize,
        fileCount: input.fileCount,
        provenance: input.provenance,
        createdAt: input.createdAt ?? nowIso(),
      };
      const result = await sql`
        insert into hosted.artifacts
          (digest, byte_size, file_count, provenance, created_at, verified_at)
        values
          (${artifact.digest}, ${artifact.byteSize}, ${artifact.fileCount},
           ${writeJson(artifact.provenance)}, ${artifact.createdAt}, null)
        on conflict (digest) do nothing
      `;
      if (changeCount(result) === 1) return { artifact, inserted: true };
      return { artifact: (await byDigest(artifact.digest)) ?? artifact, inserted: false };
    },

    get: byDigest,

    async markVerified(digest, now = nowIso()) {
      const result = await sql`
        update hosted.artifacts set verified_at = ${now} where digest = ${digest}
      `;
      return changeCount(result) === 1;
    },

    async list(opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 200));
      const rows = (await sql`
        select * from hosted.artifacts order by created_at desc, digest limit ${limit}
      `) as unknown as PgRow[];
      return rows.map(map);
    },
  };
}
