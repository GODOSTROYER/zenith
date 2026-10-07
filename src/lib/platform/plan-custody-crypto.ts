/**
 * Worker identity-bound custody wrap (PROD-DUR-05). Pure: no SQL, no plan bytes.
 *
 * A custody grant carries a random 32-byte read token sealed with AES-256-GCM under a key
 * derived (HKDF-SHA256) from the plan artifact key, the workspace and the WORKER IDENTITY. The
 * additional authenticated data is the whole binding: tenant, consuming operation, source
 * artifact, manifest digest, worker, fence and expiry. Opening therefore only succeeds for the
 * worker identity that presents itself, for that exact artifact and tenant, with the stored
 * expiry and fence unaltered. A copied, retargeted or edited grant row fails authentication.
 *
 * Honest scope: this binds authorization and audit to an identity and makes a stolen database
 * row useless to another identity. It does not stop a process that holds the plan artifact key
 * from decrypting the artifact itself; the artifact ciphertext remains sealed under the shared
 * plan key. Per-worker artifact re-wrapping (a KMS or HSM backed DEK) is a separate capability.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { stableJson } from "@/lib/tofu/stable";
import { planArtifactCipherFromEnv } from "./plan-artifacts";
import { WORKER_IDENTITY } from "@/lib/controlplane/db/repos/plan-custody";

export { WORKER_IDENTITY };

export interface CustodyBinding {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly sourceOperationId: string;
  readonly manifestDigest: string;
  readonly workerIdentity: string;
  readonly fenceToken: number;
  /** Canonical UTC ISO text exactly as the repository reads it back. */
  readonly expiresAt: string;
}
export interface CustodyWrap { readonly tokenDigest: string; readonly iv: string; readonly authTag: string; readonly ciphertext: string }
export interface CustodyCrypto {
  wrap(binding: CustodyBinding): CustodyWrap;
  /** True only when the wrap opens under THIS binding (including its worker identity) and its token digest matches. */
  opens(binding: CustodyBinding, wrap: CustodyWrap): boolean;
}

function keyBytes(raw: string): Buffer {
  const trimmed = raw.trim();
  return /^[a-f0-9]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
}
function derive(planKey: Buffer, binding: CustodyBinding): Buffer {
  const info = `zenith.plan-custody.unwrap.v1|${binding.workspaceId}|${binding.workerIdentity}`;
  return Buffer.from(hkdfSync("sha256", planKey, createHash("sha256").update("zenith.plan-custody.v1").digest(), info, 32));
}
const aad = (binding: CustodyBinding): Buffer => Buffer.from(stableJson({ format: "zenith.plan-custody-grant.v1", ...binding }));
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Keys come from the same validated plan-artifact key set as the artifact cipher; previous keys only open. */
export function planCustodyCryptoFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): CustodyCrypto {
  // Throws the shared, secret-free error when the key set is unavailable, malformed or overlaps the vault key.
  planArtifactCipherFromEnv(env);
  const current = keyBytes(env.ZENITH_PLAN_ARTIFACT_KEY!);
  const previous = (() => {
    const raw = env.ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS;
    if (!raw) return [] as Buffer[];
    const values: unknown = JSON.parse(raw);
    return Array.isArray(values) ? values.map(value => keyBytes(String(value))) : [];
  })();
  const all = [current, ...previous];
  return Object.freeze({
    wrap(binding: CustodyBinding): CustodyWrap {
      if (!WORKER_IDENTITY.test(binding.workerIdentity)) throw new Error("Worker identity is invalid.");
      const token = randomBytes(32), iv = randomBytes(12);
      try {
        const cipher = createCipheriv("aes-256-gcm", derive(current, binding), iv);
        cipher.setAAD(aad(binding));
        const ciphertext = Buffer.concat([cipher.update(token), cipher.final()]);
        return { tokenDigest: sha(token), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
      } finally { token.fill(0); }
    },
    opens(binding: CustodyBinding, wrap: CustodyWrap): boolean {
      if (!WORKER_IDENTITY.test(binding.workerIdentity)) return false;
      for (const key of all) {
        try {
          const iv = Buffer.from(wrap.iv, "base64"), tag = Buffer.from(wrap.authTag, "base64");
          if (iv.length !== 12 || tag.length !== 16) return false;
          const decipher = createDecipheriv("aes-256-gcm", derive(key, binding), iv);
          decipher.setAAD(aad(binding));
          decipher.setAuthTag(tag);
          const token = Buffer.concat([decipher.update(Buffer.from(wrap.ciphertext, "base64")), decipher.final()]);
          try {
            const expected = Buffer.from(wrap.tokenDigest, "hex"), actual = Buffer.from(sha(token), "hex");
            return expected.length === actual.length && timingSafeEqual(expected, actual);
          } finally { token.fill(0); }
        } catch { /* try the next overlapping key; authentication must succeed before anything is accepted */ }
      }
      return false;
    },
  });
}
