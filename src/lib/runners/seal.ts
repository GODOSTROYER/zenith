/**
 * Sealing of job results at rest.
 *
 * A runner's result can carry exactly the material the platform must never
 * persist in the clear: an `aws.http` response body is whatever AWS answered
 * (ECR `GetAuthorizationToken`, STS `AssumeRole`, `GetSecretValue`, a decrypted
 * SSM parameter), and a `tofu show -json` plan holds sensitive values in
 * plaintext next to its `*_sensitive` markers. The awaiting side (an activity
 * in another process) can only learn the result through the store, so the store
 * row is the rendezvous. This module keeps that row opaque: the whole `result`
 * is AES-256-GCM sealed, bound (AAD) to its workspace and job id so a row cannot
 * be transplanted onto another job, and only `awaitRunnerJob` opens it.
 *
 * Key: `ZENITH_RUNNER_RESULT_KEY` (base64url, 32 bytes) if set; otherwise derived
 * with HKDF-SHA256 from the private scalar of `ZENITH_CONTROL_SIGNING_JWK`, so a
 * deployment that already has the signing key needs nothing more (the key
 * registry reports that derivation as a purpose-separation warning). With a
 * KMS-backed signer (no `d` available) `ZENITH_RUNNER_RESULT_KEY` must be set.
 * Every box names its key (`kid`, a non-secret id); retired keys stay in
 * `ZENITH_RUNNER_RESULT_PREVIOUS_KEYS` as decrypt-only (PROD-OPS-05).
 *
 * Honest limits: this protects the stored row (database dumps, replicas, a
 * read-only SQL user); it does not protect against someone holding the key, and
 * a result whose key has been dropped from the ring becomes unreadable (the
 * operation ends `uncertain` — short-lived rows, acceptable).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KeyCustodyError } from "@/lib/keycustody/purposes";
import { KeyRing } from "@/lib/keycustody/registry";
import { RunnerConfigError } from "@/lib/runners/types";

export interface SealedBox {
  /** format version */
  v: 1;
  alg: "A256GCM";
  iv: string;
  ct: string;
  tag: string;
  /** non-secret id of the sealing key; absent on boxes sealed before key ids existed */
  kid?: string;
}

export interface ResultSealer {
  /** `aad` binds the box to its context, e.g. `${workspaceId}|${jobId}` */
  seal(aad: string, value: unknown): SealedBox;
  /** Throws when the box was tampered with, moved to another context, or sealed under another key. */
  open(aad: string, box: unknown): unknown;
}

export const isSealedBox = (v: unknown): v is SealedBox =>
  v !== null && typeof v === "object" && (v as SealedBox).v === 1 && (v as SealedBox).alg === "A256GCM" && typeof (v as SealedBox).iv === "string" && typeof (v as SealedBox).ct === "string" && typeof (v as SealedBox).tag === "string"
  && ((v as SealedBox).kid === undefined || typeof (v as SealedBox).kid === "string");

export interface SealerKey { keyId: string; key: Uint8Array }
export interface AesSealerOptions {
  /** id written into every box this sealer seals; omit for the legacy id-less box */
  keyId?: string;
  /** decrypt-only: opens boxes sealed earlier, never seals */
  previous?: readonly SealerKey[];
}

export function createAesResultSealer(key: Uint8Array, options: AesSealerOptions = {}): ResultSealer {
  if (key.length !== 32) throw new RunnerConfigError("The result sealing key must be 32 bytes.");
  const k = Buffer.from(key);
  const prior = (options.previous ?? []).map((p) => {
    if (p.key.length !== 32) throw new RunnerConfigError("The result sealing key must be 32 bytes.");
    return { keyId: p.keyId, key: Buffer.from(p.key) };
  });
  const tryOpen = (candidate: Buffer, aad: string, box: SealedBox): unknown => {
    const decipher = createDecipheriv("aes-256-gcm", candidate, Buffer.from(box.iv, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
    const pt = Buffer.concat([decipher.update(Buffer.from(box.ct, "base64url")), decipher.final()]);
    return JSON.parse(pt.toString("utf8"));
  };
  return {
    seal(aad, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", k, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([cipher.update(JSON.stringify(value === undefined ? null : value), "utf8"), cipher.final()]);
      return { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: ct.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ...(options.keyId ? { kid: options.keyId } : {}) };
    },
    open(aad, box) {
      if (!isSealedBox(box)) throw new Error("Not a sealed result.");
      // A box that names its key is opened with exactly that key; an id-less (legacy) box tries each in order.
      const candidates = box.kid === undefined
        ? [k, ...prior.map((p) => p.key)]
        : box.kid === options.keyId ? [k] : prior.filter((p) => p.keyId === box.kid).map((p) => p.key);
      if (!candidates.length) throw new Error("The result's sealing key is not available.");
      let last: unknown;
      for (const candidate of candidates) {
        try { return tryOpen(candidate, aad, box); } catch (error) { last = error; }
      }
      throw last instanceof Error ? last : new Error("The sealed result could not be opened.");
    },
  };
}

/**
 * The result keys (`ZENITH_RUNNER_RESULT_KEY` plus decrypt-only `ZENITH_RUNNER_RESULT_PREVIOUS_KEYS`, else the
 * legacy HKDF of the control signing key's private scalar) are resolved by the key registry, which refuses to
 * hand out a key outside its purpose or role. Refusal messages are the ones this module always raised.
 */
export function createResultSealerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ResultSealer {
  const ring = KeyRing.fromEnv(env, { purposes: ["enc:results"] });
  try {
    const [current] = ring.materialFor("enc:results", "encrypt");
    const previous = ring.materialFor("enc:results", "decrypt")
      .filter((m) => m.role === "decrypt_only")
      .map((m) => ({ keyId: m.keyId, key: new Uint8Array(m.key) }));
    return createAesResultSealer(new Uint8Array(current.key), { keyId: current.keyId, previous });
  } catch (error) {
    if (error instanceof KeyCustodyError) throw new RunnerConfigError(error.message);
    throw error;
  }
}
