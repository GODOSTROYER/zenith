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
 * deployment that already has the signing key needs nothing more. With a
 * KMS-backed signer (no `d` available) `ZENITH_RUNNER_RESULT_KEY` must be set.
 *
 * Honest limits: this protects the stored row (database dumps, replicas, a
 * read-only SQL user); it does not protect against someone holding the key, and
 * rotating the key makes results still in flight unreadable (they become
 * `uncertain` — short-lived rows, acceptable).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { RunnerConfigError } from "@/lib/runners/types";

export interface SealedBox {
  /** format version */
  v: 1;
  alg: "A256GCM";
  iv: string;
  ct: string;
  tag: string;
}

export interface ResultSealer {
  /** `aad` binds the box to its context, e.g. `${workspaceId}|${jobId}` */
  seal(aad: string, value: unknown): SealedBox;
  /** Throws when the box was tampered with, moved to another context, or sealed under another key. */
  open(aad: string, box: unknown): unknown;
}

export const isSealedBox = (v: unknown): v is SealedBox =>
  v !== null && typeof v === "object" && (v as SealedBox).v === 1 && (v as SealedBox).alg === "A256GCM" && typeof (v as SealedBox).iv === "string" && typeof (v as SealedBox).ct === "string" && typeof (v as SealedBox).tag === "string";

export function createAesResultSealer(key: Uint8Array): ResultSealer {
  if (key.length !== 32) throw new RunnerConfigError("The result sealing key must be 32 bytes.");
  const k = Buffer.from(key);
  return {
    seal(aad, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", k, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([cipher.update(JSON.stringify(value === undefined ? null : value), "utf8"), cipher.final()]);
      return { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: ct.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
    },
    open(aad, box) {
      if (!isSealedBox(box)) throw new Error("Not a sealed result.");
      const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(box.iv, "base64url"));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
      const pt = Buffer.concat([decipher.update(Buffer.from(box.ct, "base64url")), decipher.final()]);
      return JSON.parse(pt.toString("utf8"));
    },
  };
}

/** Derive the sealing key from `ZENITH_RUNNER_RESULT_KEY`, else from the signing JWK's private scalar. */
export function createResultSealerFromEnv(env: Record<string, string | undefined> = process.env): ResultSealer {
  const explicit = env.ZENITH_RUNNER_RESULT_KEY;
  if (explicit) {
    const key = Buffer.from(explicit, "base64url");
    if (key.length !== 32) throw new RunnerConfigError("ZENITH_RUNNER_RESULT_KEY must be 32 bytes, base64url.");
    return createAesResultSealer(key);
  }
  const raw = env.ZENITH_CONTROL_SIGNING_JWK;
  if (!raw) throw new RunnerConfigError("Neither ZENITH_RUNNER_RESULT_KEY nor ZENITH_CONTROL_SIGNING_JWK is set; job results cannot be sealed.");
  let d: unknown;
  try {
    d = (JSON.parse(raw) as { d?: unknown }).d;
  } catch {
    throw new RunnerConfigError("ZENITH_CONTROL_SIGNING_JWK is not valid JSON.");
  }
  if (typeof d !== "string" || d.length !== 43) throw new RunnerConfigError("ZENITH_CONTROL_SIGNING_JWK has no private scalar to derive the sealing key from; set ZENITH_RUNNER_RESULT_KEY.");
  const key = hkdfSync("sha256", Buffer.from(d, "base64url"), Buffer.alloc(0), "zenith.runner.result-seal.v1", 32);
  return createAesResultSealer(new Uint8Array(key));
}
