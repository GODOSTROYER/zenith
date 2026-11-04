/**
 * RFC 7009 token revocation for every bearer Zenith's MCP endpoints accept
 * (PROD-UX-02). Possession of the token is the authorization to revoke it, as
 * RFC 7009 allows for public clients, so this needs no cookie and no client
 * secret and is reachable from a terminal, an SDK or a plugin.
 *
 *  - `za_` linked credential: revoked in the credential authority. Effective on
 *    the credential's next request because no verified credential is cached.
 *  - `zp_` plugin token: its grant is revoked. Effective on the next request
 *    because every plugin request re-reads grant, registration and parent.
 *  - anything else is an OAuth access token from the configured authorization
 *    server. Zenith is only the resource server, so it cannot invalidate the
 *    token at the issuer. It revokes the Zenith GRANT the user gave that
 *    (subject, client, issuer) in the named workspace. `bindGrant` requires a
 *    live grant on every request, so every token that client holds stops
 *    working on its next call. Refresh tokens belong to the issuer and are not
 *    revoked here (a revoked grant makes any access token minted from them
 *    useless to Zenith).
 *
 * Per RFC 7009 section 2.2 an unknown, expired or already-revoked token
 * answers 200 exactly like a revoked one, so the endpoint is not an oracle.
 * Errors that are about the request (not the token) are RFC 6749 errors.
 */
import type { OAuthConfig, VerifiedOAuth } from "../control/oauth";

export interface RevokeDeps {
  /** Throws (403) unless the request is for the configured Zenith host; returns the trusted origin. */
  checkOrigin(request: Request): string;
  /** Fixed-window limiter; throws a 429-coded error when exceeded. */
  limit(request: Request): Promise<void>;
  authority(): Promise<{
    verify(authorizationHeader: string | null): Promise<{ id: string; subject: string; workspaceId: string }>;
    revokeCredential(subject: string | null, workspaceId: string, credentialId: string): Promise<boolean>;
  }>;
  plugins?: { revokeByToken(token: string): Promise<boolean> };
  oauth: {
    config(origin: string): OAuthConfig | undefined;
    verify(token: string, config: OAuthConfig): Promise<VerifiedOAuth>;
    /** Mark the Zenith grant revoked. false when no such grant exists. */
    revokeGrant(identity: VerifiedOAuth, workspaceId: string): Promise<boolean>;
  };
  /** Resource identifiers an OAuth token may carry (v3 first, then v2). */
  resources(origin: string): string[];
}

const HEADERS = { "cache-control": "no-store", pragma: "no-cache", "x-content-type-options": "nosniff" };
const ID = /^[A-Za-z0-9_-]{1,100}$/;

function oauthError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status, headers: HEADERS });
}

async function readForm(request: Request): Promise<URLSearchParams | undefined> {
  if ((request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return undefined;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 20_000) return undefined;
  const text = await request.text();
  return text.length > 20_000 ? undefined : new URLSearchParams(text);
}

export async function revokeToken(request: Request, deps: RevokeDeps): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "invalid_request", error_description: "Use POST." }, { status: 405, headers: { ...HEADERS, allow: "POST" } });
  let origin: string;
  try {
    origin = deps.checkOrigin(request);
  } catch (error) {
    const status = (error as { status?: number }).status;
    return oauthError(status === 503 ? 503 : 403, status === 503 ? "temporarily_unavailable" : "invalid_request", "Use the configured Zenith host.");
  }
  try {
    await deps.limit(request);
  } catch (error) {
    if ((error as { status?: number }).status === 429) return Response.json({ error: "temporarily_unavailable", error_description: "Too many revocation requests." }, { status: 429, headers: { ...HEADERS, "retry-after": "60" } });
    return oauthError(503, "temporarily_unavailable", "Revocation is unavailable right now.");
  }
  const form = await readForm(request);
  const token = form?.get("token")?.trim();
  if (!form || !token || token.length > 16_384) return oauthError(400, "invalid_request", "Send application/x-www-form-urlencoded with a token parameter.");
  const hint = form.get("token_type_hint");
  if (hint !== null && hint !== "access_token" && hint !== "refresh_token") return oauthError(400, "unsupported_token_type", "token_type_hint must be access_token or refresh_token.");
  const clientId = form.get("client_id");
  const workspaceId = form.get("workspace") ?? request.headers.get("x-zenith-workspace");

  try {
    if (token.startsWith("za_")) {
      // A launcher child lives in plugin_grants, not agent_credentials. Revoke
      // that grant first; possession must never revoke its parent credential.
      if (await deps.plugins?.revokeByToken(token)) return new Response(null, { status: 200, headers: HEADERS });
      const authority = await deps.authority();
      let credential: { id: string; subject: string; workspaceId: string } | undefined;
      try { credential = await authority.verify(`Bearer ${token}`); } catch { credential = undefined; }
      if (credential) await authority.revokeCredential(credential.subject, credential.workspaceId, credential.id);
    } else if (token.startsWith("zp_")) {
      await deps.plugins?.revokeByToken(token);
    } else {
      const config = deps.oauth.config(origin);
      if (!config) return oauthError(503, "temporarily_unavailable", "OAuth is not configured on this deployment.");
      let verified: VerifiedOAuth | undefined;
      for (const resource of deps.resources(origin)) {
        try { verified = await deps.oauth.verify(token, { ...config, resource }); break; } catch { /* try the next audience */ }
      }
      if (verified) {
        if (clientId !== null && clientId !== verified.clientId) return oauthError(400, "invalid_client", "The token was not issued to this client.");
        if (!workspaceId || !ID.test(workspaceId)) return oauthError(400, "invalid_request", "Name the workspace the grant belongs to with the workspace parameter or the x-zenith-workspace header.");
        await deps.oauth.revokeGrant(verified, workspaceId);
      }
    }
  } catch {
    return oauthError(503, "temporarily_unavailable", "Revocation could not be completed. Repeat the request.");
  }
  return new Response(null, { status: 200, headers: HEADERS });
}
