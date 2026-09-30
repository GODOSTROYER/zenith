/**
 * Signer loading. Turns `CredentialsConfig` into `JwtSigner`s and public-key
 * sets, memoised per process (KMS `GetPublicKey` is a network call and a local
 * RSA import is not free) but re-evaluated whenever the underlying
 * configuration changes.
 *
 * Nothing here reads `process.env` directly except through
 * `loadCredentialsConfig` (the module's one config function).
 */
import { createHash, createPublicKey } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { loadCredentialsConfig, type CredentialsConfig, type EnvLike } from "../config";
import { CredentialConfigError } from "../errors";
import { algForKey, hasPrivateMembers, parseJwkEnvValue, publicJwkFromKey } from "./jwk";
import { KmsSigner } from "./kms";
import { LocalJwkSigner } from "./local";
import type { JwtSigner, PublicJwk, SigningAlg } from "./types";

export { generateSigningJwk, serializePrivateJwk, type GeneratedSigningKey } from "./keygen";
export { KmsSigner, derEcdsaToJose } from "./kms";
export { LocalJwkSigner } from "./local";
export { jwkThumbprint } from "./jwk";
export type { JwtSigner, PublicJwk, SigningAlg } from "./types";

export interface SignerDeps {
  /** injected KMS client (tests, or a pre-configured client); default is built from the key ARN's region */
  kmsClient?: KMSClient;
}

type Family = "oidc" | "control";

const FAMILY: Record<
  Family,
  { alg: SigningAlg; jwkVar: string; kmsVar: string; extraVar: string }
> = {
  oidc: {
    alg: "RS256",
    jwkVar: "ZENITH_OIDC_SIGNING_JWK",
    kmsVar: "ZENITH_OIDC_KMS_KEY_ID",
    extraVar: "ZENITH_OIDC_EXTRA_PUBLIC_JWKS",
  },
  control: {
    alg: "EdDSA",
    jwkVar: "ZENITH_CONTROL_SIGNING_JWK",
    kmsVar: "ZENITH_CONTROL_KMS_KEY_ID",
    extraVar: "ZENITH_CONTROL_EXTRA_PUBLIC_JWKS",
  },
};

function kmsRegion(keyId: string, fallback?: string): string | undefined {
  const m = /^arn:[^:]+:kms:([a-z0-9-]+):/.exec(keyId);
  return m?.[1] ?? fallback;
}

async function buildSigner(family: Family, config: CredentialsConfig, deps: SignerDeps): Promise<JwtSigner | undefined> {
  const f = FAMILY[family];
  const secret = family === "oidc" ? config.oidcSigningJwk : config.controlSigningJwk;
  const kmsKeyId = family === "oidc" ? config.oidcKmsKeyId : config.controlKmsKeyId;
  if (secret) return LocalJwkSigner.fromSecret(f.jwkVar, secret, { alg: f.alg });
  if (kmsKeyId) {
    const client = deps.kmsClient ?? new KMSClient({ region: kmsRegion(kmsKeyId, config.awsRegion), maxAttempts: 3 });
    return KmsSigner.create({ client, keyId: kmsKeyId, alg: f.alg, variable: f.kmsVar });
  }
  return undefined;
}

function fingerprint(family: Family, config: CredentialsConfig): string {
  const secret = family === "oidc" ? config.oidcSigningJwk : config.controlSigningJwk;
  const kms = family === "oidc" ? config.oidcKmsKeyId : config.controlKmsKeyId;
  if (secret) return `jwk:${createHash("sha256").update(secret.reveal()).digest("hex")}`;
  if (kms) return `kms:${kms}`;
  return "none";
}

const memo = new Map<Family, { fingerprint: string; promise: Promise<JwtSigner | undefined> }>();

async function getSigner(family: Family, env: EnvLike | undefined, deps: SignerDeps | undefined): Promise<JwtSigner | undefined> {
  const config = loadCredentialsConfig(env);
  // An injected client means a test (or a caller with special needs): never cache it.
  if (deps?.kmsClient) return buildSigner(family, config, deps);
  const fp = fingerprint(family, config);
  const hit = memo.get(family);
  if (hit && hit.fingerprint === fp) return hit.promise;
  const promise = buildSigner(family, config, deps ?? {});
  memo.set(family, { fingerprint: fp, promise });
  // A failed load must not poison the cache: the next call retries.
  promise.catch(() => {
    if (memo.get(family)?.promise === promise) memo.delete(family);
  });
  return promise;
}

/** The RS256 signer for cloud workload-identity tokens, or undefined when none is configured. */
export const getOidcSigner = (env?: EnvLike, deps?: SignerDeps): Promise<JwtSigner | undefined> => getSigner("oidc", env, deps);

/** The EdDSA signer for capability grants / job envelopes, or undefined when none is configured. */
export const getControlSigner = (env?: EnvLike, deps?: SignerDeps): Promise<JwtSigner | undefined> =>
  getSigner("control", env, deps);

/** Test helper: forget memoised signers. */
export function resetSignerCache(): void {
  memo.clear();
}

/**
 * Parse a JWKS / array / single JWK of PUBLIC keys (`ZENITH_*_EXTRA_PUBLIC_JWKS`).
 * Anything carrying private members is rejected outright — a private key in a
 * published JWKS is an incident, so the loader refuses to be the one that
 * publishes it.
 */
export function parseExtraPublicJwks(family: Family, raw: string | undefined): PublicJwk[] {
  if (!raw) return [];
  const f = FAMILY[family];
  const parsed = parseJwkEnvValue(f.extraVar, raw);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { keys?: unknown }).keys)
      ? ((parsed as { keys: unknown[] }).keys)
      : [parsed];
  const out: PublicJwk[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") throw new CredentialConfigError(f.extraVar, "contains a non-object key entry");
    const jwk = item as Record<string, unknown>;
    if (hasPrivateMembers(jwk)) {
      throw new CredentialConfigError(f.extraVar, "contains private key members; only public keys may be listed here");
    }
    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
    } catch {
      throw new CredentialConfigError(f.extraVar, "contains an invalid public JWK");
    }
    if (algForKey(publicKey) !== f.alg) {
      throw new CredentialConfigError(f.extraVar, `every key must be a ${f.alg} key`);
    }
    const kid = typeof jwk.kid === "string" && jwk.kid ? jwk.kid : undefined;
    out.push(publicJwkFromKey(publicKey, f.alg, kid));
  }
  return out;
}

/**
 * Public keys to publish for the OIDC issuer: the current signing key first,
 * then any extra (next / previous) keys. Rotation: add the next key to
 * `ZENITH_OIDC_EXTRA_PUBLIC_JWKS` ≥ 24 h before switching the signer, and keep
 * the retired key listed until every token it signed (≤ 5 min) has expired and
 * relying-party caches have turned over.
 */
export async function getOidcPublicJwks(env?: EnvLike, deps?: SignerDeps): Promise<PublicJwk[] | undefined> {
  const config = loadCredentialsConfig(env);
  const signer = await getOidcSigner(env, deps);
  if (!signer) return undefined;
  const keys = [signer.publicJwk(), ...parseExtraPublicJwks("oidc", config.oidcExtraPublicJwks)];
  return dedupeByKid(keys);
}

/** Pinned public keys accepted for capability grants: the signing key plus extras. */
export async function getControlVerificationKeys(env?: EnvLike, deps?: SignerDeps): Promise<PublicJwk[]> {
  const config = loadCredentialsConfig(env);
  const signer = await getControlSigner(env, deps);
  const keys = [...(signer ? [signer.publicJwk()] : []), ...parseExtraPublicJwks("control", config.controlExtraPublicJwks)];
  return dedupeByKid(keys);
}

function dedupeByKid(keys: PublicJwk[]): PublicJwk[] {
  const seen = new Set<string>();
  return keys.filter((k) => (seen.has(k.kid) ? false : (seen.add(k.kid), true)));
}
