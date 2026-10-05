/** Plugin review: registered plugins, their declared capabilities, and the tokens issued to them. */
import { platformDb, repos } from "@/lib/controlplane/db";
import { resourceFor } from "@/lib/agent-access/v3/auth";
import { controlOrigin } from "@/lib/agent-access/control/boundary";
import { grantView, view } from "@/lib/plugins/view";
import { loadPage } from "../_lib/loaders";
import { PageState } from "../_components/page-state";
import { PluginsManager } from "./plugins-manager";

export const dynamic = "force-dynamic";

export default async function PluginsPage() {
  const result = await loadPage(async (context) => {
    const sql = await platformDb();
    const admin = context.role === "admin";
    const all = await repos.plugins.list(sql, context.workspaceId);
    const visible = admin ? all : all.filter((r) => r.status === "approved");
    const grants = await repos.plugins.listGrants(sql, context.workspaceId);
    const ids = new Set(visible.map((r) => r.id));
    let resource: string | null = null;
    try {
      resource = resourceFor(controlOrigin());
    } catch {
      /* origin not configured: shown as unavailable */
    }
    return {
      plugins: visible.map(view),
      tokens: grants.filter((g) => ids.has(g.registrationId) && (admin || g.createdBy === context.principal.id)).map(grantView),
      resource,
    };
  });
  if ("error" in result) return <PageState {...result} />;
  return (
    <div className="space-y-5">
      <h1 className="app-page-title">Plugins</h1>
      <p className="text-[13px] text-ink-mute">
        A plugin reaches Zenith only through the tools an admin approves here, using its own revocable token. It never receives your credential, and revoking it takes effect on its next request.
      </p>
      <PluginsManager workspaceId={result.context.workspaceId} role={result.context.role} plugins={result.data.plugins} tokens={result.data.tokens} resource={result.data.resource} />
    </div>
  );
}
