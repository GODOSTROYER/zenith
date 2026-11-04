/** Add the tenant-leading replay index without changing stream rows or authority. */
import type { PlatformMigration } from "./index";

export const migration0043McpStreamEventsTenantIndex: PlatformMigration = {
  version: 43,
  name: "mcp_stream_events_tenant_index",
  sql: `
create index if not exists mcp_stream_events_workspace_stream
  on platform.mcp_stream_events(workspace_id, stream_id, seq);
`,
};
