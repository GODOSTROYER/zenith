/**
 * RFC 8414 authorization server metadata discovery and the checks Zenith needs
 * the configured issuer to pass (PROD-UX-02).
 *
 * Zenith is only the resource server: login, consent screens for third-party
 * clients, PKCE and token minting belong to the external authorization server
 * named by ZENITH_AGENT_OAUTH_ISSUER. Zenith publishes RFC 9728 protected
 * resource metadata naming that exact issuer and the exact audience; an MCP
 * client then fetches the issuer's own RFC 8414 (or OpenID Connect) metadata.
 * This module is that second hop, used by `npm run doctor` and by the client
 * conformance harness, so a misconfigured issuer is found before a user is.
 *
 * Discovery order follows the MCP authorization spec for an issuer with and
 * without a path component. The issuer in the document must equal the
 * configured issuer EXACTLY (RFC 8414 section 3.3), or the document is refused.
 */

export interface AsMetadata {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  jwks_uri?: unknown;
  revocation_endpoint?: unknown;
  registration_endpoint?: unknown;
  code_challenge_methods_supported?: unknown;
  grant_types_supported?: unknown;
  response_types_supported?: unknown;
  scopes_supported?: unknown;
  authorization_response_iss_parameter_supported?: unknown;
  [key: string]: unknown;
}

/** Candidate metadata URLs, in the order the MCP spec tries them. */
export function metadataCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const base = url.origin;
  return path
    ? [`${base}/.well-known/oauth-authorization-server${path}`, `${base}/.well-known/openid-configuration${path}`, `${base}${path}/.well-known/openid-configuration`]
    : [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`];
}

export interface DiscoveredMetadata {
  url: string;
  metadata: AsMetadata;
}

export async function fetchAuthorizationServerMetadata(issuer: string, fetcher: typeof fetch = fetch, timeoutMs = 5000): Promise<DiscoveredMetadata | undefined> {
  for (const url of metadataCandidates(issuer)) {
    try {
      const response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      if (!response.ok) continue;
      const metadata = (await response.json()) as AsMetadata;
      if (typeof metadata === "object" && metadata !== null) return { url, metadata };
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

export interface MetadataFinding {
  level: "fail" | "warn";
  message: string;
}

const isHttps = (value: unknown, allowLoopbackHttp: boolean): boolean => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (allowLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch { return false; }
};
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/**
 * What an MCP client needs from the issuer to complete the journey against
 * Zenith. `fail` findings break the journey; `warn` findings degrade it.
 */
export function checkAuthorizationServerMetadata(issuer: string, metadata: AsMetadata, expected: { jwksUrl?: string; allowLoopbackHttp?: boolean } = {}): MetadataFinding[] {
  const out: MetadataFinding[] = [];
  const allow = expected.allowLoopbackHttp === true;
  if (metadata.issuer !== issuer) out.push({ level: "fail", message: "The metadata issuer is not identical to the configured issuer (RFC 8414 section 3.3); clients must reject it." });
  if (!isHttps(metadata.authorization_endpoint, allow)) out.push({ level: "fail", message: "authorization_endpoint is missing or not HTTPS." });
  if (!isHttps(metadata.token_endpoint, allow)) out.push({ level: "fail", message: "token_endpoint is missing or not HTTPS." });
  if (!list(metadata.code_challenge_methods_supported).includes("S256")) out.push({ level: "fail", message: "code_challenge_methods_supported must include S256: MCP clients require PKCE." });
  const grants = metadata.grant_types_supported === undefined ? ["authorization_code"] : list(metadata.grant_types_supported);
  if (!grants.includes("authorization_code")) out.push({ level: "fail", message: "grant_types_supported does not include authorization_code." });
  if (expected.jwksUrl && metadata.jwks_uri !== expected.jwksUrl) out.push({ level: "fail", message: "jwks_uri differs from ZENITH_AGENT_OAUTH_JWKS: tokens would be verified against different keys than the issuer publishes." });
  if (!isHttps(metadata.revocation_endpoint, allow)) out.push({ level: "warn", message: "No revocation_endpoint: a client cannot revoke its access token at the issuer. Zenith revocation (/api/agent/oauth/revoke) still ends access to Zenith." });
  if (metadata.registration_endpoint === undefined) out.push({ level: "warn", message: "No registration_endpoint (dynamic client registration): clients such as Claude Code need a pre-registered client id." });
  if (metadata.authorization_response_iss_parameter_supported !== true) out.push({ level: "warn", message: "authorization_response_iss_parameter_supported is not true (RFC 9207): mix-up attacks are not mitigated at the client." });
  return out;
}
