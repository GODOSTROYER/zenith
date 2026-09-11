/**
 * Zenith's secret store — the smallest thing that is honestly a store.
 *
 * What it is: one row per (workspace, reference), holding the metadata anybody
 * may read and the value sealed with AES-256-GCM under the server's
 * `ZENITH_SECRET_KEY`. The reference — `vault:<projectId>/<serviceId>/<KEY>`,
 * see `vaultRef` below — is the only part that ever reaches a manifest, a
 * revision, a diff, the audit log or an export.
 *
 * **This file owns the crypto and nothing else owns any of it.** Where the
 * sealed bytes are kept is `./backend.ts`'s question: `<ZENITH_DATA>/secrets.json`
 * at mode 0600 (`./file-backend.ts`, the default and unchanged), or
 * `public.secrets` when `ZENITH_STORE=postgres` (`./pg-backend.ts`). A backend
 * never sees a plaintext value and never holds the key, so moving the rows to
 * Postgres gives the database ciphertext it cannot open — which is the whole
 * reason the seam is drawn here and not further down.
 *
 * What it is not: a KMS. There is one key for the whole server, it lives in
 * the environment, there is no per-user access control and no way to export a
 * value. `docs/LIMITATIONS.md` says so in the same words.
 *
 * Without `ZENITH_SECRET_KEY` the store is *not configured*: every write is
 * refused, naming the variable and how to generate one. It never degrades to
 * writing plaintext.
 */
import crypto from "node:crypto";
import { decodeSecretKey, env, SECRET_KEY_FIX } from "@/lib/env";
import { KEY_VERSION, secretsBackend, type SecretRecord } from "./backend";

/* ---------------------------------- shape --------------------------------- */

/** Everything about a stored secret except the value. Safe to send anywhere. */
export interface SecretMeta {
  /** e.g. "vault:kq3f9a2b1c/kq3f9axyz0/STRIPE_API_KEY" — see `vaultRef` */
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

/** The record minus everything sealed — what a caller is allowed to see. */
const metaOf = (record: SecretRecord): SecretMeta => ({
  ref: record.ref,
  createdAt: record.createdAt,
  createdBy: record.createdBy,
  updatedAt: record.updatedAt,
  updatedBy: record.updatedBy,
  version: record.version,
});

/** The storage seam, for anything that needs to know which one is in play. */
export { secretsBackend, type SecretRecord, type SecretsBackend } from "./backend";

/* -------------------------------- references ------------------------------- */

/** Marks a reference Zenith resolves itself, as opposed to your own manager. */
export { VAULT_PREFIX, isVaultRef, parseVaultRef, vaultRef, type VaultRefParts } from "./refs";

/**
 * THE SHAPE OF A GENERATED REFERENCE
 *
 *     vault:<projectId>/<serviceId>/<KEY>
 *
 * Four dimensions decide which value a variable reads, and all four are in
 * play: the workspace is applied by the store itself — rows are filed under it
 * and it is authenticated alongside the value (see `aad`) — so it is the one
 * that does not repeat in the string; project, service and key are here.
 *
 * Why: `vault:DATABASE_URL` is not a name, it is a collision. Two unrelated
 * services that both read DATABASE_URL would land on one row, so rotating one
 * would rewrite the other's credential and removing one would delete the value
 * the other still needs. Scoping the generated reference to the service that
 * asked for it makes the common case — same name, different value — separate
 * by default. Sharing is still possible and is now a thing you say out loud,
 * by passing an existing `secretRef` to `system.setSecret`.
 *
 * Ids, never names: services and projects get renamed, and a rename must not
 * strand a stored value or silently point a variable at a different one.
 *
 * LEGACY — `vault:<KEY>`, with no identity in it, is what Zenith wrote before
 * this and what older imports wrote. Those references stay exactly as
 * they are: they resolve, rotate and deploy unchanged, and a variable that
 * already points at one keeps it rather than being re-pointed at a new empty
 * reference (which would orphan the value it has). Nothing is migrated, so
 * nothing is lost; `parseVaultRef` tells the two apart for anything that wants
 * to say so.
 */

/* ------------------------------- configuration ----------------------------- */

export const SECRET_STORE_UNCONFIGURED =
  "Zenith's secret store is not configured on this server, so there is nowhere to put the value.";

export interface StoreState {
  configured: boolean;
  /** why it cannot be written to — present only when `configured` is false */
  reason?: string;
  /** what to do about it — present only when `configured` is false */
  fix?: string;
}

/** Is there a usable key? Cheap; every write and every surface asks first. */
export function secretStoreState(): StoreState {
  return env().ZENITH_SECRET_KEY
    ? { configured: true }
    : { configured: false, reason: SECRET_STORE_UNCONFIGURED, fix: SECRET_KEY_FIX };
}

function requireKey(): Buffer {
  const raw = env().ZENITH_SECRET_KEY;
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
 * quietly handing back the wrong secret. Unchanged by the storage seam, and it
 * has to be: rows written by any earlier Zenith open with exactly this.
 */
const aad = (workspaceId: string, ref: string) => Buffer.from(`${workspaceId} ${ref}`, "utf8");

/** The three sealed parts, base64. Joined by the file backend, columns in Postgres. */
type Sealed = Pick<SecretRecord, "iv" | "authTag" | "ciphertext">;

function seal(workspaceId: string, ref: string, value: string): Sealed {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", requireKey(), iv);
  c.setAAD(aad(workspaceId, ref));
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return {
    iv: iv.toString("base64"),
    authTag: c.getAuthTag().toString("base64"),
    ciphertext: ct.toString("base64"),
  };
}

function unseal(workspaceId: string, ref: string, sealed: Sealed): string {
  try {
    const d = crypto.createDecipheriv(
      "aes-256-gcm",
      requireKey(),
      Buffer.from(sealed.iv, "base64")
    );
    d.setAAD(aad(workspaceId, ref));
    d.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    return Buffer.concat([
      d.update(Buffer.from(sealed.ciphertext, "base64")),
      d.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      `The stored value for ${ref} cannot be opened with this server's ZENITH_SECRET_KEY. ` +
        `It was written under a different key, or the store file was altered. ` +
        `Restore the original key, or set a new value with system.rotateSecret — the old one is unrecoverable.`
    );
  }
}

/* ---------------------------------- reads --------------------------------- */

/** Metadata for one reference. Never the value. */
export function secretStatus(workspaceId: string, ref: string): SecretStatus {
  const record = secretsBackend().get(workspaceId, ref);
  if (!record) return { ref, exists: false };
  return { ...metaOf(record), exists: true };
}

/** Every reference this workspace has a value for, oldest first. Never values. */
export function listSecrets(workspaceId: string): SecretMeta[] {
  // Sorted here rather than in either backend, so both answer in one order.
  return secretsBackend()
    .list(workspaceId)
    .map(metaOf)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * The plaintext value. SERVER ONLY, and deliberately awkward to reach: the
 * deploy path is the one legitimate caller, no API route returns this, and
 * nothing here logs it. Undefined when there is no such reference.
 */
export function readSecretValue(workspaceId: string, ref: string): string | undefined {
  const record = secretsBackend().get(workspaceId, ref);
  return record && unseal(workspaceId, ref, record);
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

  const backend = secretsBackend();
  const prior = backend.get(workspaceId, ref);
  const now = new Date().toISOString();
  const record: SecretRecord = {
    ref,
    createdAt: prior?.createdAt ?? now,
    createdBy: prior?.createdBy ?? by,
    updatedAt: now,
    updatedBy: by,
    version: (prior?.version ?? 0) + 1,
    keyVersion: KEY_VERSION,
    ...seal(workspaceId, ref, value),
  };
  backend.put(workspaceId, record);
  return metaOf(record);
}

/**
 * Forget a value. Returns the metadata it had, or undefined if there was none.
 *
 * The one write that does not need the key: a delete cannot silently discard
 * something the caller thinks was saved, and refusing it would strand rows
 * forever on a server whose key has changed.
 */
export function removeSecret(workspaceId: string, ref: string): SecretMeta | undefined {
  const record = secretsBackend().remove(workspaceId, ref);
  return record && metaOf(record);
}
