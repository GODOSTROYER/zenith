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
    if (!found || found.revokedAt || !(Date.parse(found.expiresAt) > now)) return null;
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
  return { sql: await platformDb(), parents: liveParentCredential };
}
