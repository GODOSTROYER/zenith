/**
 * Orrery's secret store — the smallest thing that is honestly a store.
 *
 * What it is: one file beside the snapshot (`<ORRERY_DATA>/secrets.json`,
 * mode 0600) holding, per workspace, one row per reference: the metadata
 * anybody may read, and the value sealed with AES-256-GCM under the server's
 * `ORRERY_SECRET_KEY`. The reference — `vault:<KEY>` — is the only part that
 * ever reaches a manifest, a revision, a diff, the audit log or an export.
 *
 * What it is not: a KMS. There is one key for the whole server, it lives in
 * the environment, there is no per-user access control and no way to export a
 * value. `docs/LIMITATIONS.md` says so in the same words.
 *
 * Without `ORRERY_SECRET_KEY` the store is *not configured*: every write is
 * refused, naming the variable and how to generate one. It never degrades to
 * writing plaintext.
 *
 * ponytail: read-through file access, no cache — the file is small and written
 * rarely, and a cache is a correctness bug the moment two things hold the data
 * directory. Move it behind the same interface if that stops being true.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decodeSecretKey, env, SECRET_KEY_FIX } from "@/lib/env";

/* ---------------------------------- shape --------------------------------- */

/** Everything about a stored secret except the value. Safe to send anywhere. */
export interface SecretMeta {
  /** e.g. "vault:STRIPE_API_KEY" */
  ref: string;
  createdAt: string;
  /** display name of the actor who first stored a value here */
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** 1 on first write, +1 per rotation */
  version: number;
}

/** What a read returns: metadata when there is a value, `exists: false` when not. */
export type SecretStatus = ({ exists: true } & SecretMeta) | { ref: string; exists: false };

interface StoredSecret extends SecretMeta {
  /** base64(iv).base64(authTag).base64(ciphertext) */
  cipher: string;
}

interface StoreFile {
  version: 1;
  /** workspaceId → ref → row */
  workspaces: Record<string, Record<string, StoredSecret>>;
}

const EMPTY: StoreFile = { version: 1, workspaces: {} };

/* ------------------------------- configuration ----------------------------- */

export const SECRET_STORE_UNCONFIGURED =
  "Orrery's secret store is not configured on this server, so there is nowhere to put the value.";

export interface StoreState {
  configured: boolean;
  /** why it cannot be written to — present only when `configured` is false */
  reason?: string;
  /** what to do about it — present only when `configured` is false */
  fix?: string;
}

/** Is there a usable key? Cheap; every write and every surface asks first. */
export function secretStoreState(): StoreState {
  return env().ORRERY_SECRET_KEY
    ? { configured: true }
    : { configured: false, reason: SECRET_STORE_UNCONFIGURED, fix: SECRET_KEY_FIX };
}

function requireKey(): Buffer {
  const raw = env().ORRERY_SECRET_KEY;
  // env() already rejects a malformed key at boot; this is the belt to that
  // brace, and the message a caller who skipped secretStoreState() deserves.
  const key = raw ? decodeSecretKey(raw) : undefined;
  if (!key) throw new Error(`${SECRET_STORE_UNCONFIGURED} ${SECRET_KEY_FIX}`);
  return key;
}

/* --------------------------------- crypto --------------------------------- */

/**
 * The workspace and the reference are authenticated alongside the value, so a
 * row copied to another ref or another workspace fails to open rather than
 * quietly handing back the wrong secret.
 */
const aad = (workspaceId: string, ref: string) => Buffer.from(`${workspaceId} ${ref}`, "utf8");

function seal(workspaceId: string, ref: string, value: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", requireKey(), iv);
  c.setAAD(aad(workspaceId, ref));
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

function unseal(workspaceId: string, ref: string, cipher: string): string {
  const [iv, tag, ct] = cipher.split(".").map((s) => Buffer.from(s, "base64"));
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", requireKey(), iv);
    d.setAAD(aad(workspaceId, ref));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    throw new Error(
      `The stored value for ${ref} cannot be opened with this server's ORRERY_SECRET_KEY. ` +
        `It was written under a different key, or the store file was altered. ` +
        `Restore the original key, or set a new value with system.rotateSecret — the old one is unrecoverable.`
    );
  }
}

/* ---------------------------------- file ---------------------------------- */

const storePath = () => path.join(env().ORRERY_DATA, "secrets.json");

function read(): StoreFile {
  const file = storePath();
  if (!fs.existsSync(file)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoreFile;
    return { ...EMPTY, ...parsed, workspaces: parsed.workspaces ?? {} };
  } catch {
    // Never start fresh here: that would silently discard every value. Refuse
    // loudly instead — the file is the only copy Orrery has.
    throw new Error(
      `${file} is not readable JSON, so Orrery cannot tell whether it holds your secrets. ` +
        `Restore it from a backup before writing anything else; nothing was changed.`
    );
  }
}

function write(data: StoreFile): void {
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

/* ---------------------------------- reads --------------------------------- */

/** Metadata for one reference. Never the value. */
export function secretStatus(workspaceId: string, ref: string): SecretStatus {
  const row = read().workspaces[workspaceId]?.[ref];
  if (!row) return { ref, exists: false };
  const { cipher: _cipher, ...meta } = row;
  return { ...meta, exists: true };
}

export const secretExists = (workspaceId: string, ref: string): boolean =>
  secretStatus(workspaceId, ref).exists;

/** Every reference this workspace has a value for, oldest first. Never values. */
export function listSecrets(workspaceId: string): SecretMeta[] {
  const rows = Object.values(read().workspaces[workspaceId] ?? {});
  return rows
    .map(({ cipher: _cipher, ...meta }) => meta)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * The plaintext value. SERVER ONLY, and deliberately awkward to reach: the
 * deploy path is the one legitimate caller, no API route returns this, and
 * nothing here logs it. Undefined when there is no such reference.
 */
export function readSecretValue(workspaceId: string, ref: string): string | undefined {
  const row = read().workspaces[workspaceId]?.[ref];
  return row && unseal(workspaceId, ref, row.cipher);
}

/* --------------------------------- writes --------------------------------- */

/** A value larger than this is a file, not a credential, and the store is JSON. */
const MAX_VALUE_BYTES = 8 * 1024;

function checkRef(ref: string): void {
  if (!ref.trim() || /[\s]/.test(ref))
    throw new Error(
      `"${ref}" is not a usable secret reference. Use a short name with no spaces, e.g. "vault:STRIPE_API_KEY".`
    );
}

function checkValue(value: string): void {
  if (value.length === 0)
    throw new Error("A secret needs a value. To remove one, use system.removeSecret instead.");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES)
    throw new Error(
      `That value is ${Buffer.byteLength(value, "utf8")} bytes and the store holds at most ${MAX_VALUE_BYTES}. ` +
        `Put a file that size in object storage and keep its credentials here.`
    );
}

/**
 * Store a value under `ref`, creating it or rotating it in place.
 * Returns the metadata that results, so the caller can report the version.
 */
export function putSecret(
  workspaceId: string,
  ref: string,
  value: string,
  by: string
): SecretMeta {
  requireKey();
  checkRef(ref);
  checkValue(value);

  const data = read();
  const bucket = (data.workspaces[workspaceId] ??= {});
  const prior = bucket[ref];
  const now = new Date().toISOString();
  const row: StoredSecret = {
    ref,
    createdAt: prior?.createdAt ?? now,
    createdBy: prior?.createdBy ?? by,
    updatedAt: now,
    updatedBy: by,
    version: (prior?.version ?? 0) + 1,
    cipher: seal(workspaceId, ref, value),
  };
  bucket[ref] = row;
  write(data);
  const { cipher: _cipher, ...meta } = row;
  return meta;
}

/**
 * Forget a value. Returns the metadata it had, or undefined if there was none.
 *
 * The one write that does not need the key: a delete cannot silently discard
 * something the caller thinks was saved, and refusing it would strand rows
 * forever on a server whose key has changed.
 */
export function removeSecret(workspaceId: string, ref: string): SecretMeta | undefined {
  const data = read();
  const row = data.workspaces[workspaceId]?.[ref];
  if (!row) return undefined;
  delete data.workspaces[workspaceId][ref];
  write(data);
  const { cipher: _cipher, ...meta } = row;
  return meta;
}
