/** Authenticated readiness of the restored application, bound to its fenced restore run. */
import type { NextRequest } from "next/server";
import { authorizeCron, ensurePlatformCron } from "@/lib/server/cron";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { platformDb } from "@/lib/controlplane/db";
import { PLATFORM_SCHEMA_VERSION } from "@/lib/controlplane/db/migrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: NextRequest): Promise<Response> {
  try {
    authorizeCron(request);
    const restoreRunId = request.nextUrl.searchParams.get("restoreRunId") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(restoreRunId)) throw new ApiError("Name the restore run.", 400);
    if (!await ensurePlatformCron()) throw new ApiError("Application store unavailable.", 503);
    const sql = await platformDb();
    const rows = await sql.query<{ epoch: string | number; pending: string | number; schema_version: string | number; current_epoch: string | number }>(
      `select e.epoch, platform.current_recovery_epoch() as current_epoch,
        (select count(*) from platform.recovery_items i where i.epoch = e.epoch and i.state = 'pending') as pending,
        (select max(version) from platform.schema_migrations) as schema_version
       from platform.recovery_epochs e where e.restore_run_id = $1`, [restoreRunId]);
    const row = rows[0];
    const ready = !!row && Number(row.epoch) === Number(row.current_epoch) && Number(row.pending) === 0 && Number(row.schema_version) === PLATFORM_SCHEMA_VERSION;
    return json({ ready, restoreRunId, recoveryEpoch: row ? Number(row.epoch) : null }, ready ? 200 : 503);
  } catch (error) { return errorResponse(error); }
}
