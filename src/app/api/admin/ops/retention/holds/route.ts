/**
 * `GET|POST|DELETE /api/admin/ops/retention/holds` - legal holds (PROD-OPS-07).
 *
 * A hold blocks archive-then-delete and pruning for what it covers: a whole workspace, or narrowed by data class,
 * one resource (job, request, resource, environment or operation id) and/or a time range over the row's recorded time.
 * Creating or releasing a hold never deletes anything. Holds are never removed; DELETE releases (one way) with an
 * audit trail on the row. Platform operators only, same-origin for writes.
 *
 *   GET [?workspaceId=ID][&all=1]        active holds (all=1 includes released ones)
 *   POST { workspaceId, reason, dataClass?, resourceRef?, timeFrom?, timeTo? }
 *   DELETE ?id=HOLD_ID[&workspaceId=ID][&reason=TEXT]
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { log } from "@/lib/log";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { readWaitlistJson } from "@/lib/waitlist/http";
import { opsStore, requireOpsOperator, storeFailure } from "@/lib/ops/operator";
import { RETENTION_CLASSES } from "@/lib/retention/classes";
import { createHold, listHolds, releaseHold } from "@/lib/retention/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const Body = z.object({
  workspaceId: id,
  reason: z.string().trim().min(1).max(500),
  dataClass: z.enum(RETENTION_CLASSES).nullable().optional(),
  resourceRef: z.string().trim().min(1).max(200).nullable().optional(),
  timeFrom: z.string().datetime({ offset: true }).nullable().optional(),
  timeTo: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireOpsOperator(request, false);
    const raw = request.nextUrl.searchParams.get("workspaceId");
    const ws = raw === null ? undefined : id.safeParse(raw);
    if (ws && !ws.success) throw new ApiError("workspaceId is invalid.", 400);
    const all = request.nextUrl.searchParams.get("all") === "1";
    return json({ holds: await listHolds(await opsStore(), { workspaceId: ws?.data, activeOnly: !all, limit: 200 }) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const operator = await requireOpsOperator(request, true);
    const parsed = Body.safeParse(await readWaitlistJson(request));
    if (!parsed.success) throw new ApiError("Send { workspaceId, reason, dataClass?, resourceRef?, timeFrom?, timeTo? } (times as ISO 8601 with offset).", 400);
    let hold;
    try { hold = await createHold(await opsStore(), { ...parsed.data, actor: operator.id }); } catch (error) { storeFailure(error); }
    log.info("legal hold created", { scope: "ops", holdId: hold.id, workspaceId: hold.workspaceId, actor: operator.id });
    return json({ hold }, 201);
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  try {
    const operator = await requireOpsOperator(request, true);
    const holdId = id.safeParse(request.nextUrl.searchParams.get("id"));
    if (!holdId.success) throw new ApiError("id is required.", 400);
    const ws = request.nextUrl.searchParams.get("workspaceId");
    if (ws !== null && !id.safeParse(ws).success) throw new ApiError("workspaceId is invalid.", 400);
    let hold;
    try {
      hold = await releaseHold(await opsStore(), { id: holdId.data, workspaceId: ws ?? undefined, actor: operator.id, reason: request.nextUrl.searchParams.get("reason") ?? undefined });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === "not_found") throw new ApiError(error.message, 404);
      storeFailure(error);
    }
    log.info("legal hold released", { scope: "ops", holdId: hold.id, workspaceId: hold.workspaceId, actor: operator.id });
    return json({ hold });
  } catch (error) { return errorResponse(error); }
}
