/** Cookie-independent read/check transports. The management and issuance
 * routes remain browser-only. No caller-supplied scope becomes authority. */
import { checkRequestOrigin, authorizeRequest, boundedBody, json } from "@/lib/agent-access/control/boundary";
import { requireControlAsync } from "@/lib/agent-access/control/runtime";
import { resourceFor } from "@/lib/agent-access/v3/auth";
import * as repos from "@/lib/controlplane/db/repos";
import { PluginError } from "./errors";
import { defaultPluginDeps } from "./runtime";
import { checkLauncherLease, type PluginDeps } from "./service";
import { view } from "./view";

interface CheckDeps {
  checkOrigin(request: Request): string;
  ready(): Promise<unknown>;
  plugins(): Promise<PluginDeps>;
}
const defaults: CheckDeps = { checkOrigin: checkRequestOrigin, ready: requireControlAsync, plugins: defaultPluginDeps };
function refused(error: unknown): Response {
  if (error instanceof PluginError) return json({ error: { code: error.code, message: error.message } }, error.status);
  const status = (error as { status?: number })?.status;
  // Never expose storage/provider errors, request body or credentials.
  return json({ error: { code: status && status < 500 ? "plugin_forbidden" : "plugin_unavailable",
    message: "The plugin authority could not confirm access." } }, status && [400, 401, 403, 413, 429].includes(status) ? status : 503);
}
export function launcherCheckHandler(deps: CheckDeps = defaults) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json({ error: { code: "method_not_allowed" } }, 405);
    try {
      const origin = deps.checkOrigin(request);
      const header = request.headers.get("authorization");
      if (!header || !/^Bearer za_[A-Za-z0-9_-]{43}$/.test(header) || new URL(request.url).search ||
          request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
        throw new PluginError("plugin_grant_invalid", "Supply a dedicated launcher bearer and JSON binding.");
      }
      await deps.ready();
      let input: unknown;
      try { input = JSON.parse(Buffer.from(await boundedBody(request, 16_384)).toString("utf8")) as unknown; }
      catch { throw new PluginError("plugin_manifest_invalid", "Supply a bounded JSON binding."); }
      return json(await checkLauncherLease(await deps.plugins(), header.slice(7), input, resourceFor(origin)));
    } catch (error) { return refused(error); }
  };
}
export const pluginsLaunchCheck = launcherCheckHandler();

/** Linked credentials can discover registrations. This intentionally uses the
 * general agent authority, which does not accept launcher child hashes. */
export async function pluginsCatalog(request: Request): Promise<Response> {
  try {
    await requireControlAsync();
    const { who } = await authorizeRequest(request);
    if (!who.scopes.includes("read")) throw new PluginError("plugin_forbidden", "The read scope is required.");
    const deps = await defaultPluginDeps();
    const plugins = (await repos.plugins.list(deps.sql, who.workspaceId)).filter((p) => p.status === "approved");
    return json({ workspaceId: who.workspaceId, plugins: plugins.map(view) });
  } catch (error) { return refused(error); }
}
