/**
 * `GET /api/admin/ops/slo` - the operator's service-objective report (PROD-OPS-01).
 *
 * Every SLI against its PROVISIONAL target, with error budget, burn rates and the latest recorded RPO, RTO and
 * capacity measurements. The body carries `label: "Provisional, not approved"` and the pending decision
 * (DEC-BUSINESS); targets are engineering defaults, not commitments. Platform operators only
 * (ZENITH_OPS_ADMIN_IDS), read-only.
 */
import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/lib/server/errors";
import { opsStore, requireOpsOperator } from "@/lib/ops/operator";
import { buildSloReport } from "@/lib/slo/report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireOpsOperator(request, false);
    return json(await buildSloReport(await opsStore()));
  } catch (error) { return errorResponse(error); }
}
