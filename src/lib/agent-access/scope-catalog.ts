/**
 * The exact scopes a client can be granted, in one place, for the consent
 * screens and the API that feeds them (PROD-UX-02). Each entry carries the
 * literal OAuth scope string the client will present (`zenith:<name>`) and the
 * MCP v3 tools that scope unlocks, so a person approving access reads the same
 * names the token and the server use. The wording is shared with the device
 * link screen and the Integrations screen.
 */
import { TOOL_CATALOG } from "./v3/catalog";
import { INTEGRATION_SCOPES, MCP_PATH, type IntegrationScope } from "./v3/contract";

export const OAUTH_SCOPE_PREFIX = "zenith:" as const;

export const SCOPE_SUMMARY: Record<IntegrationScope, string> = {
  read: "Read projects, revisions and operations. Always included.",
  plan: "Prepare proposals for review here. Never executes anything.",
  export: "Export a project's configuration.",
  write: "Dispatch a proposal you have approved.",
  publish: "Release an app it also has an explicit owner grant for.",
  logs: "Read redacted deployment logs.",
};

export interface ScopeInfo {
  name: IntegrationScope;
  /** the literal string in the token's `scope` claim */
  oauthScope: string;
  summary: string;
  /** MCP v3 tools this scope unlocks */
  tools: string[];
  alwaysIncluded: boolean;
}

export function scopeCatalog(): ScopeInfo[] {
  return INTEGRATION_SCOPES.map((name) => ({
    name,
    oauthScope: `${OAUTH_SCOPE_PREFIX}${name}`,
    summary: SCOPE_SUMMARY[name],
    tools: TOOL_CATALOG.filter((tool) => tool.requiredScope === name).map((tool) => tool.name),
    alwaysIncluded: name === "read",
  }));
}

/** Everything a person should see before authorizing a client: who issues its tokens and where they are accepted. */
export function consentFacts(origin: string, issuer: string | null) {
  return {
    issuer,
    resources: { v2: `${origin}/api/agent/v2/mcp`, v3: `${origin}${MCP_PATH}` },
    revocationEndpoint: `${origin}/api/agent/oauth/revoke`,
    scopeCatalog: scopeCatalog(),
  };
}
