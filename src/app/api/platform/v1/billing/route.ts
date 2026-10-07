/**
 * `GET /api/platform/v1/billing` - the workspace's plan, standing, current-period usage against its allowances and recent
 * invoices (PROD-MAN-06). Any workspace member. Plans are provisional placeholders (DEC-BUSINESS) and every response says so.
 *
 * With `ZENITH_BILLING` unset or `disabled` (BYOC and self-hosted) this answers `{ mode: "disabled" }` without reading the
 * store. Suspension never affects this route: reads are always served.
 */
import { billingConfigFromEnv } from "@/lib/billing/config";
import { SUSPENSION_MEANING, billingView } from "@/lib/billing/service";
import { json, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route({ workspaceRole: "viewer" }, async () => {
  if (billingConfigFromEnv().mode !== "managed") return json({ mode: "disabled", message: "Billing is not enabled on this installation; nothing is metered or charged." });
  const { platformDb } = await import("@/lib/controlplane/db");
  return json({ ...(await billingView(await platformDb(), requireWorkspace().id, new Date())), whatSuspensionMeans: SUSPENSION_MEANING });
});
