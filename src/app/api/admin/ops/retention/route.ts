/**
 * `GET /api/admin/ops/retention` - the retention overview and dry-run preview (PROD-OPS-07).
 *
 * Answers the policy in force (default: retain everything forever), whether deletion is possible at all (it needs an
 * approved DEC-RETENTION policy and ZENITH_RETENTION_APPLY=1), the archive storage status, active legal holds, recent
 * archives, and per-class counts of what would be archived and pruned. Read-only: nothing here changes data.
 * Platform operators only (ZENITH_OPS_ADMIN_IDS).
 */
import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/lib/server/errors";
import { opsStore, requireOpsOperator } from "@/lib/ops/operator";
import { retentionOverview } from "@/lib/retention/overview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireOpsOperator(request, false);
    return json(await retentionOverview(await opsStore()));
  } catch (error) { return errorResponse(error); }
}
