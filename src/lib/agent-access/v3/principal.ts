/**
 * From an authenticated agent credential or OAuth grant to a control-plane
 * `Principal`, and the grant checks made BEFORE the broker is asked.
 *
 * The mapping (ADR-0007, docs/platform/MCP.md):
 *
 * ```
 * credential / grant                      control-plane Principal
 * ---------------------------------       -----------------------------------------
 * integrationId (credential id)     ──▶   { kind: "integration", id, integrationId,
 * subject (the linking user)        ──▶             onBehalfOf: <user id>,
 *                                                   name: "integration <id>" }
 * scopes, projectIds, environmentIds ──▶  McpPrincipal.scopes / .projectIds / .environmentIds
 * ```
 *
 * The principal never carries a role: the broker's role resolver re-asks the
 * credential authority and the member table on every decision, so a revoked
 * credential or a removed member stops working on the next call.
 *
 * DEFENCE IN DEPTH. The broker enforces the grant's project and environment
 * restrictions and the integration scopes itself (`evaluate`, policy input
 * `integrationScopes`). This module checks them first, so a request outside the
 * grant never reaches the broker at all, and answers with the broker's own
 * uniform `not_found` — a foreign id and a missing id are indistinguishable.
 * The checks depend only on the grant (never on tenant data), so they cannot be
 * used to probe for ids.
 */
import type { Principal } from "@/lib/controlplane/types";
import { INTEGRATION_SCOPES, type IntegrationScope } from "./contract";
import { McpToolError, notFound, scopeDenied } from "./errors";

/** Structural twin of the v2 control `Principal`; kept here so this module imports nothing from v2. */
export interface AgentIdentity {
  subject: string;
  integrationId: string;
  workspaceId: string;
  projectIds: readonly string[];
  environmentIds?: readonly string[];
  appIds?: readonly string[];
  scopes: readonly string[];
  expiresAt: string;
  oauthIssuer?: string;
  grantDigest?: string;
}

export interface McpPrincipal {
  /** The principal every broker call is made as. */
  principal: Principal;
  /** Integration scopes held, filtered to the known set. */
  scopes: readonly IntegrationScope[];
  workspaceId: string;
  projectIds: readonly string[];
  /** Absent = every environment of the permitted projects. */
  environmentIds?: readonly string[];
  expiresAt: string;
  via: "credential" | "oauth";
  /** The authenticated identity as v2 shapes it; used for throttling and the product-store scope. */
  identity: AgentIdentity;
}

const isScope = (s: string): s is IntegrationScope => (INTEGRATION_SCOPES as readonly string[]).includes(s);

/** Map an authenticated identity. Throws when it is expired or holds no usable scope. */
export function principalFromIdentity(identity: AgentIdentity, now: number = Date.now()): McpPrincipal {
  const expires = Date.parse(identity.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) {
    throw new McpToolError("credential_expired", "This connection has expired. Link the agent again.", 401);
  }
  if (!identity.subject || !identity.integrationId || !identity.workspaceId) {
    throw new McpToolError("authentication_required", "The credential does not identify an integration.", 401);
  }
  const scopes = [...new Set(identity.scopes.filter(isScope))];
  if (!scopes.includes("read")) {
    throw new McpToolError("insufficient_scope", "This connection does not hold the read scope.", 403, "Ask the account owner to link the agent again with the read scope.");
  }
  return {
    principal: {
      kind: "integration",
      id: identity.integrationId,
      name: `integration ${identity.integrationId}`,
      integrationId: identity.integrationId,
      onBehalfOf: identity.subject,
    },
    scopes,
    workspaceId: identity.workspaceId,
    projectIds: [...identity.projectIds],
    ...(identity.environmentIds ? { environmentIds: [...identity.environmentIds] } : {}),
    expiresAt: identity.expiresAt,
    via: identity.oauthIssuer ? "oauth" : "credential",
    identity,
  };
}

export interface TargetLike {
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
}

/**
 * The grant's workspace, project and environment restrictions. Anything outside
 * them is the broker's uniform `not_found`, raised before the broker is called.
 */
export function assertInGrant(p: McpPrincipal, target: TargetLike): void {
  if (target.workspaceId !== p.workspaceId) throw notFound();
  if (target.projectId !== undefined && !p.projectIds.includes(target.projectId)) throw notFound();
  if (target.environmentId !== undefined && p.environmentIds && !p.environmentIds.includes(target.environmentId)) throw notFound();
}

/** Is this environment inside the grant? For filtering lists the tool builds. */
export const environmentInGrant = (p: McpPrincipal, environmentId: string): boolean => !p.environmentIds || p.environmentIds.includes(environmentId);

export function hasScope(p: McpPrincipal, scope: IntegrationScope): boolean {
  return p.scopes.includes(scope);
}

/** The scope check for a tool; depends only on the credential. */
export function requireScope(p: McpPrincipal, tool: string, scope: IntegrationScope): void {
  if (!hasScope(p, scope)) throw scopeDenied(tool, scope);
}
