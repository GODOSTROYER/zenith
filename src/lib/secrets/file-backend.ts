/**
 * The file backend: `<ZENITH_DATA>/secrets.json`, mode 0600.
 *
 * This is the store Zenith has always had, moved behind `SecretsBackend`
 * without changing one byte it writes. The on-disk shape is still
 *
 *     { "version": 1, "workspaces": { "<workspaceId>": { "<ref>": { …meta, "cipher": "iv.tag.ct" } } } }
 *
 * …with the three cipher parts joined by dots, because a file written by an
 * older Zenith must still open in this one and vice versa. `SecretRecord`'s
 * split parts are joined on the way out and split on the way in; nothing else
 * about the format moved, and `tests/secrets/**` passes unchanged.
 *
 * TODO(ceiling): read-through file access, no cache beyond the stat check below
 * — the file is small and written rarely, and a real cache is a correctness bug
 * the moment two processes hold the data directory.
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import type { SecretRecord, SecretsBackend } from "./backend";

/** What one row looks like on disk. `cipher` is the combined string. */
interface StoredSecret {
  ref: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  /** base64(iv).base64(authTag).base64(ciphertext) */
  cipher: string;
}

interface StoreFile {
  version: 1;
  /** workspaceId → ref → row */
  workspaces: Record<string, Record<string, StoredSecret>>;
}

const EMPTY: StoreFile = { version: 1, workspaces: {} };

/**
 * A row written before `key_version` existed was written by scheme 1, which is
 * the only scheme there has ever been. The file format does not carry the
 * number and does not gain it here: adding a field would change every byte of
 * every store file for information that is currently a constant.
 */
const FILE_KEY_VERSION = 1;

const toRecord = (row: StoredSecret): SecretRecord => {
  const [iv = "", authTag = "", ciphertext = ""] = row.cipher.split(".");
  return {
    ref: row.ref,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    version: row.version,
    keyVersion: FILE_KEY_VERSION,
    iv,
    authTag,
    ciphertext,
  };
};

const toStored = (record: SecretRecord): StoredSecret => ({
  ref: record.ref,
  createdAt: record.createdAt,
  createdBy: record.createdBy,
  updatedAt: record.updatedAt,
  updatedBy: record.updatedBy,
  version: record.version,
  cipher: [record.iv, record.authTag, record.ciphertext].join("."),
});

/* ---------------------------------- file ---------------------------------- */

/**
 * `ZENITH_DATA` is read live (scripts and tests set it at runtime), but the
 * join only has to happen when it actually moves.
 */
let pathCache: { dir: string; file: string } | undefined;

const storePath = (): string => {
  const dir = env().ZENITH_DATA;
  if (pathCache?.dir !== dir) pathCache = { dir, file: path.join(dir, "secrets.json") };
  return pathCache.file;
};

/**
 * The last parse of the store, and the stat that produced it. Every accessor
 * calls `read()`, so without this a screen listing ten references parsed (and
 * re-decoded) the whole file ten times. `mtimeMs` + `size` is the invalidation:
 * `write()` clears it outright, and an edit from outside this process moves
 * both. A stale cache can therefore only survive a change that keeps the size
 * AND the mtime, which the atomic rename in `write()` never does.
 */
let fileCache: { file: string; mtimeMs: number; size: number; data: StoreFile } | undefined;

function read(): StoreFile {
  const file = storePath();
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return structuredClone(EMPTY);
  if (
    fileCache &&
    fileCache.file === file &&
    fileCache.mtimeMs === stat.mtimeMs &&
    fileCache.size === stat.size
  )
    return fileCache.data;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoreFile;
    const data: StoreFile = { ...EMPTY, ...parsed, workspaces: parsed.workspaces ?? {} };
    fileCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  } catch {
    // Never start fresh here: that would silently discard every value. Refuse
    // loudly instead — the file is the only copy Zenith has.
    throw new Error(
      `${file} is not readable JSON, so Zenith cannot tell whether it holds your secrets. ` +
        `Restore it from a backup before writing anything else; nothing was changed.`
    );
  }
}

function write(data: StoreFile): void {
  // Drop the cache before touching the file, not after: both writers mutate
  // the object `read()` handed them, so the cached copy is already stale, and
  // a throw part-way through must not leave that copy readable.
  fileCache = undefined;
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // 0600 on create; chmod after in case the file already existed at 0644.
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows and some mounts do not carry POSIX modes. The value is still
    // encrypted at rest, which is what the file's protection actually rests on.
  }
}

/* -------------------------------- the backend ------------------------------ */

export const FileSecrets: SecretsBackend = {
  kind: "file",

  get(workspaceId, ref) {
    const row = read().workspaces[workspaceId]?.[ref];
    return row && toRecord(row);
  },

  list(workspaceId) {
    return Object.values(read().workspaces[workspaceId] ?? {}).map(toRecord);
  },

  put(workspaceId, record) {
    const data = read();
    (data.workspaces[workspaceId] ??= {})[record.ref] = toStored(record);
    write(data);
  },

  remove(workspaceId, ref) {
    const data = read();
    const row = data.workspaces[workspaceId]?.[ref];
    if (!row) return undefined;
    delete data.workspaces[workspaceId][ref];
    write(data);
    return toRecord(row);
  },
};
