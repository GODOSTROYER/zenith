/**
 * `artifacts` — the index of content-addressed build outputs.
 *
 * The bytes live in W2's artifact store; this table is the record that a
 * digest exists, what it contains and how it was produced. It is create-only
 * on purpose: an artifact is named by the SHA-256 of its own contents, so
 * "update" has no meaning — different bytes are a different row. `insert`
 * therefore ignores a repeat of the same digest rather than overwriting it,
 * and answers whether this call was the one that created it.
 *
 * `verified_at` is set by the trusted publisher only after recomputing the
 * digest over the stored bytes. A release may reference an unverified digest;
 * activating one is W7's refusal to make, with this column as the evidence.
 *
 * Workstream W1 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import type { Artifact, ArtifactProvenance } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readJson,
  readNumber,
  readOptionalText,
  readText,
  statements,
  writeJson,
  type Prepare,
  type SqlRow,
} from "../sql";

/** What the caller supplies to index an artifact. */
export interface NewArtifact {
  /** SHA-256 hex over the canonical output tree. 64 characters, enforced by the schema. */
  digest: string;
  byteSize: number;
  fileCount: number;
  provenance: ArtifactProvenance;
  createdAt?: string;
}

/** Reads and writes of the `artifacts` table. */
export interface ArtifactsRepo {
  /** Create-only. `inserted` is false when this digest was already indexed. */
  insert(input: NewArtifact): { artifact: Artifact; inserted: boolean };
  get(digest: string): Artifact | null;
  /** Stamp the publisher's verification. False when the digest is unknown. */
  markVerified(digest: string, now?: string): boolean;
  /** Every digest, newest first — the cleanup sweep walks it. */
  list(opts?: { limit?: number }): Artifact[];
}

const COLUMNS = "digest, byte_size, file_count, provenance, created_at, verified_at";

/** The one place a row of `artifacts` becomes an `Artifact`. */
function map(row: SqlRow): Artifact {
  return {
    digest: readText(row, "digest"),
    byteSize: readNumber(row, "byte_size"),
    fileCount: readNumber(row, "file_count"),
    provenance: readJson<ArtifactProvenance>(row, "provenance"),
    createdAt: readText(row, "created_at"),
    verifiedAt: readOptionalText(row, "verified_at"),
  };
}

/** Bind the `artifacts` repository to one connection. */
export function createArtifactsRepo(db: DatabaseSync): ArtifactsRepo {
  const sql: Prepare = statements(db);

  const byDigest = (digest: string): Artifact | null => {
    const row = sql(`SELECT ${COLUMNS} FROM artifacts WHERE digest = ?`).get(digest);
    return row ? map(row) : null;
  };

  return {
    insert(input) {
      const artifact: Artifact = {
        digest: input.digest,
        byteSize: input.byteSize,
        fileCount: input.fileCount,
        provenance: input.provenance,
        createdAt: input.createdAt ?? nowIso(),
      };
      const result = sql(
        `INSERT OR IGNORE INTO artifacts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, NULL)`
      ).run(
        artifact.digest,
        artifact.byteSize,
        artifact.fileCount,
        writeJson(artifact.provenance),
        artifact.createdAt
      );
      if (changeCount(result) === 1) return { artifact, inserted: true };
      return { artifact: byDigest(artifact.digest) ?? artifact, inserted: false };
    },

    get: byDigest,

    markVerified(digest, now = nowIso()) {
      const result = sql("UPDATE artifacts SET verified_at = ? WHERE digest = ?").run(now, digest);
      return changeCount(result) === 1;
    },

    list(opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 200));
      return sql(`SELECT ${COLUMNS} FROM artifacts ORDER BY created_at DESC, digest LIMIT ?`)
        .all(limit)
        .map(map);
    },
  };
}
