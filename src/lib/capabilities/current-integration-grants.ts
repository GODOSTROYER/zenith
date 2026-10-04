/** Trusted current credential or OAuth resource grant, without a role-none fallback. */
import { z } from "zod/v4";
import type { Principal } from "@/lib/controlplane/types";
import type { IntegrationGrant } from "./product-adapters";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const ids = z.array(id).max(1000).refine(values => new Set(values).size === values.length);
const scopes = z.array(z.string().regex(/^[a-z][a-z0-9:_-]{0,63}$/)).max(100)
  .refine(values => new Set(values).size === values.length);
const fields = z.object({ subject: id, workspaceId: id, projectIds: ids, environmentIds: ids.optional(),
  scopes, expiresAt: z.string().max(100) });
const Credential = fields.extend({ id, revokedAt: z.string().max(100).optional() });
const OAuthGrant = fields.extend({ integrationId: id, clientId: z.string().min(1).max(200),
  oauthIssuer: z.string().min(1).max(2048), revoked: z.boolean().optional() });
// These namespaces are minted in authority/{file,pg}.ts and control/browser.ts.
const OAUTH_ID = /^integration_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class CurrentIntegrationGrantError extends Error {
  readonly code = "current_integration_grant_unconfirmed";
  constructor() { super("The current integration grant could not be confirmed."); }
}
function refuse(): never { throw new CurrentIntegrationGrantError(); }
function live(expiresAt: string): boolean { const expires = Date.parse(expiresAt); return Number.isFinite(expires) && expires > Date.now(); }
function projection(grant: IntegrationGrant): IntegrationGrant {
  return { scopes: [...grant.scopes], projectIds: [...grant.projectIds],
    ...(grant.environmentIds ? { environmentIds: [...grant.environmentIds] } : {}) };
}
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) refuse(); }

/** No supplied directory, broker, issuer, copied scopes or provenance field can alter this read. */
export async function currentIntegrationGrant(principal: Principal, workspaceId: string, signal?: AbortSignal): Promise<IntegrationGrant | null> {
  if (principal.kind !== "integration" || !principal.onBehalfOf || !principal.integrationId
    || principal.id !== principal.integrationId || !id.safeParse(principal.onBehalfOf).success
    || !id.safeParse(workspaceId).success || !id.safeParse(principal.integrationId).success) return null;
  try {
    checkSignal(signal);
    const { credentialAuthority } = await import("@/lib/agent-access/authority");
    const credentials = await credentialAuthority().listCredentials(principal.onBehalfOf, workspaceId);
    checkSignal(signal);
    if (!Array.isArray(credentials) || credentials.length > 1000) refuse();
    const matches = credentials.filter(credential => credential.id === principal.integrationId);
    if (matches.length > 1) refuse();
    if (matches.length) {
      // An identity appearing in the native authority can never be revived by
      // an OAuth grant, including a revoked/expired row or a namespace collision.
      if (OAUTH_ID.test(principal.integrationId)) refuse();
      const parsed = Credential.safeParse(matches[0]);
      if (!parsed.success || parsed.data.subject !== principal.onBehalfOf || parsed.data.workspaceId !== workspaceId) refuse();
      return parsed.data.revokedAt || !live(parsed.data.expiresAt) ? null : projection(parsed.data);
    }
    if (!OAUTH_ID.test(principal.integrationId)) return null;
    const [{ oauthConfig }, { controlOrigin }, { agentJournal }] = await Promise.all([
      import("@/lib/agent-access/control/oauth"), import("@/lib/agent-access/control/boundary"), import("@/lib/agent-access/control/runtime"),
    ]);
    const config = oauthConfig(process.env, controlOrigin());
    if (!config) return null;
    const journal = await agentJournal();
    const grants = await journal.grants(principal.onBehalfOf, workspaceId);
    checkSignal(signal);
    if (!Array.isArray(grants) || grants.length > 100) refuse();
    const exact = grants.filter(grant => grant.integrationId === principal.integrationId);
    if (!exact.length) return null;
    if (exact.length !== 1) refuse();
    const parsed = OAuthGrant.safeParse(exact[0]);
    if (!parsed.success || parsed.data.subject !== principal.onBehalfOf || parsed.data.workspaceId !== workspaceId
      || parsed.data.oauthIssuer !== config.issuer || !parsed.data.scopes.includes("read")) refuse();
    // The browser grant is keyed by subject/client/workspace. Its unique key
    // must independently resolve to the very same current persisted document.
    const retained = await journal.getGrant(principal.onBehalfOf, parsed.data.clientId, workspaceId);
    checkSignal(signal);
    const again = OAuthGrant.safeParse(retained);
    if (!again.success || JSON.stringify(again.data) !== JSON.stringify(parsed.data)) refuse();
    return parsed.data.revoked || !live(parsed.data.expiresAt) ? null : projection(parsed.data);
  } catch { return refuse(); }
}
