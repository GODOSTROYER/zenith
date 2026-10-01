/**
 * `CredentialGrantSigner` — the `GrantSigner` port over the credential broker's
 * control-plane signer (`src/lib/credentials`, ADR-0006).
 *
 * The credential broker owns key material, key rotation, the pinned public-key
 * set and the grant format:
 *
 *     header  { "alg": "EdDSA", "typ": "zenith-grant+jwt", "kid": <thumbprint> }
 *     payload CapabilityGrantClaims
 *
 * The key is `ZENITH_CONTROL_SIGNING_JWK` (a private Ed25519 JWK, JSON or base64
 * of JSON) or `ZENITH_CONTROL_KMS_KEY_ID`; this module never sees it. An
 * execution surface verifies a grant with `verifyCapabilityGrant` from the same
 * module, which pins the public keys and (with the broker's grants table)
 * enforces single use and revocation.
 *
 * Failure mapping: a missing or unusable signing key is `signer_unavailable`
 * (`ready()` calls it BEFORE an approval is consumed); claims the signer refuses
 * are `grant_issue_failed`. Neither message contains key material or the token.
 */
import { GrantVerificationError, getControlSigner, signCapabilityGrant } from "@/lib/credentials";
import type { EnvLike } from "@/lib/credentials/config";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { BrokerError } from "./errors";
import type { GrantSigner } from "./ports";

const unavailable = (): BrokerError =>
  new BrokerError(
    "signer_unavailable",
    "Capability grants cannot be signed: the control-plane signing key is not configured or is unusable.",
    "Set ZENITH_CONTROL_SIGNING_JWK to a private Ed25519 JWK (or ZENITH_CONTROL_KMS_KEY_ID)."
  );

export class CredentialGrantSigner implements GrantSigner {
  /** `env` is injectable for tests; production reads the process environment. */
  constructor(private readonly env?: EnvLike) {}

  async ready(): Promise<void> {
    let signer;
    try {
      signer = await getControlSigner(this.env);
    } catch {
      throw unavailable();
    }
    if (!signer) throw unavailable();
  }

  async sign(claims: CapabilityGrantClaims): Promise<string> {
    try {
      return await signCapabilityGrant(claims, { env: this.env });
    } catch (error) {
      if (error instanceof GrantVerificationError) {
        if (error.code === "grant_no_keys") throw unavailable();
        throw new BrokerError("grant_issue_failed", error.message);
      }
      throw unavailable();
    }
  }
}
