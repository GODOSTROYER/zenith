/**
 * `GET|PUT /api/admin/ops/maintenance` - the operator's maintenance control (PROD-OPS-02).
 *
 * GET answers the effective mode (stored state merged with the host-level
 * `ZENITH_MAINTENANCE_MODE` override), the last changes, and the drain status:
 * `drain.drained === true` means no operation or runner job is queued or running,
 * which is when workers or the store can stop without orphaning work.
 *
 * PUT `{ mode, reason, expectedVersion? }` sets `off | dispatch_paused | read_only`.
 * Platform operators only (ZENITH_OPS_ADMIN_IDS) with same-origin; the route is a
 * control lane, so overload or read-only maintenance itself never blocks turning
 * maintenance off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { log } from "@/lib/log";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { readWaitlistJson } from "@/lib/waitlist/http";
import { effectiveMaintenance, MAINTENANCE_MODES, type MaintenanceState } from "@/lib/ops/maintenance";
import { opsStore, requireOpsOperator, storeFailure } from "@/lib/ops/operator";
import { opsRuntime } from "@/lib/ops/runtime";
import { drainStatus, getMaintenance, maintenanceHistory, setMaintenance } from "@/lib/ops/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  mode: z.enum(MAINTENANCE_MODES),
  reason: z.string().trim().max(300).optional(),
  expectedVersion: z.number().int().min(0).optional(),
}).strict();

async function view() {
  const rt = opsRuntime();
  const sql = await opsStore();
  const stored = await getMaintenance(sql);
  return {
    effective: effectiveMaintenance(stored, rt.limits.maintenanceOverride),
    stored,
    hostOverride: rt.limits.maintenanceOverride ?? null,
    history: await maintenanceHistory(sql, 20),
    drain: await drainStatus(sql, 10),
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireOpsOperator(request, false);
    return json(await view());
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: NextRequest): Promise<Response> {
  try {
    const operator = await requireOpsOperator(request, true);
    const parsed = Body.safeParse(await readWaitlistJson(request));
    if (!parsed.success) throw new ApiError("Send { mode: off | dispatch_paused | read_only, reason, expectedVersion? }.", 400);
    const sql = await opsStore();
    let state: MaintenanceState;
    try { state = await setMaintenance(sql, { ...parsed.data, actor: operator.id }); } catch (error) { storeFailure(error); }
    // This process sees the change immediately; others within ZENITH_OPS_MAINTENANCE_CACHE_MS.
    opsRuntime().maintenance.prime(state);
    log.info("maintenance mode changed", { scope: "ops", mode: state.mode, version: state.version, actor: operator.id });
    return json(await view());
  } catch (error) { return errorResponse(error); }
}
