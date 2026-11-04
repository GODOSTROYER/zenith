/**
 * Zenith as an OpenID Connect issuer for cloud workload-identity federation
 * (ADR-0006).
 *
 * The customer's trust policy pins three things — issuer, audience and the
 * EXACT `sub` — so a token is only ever valid for one workspace + connection:
 *
 *     sub = zenith:ws:<workspaceId>:conn:<connectionId>
 *
 * Tokens live ≤ 5 minutes and are exchanged immediately (AWS
 * AssumeRoleWithWebIdentity). The token carries only non-secret identifiers
 * (`zenith_op`, `zenith_cap`); it is itself a bearer credential until it
 * expires, so it is never logged, persisted or returned — the broker keeps it
 * in a local variable for the single STS call.
 *
 * AWS session tags travel in the token (nested `https://aws.amazon.com/tags`
 * claim), not in an API parameter: `AssumeRoleWithWebIdentity` has no `Tags`
 * input. The customer role's trust policy must therefore allow
 * `sts:TagSession` (the shipped CloudFormation/OpenTofu templates do).
 */
import { randomUUID } from "node:crypto";
import { loadCredentialsConfig, resolveIssuer, type EnvLike } from "../config";
import { OidcError } from "../errors";
import { getOidcSigner } from "../signing";
import type { JwtSigner, PublicJwk } from "../signing/types";

/** Max lifetime of a minted workload token (ADR-0006: ≤ 5 minutes). */
export const MAX_WORKLOAD_TOKEN_TTL_SEC = 300;
export const DEFAULT_WORKLOAD_TOKEN_TTL_SEC = 120;

/** Audience AWS expects for its STS federation (the IAM OIDC provider's client id). */
export const AWS_STS_AUDIENCE = "sts.amazonaws.com";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CAPABILITY_PATTERN = /^[a-z][A-Za-z0-9.]{0,63}$/;
const AUDIENCE_PATTERN = /^[\x21-\x7e]{1,255}$/;
const TAG_KEY_PATTERN = /^[A-Za-z0-9 _.:/=+@-]{1,128}$/;

/** Claims a workload token may carry beyond the registered ones. */
export const OIDC_CLAIMS_SUPPORTED = [
  "iss",
  "sub",
  "aud",
  "iat",
  "nbf",
  "exp",
  "jti",
  "zenith_op",
  "zenith_cap",
  "https://aws.amazon.com/tags",
] as const;

/** `zenith:ws:<workspaceId>:conn:<connectionId>` — the exact subject customers pin. */
export function workloadSubject(workspaceId: string, connectionId: string): string {
  assertId("workspaceId", workspaceId);
  assertId("connectionId", connectionId);
  return `zenith:ws:${workspaceId}:conn:${connectionId}`;
}

function assertId(name: string, value: string): void {
  // `:` is excluded on purpose: it would let one id impersonate the structure
  // of another (`a:conn:b`), and customers pin the exact subject string.
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new OidcError("oidc_input_invalid", `${name} must match ${ID_PATTERN.source}`);
  }
}

export interface WorkloadTokenInput {
  workspaceId: string;
  connectionId: string;
  /** cloud audience, e.g. "sts.amazonaws.com" */
  audience: string;
  operationId: string;
  capability: string;
  /** default 120, max 300 */
  ttlSec?: number;
  /**
   * AWS session tags to embed (one string value per key). Requires the target
   * role's trust policy to allow `sts:TagSession`.
   */
  sessionTags?: Readonly<Record<string, string>>;
}

export interface WorkloadTokenDeps {
  signer?: JwtSigner;
  /** issuer to put in `iss`; default `ZENITH_OIDC_ISSUER` */
  issuer?: string;
  now?: Date;
  env?: EnvLike;
  /** deterministic `jti` for tests */
  jti?: string;
}

/**
 * Mint an RS256 workload-identity token. Throws `OidcError` for invalid input
 * or missing configuration; the message names the variable, never a value.
 */
export async function mintWorkloadToken(input: WorkloadTokenInput, deps: WorkloadTokenDeps = {}): Promise<string> {
  const sub = workloadSubject(input.workspaceId, input.connectionId);
  assertId("operationId", input.operationId);
  if (!CAPABILITY_PATTERN.test(input.capability)) {
    throw new OidcError("oidc_input_invalid", `capability must match ${CAPABILITY_PATTERN.source}`);
  }
  if (typeof input.audience !== "string" || !AUDIENCE_PATTERN.test(input.audience)) {
    throw new OidcError("oidc_input_invalid", "audience must be 1-255 printable characters without spaces");
  }
  const ttl = input.ttlSec ?? DEFAULT_WORKLOAD_TOKEN_TTL_SEC;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_WORKLOAD_TOKEN_TTL_SEC) {
    throw new OidcError("oidc_ttl_invalid", `ttlSec must be an integer between 1 and ${MAX_WORKLOAD_TOKEN_TTL_SEC}`);
  }

  const config = loadCredentialsConfig(deps.env);
  const issuer = deps.issuer ?? resolveIssuer(config);
  if (!issuer) {
    throw new OidcError(
      "oidc_issuer_unconfigured",
      "ZENITH_OIDC_ISSUER is not set; the token issuer must be configured explicitly outside a request context"
    );
  }
  const signer = deps.signer ?? (await getOidcSigner(deps.env));
  if (!signer) {
    throw new OidcError("oidc_signer_unconfigured", "Neither ZENITH_OIDC_SIGNING_JWK nor ZENITH_OIDC_KMS_KEY_ID is set");
  }
  if (signer.alg !== "RS256") {
    throw new OidcError("oidc_signer_algorithm", "The OIDC issuer signer must use RS256");
  }

  const iat = Math.floor((deps.now ?? new Date()).getTime() / 1000);
  const payload: Record<string, unknown> = {
    iss: issuer,
    sub,
    aud: input.audience,
    iat,
    nbf: iat,
    exp: iat + ttl,
    jti: deps.jti ?? randomUUID(),
    zenith_op: input.operationId,
    zenith_cap: input.capability,
  };
  if (input.sessionTags && Object.keys(input.sessionTags).length > 0) {
    payload["https://aws.amazon.com/tags"] = { principal_tags: awsPrincipalTags(input.sessionTags) };
  }
  return signer.sign({ typ: "JWT" }, payload);
}

/** AWS nested claim format: `{ key: [value] }`, max 50 tags, key ≤128, value ≤256, no `aws:` prefix. */
function awsPrincipalTags(tags: Readonly<Record<string, string>>): Record<string, string[]> {
  const entries = Object.entries(tags);
  if (entries.length > 50) throw new OidcError("oidc_input_invalid", "at most 50 session tags are allowed");
  const out: Record<string, string[]> = {};
  for (const [k, v] of entries) {
    if (!TAG_KEY_PATTERN.test(k) || /^aws:/i.test(k)) throw new OidcError("oidc_input_invalid", "invalid session tag key");
    if (typeof v !== "string" || v.length > 256) throw new OidcError("oidc_input_invalid", "invalid session tag value");
    out[k] = [v];
  }
  return out;
}

/* ------------------------------ discovery/JWKS ----------------------------- */

export interface OidcDiscoveryDocument {
  issuer: string;
  jwks_uri: string;
  response_types_supported: ["id_token"];
  subject_types_supported: ["public"];
  id_token_signing_alg_values_supported: ["RS256"];
  claims_supported: string[];
  scopes_supported: ["openid"];
}

/**
 * The discovery document. Deliberately minimal and honest: Zenith issues
 * machine tokens for workload federation; it has no browser login, so there
 * is no `authorization_endpoint` to advertise.
 */
export function discoveryDocument(issuer: string): OidcDiscoveryDocument {
  return {
    issuer,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: [...OIDC_CLAIMS_SUPPORTED],
    scopes_supported: ["openid"],
  };
}

export function jwksDocument(keys: readonly PublicJwk[]): { keys: PublicJwk[] } {
  return { keys: keys.map((k) => ({ ...k })) };
}
