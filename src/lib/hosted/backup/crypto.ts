/**
 * Sealing and opening a backup: AES-256-GCM under `ZENITH_BACKUP_KEY`.
 *
 * A separate key from `ORRERY_SECRET_KEY` on purpose (decision R3-11): a host
 * compromise that reads the secret store must not also decrypt every backup
 * ever taken, and the backup key is supposed to live somewhere the host cannot
 * read at all.
 *
 * The sealed container, in order:
 *
 *     magic      4 bytes   "ZBKS"
 *     version    1 byte    0x01
 *     keyId      8 bytes   ASCII, the first 8 hex characters of sha256(key)
 *     iv        12 bytes   random per seal
 *     tag       16 bytes   GCM authentication tag
 *     ciphertext rest
 *
 * The 41-byte header is the AAD, so the key id cannot be edited to make a
 * mismatch look like a match, and truncating or re-heading the file fails
 * authentication rather than decrypting to something.
 *
 * The key id is a *label*, not a check value: eight hex characters of the key's
 * own hash, enough to tell "the wrong key" from "the wrong file" in an error
 * message, far too little to help anyone recover the key.
 *
 * Workstream W8 (hosted R3).
 */
import crypto from "node:crypto";
import { HostedError } from "@/lib/hosted/contracts";
import { decodeSecretKey } from "@/lib/env";

const MAGIC = Buffer.from("ZBKS", "ascii");
const VERSION = 1;
const KEY_ID_BYTES = 8;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES + IV_BYTES + TAG_BYTES;

/** How to produce a valid `ZENITH_BACKUP_KEY`. One string, so every refusal says the same thing. */
export const BACKUP_KEY_FIX =
  "Set ZENITH_BACKUP_KEY in the server environment to a 32-byte key — generate one with `openssl rand -base64 32` (hex is accepted too) — and keep it somewhere the host itself cannot read. It must differ from ORRERY_SECRET_KEY, and a backup sealed under a lost key cannot be opened by anyone, including Zenith.";

/** The 32 raw bytes of `ZENITH_BACKUP_KEY`, or a refusal naming the fix. */
export function backupKey(): Buffer {
  const raw = process.env.ZENITH_BACKUP_KEY;
  if (raw === undefined || raw.trim() === "")
    throw new HostedError("policy_unavailable", "ZENITH_BACKUP_KEY is not set, so a backup cannot be encrypted or opened.", {
      fix: BACKUP_KEY_FIX,
    });
  const key = decodeSecretKey(raw);
  if (!key)
    throw new HostedError("policy_unavailable", `ZENITH_BACKUP_KEY is set (${raw.trim().length} characters, hidden) but does not decode to 32 bytes.`, {
      fix: BACKUP_KEY_FIX,
    });
  if (process.env.ORRERY_SECRET_KEY !== undefined && process.env.ORRERY_SECRET_KEY.trim() === raw.trim())
    throw new HostedError("policy_unavailable", "ZENITH_BACKUP_KEY is the same value as ORRERY_SECRET_KEY.", {
      fix: "Give the backup its own key. Sharing one means a host compromise that reads the secret store also decrypts every backup — the separation decision R3-11 exists for.",
    });
  return key;
}

/** True when this process holds a usable backup key. Never the value. */
export function backupKeyConfigured(): boolean {
  try {
    backupKey();
    return true;
  } catch {
    return false;
  }
}

/** The eight-character label for a key. Not a check value and not reversible. */
export const keyIdOf = (key: Buffer): string =>
  crypto.createHash("sha256").update(key).digest("hex").slice(0, KEY_ID_BYTES);

/** Seal a bundle. Returns the container described at the top of this file. */
export function seal(plain: Buffer, key: Buffer = backupKey()): { bytes: Buffer; keyId: string } {
  const keyId = keyIdOf(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), Buffer.from(keyId, "ascii"), iv]);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  // The tag is not known until `final()`, so the AAD covers the header without
  // it: magic, version, key id and iv — every field an attacker could edit to
  // make one file look like another.
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { bytes: Buffer.concat([header, cipher.getAuthTag(), ciphertext]), keyId };
}

/** The key id a sealed container names, without opening it. */
export function sealedKeyId(bytes: Buffer): string | null {
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  return bytes.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_BYTES).toString("ascii");
}

/**
 * Open a sealed backup, or refuse with the reason.
 *
 * The three refusals are deliberately different sentences: "this is not a
 * backup file", "this was sealed under a different key" and "this file has
 * been altered" send an operator to three different places.
 */
export function unseal(bytes: Buffer, key: Buffer = backupKey()): { plain: Buffer; keyId: string } {
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC))
    throw new HostedError("invalid_input", "That file is not a Zenith backup: it does not start with the ZBKS header.", {
      fix: "Point the restore at a file produced by `npm run hosted:backup` (or scripts/hosted/backup.ts) — the encrypted bundle, not the manifest.",
    });
  const version = bytes[MAGIC.length];
  if (version !== VERSION)
    throw new HostedError("invalid_input", `That backup is container version ${version}; this build reads version ${VERSION}.`, {
      fix: "Restore it with the Zenith build that wrote it, or take a fresh backup with this one.",
    });

  const keyId = bytes.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_BYTES).toString("ascii");
  const mine = keyIdOf(key);
  if (keyId !== mine)
    throw new HostedError("invalid_input", `That backup was sealed under key ${keyId} and this process holds key ${mine}.`, {
      fix: `Set ZENITH_BACKUP_KEY to the key this backup was made with (id ${keyId}). ${BACKUP_KEY_FIX}`,
      details: { expectedKeyId: keyId, presentKeyId: mine },
    });

  const header = bytes.subarray(0, MAGIC.length + 1 + KEY_ID_BYTES + IV_BYTES);
  const iv = bytes.subarray(MAGIC.length + 1 + KEY_ID_BYTES, MAGIC.length + 1 + KEY_ID_BYTES + IV_BYTES);
  const tag = bytes.subarray(header.length, header.length + TAG_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES);

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return { plain: Buffer.concat([decipher.update(ciphertext), decipher.final()]), keyId };
  } catch {
    throw new HostedError(
      "invalid_input",
      `That backup does not authenticate under key ${keyId}: its contents have been altered, truncated or corrupted since it was written.`,
      {
        fix: "Restore a different backup. Do not attempt to repair this file — an authenticated-encryption failure means the bytes are not the bytes that were sealed, and there is no way to tell which ones changed.",
        details: { keyId },
      }
    );
  }
}
