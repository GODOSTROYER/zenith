/**
 * `azure:log_analytics_workspace` — portable `log_group`.
 *
 * A Container Apps environment sends its logs to exactly ONE Log Analytics
 * workspace, so the workspace is the ENVIRONMENT's (declared by the network
 * node, 30-day retention, tables `ContainerAppConsoleLogs_CL` /
 * `ContainerAppSystemLogs_CL`). A portable `log_group/<workload>` therefore
 * does not get a workspace of its own (it would receive nothing); it becomes a
 * saved query in the environment workspace that selects that workload's lines:
 *
 *   ContainerAppConsoleLogs_CL | where ContainerAppName_s == "<app name>"
 *
 * (Container Apps jobs: `ContainerGroupName_s startswith "<job name>"` — the
 * column used for job executions is unverified live.) Workload names are
 * rendered as escaped KQL literals (`kql.ts`).
 *
 * Retention is a property of the workspace, shared by every log group of the
 * environment. `retentionDays` is compared with the workspace's actual
 * retention, so a log group asking for something other than the 30 days the
 * landing zone provisions shows up as drift instead of being silently
 * ignored; there is no per-workload retention to set.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { LogGroupSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, fragment, requireNode, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, getById, pick, props, type AzureCtx, type Located } from "@/lib/providers/azure/kit";
import { armClient } from "@/lib/providers/azure/arm";
import { azureTags, scopedName, tfLabel } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";
import { kqlString } from "@/lib/providers/azure/kql";
import { workloadName } from "@/lib/providers/azure/drivers/compute/workload";
import { findLandingZoneTagged } from "@/lib/providers/azure/drivers/network/landing";

export const LOG_ANALYTICS_WORKSPACE = { type: "Microsoft.OperationalInsights/workspaces", apiVersion: API.logAnalytics } as const;
const SAVED_SEARCH_API = "2020-08-01";

export function workloadLogQuery(workloadKind: string, appName: string): string {
  return workloadKind === "scheduled_job"
    ? `ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith ${kqlString(appName, 64)} | order by TimeGenerated desc`
    : `ContainerAppConsoleLogs_CL | where ContainerAppName_s == ${kqlString(appName, 64)} | order by TimeGenerated desc`;
}

export function compileLogGroup(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<LogGroupSpec>(node);
  const a = node.address;
  const net = resolveNetwork(node, ctx);
  const workload = requireNode(ctx, spec.workload, "the log group's workload", a);
  if (workload.provider !== "azure") throw new AzureCompileError(`workload ${spec.workload} is on ${workload.provider}.`, a);
  const L = tfLabel(a, "query");
  return fragment({
    resource: block("azurerm_log_analytics_saved_search", L, {
      name: scopedName(a, { max: 80, suffix: "logs" }),
      log_analytics_workspace_id: exportRef(net, "law_id"),
      category: "Zenith",
      display_name: `${spec.workload} logs`.slice(0, 120),
      query: workloadLogQuery(workload.kind, workloadName(ctx, spec.workload)),
      tags: azureTags(ctx, node),
    }),
    locals: exportLocals(a, { id: `\${azurerm_log_analytics_saved_search.${L}.id}`, name: `\${azurerm_log_analytics_saved_search.${L}.name}` }),
  });
}

async function locateWorkspace(ctx: AzureCtx, node: ResourceNode, externalId?: string) {
  const arm = armClient(ctx.session, ctx.signal);
  if (externalId) return getById(arm, externalId, API.logAnalytics);
  const found = await findLandingZoneTagged(ctx, node, arm, LOG_ANALYTICS_WORKSPACE.type);
  if (!("matches" in found)) return found;
  if (found.matches.length === 0) return { state: "missing" } as const;
  if (found.matches.length > 1) return { state: "unknown", detail: `ambiguous: ${found.matches.length} workspaces carry the landing zone's tags` } as const;
  return getById(arm, found.matches[0].id, API.logAnalytics);
}

export const logAnalyticsDriver = defineAzureDriver({
  id: "azure.log_analytics_workspace@1",
  kind: "log_group",
  nativeType: "azure:log_analytics_workspace",
  arm: LOG_ANALYTICS_WORKSPACE,
  locate: locateWorkspace as (ctx: AzureCtx, node: ResourceNode, externalId?: string) => Promise<Located>,
  compile: compileLogGroup,
  expected: (node) => ({ retentionDays: specOf<LogGroupSpec>(node).retentionDays, sku: "PerGB2018" }),
  read: (res) => ({ retentionDays: pick<number>(props(res), "retentionInDays"), sku: pick<string>(props(res), "sku", "name") }),
  native: (res) => ({ customerId: props(res).customerId, provisioningState: props(res).provisioningState, dailyQuotaGb: pick(props(res), "workspaceCapping", "dailyQuotaGb") }),
  checks: async (ctx, node, res) => {
    const arm = armClient(ctx.session, ctx.signal);
    const name = scopedName(node.address, { max: 80, suffix: "logs" });
    const got = await getById(arm, `${res.id}/savedSearches/${name}`, SAVED_SEARCH_API);
    return [{ id: "saved_query", description: "the workload's log query exists in the environment workspace", passed: got.state === "found" ? true : got.state === "missing" ? false : ("unknown" as const), detail: got.state }];
  },
});
