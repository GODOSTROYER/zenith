/** Stable, secret-free refusals of the plugin boundary. */
export type PluginErrorCode =
  | "plugin_manifest_invalid"
  | "plugin_provenance_unverified"
  | "plugin_not_found"
  | "plugin_conflict"
  | "plugin_not_approved"
  | "plugin_revoked"
  | "plugin_grant_invalid"
  | "plugin_forbidden"
  | "plugin_capability_denied"
  | "plugin_unavailable";

const STATUS: Record<PluginErrorCode, number> = {
  plugin_manifest_invalid: 400,
  plugin_provenance_unverified: 403,
  plugin_not_found: 404,
  plugin_conflict: 409,
  plugin_not_approved: 403,
  plugin_revoked: 401,
  plugin_grant_invalid: 401,
  plugin_forbidden: 403,
  plugin_capability_denied: 403,
  plugin_unavailable: 503,
};

export class PluginError extends Error {
  readonly status: number;
  constructor(
    readonly code: PluginErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PluginError";
    this.status = STATUS[code];
  }
}
