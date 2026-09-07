/**
 * The sealed invitation payload: AES-256-GCM over the one thing this system
 * refuses to keep in clear.
 *
 * An invitation link is a bearer credential. `app_invites` stores only its
 * SHA-256, so the database cannot be turned back into a working link — but the
 * outbox has to be able to rebuild the email after a crash, and that needs the
 * token itself. So the token lives, for as long as one delivery row is
 * outstanding, as ciphertext under `ORRERY_SECRET_KEY`, and
 * `deliveries.clearSealedPayload` erases it the moment the row settles.
 *
 * The invitation id is the AAD, so a payload copied onto another delivery row —
 * or another invitation — fails to open rather than quietly handing back
 * somebody else's token. This mirrors `src/lib/secrets/index.ts` (workspace +
 * ref as AAD) deliberately, and does not import it: that store is a JSON file
 * of workspace secrets and has no business being reachable from app access.
 *
 * Workstream W5 (hosted R3).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HostedError } from "@/lib/hosted/contracts";
import { SECRET_KEY_FIX, decodeSecretKey, env } from "@/lib/env";

/** What one delivery needs to rebuild its email. Never leaves this process in clear. */
export interface SealedInvite {
  /** The single-use invitation token, base64url. */
  token: string;
  /** Lowercase recipient address, as stored on the invitation. */
  email: string;
  /** The app's display name, for the subject line. */
  appName: string;
  /** The control-origin URL the recipient opens. */
  acceptUrl: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export const NO_SECRET_KEY =
  "No ORRERY_SECRET_KEY is set, so an invitation token cannot be sealed for delivery and no invitation email can be sent.";

/** The 32-byte key, or `policy_unavailable` naming the fix. Never returns a guess. */
function key(): Buffer {
  const raw = env().ORRERY_SECRET_KEY;
  const decoded = raw ? decodeSecretKey(raw) : undefined;
  if (!decoded)
    throw new HostedError("policy_unavailable", NO_SECRET_KEY, { fix: SECRET_KEY_FIX });
  return decoded;
}

/** True when this process could seal a payload. Cheap; the invite path asks first. */
export function sealingConfigured(): boolean {
  const raw = env().ORRERY_SECRET_KEY;
  return !!raw && decodeSecretKey(raw) !== undefined;
}

/** Seal one invitation's delivery payload. `inviteId` is authenticated, not encrypted. */
export function sealInvite(inviteId: string, payload: SealedInvite): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(inviteId, "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

/**
 * Open a sealed payload. Throws when the key is different, the bytes were
 * altered, or the payload belongs to another invitation — all three are the
 * same answer on purpose, because telling them apart is an oracle over
 * ciphertext this process did not write.
 */
export function unsealInvite(inviteId: string, sealed: Uint8Array): SealedInvite {
  const refuse = (): never => {
    throw new HostedError(
      "internal",
      "The sealed invitation payload could not be opened with this server's ORRERY_SECRET_KEY.",
      {
        fix: "It was sealed under a different key, or the row was altered. Revoke the invitation and send a new one; the old link cannot be recovered.",
        details: { inviteId },
      }
    );
  };
  if (sealed.length <= IV_BYTES + TAG_BYTES) return refuse();
  const buf = Buffer.from(sealed);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(inviteId, "utf8"));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const clear = Buffer.concat([
      decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(clear) as Partial<SealedInvite>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.appName !== "string" ||
      typeof parsed.acceptUrl !== "string"
    )
      return refuse();
    return { token: parsed.token, email: parsed.email, appName: parsed.appName, acceptUrl: parsed.acceptUrl };
  } catch (err) {
    if (err instanceof HostedError && err.code === "policy_unavailable") throw err;
    return refuse();
  }
}
