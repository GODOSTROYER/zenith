/** Process configuration is distinct from grants and application permissions. */
import { OperationError } from "./journal";
import { oauthConfig, type OAuthConfig } from "./access";
export interface AgentConfiguration {
  enabled: boolean; origin: string; mode: "local" | "oauth";
  grantsPath: string; operatorKeyPath: string; operatorOrigin: string;
  oauth?: OAuthConfig;
}
export function configuration(): AgentConfiguration {
  const enabled = process.env.ZENITH_AGENT_V2 === "1";
  const origin = process.env.ZENITH_AGENT_ORIGIN ?? "";
  const mode = process.env.ZENITH_AGENT_AUTH === "oauth" ? "oauth" : "local";
  if (!enabled) return { enabled: false, origin, mode, grantsPath: "", operatorKeyPath: "", operatorOrigin: "" };
  const bad = () => new OperationError("configuration_invalid", "Configure ZENITH_AGENT_ORIGIN as an exact trusted origin, ZENITH_AGENT_GRANTS_FILE as a private version-2 authority file, and an explicit local or oauth authentication mode.", 503);
  let url: URL;
  try { url = new URL(origin); } catch { throw bad(); }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !["local", "oauth"].includes(process.env.ZENITH_AGENT_AUTH ?? "local") || !process.env.ZENITH_AGENT_GRANTS_FILE) throw bad();
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(origin);
  if (mode === "local" && !loopback || mode === "oauth" && url.protocol !== "https:") throw bad();
  const result: AgentConfiguration = { enabled, origin, mode, grantsPath: process.env.ZENITH_AGENT_GRANTS_FILE,
    operatorKeyPath: process.env.ZENITH_AGENT_OPERATOR_KEY_FILE ?? "", operatorOrigin: process.env.ZENITH_AGENT_OPERATOR_ORIGIN ?? (loopback ? origin : "") };
  if (mode === "oauth") result.oauth = oauthConfig({ issuer: process.env.ZENITH_AGENT_OAUTH_ISSUER ?? "", introspectionUrl: process.env.ZENITH_AGENT_OAUTH_INTROSPECTION ?? "",
    clientId: process.env.ZENITH_AGENT_OAUTH_CLIENT_ID ?? "", clientSecret: process.env.ZENITH_AGENT_OAUTH_CLIENT_SECRET ?? "", resource: `${origin}/api/agent/v2/mcp` });
  return result;
}
export function validateOrigin(request: Request, origin: string): void {
  const target = new URL(origin);
  if ((request.headers.get("host") ?? new URL(request.url).host) !== target.host || request.headers.has("origin") && request.headers.get("origin") !== origin)
    throw new OperationError("origin_denied", "Use the exact configured Zenith origin. Forwarded-host headers and arbitrary browser origins are not trusted.", 403);
}
export function metadata(config = configuration()) {
  if (!config.enabled || config.mode !== "oauth" || !config.oauth) throw new OperationError("oauth_unavailable", "Remote OAuth is not configured on this instance.", 404);
  return { resource: config.oauth.resource, authorization_servers: [config.oauth.issuer], scopes_supported: ["read", "plan", "export", "execute", "publish", "logs"].map(s => `zenith:${s}`), bearer_methods_supported: ["header"] };
}
