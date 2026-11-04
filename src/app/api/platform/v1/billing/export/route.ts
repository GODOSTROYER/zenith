/**
 * `GET /api/platform/v1/billing/export[?limit=N]` - the workspace's platform records as one downloadable JSON file
 * (PROD-MAN-06). Workspace administrators only. Available in every billing state, including suspended and
 * `billing: disabled`: getting your own records out is never conditional on billing. Read-only and bounded per section.
 */
import { billingConfigFromEnv } from "@/lib/billing/config";
import { buildTenantExport } from "@/lib/billing/export";
import { recordAccountEvent, getAccount } from "@/lib/billing/store";
import { ApiError, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route({ workspaceRole: "admin" }, async (req, _params, grant) => {
  const rawLimit = req.nextUrl.searchParams.get("limit");
  if (rawLimit !== null && !/^\d{1,5}$/.test(rawLimit)) throw new ApiError("limit must be a whole number.", 400);
  const workspaceId = requireWorkspace().id;
  const { platformDb } = await import("@/lib/controlplane/db");
  const sql = await platformDb();
  const billing = billingConfigFromEnv().mode === "managed" ? "managed" : "disabled";
  const now = new Date();
  const bundle = await buildTenantExport(sql, { workspaceId, billing, now, ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}) });
  if (billing === "managed" && (await getAccount(sql, workspaceId))) {
    await recordAccountEvent(sql, { workspaceId, kind: "export_requested", actor: grant.actor.id, detail: { digest: bundle.manifest.digest } }).catch(() => undefined);
  }
  return new Response(JSON.stringify(bundle), {
    status: 200,
    headers: {
      "content-type": "application/json", "cache-control": "no-store",
      "content-disposition": `attachment; filename="zenith-export-${workspaceId.replace(/[^A-Za-z0-9_-]/g, "_")}-${now.toISOString().slice(0, 10)}.json"`,
    },
  });
});
