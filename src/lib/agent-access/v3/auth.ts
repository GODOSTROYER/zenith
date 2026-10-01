/**
 * Authentication for the MCP v3 endpoint: a bearer, and only a bearer.
 *
 * The same two credential kinds as v2, resolved by the same code:
 *
 *  - `Authorization: Bearer za_…` — Zenith's own agent credential, verified
 *    against the credential authority on EVERY request (so revocation is
 *    immediate: there is no token cache). On a remote HTTPS origin only the
 *    Postgres authority is accepted; a file credential is loopback-only, as in v2.
 *  - any other bearer — an OAuth access token, verified as a resource server
 *    (`jose`, pinned issuer, JWKS, resource and client claim). The audience is
 *    THIS endpoint (`<origin>/api/agent/v3/mcp`), so a token minted for v2 is
 *    refused here, and the grant the user gave in the browser must agree with
 *    the token's scopes (`bindGrant` intersects them).
 *
 * What is never accepted: a browser cookie, a session, an `x-api-key`, a query
 * string token. A request with only cookies is `authentication_required` (401).
 * The MCP endpoint is exempt from the cookie middleware precisely because it
 * authenticates itself; it must not fall back to it.
 *
 * Everything external is injected (`AuthDeps`), so the decision logic is tested
 * without the v2 runtime. `auth-default.ts` supplies the real dependencies.
 */
import { MCP_PATH } from "./contract";
import { McpToolError } from "./errors";
import { principalFromIdentity, type AgentIdentity, type McpPrincipal } from "./principal";

/** A verified agent credential, as the credential authority returns it. */
export interface VerifiedCredential {
  id: string;
  subject: string;
  workspaceId: string;
  projectIds: readonly string[];
  environmentIds?: readonly string[];
  appIds?: readonly string[];
  scopes: readonly string[];
  expiresAt: string;
}

export interface AuthorityLike {
  readonly kind: "file" | "postgres";
  verify(authorizationHeader: string | null): Promise<VerifiedCredential>;
  touch(credentialId: string, at: string): Promise<void>;
}

export interface OAuthLike<Config = unknown, Verified = unknown> {
  /** `undefined` when OAuth is not configured on this deployment. The resource must be this endpoint. */
  config(origin: string): Config | undefined;
  verify(token: string, config: Config): Promise<Verified>;
  /** Intersect the token with the user's browser grant for the selected workspace. */
  bind(identity: Verified, workspaceId: string): Promise<AgentIdentity>;
}

export interface AuthDeps {
  /** Throws (403) unless the request is for the configured Zenith host. Returns the trusted origin. */
  checkOrigin(request: Request): string;
  authority(): Promise<AuthorityLike>;
  oauth: OAuthLike;
  now(): number;
}

export interface McpAuth {
  principal: McpPrincipal;
  origin: string;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const isId = (x: string | null | undefined): x is string => typeof x === "string" && ID.test(x);

/** The OAuth resource identifier for this endpoint. */
export const resourceFor = (origin: string): string => `${origin}${MCP_PATH}`;

/** RFC 9728 discovery URL. The caller must supply the checked, trusted origin. */
export const resourceMetadataFor = (origin: string): string => `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** Canonical v3 401 challenge; transport wiring belongs in server.ts. */
export const authenticationChallengeFor = (origin: string): string => `Bearer resource_metadata="${resourceMetadataFor(origin)}", scope="zenith:read"`;

/**
 * An optional header/query selection, validated against the grant. Tools carry
 * explicit ids; this exists so a client that sets the v2 headers is held to the
 * same limits, and so OAuth can pick the workspace its grant belongs to.
 */
function selection(request: Request): { workspaceId?: string; projectId?: string; environmentId?: string } {
  const params = new URL(request.url).searchParams;
  const take = (header: string, query: string): string | undefined => {
    const a = request.headers.get(header);
    const b = params.get(query);
    if (a && b && a !== b) throw new McpToolError("ambiguous_scope", "Header and URL selections conflict.", 400);
    return a ?? b ?? undefined;
  };
  const workspaceId = take("x-zenith-workspace", "workspace");
  const projectId = take("x-zenith-project", "project");
  const environmentId = take("x-zenith-environment", "environment");
  if ((workspaceId !== undefined && !isId(workspaceId)) || (projectId !== undefined && !isId(projectId)) || (environmentId !== undefined && (!isId(environmentId) || !projectId))) {
    throw new McpToolError("scope_required", "The workspace, project and environment selections are not valid identifiers.", 400);
  }
  return { workspaceId, projectId, environmentId };
}

function checkSelection(selected: ReturnType<typeof selection>, identity: AgentIdentity): void {
  if (
    (selected.workspaceId !== undefined && selected.workspaceId !== identity.workspaceId) ||
    (selected.projectId !== undefined && !identity.projectIds.includes(selected.projectId)) ||
    (selected.environmentId !== undefined && identity.environmentIds && !identity.environmentIds.includes(selected.environmentId))
  ) {
    throw new McpToolError("scope_denied", "The requested selection is outside this connection's grant.", 403);
  }
}

/** Best-effort "last used" recording: never awaited, never able to deny a request. */
const lastNoted = new Map<string, number>();
function noteUse(authority: AuthorityLike, credentialId: string, now: number): void {
  if ((lastNoted.get(credentialId) ?? 0) > now - 60_000) return;
  if (lastNoted.size > 2000) lastNoted.clear();
  lastNoted.set(credentialId, now);
  void authority.touch(credentialId, new Date(now).toISOString()).catch(() => undefined);
}

export async function authenticateMcp(request: Request, deps: AuthDeps): Promise<McpAuth> {
  const origin = deps.checkOrigin(request);
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ") || header.slice(7).trim() === "") {
    throw new McpToolError("authentication_required", "Authenticate with a scoped Zenith integration token as a bearer. Cookies and sessions are not accepted here.", 401);
  }
  const token = header.slice(7).trim();
  const now = deps.now();

  let identity: AgentIdentity;
  if (token.startsWith("za_")) {
    const authority = await deps.authority();
    if (!origin.startsWith("http://") && authority.kind !== "postgres") {
      throw new McpToolError("oauth_required", "Remote access requires OAuth or a linked credential; development credentials are accepted only on the loopback origin.", 401);
    }
    const credential = await authority.verify(header);
    identity = {
      subject: credential.subject,
      integrationId: credential.id,
      workspaceId: credential.workspaceId,
      projectIds: credential.projectIds,
      ...(credential.environmentIds ? { environmentIds: credential.environmentIds } : {}),
      ...(credential.appIds ? { appIds: credential.appIds } : {}),
      scopes: credential.scopes,
      expiresAt: credential.expiresAt,
    };
    noteUse(authority, credential.id, now);
    checkSelection(selection(request), identity);
  } else {
    const config = deps.oauth.config(origin);
    if (!config) throw new McpToolError("oauth_unavailable", "OAuth is not configured on this deployment; use a linked credential.", 503);
    const selected = selection(request);
    if (!selected.workspaceId) throw new McpToolError("scope_required", "Select the workspace the grant belongs to with the x-zenith-workspace header.", 400);
    const verified = await deps.oauth.verify(token, config);
    identity = await deps.oauth.bind(verified, selected.workspaceId);
    checkSelection(selected, identity);
  }
  return { principal: principalFromIdentity(identity, now), origin };
}
