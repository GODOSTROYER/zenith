/**
 * Signing glue between the runner plane and the credential module's control-plane key.
 *
 * The control-plane key (EdDSA / Ed25519) belongs to `src/lib/credentials`
 * (`getControlSigner`, local JWK or KMS; `getControlVerificationKeys`). It signs
 * three things (RUNNER-PROTOCOL.md sections 1, 4, 5):
 *   - runner jobs         `typ: zenith-job+jwt`      (this module signs them)
 *   - zenithd requests    `typ: zenith-machine+jwt`  (this module signs them)
 *   - capability grants   `typ: zenith-grant+jwt`    (the broker issues them; `dispatch.ts`
 *                                                      verifies them with `verifyCapabilityGrant`)
 *
 * The protected header the credential signer emits is `alg`, `typ`, `kid` and
 * nothing else — the Go agents decode it with unknown members refused.
 *
 * Also here: Ed25519 verification of AGENT request signatures (`request-auth.ts`)
 * and a few pure helpers. Agent keys are raw 32-byte public keys (base64url),
 * the control plane's are JWKs; both reduce to the same node:crypto call.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { JwtSigner, PublicJwk } from "@/lib/credentials/signing/types";
import type { JwsTyp } from "@/lib/runners/types";

/** A control-plane public key as agents pin it (spec section 2). */
export interface ControlKey {
  kid: string;
  /** base64url of the raw 32-byte Ed25519 public key */
  publicKey: string;
}

export function controlKeyOf(jwk: Pick<PublicJwk, "kid" | "x">): ControlKey {
  if (!jwk.x) throw new Error("The control-plane signing key is not an Ed25519 (OKP) key.");
  return { kid: jwk.kid, publicKey: jwk.x };
}

/** Sign an envelope with the control-plane key: a compact JWS whose header is `{alg, typ, kid}`. */
export function signEnvelope(signer: JwtSigner, typ: JwsTyp, payload: object): Promise<string> {
  if (signer.alg !== "EdDSA") throw new Error("Runner envelopes must be signed with the EdDSA control-plane key.");
  return signer.sign({ typ }, payload as Record<string, unknown>);
}

/* ------------------------------ Ed25519 verification ------------------------------ */

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const keyCache = new Map<string, ReturnType<typeof createPublicKey>>();

/** Verify `data` against a raw base64url Ed25519 public key; false for any malformed input. */
export function verifyEd25519(publicKey: string, data: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64 || !PUBLIC_KEY.test(publicKey)) return false;
  try {
    let key = keyCache.get(publicKey);
    if (!key) {
      key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
      if (keyCache.size > 512) keyCache.clear();
      keyCache.set(publicKey, key);
    }
    return cryptoVerify(null, data, key, signature);
  } catch {
    return false;
  }
}

/** Read the claims of a compact JWS WITHOUT verifying it (for our own envelopes and diagnostics; never trust a foreign token's result). */
export function unverifiedClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
