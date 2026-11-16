/**
 * HTTP handlers for the public OIDC endpoints. The route files under
 * `src/app/api/oidc/**` are one-line adapters over these so the logic is
 * testable without a Next runtime.
 *
 * Both endpoints are PUBLIC and unauthenticated by design — AWS (and any other
 * relying party) fetches them anonymously. They expose only the issuer
 * metadata and PUBLIC keys. The deployment's session middleware must let
 * `/api/oidc/.well-known/openid-configuration` and `/api/oidc/jwks` through
 * (see the handoff: `src/middleware.ts` is not owned by this module).
 *
 * Failure behaviour: an unconfigured or broken signer yields 503 with
 * `Cache-Control: no-store` and a fixed body — never a partial JWKS, never a
 * stack trace, never key material.
 */
import { loadCredentialsConfig, resolveIssuer, type EnvLike } from "../config";
import { CredentialConfigError, SigningError } from "../errors";
import { getOidcPublicJwks, type SignerDeps } from "../signing";
import { discoveryDocument, jwksDocument } from "./issuer";
import { log } from "@/lib/log";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" } as const;

const DISCOVERY_CACHE = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=300";
/** Short, so a key rotation reaches relying parties quickly. */
const JWKS_CACHE = "public, max-age=300, s-maxage=300, stale-while-revalidate=60";

function unavailable(error: string, detail: string): Response {
  return new Response(JSON.stringify({ error, detail }), {
    status: 503,
    headers: { ...JSON_HEADERS, "cache-control": "no-store" },
  });
}

function requestOrigin(req: Request): string | undefined {
  try {
    return new URL(req.url).origin;
  } catch {
    return undefined;
  }
}

export interface OidcHttpDeps extends SignerDeps {
  env?: EnvLike;
}

export async function discoveryResponse(req: Request, deps: OidcHttpDeps = {}): Promise<Response> {
  let issuer: string | undefined;
  let configured: boolean;
  try {
    const config = loadCredentialsConfig(deps.env);
    issuer = resolveIssuer(config, requestOrigin(req));
    configured = Boolean(config.oidcSigningJwk || config.oidcKmsKeyId);
  } catch (e) {
    return failure("oidc.discovery_failed", e);
  }
  if (!configured) {
    return unavailable("oidc_not_configured", "Set ZENITH_OIDC_SIGNING_JWK or ZENITH_OIDC_KMS_KEY_ID to enable the issuer.");
  }
  if (!issuer) return unavailable("oidc_not_configured", "The issuer URL could not be determined; set ZENITH_OIDC_ISSUER.");
  return new Response(JSON.stringify(discoveryDocument(issuer)), {
    status: 200,
    headers: { ...JSON_HEADERS, "cache-control": DISCOVERY_CACHE },
  });
}

export async function jwksResponse(_req: Request, deps: OidcHttpDeps = {}): Promise<Response> {
  try {
    const keys = await getOidcPublicJwks(deps.env, deps);
    if (!keys || keys.length === 0) {
      return unavailable("oidc_not_configured", "Set ZENITH_OIDC_SIGNING_JWK or ZENITH_OIDC_KMS_KEY_ID to enable the issuer.");
    }
    return new Response(JSON.stringify(jwksDocument(keys)), {
      status: 200,
      headers: { ...JSON_HEADERS, "cache-control": JWKS_CACHE },
    });
  } catch (e) {
    return failure("oidc.jwks_failed", e);
  }
}

function failure(event: string, e: unknown): Response {
  // Our own error classes carry messages that never include key material.
  const known = e instanceof CredentialConfigError || e instanceof SigningError;
  log.error(event, { name: e instanceof Error ? e.name : "unknown", ...(known ? { detail: (e as Error).message } : {}) });
  return unavailable("oidc_unavailable", "The OIDC issuer keys are temporarily unavailable.");
}
