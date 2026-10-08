import { LocalJwkSigner } from "@/lib/credentials/signing/local";
import { SecretString } from "@/lib/credentials/secret";
import { KeyRing, type EnvSource } from "@/lib/keycustody/registry";
import { KeyCustodyError } from "@/lib/keycustody/purposes";
import type { JwtSigner } from "@/lib/credentials/signing/types";

/** Audit authority has its own signing purpose. No jobs/release/KMS fallback. */
export function getAuditExportSigner(env: EnvSource = process.env): JwtSigner | undefined {
  const raw = env.ZENITH_AUDIT_EXPORT_SIGNING_JWK?.trim();
  if (!raw) return undefined;
  const ring = KeyRing.fromEnv(env, { purposes: ["signing:audit-export"] });
  if (ring.configurationErrors().length) throw new KeyCustodyError("key_config_invalid", "The audit export signing key is invalid.");
  const signer = LocalJwkSigner.fromSecret("ZENITH_AUDIT_EXPORT_SIGNING_JWK", new SecretString(raw), { alg: "EdDSA" });
  const own = signer.publicJwk();
  for (const [variable, alg] of [["ZENITH_CONTROL_SIGNING_JWK", "EdDSA"], ["ZENITH_OIDC_SIGNING_JWK", "RS256"]] as const) {
    const other = env[variable]?.trim();
    if (!other) continue;
    const key = LocalJwkSigner.fromSecret(variable, new SecretString(other), { alg }).publicJwk();
    if (own.kty === key.kty && own.x === key.x && own.crv === key.crv)
      throw new KeyCustodyError("key_purpose_violation", "Audit exports require a signing key independent of workload and capability authority.");
  }
  return signer;
}
