/**
 * The key registry (PROD-OPS-05).
 *
 * One place that knows every key the control plane holds or trusts, which
 * purpose each one has, and which role it plays (current, decrypt-only,
 * verify-only). Consumers that need key material ask the ring for a purpose and
 * an operation; the ring refuses anything the purpose or the role does not
 * allow. Descriptors (id, purpose, role, source) are safe to print; material is
 * held in a JavaScript-private field and never appears in descriptors, errors,
 * JSON or inspection output.
 *
 * What this is not: a KMS. Symmetric keys still arrive through environment
 * variables, exactly as before; the registry adds purpose separation, refusal,
 * decrypt-only histories and diagnostics on top of them. The control plane
 * never holds a release private key (they are offline), and KMS-backed signing
 * keys never expose material at all.
 *
 * Key ids are non-secret and purpose-bound: HMAC-SHA256 keyed by the material
 * over a purpose label, truncated, so one key reused under two purposes would
 * not even share an id (and is reported as a violation). The Temporal payload id
 * is the one exception: it is the id already written into every payload, so an
 * operator can match a stuck history to a key.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";
import { loadCredentialsConfig } from "@/lib/credentials/config";
import { CredentialConfigError } from "@/lib/credentials/errors";
import { algForKey, parseJwkEnvValue, publicJwkFromKey } from "@/lib/credentials/signing/jwk";
import type { SigningAlg } from "@/lib/credentials/signing/types";
import { decodeSecretKey } from "@/lib/env";
import {
  KEY_PURPOSES, PURPOSE_SPECS, ROLE_OPERATIONS, KeyCustodyError, isKeyPurpose,
  type KeyOperation, type KeyPurpose, type KeyRole,
} from "./purposes";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type KeyDerivation =
  | "direct"
  | "hkdf-of-secret-key"
  | "hkdf-of-signing-key"
  | "public-key"
  | "kms"
  | "certificate";

/** Everything about a key that is safe to show an operator. */
export interface KeyDescriptor {
  purpose: KeyPurpose;
  keyId: string;
  role: KeyRole;
  /** the configuration variable (or file) the key comes from; never its value */
  source: string;
  derivation: KeyDerivation;
  algorithm: string;
  /** certificates only: expiry, ISO 8601 */
  notAfter?: string;
}

export type ViolationSeverity = "error" | "warning" | "notice";
export interface KeyViolation {
  severity: ViolationSeverity;
  code: string;
  purposes: KeyPurpose[];
  /** fixed guidance; no key ids, no material */
  message: string;
}

interface Held extends KeyDescriptor { material?: Buffer }

/* --------------------------------- ids ---------------------------------- */

export function symmetricKeyId(purpose: KeyPurpose, key: Uint8Array): string {
  return createHmac("sha256", key).update(`zenith.key-id.v1|${purpose}`).digest("hex").slice(0, 16);
}

/** The id the Temporal codec writes into every payload (sha256 of the derived key, 32 hex). */
export function temporalPayloadKeyId(derivedKey: Uint8Array): string {
  return createHash("sha256").update(derivedKey).digest("hex").slice(0, 32);
}

/** HKDF info strings; identical to the ones the codec and the machine sealer have always used. */
export const TEMPORAL_KEY_INFO = "zenith.temporal.payload.v1";
export const MACHINE_RESULT_KEY_INFO = "zenith.machine.results.v1";
export const RUNNER_RESULT_KEY_INFO = "zenith.runner.result-seal.v1";

const hkdf = (root: Uint8Array, info: string): Buffer => Buffer.from(hkdfSync("sha256", Buffer.from(root), Buffer.alloc(0), info, 32));

/* ------------------------------ config parsing ----------------------------- */

const invalid = (message: string): KeyCustodyError => new KeyCustodyError("key_config_invalid", message);

function jsonArray(variable: string, raw: string | undefined, shape: string): unknown[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw invalid(`${variable} must be a JSON array of ${shape}.`); }
  if (!Array.isArray(parsed)) throw invalid(`${variable} must be a JSON array of ${shape}.`);
  return parsed;
}

/** Vault format: 32-byte hex or base64. Messages are the ones the vault has always raised. */
function vaultKey(raw: unknown, variable: string): Buffer {
  if (typeof raw !== "string" || !/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9+/]{43}=?)$/.test(raw.trim())) throw invalid(`${variable} must contain 32-byte hex or base64 keys.`);
  const key = decodeSecretKey(raw);
  if (!key) throw invalid(`${variable} must contain 32-byte hex or base64 keys.`);
  return key;
}

function dedupe(entries: Held[]): Held[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const id = `${entry.purpose}|${entry.keyId}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

type Builder = (env: EnvSource) => Held[];

const BUILDERS: Record<KeyPurpose, Builder> = {
  "enc:vault"(env) {
    if (env.ZENITH_SECRET_KEY === undefined) return [];
    const out: Held[] = [{ purpose: "enc:vault", keyId: "", role: "current", source: "ZENITH_SECRET_KEY", derivation: "direct", algorithm: "AES-256-GCM", material: vaultKey(env.ZENITH_SECRET_KEY, "ZENITH_SECRET_KEY") }];
    for (const raw of jsonArray("ZENITH_VAULT_PREVIOUS_SECRET_KEYS", env.ZENITH_VAULT_PREVIOUS_SECRET_KEYS, "32-byte keys"))
      out.push({ purpose: "enc:vault", keyId: "", role: "decrypt_only", source: "ZENITH_VAULT_PREVIOUS_SECRET_KEYS", derivation: "direct", algorithm: "AES-256-GCM", material: vaultKey(raw, "ZENITH_VAULT_PREVIOUS_SECRET_KEYS") });
    return out;
  },

  "enc:plan-artifacts"(env) {
    if (!env.ZENITH_PLAN_ARTIFACT_KEY) return [];
    const parse = (raw: unknown, variable: string): Buffer => {
      const text = typeof raw === "string" ? raw.trim() : "";
      const bytes = /^[a-f0-9]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
      if (bytes.length !== 32) throw invalid(`${variable} must contain 32-byte hex or base64 keys.`);
      return bytes;
    };
    const out: Held[] = [{ purpose: "enc:plan-artifacts", keyId: "", role: "current", source: "ZENITH_PLAN_ARTIFACT_KEY", derivation: "direct", algorithm: "AES-256-GCM", material: parse(env.ZENITH_PLAN_ARTIFACT_KEY, "ZENITH_PLAN_ARTIFACT_KEY") }];
    for (const raw of jsonArray("ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS", env.ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS, "32-byte keys"))
      out.push({ purpose: "enc:plan-artifacts", keyId: "", role: "decrypt_only", source: "ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS", derivation: "direct", algorithm: "AES-256-GCM", material: parse(raw, "ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS") });
    return out;
  },

  "enc:archive"(env) {
    const raw = env.ZENITH_BACKUP_KEY;
    if (!raw?.trim()) return [];
    const root = decodeSecretKey(raw);
    if (!root) throw invalid("ZENITH_BACKUP_KEY must decode to 32 bytes.");
    return [{ purpose: "enc:archive", keyId: "", role: "current", source: "ZENITH_BACKUP_KEY (archive HKDF)", derivation: "hkdf-of-secret-key", algorithm: "AES-256-GCM", material: hkdf(root, "zenith.retention.archive.v1") }];
  },
  "enc:backup"(env) {
    const raw = env.ZENITH_BACKUP_KEY;
    if (raw === undefined || raw.trim() === "") return [];
    const key = decodeSecretKey(raw);
    if (!key) throw invalid("ZENITH_BACKUP_KEY must decode to 32 bytes.");
    return [{ purpose: "enc:backup", keyId: "", role: "current", source: "ZENITH_BACKUP_KEY", derivation: "direct", algorithm: "AES-256-GCM", material: key }];
  },

  "enc:results"(env) {
    const explicit = env.ZENITH_RUNNER_RESULT_KEY?.trim();
    const out: Held[] = [];
    // An unreadable signing key must not break an explicit result key; the legacy derivation is then simply absent.
    const legacy = (): Buffer | undefined => { try { return derivedResultKey(env); } catch { return undefined; } };
    if (explicit) {
      const key = Buffer.from(explicit, "base64url");
      if (key.length !== 32) throw invalid("ZENITH_RUNNER_RESULT_KEY must be 32 bytes, base64url.");
      out.push({ purpose: "enc:results", keyId: "", role: "current", source: "ZENITH_RUNNER_RESULT_KEY", derivation: "direct", algorithm: "AES-256-GCM", material: key });
      for (const prior of jsonArray("ZENITH_RUNNER_RESULT_PREVIOUS_KEYS", env.ZENITH_RUNNER_RESULT_PREVIOUS_KEYS, "32-byte base64url keys")) {
        const bytes = typeof prior === "string" ? Buffer.from(prior.trim(), "base64url") : Buffer.alloc(0);
        if (bytes.length !== 32) throw invalid("ZENITH_RUNNER_RESULT_PREVIOUS_KEYS must be a JSON array of 32-byte base64url keys.");
        out.push({ purpose: "enc:results", keyId: "", role: "decrypt_only", source: "ZENITH_RUNNER_RESULT_PREVIOUS_KEYS", derivation: "direct", algorithm: "AES-256-GCM", material: bytes });
      }
      // Results sealed before the explicit key existed were sealed under the key derived from the signing key.
      // Keep it decrypt-only so in-flight and recent results still open; it is reported as a legacy derivation.
      const old = legacy();
      if (old) out.push({ purpose: "enc:results", keyId: "", role: "decrypt_only", source: "ZENITH_CONTROL_SIGNING_JWK (legacy derivation)", derivation: "hkdf-of-signing-key", algorithm: "AES-256-GCM", material: old });
      return out;
    }
    const secret = loadCredentialsConfig(env).controlSigningJwk;
    if (!secret)
      throw invalid("ZENITH_RUNNER_RESULT_KEY is not set and there is no local ZENITH_CONTROL_SIGNING_JWK to derive a sealing key from (a KMS-backed signer exposes no private scalar); job results cannot be sealed.");
    const derived = derivedResultKey(env);
    if (!derived) throw invalid("ZENITH_CONTROL_SIGNING_JWK has no private scalar to derive the sealing key from; set ZENITH_RUNNER_RESULT_KEY.");
    out.push({ purpose: "enc:results", keyId: "", role: "current", source: "ZENITH_CONTROL_SIGNING_JWK (derived)", derivation: "hkdf-of-signing-key", algorithm: "AES-256-GCM", material: derived });
    return out;
  },

  "enc:machine-results"(env) {
    if (env.ZENITH_SECRET_KEY === undefined) return [];
    const root = /^[a-f0-9]{64}$/i.test(env.ZENITH_SECRET_KEY) ? Buffer.from(env.ZENITH_SECRET_KEY, "hex") : undefined;
    if (!root) throw invalid("Machine persistence requires the worker's 64-hex secret key.");
    const out: Held[] = [{ purpose: "enc:machine-results", keyId: "", role: "current", source: "ZENITH_SECRET_KEY", derivation: "hkdf-of-secret-key", algorithm: "AES-256-GCM", material: hkdf(root, MACHINE_RESULT_KEY_INFO) }];
    for (const raw of jsonArray("ZENITH_VAULT_PREVIOUS_SECRET_KEYS", env.ZENITH_VAULT_PREVIOUS_SECRET_KEYS, "32-byte keys")) {
      const prior = vaultKey(raw, "ZENITH_VAULT_PREVIOUS_SECRET_KEYS");
      out.push({ purpose: "enc:machine-results", keyId: "", role: "decrypt_only", source: "ZENITH_VAULT_PREVIOUS_SECRET_KEYS", derivation: "hkdf-of-secret-key", algorithm: "AES-256-GCM", material: hkdf(prior, MACHINE_RESULT_KEY_INFO) });
    }
    return out;
  },

  "enc:temporal-payload"(env) {
    // A blank variable is unset.
    const dedicated = env.ZENITH_TEMPORAL_PAYLOAD_KEY?.trim() || undefined;
    const rootRaw = dedicated ?? env.ZENITH_SECRET_KEY;
    if (!rootRaw) {
      if (env.ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS !== undefined) throw invalid("Temporal payload encryption requires ZENITH_SECRET_KEY (64 hex characters).");
      return [];
    }
    const source = dedicated !== undefined ? "ZENITH_TEMPORAL_PAYLOAD_KEY" : "ZENITH_SECRET_KEY";
    const derivation: KeyDerivation = dedicated !== undefined ? "direct" : "hkdf-of-secret-key";
    const root = (raw: unknown, variable: string): Buffer => {
      if (typeof raw !== "string" || !/^[a-f0-9]{64}$/i.test(raw)) throw invalid(`${variable} must be 64 hex characters.`);
      return Buffer.from(raw, "hex");
    };
    const make = (rootBytes: Buffer, role: KeyRole, from: string): Held => {
      const key = hkdf(rootBytes, TEMPORAL_KEY_INFO);
      return { purpose: "enc:temporal-payload", keyId: temporalPayloadKeyId(key), role, source: from, derivation, algorithm: "AES-256-GCM", material: key };
    };
    const out: Held[] = [make(root(rootRaw, source), "current", source)];
    for (const prior of jsonArray("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", env.ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS, "64-hex keys"))
      out.push(make(root(prior, "ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS"), "decrypt_only", "ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS"));
    return out;
  },

  "signing:audit-export": (env) => signingEntries("signing:jobs", "EdDSA", { ZENITH_CONTROL_SIGNING_JWK: env.ZENITH_AUDIT_EXPORT_SIGNING_JWK }).map(entry => ({ ...entry, purpose: "signing:audit-export" as const, source: "ZENITH_AUDIT_EXPORT_SIGNING_JWK" })),
  "signing:jobs": (env) => signingEntries("signing:jobs", "EdDSA", env),
  "signing:oidc": (env) => signingEntries("signing:oidc", "RS256", env),

  "signing:release"() {
    // By design the control plane holds no release key at all; see `violations()` for the offline-key check.
    return [];
  },

  "signing:plugin-publisher"(env) {
    const raw = env.ZENITH_PLUGIN_TRUSTED_PUBLISHERS?.trim();
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw invalid("ZENITH_PLUGIN_TRUSTED_PUBLISHERS must be valid JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("ZENITH_PLUGIN_TRUSTED_PUBLISHERS must map publisher ids to key lists.");
    const out: Held[] = [];
    for (const [publisher, keys] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(keys)) throw invalid("ZENITH_PLUGIN_TRUSTED_PUBLISHERS must map publisher ids to key lists.");
      for (const key of keys) {
        const keyId = key && typeof key === "object" ? (key as { keyId?: unknown }).keyId : undefined;
        if (typeof keyId !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(keyId)) throw invalid("ZENITH_PLUGIN_TRUSTED_PUBLISHERS holds an invalid key id.");
        out.push({ purpose: "signing:plugin-publisher", keyId: `${publisher}/${keyId}`, role: "verify_only", source: "ZENITH_PLUGIN_TRUSTED_PUBLISHERS", derivation: "public-key", algorithm: "Ed25519" });
      }
    }
    return out;
  },

  "signing:template-attestation"(env) {
    if (!env.ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY?.trim()) return [];
    const keyId = env.ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID?.trim();
    if (!keyId) throw invalid("ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID is required beside the attestation public key.");
    return [{ purpose: "signing:template-attestation", keyId, role: "verify_only", source: "ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY", derivation: "public-key", algorithm: "Ed25519" }];
  },

  "tls:temporal-mtls"() {
    // Certificate facts need file reads; see inspectTemporalMtls in diagnostics.ts.
    return [];
  },
};

/** The sealing key the result sealer has always derived from the control signing key's private scalar. */
function derivedResultKey(env: EnvSource): Buffer | undefined {
  const secret = loadCredentialsConfig(env).controlSigningJwk;
  if (!secret) return undefined;
  let d: unknown;
  try {
    const text = secret.reveal().trim();
    d = (JSON.parse(text.startsWith("{") ? text : Buffer.from(text, "base64").toString("utf8")) as { d?: unknown }).d;
  } catch {
    throw invalid("ZENITH_CONTROL_SIGNING_JWK is not valid JSON (or base64 of JSON).");
  }
  if (typeof d !== "string" || d.length !== 43) return undefined;
  return hkdf(Buffer.from(d, "base64url"), RUNNER_RESULT_KEY_INFO);
}

function signingEntries(purpose: "signing:jobs" | "signing:oidc", alg: SigningAlg, env: EnvSource): Held[] {
  const family = purpose === "signing:jobs" ? "control" : "oidc";
  const config = loadCredentialsConfig(env);
  const secret = family === "control" ? config.controlSigningJwk : config.oidcSigningJwk;
  const kms = family === "control" ? config.controlKmsKeyId : config.oidcKmsKeyId;
  const extra = family === "control" ? config.controlExtraPublicJwks : config.oidcExtraPublicJwks;
  const jwkVar = family === "control" ? "ZENITH_CONTROL_SIGNING_JWK" : "ZENITH_OIDC_SIGNING_JWK";
  const extraVar = family === "control" ? "ZENITH_CONTROL_EXTRA_PUBLIC_JWKS" : "ZENITH_OIDC_EXTRA_PUBLIC_JWKS";
  const out: Held[] = [];
  if (secret) {
    let jwk: Record<string, unknown>;
    try { jwk = parseJwkEnvValue(jwkVar, secret.reveal()); } catch { throw invalid(`${jwkVar} is not valid JSON (or base64 of JSON).`); }
    try {
      const priv = createPrivateKey({ key: jwk as never, format: "jwk" });
      if (algForKey(priv) !== alg) throw new Error();
      const kid = typeof jwk.kid === "string" && jwk.kid ? jwk.kid : undefined;
      out.push({ purpose, keyId: publicJwkFromKey(createPublicKey(priv), alg, kid).kid, role: "current", source: jwkVar, derivation: "direct", algorithm: alg });
    } catch { throw invalid(`${jwkVar} is not a valid private JWK for ${alg}.`); }
  } else if (kms) {
    out.push({ purpose, keyId: `kms:${kms}`, role: "current", source: family === "control" ? "ZENITH_CONTROL_KMS_KEY_ID" : "ZENITH_OIDC_KMS_KEY_ID", derivation: "kms", algorithm: alg });
  }
  if (extra) {
    let parsed: unknown;
    try { parsed = parseJwkEnvValue(extraVar, extra); } catch { throw invalid(`${extraVar} is not valid JSON (or base64 of JSON).`); }
    const list: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { keys?: unknown }).keys) ? (parsed as { keys: unknown[] }).keys : [parsed];
    for (const item of list) {
      if (!item || typeof item !== "object") throw invalid(`${extraVar} contains a non-object key entry.`);
      const jwk = item as Record<string, unknown>;
      if ("d" in jwk || "p" in jwk || "q" in jwk || "k" in jwk) throw invalid(`${extraVar} contains private key members; only public keys may be listed here.`);
      try {
        const pub = createPublicKey({ key: jwk as never, format: "jwk" });
        if (algForKey(pub) !== alg) throw new Error();
        const kid = typeof jwk.kid === "string" && jwk.kid ? jwk.kid : undefined;
        out.push({ purpose, keyId: publicJwkFromKey(pub, alg, kid).kid, role: "verify_only", source: extraVar, derivation: "public-key", algorithm: alg });
      } catch { throw invalid(`${extraVar} contains an invalid ${alg} public JWK.`); }
    }
  }
  return dedupe(out);
}

/* ----------------------------------- ring ---------------------------------- */

export interface KeyRingOptions {
  /** build only these purposes (a consumer never pays to parse signing keys) */
  purposes?: readonly KeyPurpose[];
}

export interface KeyMaterial { keyId: string; role: KeyRole; key: Buffer }

export class KeyRing {
  // JavaScript privacy: material must not be reachable through enumeration, JSON or debug output.
  readonly #held: Held[];
  readonly #errors: Map<KeyPurpose, KeyCustodyError>;
  readonly #built: ReadonlySet<KeyPurpose>;
  readonly #env: { releaseKeyOnline: boolean };

  private constructor(held: Held[], errors: Map<KeyPurpose, KeyCustodyError>, built: ReadonlySet<KeyPurpose>, releaseKeyOnline: boolean) {
    this.#held = held;
    this.#errors = errors;
    this.#built = built;
    this.#env = { releaseKeyOnline };
  }

  /** Never throws for bad configuration: errors are held per purpose and raised when that purpose is used. */
  static fromEnv(env: EnvSource = process.env, options: KeyRingOptions = {}): KeyRing {
    const purposes = options.purposes ?? KEY_PURPOSES;
    const held: Held[] = [];
    const errors = new Map<KeyPurpose, KeyCustodyError>();
    for (const purpose of purposes) {
      try {
        const built = BUILDERS[purpose](env);
        // Ids first, then de-duplication: the same key listed twice (or in hex and base64) is one key.
        for (const entry of built) if (!entry.keyId) entry.keyId = symmetricKeyId(purpose, entry.material!);
        held.push(...dedupe(built));
      } catch (error) {
        errors.set(purpose, error instanceof KeyCustodyError ? error
          : error instanceof CredentialConfigError ? invalid(`${error.message}`)
          : invalid(`The ${purpose} key configuration could not be read.`));
      }
    }
    return new KeyRing(held, errors, new Set(purposes), Boolean(env.ZENITH_RELEASE_KEY_FILE?.trim()));
  }

  /** Safe to print. */
  descriptors(purpose?: KeyPurpose): KeyDescriptor[] {
    return this.#held.filter((h) => !purpose || h.purpose === purpose).map(({ material: _material, ...descriptor }) => ({ ...descriptor }));
  }

  configurationErrors(): { purpose: KeyPurpose; code: string; message: string }[] {
    return [...this.#errors].map(([purpose, error]) => ({ purpose, code: error.code, message: error.message }));
  }

  /** Purposes this ring was asked to build and that have at least one key. */
  configuredPurposes(): KeyPurpose[] {
    return [...new Set(this.#held.map((h) => h.purpose))];
  }

  /**
   * The single gate for key material. `encrypt`/`sign` returns the current key only; `decrypt` returns the
   * current key then every decrypt-only key. A purpose that does not allow the operation, or a ring that
   * was not built for the purpose, is refused.
   */
  materialFor(purpose: KeyPurpose, operation: KeyOperation): KeyMaterial[] {
    if (!isKeyPurpose(purpose)) throw new KeyCustodyError("key_purpose_unknown", "Unknown key purpose.");
    if (!PURPOSE_SPECS[purpose].operations.includes(operation))
      throw new KeyCustodyError("key_purpose_operation", `A ${purpose} key may not be used to ${operation}.`);
    if (!this.#built.has(purpose)) throw new KeyCustodyError("key_unavailable", `This key ring was not built for ${purpose}.`);
    const failed = this.#errors.get(purpose);
    if (failed) throw failed;
    const usable = this.#held.filter((h) => h.material && ROLE_OPERATIONS[h.role].includes(operation) && h.purpose === purpose);
    if (!usable.length) throw new KeyCustodyError("key_unavailable", `No ${purpose} key is available for ${operation}.`);
    return usable.map((h) => ({ keyId: h.keyId, role: h.role, key: Buffer.from(h.material!) }));
  }

  /** One key for one operation; `keyId` selects a specific key and is refused when its role forbids the operation. */
  useKey(purpose: KeyPurpose, operation: KeyOperation, keyId?: string): Buffer {
    if (keyId === undefined) return this.materialFor(purpose, operation)[0].key;
    if (!isKeyPurpose(purpose)) throw new KeyCustodyError("key_purpose_unknown", "Unknown key purpose.");
    if (!PURPOSE_SPECS[purpose].operations.includes(operation))
      throw new KeyCustodyError("key_purpose_operation", `A ${purpose} key may not be used to ${operation}.`);
    const found = this.#held.find((h) => h.purpose === purpose && h.keyId === keyId && h.material);
    if (!found) throw new KeyCustodyError("key_unavailable", `The requested ${purpose} key is not available.`);
    if (!ROLE_OPERATIONS[found.role].includes(operation))
      throw new KeyCustodyError("key_role_operation", `A ${found.role.replace("_", "-")} ${purpose} key may not be used to ${operation}.`);
    return Buffer.from(found.material!);
  }

  /** Separation findings over the purposes this ring was built for. */
  violations(): KeyViolation[] {
    const out: KeyViolation[] = [];
    for (const { purpose } of this.configurationErrors())
      out.push({ severity: "error", code: "key_config_invalid", purposes: [purpose], message: `The ${purpose} key configuration is invalid; the purpose cannot be used until it is fixed.` });

    const direct = this.#held.filter((h) => h.material && h.derivation === "direct");
    const reported = new Set<string>();
    for (let i = 0; i < direct.length; i++) for (let j = i + 1; j < direct.length; j++) {
      const a = direct[i], b = direct[j];
      if (a.purpose === b.purpose || !a.material!.equals(b.material!)) continue;
      const pair = [a.purpose, b.purpose].sort() as KeyPurpose[];
      if (reported.has(pair.join("|"))) continue;
      reported.add(pair.join("|"));
      out.push({ severity: "error", code: "key_reused_across_purposes", purposes: pair, message: `${pair[0]} and ${pair[1]} share key material. Give each purpose its own key.` });
    }

    const has = (purpose: KeyPurpose, derivation: KeyDerivation): boolean => this.#held.some((h) => h.purpose === purpose && h.role === "current" && h.derivation === derivation);
    if (has("enc:results", "hkdf-of-signing-key"))
      out.push({ severity: "warning", code: "result_key_derived_from_signing_key", purposes: ["enc:results", "signing:jobs"], message: "Result sealing derives its key from the control signing key. Set ZENITH_RUNNER_RESULT_KEY so signing and encryption keys rotate independently." });
    for (const purpose of ["enc:temporal-payload", "enc:machine-results"] as const)
      if (has(purpose, "hkdf-of-secret-key"))
        out.push({ severity: "notice", code: "purpose_shares_root_with_vault", purposes: [purpose, "enc:vault"], message: `${purpose} is an HKDF domain of ZENITH_SECRET_KEY: domain-separated, but rotating the vault key rotates it too.` });
    if (this.#built.has("signing:release") && this.#env.releaseKeyOnline)
      out.push({ severity: "error", code: "release_private_key_online", purposes: ["signing:release"], message: "ZENITH_RELEASE_KEY_FILE is set in this environment. Release signing keys must stay offline; remove it from the control plane." });

    const jobs = this.#held.find((h) => h.purpose === "signing:jobs" && h.role === "current");
    const oidc = this.#held.find((h) => h.purpose === "signing:oidc" && h.role === "current");
    if (jobs && oidc && jobs.keyId === oidc.keyId)
      out.push({ severity: "error", code: "signing_key_reused", purposes: ["signing:jobs", "signing:oidc"], message: "The control-plane and OIDC signers use the same key. They must be independent keys." });
    return out;
  }

  /** Throws `key_purpose_violation` when any error-level finding exists (or any warning when `strict`). */
  assertSeparated(options: { strict?: boolean } = {}): void {
    const bad = this.violations().filter((v) => v.severity === "error" || (options.strict && v.severity === "warning"));
    if (bad.length) throw new KeyCustodyError("key_purpose_violation", `Key custody refused: ${bad.map((v) => v.code).join(", ")}.`);
  }
}
