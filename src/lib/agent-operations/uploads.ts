/** Bounded immutable upload store. Source bytes never enter MCP tool output. */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openSync, closeSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { env } from "@/lib/env";
import { validateSource } from "@/lib/hosted/source";
import { journal } from "./application";
import { OperationError, assertUuid, digest, type Owner } from "./journal";
export const MAX_UPLOAD_BYTES = 5 * 1048576;
export interface Upload {
  id: string; appId: string; sha256: string; sourceDigest: string; fileCount: number;
  sourceBytes: number; archiveBytes: number; createdAt: number; expiresAt: number;
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function validateArchive(bytes: Buffer): { digest: string; fileCount: number; totalBytes: number } {
  if (bytes.length > MAX_UPLOAD_BYTES || !bytes.length) throw new OperationError("source_too_large", "Submit a nonempty archive of at most 5 MiB. Source is transferred outside model context.", 413);
  let validated;
  try { validated = validateSource({ kind: "tarball", bytes }); }
  catch { throw new OperationError("unsupported_source", "The archive does not satisfy Zenith's React/Vite frontend source contract. Use zenith.app.json and index.html, supported src/public files, no scripts/configuration/dependencies, dotfiles, traversal or links. Validate the original source locally for details.", 400); }
  for (const file of validated.files) {
    if (!/\.(?:tsx?|jsx?|json|html|css|md|txt)$/.test(file.path)) continue;
    const text = file.bytes.toString("utf8");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|\bza_[A-Za-z0-9_-]{43}\b/.test(text))
      throw new OperationError("source_contains_credential", "The source contains a recognizable credential or private key. Remove it, rotate any exposed credential, and rebuild the archive. Source bytes will not be accepted.", 400);
  }
  return { digest: validated.digest, fileCount: validated.files.length, totalBytes: validated.totalBytes };
}
export class UploadStore {
  constructor(private readonly sql: DatabaseSync, private readonly clock: () => number = Date.now) {
    sql.exec("PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const version = Number(sql.prepare("PRAGMA user_version").get()?.user_version);
    if (![0, 1].includes(version) || sql.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new OperationError("source_store_unavailable", "The upload store is incompatible or damaged. Stop publishing and restore a verified backup.", 503);
    sql.exec("CREATE TABLE IF NOT EXISTS agent_sources(id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, app_id TEXT NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL, metadata TEXT NOT NULL, expires_at INTEGER NOT NULL); PRAGMA user_version=1;");
  }
  close() { this.sql.close(); }
  put(id: string, owner: Owner, appId: string, bytes: Buffer, expectedDigest: string, validated: { digest: string; fileCount: number; totalBytes: number }): Upload {
    assertUuid(id);
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES || sha256(bytes) !== expectedDigest) throw new OperationError("source_digest_mismatch", "The received archive differs from its declared digest or size. Validate and submit the exact bytes again.", 400);
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.sql.prepare("SELECT owner_hash,app_id,digest,metadata FROM agent_sources WHERE id=?").get(id);
      if (prior) {
        if (prior.owner_hash !== digest(owner) || prior.app_id !== appId || prior.digest !== expectedDigest) throw new OperationError("upload_conflict", "That upload ID already identifies a different source or scope. Do not reuse it for another submission.");
        this.sql.exec("COMMIT"); return JSON.parse(String(prior.metadata)) as Upload;
      }
      this.sql.prepare("DELETE FROM agent_sources WHERE expires_at<?").run(this.clock());
      if (Number(this.sql.prepare("SELECT count(*) AS n FROM agent_sources").get()?.n) >= 100) throw new OperationError("upload_capacity", "The control host's upload store is full. Wait for unused uploads to expire or ask the operator to archive them.", 503);
      const now = this.clock();
      const data: Upload = { id, appId, sha256: expectedDigest, sourceDigest: validated.digest, fileCount: validated.fileCount, sourceBytes: validated.totalBytes, archiveBytes: bytes.length, createdAt: now, expiresAt: now + 86400000 };
      this.sql.prepare("INSERT INTO agent_sources(id,owner_hash,app_id,digest,bytes,metadata,expires_at) VALUES(?,?,?,?,?,?,?)").run(id, digest(owner), appId, expectedDigest, bytes, JSON.stringify(data), data.expiresAt);
      this.sql.exec("COMMIT"); return data;
    } catch (error) { this.sql.exec("ROLLBACK"); throw error; }
  }
  get(id: string, owner: Owner, appId: string): { metadata: Upload; bytes: Buffer } {
    assertUuid(id);
    const row = this.sql.prepare("SELECT owner_hash,app_id,digest,bytes,metadata,expires_at FROM agent_sources WHERE id=?").get(id);
    if (!row || row.owner_hash !== digest(owner) || row.app_id !== appId) throw new OperationError("source_not_found", "No uploaded source is permitted by this credential, selection and app. Upload the source under the correct scope.", 404);
    if (Number(row.expires_at) <= this.clock()) throw new OperationError("source_expired", "This upload expired. Validate and upload a new archive before preparing another publish.");
    const bytes = Buffer.from(row.bytes as Uint8Array);
    if (sha256(bytes) !== row.digest) throw new OperationError("source_corrupt", "Stored source failed its digest check. Stop publishing and inspect control-host storage.", 503);
    return { metadata: JSON.parse(String(row.metadata)) as Upload, bytes };
  }
}
type Globals = typeof globalThis & { __zenithAgentSources?: Map<string, UploadStore> };
export function uploads(): UploadStore {
  journal(); // establishes the single control process and private directory first
  const path = join(env().ZENITH_DATA, "agent-operations", "uploads.sqlite"), stores = (globalThis as Globals).__zenithAgentSources ??= new Map();
  let store = stores.get(path);
  if (!store) {
    try { closeSync(openSync(path, "wx", 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077)) throw new OperationError("source_store_unavailable", "Use an owned upload store with mode 0600 in the private operations directory.", 503);
    store = new UploadStore(new DatabaseSync(path)); stores.set(path, store);
  }
  return store;
}
