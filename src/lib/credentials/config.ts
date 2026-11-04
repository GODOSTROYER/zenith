/**
 * The ONE place this module reads environment variables.
 *
 * (`src/lib/env.ts` is owned by another workstream; the variables below are
 * listed in the handoff so they can be added to that schema later. Until then
 * this function is authoritative.)
 *
 * | Variable                        | Meaning                                                        |
 * |---------------------------------|----------------------------------------------------------------|
 * | ZENITH_OIDC_ISSUER              | issuer URL override; default `<request origin>/api/oidc`      |
 * | ZENITH_OIDC_SIGNING_JWK         | private RSA JWK (RS256) — local signer (dev / small installs)  |
 * | ZENITH_OIDC_KMS_KEY_ID          | AWS KMS key id/ARN/alias (RSA_2048+, SIGN_VERIFY) — production |
 * | ZENITH_OIDC_EXTRA_PUBLIC_JWKS   | JWKS of additional PUBLIC keys to publish (next / previous)    |
 * | ZENITH_CONTROL_SIGNING_JWK      | private Ed25519 JWK — control-plane grants/jobs                |
 * | ZENITH_CONTROL_KMS_KEY_ID       | KMS key (ECC_NIST_EDWARDS25519) alternative for the above      |
 * | ZENITH_CONTROL_EXTRA_PUBLIC_JWKS| additional PUBLIC Ed25519 keys accepted when verifying grants  |
 *
 * Invariants:
 *  - Secret values are returned wrapped in `SecretString` so a stray
 *    `JSON.stringify(config)` cannot print them.
 *  - Errors name the variable and the problem, never the value.
 *  - Nothing here parses key material beyond "is this JSON / base64 of JSON";
 *    the signer loaders validate key semantics.
 */
import { CredentialConfigError } from "./errors";
import { SecretString } from "./secret";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface CredentialsConfig {
  /** validated issuer override, no trailing slash */
  oidcIssuer?: string;
  oidcSigningJwk?: SecretString;
  oidcKmsKeyId?: string;
  oidcExtraPublicJwks?: string;
  controlSigningJwk?: SecretString;
  controlKmsKeyId?: string;
  controlExtraPublicJwks?: string;
  /** region hint for the default KMS client when the key id is not an ARN */
  awsRegion?: string;
}

const PATH = "/api/oidc";

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

/**
 * Validate an issuer URL. AWS requires https; plain http is accepted only for
 * loopback development. No credentials, query or fragment; trailing slash is
 * stripped so `iss` is byte-identical everywhere it is compared.
 */
export function normalizeIssuer(variable: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CredentialConfigError(variable, "must be an absolute URL (for example https://zenith.example.com/api/oidc)");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new CredentialConfigError(variable, "must be an https URL (http is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CredentialConfigError(variable, "must not contain credentials, a query string or a fragment");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** `${ZENITH_OIDC_ISSUER ?? origin + "/api/oidc"}` — the single derivation of the issuer. */
export function resolveIssuer(config: Pick<CredentialsConfig, "oidcIssuer">, requestOrigin?: string): string | undefined {
  if (config.oidcIssuer) return config.oidcIssuer;
  if (!requestOrigin) return undefined;
  return normalizeIssuer("request origin", `${requestOrigin.replace(/\/+$/, "")}${PATH}`);
}

export function loadCredentialsConfig(env: EnvLike = process.env): CredentialsConfig {
  const issuerRaw = nonEmpty(env.ZENITH_OIDC_ISSUER);
  const oidcJwk = nonEmpty(env.ZENITH_OIDC_SIGNING_JWK);
  const oidcKms = nonEmpty(env.ZENITH_OIDC_KMS_KEY_ID);
  const controlJwk = nonEmpty(env.ZENITH_CONTROL_SIGNING_JWK);
  const controlKms = nonEmpty(env.ZENITH_CONTROL_KMS_KEY_ID);

  if (oidcJwk && oidcKms) {
    throw new CredentialConfigError(
      "ZENITH_OIDC_SIGNING_JWK",
      "set together with ZENITH_OIDC_KMS_KEY_ID; configure exactly one OIDC signer"
    );
  }
  if (controlJwk && controlKms) {
    throw new CredentialConfigError(
      "ZENITH_CONTROL_SIGNING_JWK",
      "set together with ZENITH_CONTROL_KMS_KEY_ID; configure exactly one control-plane signer"
    );
  }

  return {
    oidcIssuer: issuerRaw ? normalizeIssuer("ZENITH_OIDC_ISSUER", issuerRaw) : undefined,
    oidcSigningJwk: oidcJwk ? new SecretString(oidcJwk) : undefined,
    oidcKmsKeyId: oidcKms,
    oidcExtraPublicJwks: nonEmpty(env.ZENITH_OIDC_EXTRA_PUBLIC_JWKS),
    controlSigningJwk: controlJwk ? new SecretString(controlJwk) : undefined,
    controlKmsKeyId: controlKms,
    controlExtraPublicJwks: nonEmpty(env.ZENITH_CONTROL_EXTRA_PUBLIC_JWKS),
    awsRegion: nonEmpty(env.AWS_REGION) ?? nonEmpty(env.AWS_DEFAULT_REGION),
  };
}
