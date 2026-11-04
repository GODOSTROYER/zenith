/**
 * Production wiring for the plugin service: the platform control store and the
 * live credential authority. Imported lazily so loading a route never opens a
 * database. A parent credential is looked up through the same authority the
 * MCP endpoint and the broker use, by the signed-in subject, so a member can
 * only ever bind a credential that is theirs.
 */
import { platformDb } from "@/lib/controlplane/db";
import { PluginError } from "./errors";
import type { ParentLookup, PluginDeps } from "./service";

export const liveParentCredential: ParentLookup = async (subject, workspaceId, credentialId) => {
  try {
    const { requireCredentialAuthority } = await import("@/lib/agent-access/authority");
    const authority = await requireCredentialAuthority();
    const rows = await authority.listCredentials(subject, workspaceId);
    const now = Date.now();
    const found = rows.find((c) => c.id === credentialId && c.workspaceId === workspaceId && c.subject === subject);
    if (!found || found.revokedAt || !(Date.parse(found.issuedAt) <= now) || !(Date.parse(found.expiresAt) > now)) return null;
    return {
      id: found.id,
      subject: found.subject,
      workspaceId: found.workspaceId,
      projectIds: [...found.projectIds],
      ...(found.environmentIds ? { environmentIds: [...found.environmentIds] } : {}),
      scopes: [...found.scopes],
      expiresAt: found.expiresAt,
    };
  } catch (error) {
    if (error instanceof PluginError) throw error;
    // Fail closed: a credential store that cannot answer authenticates nobody.
    throw new PluginError("plugin_unavailable", "The credential authority could not confirm the connection, so the plugin request was refused.");
  }
};

export async function defaultPluginDeps(): Promise<PluginDeps> {
  return { sql: await platformDb(), parents: liveParentCredential, assertLaunchScope: async (identity) => {
    const { requireCredentialAuthority } = await import("@/lib/agent-access/authority");
    if ((await requireCredentialAuthority()).kind !== "postgres") throw new PluginError("plugin_unavailable", "Launcher consent requires the Postgres credential authority.");
    const { inAgentScope, liveMember, resolveTarget } = await import("@/lib/agent-access/control/runtime");
    // The control adapter owns mutable scope arrays; keep the MCP identity's
    // immutable grant separate, copying every optional restriction as well.
    const who = { subject: identity.subject, integrationId: identity.integrationId, workspaceId: identity.workspaceId,
      projectIds: [...identity.projectIds], scopes: [...identity.scopes], expiresAt: identity.expiresAt,
      ...(identity.environmentIds ? { environmentIds: [...identity.environmentIds] } : {}),
      ...(identity.appIds ? { appIds: [...identity.appIds] } : {}) };
    await inAgentScope(who, async () => {
      if (!["admin", "editor"].includes(liveMember(who).role)) throw new PluginError("plugin_forbidden", "This role cannot give a plugin access.");
      const { db } = await import("@/lib/db/store");
      for (const projectId of who.projectIds) resolveTarget(who, { workspaceId: who.workspaceId, projectId });
      for (const environmentId of identity.environmentIds ?? []) {
        const environment = db().environments.find((e) => e.id === environmentId && identity.projectIds.includes(e.projectId));
        if (!environment) throw new PluginError("plugin_forbidden", "The selected environment is outside the approved projects.");
        resolveTarget(who, { workspaceId: who.workspaceId, projectId: environment.projectId, environmentId });
      }
    });
  } };
}
