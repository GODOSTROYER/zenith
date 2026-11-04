/**
 * Key purposes (PROD-OPS-05).
 *
 * Every key the control plane holds or trusts has exactly one purpose. A purpose
 * fixes which operations a key may be used for and which roles it may hold, so a
 * key (or key material) minted for one job can never quietly do another: the
 * result-sealing key cannot sign, a verify-only release key cannot encrypt, and a
 * decrypt-only historical key cannot seal new data.
 *
 * This file is vocabulary only (no environment, no I/O) so every consumer and the
 * operator CLI agree on the names.
 */

export const KEY_PURPOSES = [
  "signing:release",
  "signing:jobs",
  "signing:audit-export",
  "signing:oidc",
  "signing:plugin-publisher",
  "signing:template-attestation",
  "enc:vault",
  "enc:results",
  "enc:machine-results",
  "enc:temporal-payload",
  "enc:plan-artifacts",
  "enc:backup",
  "enc:archive",
  "tls:temporal-mtls",
] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

export type KeyOperation = "encrypt" | "decrypt" | "sign" | "verify";

/**
 * current        the one key that may produce new ciphertext / signatures
 * decrypt_only   historical encryption key kept so old data still opens
 * verify_only    public key kept so old or foreign signatures still verify
 */
export type KeyRole = "current" | "decrypt_only" | "verify_only";

export interface PurposeSpec {
  readonly family: "signing" | "encryption" | "transport";
  /** operations a key of this purpose may ever be used for */
  readonly operations: readonly KeyOperation[];
  /** what the purpose protects, in one operator-readable sentence */
  readonly protects: string;
  /** how an operator rotates it, in one sentence */
  readonly rotation: string;
}

export const PURPOSE_SPECS: Readonly<Record<KeyPurpose, PurposeSpec>> = {
  "signing:release": {
    family: "signing", operations: ["verify"],
    protects: "Signed runner and zenithd release manifests. The private key stays offline; the control plane only ever holds public keys.",
    rotation: "Sign new releases with a new offline key; pin both public keys on agents until every host has updated, then drop the old one.",
  },
  "signing:audit-export": {
    family: "signing", operations: ["sign", "verify"],
    protects: "Signed audit export chains (ZENITH_AUDIT_EXPORT_SIGNING_JWK), separate from capability grants.",
    rotation: "Switch to an independent audit key; retain prior public keys with exported chains for offline verification.",
  },
  "signing:jobs": {
    family: "signing", operations: ["sign", "verify"],
    protects: "Capability grants, runner jobs, machine requests and signed runbooks (ZENITH_CONTROL_SIGNING_JWK or ZENITH_CONTROL_KMS_KEY_ID).",
    rotation: "Publish the next public key in ZENITH_CONTROL_EXTRA_PUBLIC_JWKS, switch the signer, keep the old public key until its grants expire.",
  },
  "signing:oidc": {
    family: "signing", operations: ["sign", "verify"],
    protects: "Cloud workload-identity tokens (ZENITH_OIDC_SIGNING_JWK or ZENITH_OIDC_KMS_KEY_ID).",
    rotation: "Publish the next public key in ZENITH_OIDC_EXTRA_PUBLIC_JWKS at least 24 hours before switching the signer.",
  },
  "signing:plugin-publisher": {
    family: "signing", operations: ["verify"],
    protects: "Plugin manifest provenance (ZENITH_PLUGIN_TRUSTED_PUBLISHERS). Zenith never holds a publisher private key.",
    rotation: "Add the new publisher key id, re-register plugins signed by it, then remove the old key id.",
  },
  "signing:template-attestation": {
    family: "signing", operations: ["verify"],
    protects: "Hosted build template attestations (ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY). Zenith only verifies.",
    rotation: "Replace the public key and key id together once the publisher has switched.",
  },
  "enc:vault": {
    family: "encryption", operations: ["encrypt", "decrypt"],
    protects: "Vault secret values at rest (ZENITH_SECRET_KEY, previous keys in ZENITH_VAULT_PREVIOUS_SECRET_KEYS).",
    rotation: "Move the old key into ZENITH_VAULT_PREVIOUS_SECRET_KEYS, set the new key, run the vault rewrap, then retire the old key.",
  },
  "enc:results": {
    family: "encryption", operations: ["encrypt", "decrypt"],
    protects: "Runner and zenithd job results at rest (ZENITH_RUNNER_RESULT_KEY).",
    rotation: "Move the old key into ZENITH_RUNNER_RESULT_PREVIOUS_KEYS and set the new key; results are short-lived, so retire the old key after the result window.",
  },
  "enc:machine-results": {
    family: "encryption", operations: ["encrypt", "decrypt"],
    protects: "Machine replay artifacts and exec output cached for at-most-once dispatch (an HKDF domain of ZENITH_SECRET_KEY).",
    rotation: "Follows ZENITH_SECRET_KEY; cached artifacts expire after 30 days and fail closed when their key is gone.",
  },
  "enc:temporal-payload": {
    family: "encryption", operations: ["encrypt", "decrypt"],
    protects: "Temporal workflow and activity payloads (ZENITH_TEMPORAL_PAYLOAD_KEY, else an HKDF domain of ZENITH_SECRET_KEY).",
    rotation: "Add the old root to ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS on every client and worker before switching; keep it until no open or replayable history uses it.",
  },
  "enc:plan-artifacts": {
    family: "encryption", operations: ["encrypt", "decrypt"],
    protects: "Raw plan artifacts and standalone plan settlements (ZENITH_PLAN_ARTIFACT_KEY, previous keys in ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS).",
    rotation: "Move the old key into ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS and set the new key; plan custody owns the rewrap of its rows.",
  },
  "enc:archive": {
    family: "encryption", operations: ["encrypt", "decrypt"],
    protects: "Retention archives under a dedicated HKDF domain of ZENITH_BACKUP_KEY; never the hosted backup key bytes.",
    rotation: "Keep the prior backup root for archive restore; pruning refuses records with an unavailable historical derived key.",
  },
  "enc:backup": {
    family: "encryption", operations: ["encrypt", "decrypt"],
    protects: "Hosted backups (ZENITH_BACKUP_KEY). Must differ from every other encryption key.",
    rotation: "Backups carry their key id; keep the old key available to restore older backups. This build has no decrypt-only list for it.",
  },
  "tls:temporal-mtls": {
    family: "transport", operations: ["verify"],
    protects: "Mutual TLS to Temporal Cloud (ZENITH_TEMPORAL_TLS_*). Reported by certificate fingerprint and expiry only.",
    rotation: "Issue a new client certificate, update the files on every client and worker, restart them.",
  },
};

export function isKeyPurpose(value: unknown): value is KeyPurpose {
  return typeof value === "string" && (KEY_PURPOSES as readonly string[]).includes(value);
}

/** Which roles may perform which operation. Nothing else is ever allowed. */
export const ROLE_OPERATIONS: Readonly<Record<KeyRole, readonly KeyOperation[]>> = {
  current: ["encrypt", "decrypt", "sign", "verify"],
  decrypt_only: ["decrypt"],
  verify_only: ["verify"],
};

export type KeyCustodyErrorCode =
  | "key_purpose_unknown"
  | "key_purpose_operation"
  | "key_role_operation"
  | "key_unavailable"
  | "key_config_invalid"
  | "key_purpose_violation";

/** Fixed guidance only. Never carries key material, key ids of other purposes or raw configuration. */
export class KeyCustodyError extends Error {
  constructor(readonly code: KeyCustodyErrorCode, message: string) {
    super(message);
    this.name = "KeyCustodyError";
  }
}
