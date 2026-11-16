/**
 * `GET|PUT|DELETE /api/admin/ops/quotas` - per-workspace limits and scheduling weight (PROD-OPS-02).
 *
 * A workspace without a row uses the platform defaults (ZENITH_OPS_*). A row
 * overrides any field it sets and carries the weight used by the weighted-fair
 * worker gate and to scale the default API and dispatch limits. Platform
 * operators only, same-origin for writes, optimistic `expectedVersion`.
 *
 *   GET                       list overrides (bounded)
 *   GET ?workspaceId=ID       one workspace
 *   PUT { workspaceId, weight?, apiRatePerSec?, apiBurst?, maxConcurrentRequests?,
 *         maxActiveOperations?, maxQueuedJobs?, expectedVersion? }   (null = default)
 *   DELETE ?workspaceId=ID    back to defaults
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { log } from "@/lib/log";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { readWaitlistJson } from "@/lib/waitlist/http";
import { opsStore, requireOpsOperator, storeFailure } from "@/lib/ops/operator";
import { opsRuntime } from "@/lib/ops/runtime";
import { deleteTenantQuota, getTenantQuota, listTenantQuotas, putTenantQuota, type TenantQuota } from "@/lib/ops/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const maybe = (schema: z.ZodNumber) => schema.nullable().optional();
const Body = z.object({
  workspaceId: id,
  weight: z.number().int().min(1).max(100).optional(),
  apiRatePerSec: maybe(z.number().min(0.001).max(100_000)),
  apiBurst: maybe(z.number().int().min(1).max(100_000)),
  maxConcurrentRequests: maybe(z.number().int().min(1).max(10_000)),
  maxActiveOperations: maybe(z.number().int().min(1).max(100_000)),
  maxQueuedJobs: maybe(z.number().int().min(1).max(1_000_000)),
  expectedVersion: z.number().int().min(0).optional(),
}).strict();

function workspaceParam(request: NextRequest): string | undefined {
  const raw = request.nextUrl.searchParams.get("workspaceId");
  if (raw === null) return undefined;
  const parsed = id.safeParse(raw);
  if (!parsed.success) throw new ApiError("workspaceId is invalid.", 400);
  return parsed.data;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireOpsOperator(request, false);
    const sql = await opsStore();
    const ws = workspaceParam(request);
    if (ws) return json({ quota: await getTenantQuota(sql, ws), defaults: opsRuntime().limits });
    return json({ quotas: await listTenantQuotas(sql, 200), defaults: opsRuntime().limits });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: NextRequest): Promise<Response> {
  try {
    const operator = await requireOpsOperator(request, true);
    const parsed = Body.safeParse(await readWaitlistJson(request));
    if (!parsed.success) throw new ApiError("The quota request is invalid.", 400);
    const sql = await opsStore();
    let quota: TenantQuota;
    try { quota = await putTenantQuota(sql, { ...parsed.data, actor: operator.id }); } catch (error) { storeFailure(error); }
    opsRuntime().quotas.invalidate(quota.workspaceId);
    log.info("tenant quota changed", { scope: "ops", workspaceId: quota.workspaceId, version: quota.version, actor: operator.id });
    return json({ quota });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  try {
    const operator = await requireOpsOperator(request, true);
    const ws = workspaceParam(request);
    if (!ws) throw new ApiError("workspaceId is required.", 400);
    const removed = await deleteTenantQuota(await opsStore(), ws);
    opsRuntime().quotas.invalidate(ws);
    log.info("tenant quota removed", { scope: "ops", workspaceId: ws, actor: operator.id, removed });
    return json({ removed });
  } catch (error) { return errorResponse(error); }
}
