/**
 * `GET /api/admin/ops/retention/archives[?workspaceId=ID][&limit=N]` - list archives (PROD-OPS-07).
 *
 * Verified archive records, newest first: data class, row count, id range, where they live (operator storage or the
 * tenant's own destination), how much has been pruned, and the restore audit trail count. Never object bytes or rows.
 * Verify and restore are the sibling `[id]/verify` and `[id]/restore` routes. Platform operators only.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { opsStore, requireOpsOperator } from "@/lib/ops/operator";
import { listArchives } from "@/lib/retention/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireOpsOperator(request, false);
    const ws = request.nextUrl.searchParams.get("workspaceId");
    if (ws !== null && !id.safeParse(ws).success) throw new ApiError("workspaceId is invalid.", 400);
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("limit must be 1 to 200.", 400);
    return json({ archives: await listArchives(await opsStore(), { workspaceId: ws ?? undefined, limit }) });
  } catch (error) { return errorResponse(error); }
}
