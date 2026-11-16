/** Public projections shared by the JSON API and the /platform/plugins page. Never carries a token or its hash. */
import type * as repos from "@/lib/controlplane/db/repos";

/** A registration as the screen may see it. The manifest is already public to the reviewer. */
export const view = (r: repos.plugins.PluginRegistration) => ({
  id: r.id,
  pluginId: r.pluginId,
  version: r.pluginVersion,
  status: r.status,
  publisherId: r.publisherId,
  manifestDigest: r.manifestDigest,
  artifactDigest: r.artifactDigest,
  manifest: r.manifest,
  provenance: r.provenance,
  approvedTools: r.approvedTools,
  approvedScopes: r.approvedScopes,
  requestedBy: r.requestedBy,
  reviewedBy: r.reviewedBy ?? null,
  reviewedAt: r.reviewedAt ?? null,
  revokedAt: r.revokedAt ?? null,
  revokeReason: r.revokeReason ?? null,
  createdAt: r.createdAt,
});


export const grantView = (g: repos.plugins.PluginGrantRecord) => ({
  id: g.id,
  registrationId: g.registrationId,
  credentialId: g.credentialId,
  scopes: g.scopes,
  createdBy: g.createdBy,
  createdAt: g.createdAt,
  expiresAt: g.expiresAt,
  revokedAt: g.revokedAt ?? null,
  lastUsedAt: g.lastUsedAt ?? null,
});
export type PluginView = ReturnType<typeof view>;
export type PluginGrantView = ReturnType<typeof grantView>;
