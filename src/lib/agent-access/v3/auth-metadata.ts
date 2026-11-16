/**
 * Public RFC 9728 metadata for the v3 resource, using v2's trusted origin and
 * OAuth configuration rules. Discovery never verifies a bearer or opens an
 * authority, grant store, cloud session or workflow connection. Metadata is
 * configuration, not proof that the external authorization server is live.
 */
import { checkRequestOrigin, failure, json } from "@/lib/agent-access/control/boundary";
import { ControlError } from "@/lib/agent-access/control/journal";
import { oauthConfig, type OAuthConfig } from "@/lib/agent-access/control/oauth";
import { resourceFor } from "@/lib/agent-access/v3/auth";
import { INTEGRATION_SCOPES } from "@/lib/agent-access/v3/contract";

export function metadata(request: Request): Response {
  try {
    const origin = checkRequestOrigin(request);
    let config: OAuthConfig | undefined;
    try {
      config = oauthConfig(process.env, origin);
    } catch {
      // URL parser errors can include the configured value. Never echo or log it.
      throw new ControlError("oauth_configuration", "Configure a trusted OAuth issuer, JWKS URL and claim settings.", 503);
    }
    if (!config) throw new ControlError("oauth_unavailable", "OAuth is not configured on this deployment.", 503);
    return json({
      resource: resourceFor(origin),
      authorization_servers: [config.issuer],
      scopes_supported: INTEGRATION_SCOPES.map((scope) => `zenith:${scope}`),
      bearer_methods_supported: ["header"],
      resource_name: "Zenith control v3",
    });
  } catch (error) {
    return failure(error);
  }
}
