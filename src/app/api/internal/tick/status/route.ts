/**
 * `GET|POST /api/internal/tick/status` - last-run and health of the critical periodic jobs.
 *
 * Reads `platform.scheduled_job_runs` (PROD-OBS-04): per job the last success and its source
 * (temporal = the durable schedule, fallback = GitHub cron / in-process scheduler), consecutive
 * failures, missed ticks closed by catch-up, and fallback triggers deferred to a current durable
 * run. Counts and fixed codes only. Same bearer gate as every tick route, checked first.
 * `?strict=1` answers 503 while any job is stale, failing or has never run, so an uptime monitor
 * or the workflow can alert on it. Control-store only; never boots the legacy product.
 */
import type { NextRequest } from "next/server";
import { authorizeCron, ensurePlatformCron } from "@/lib/server/cron";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { criticalJobHealth } from "@/lib/platform/critical-jobs";
import { withRequestId } from "@/lib/log";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function status(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  return withRequestId(requestId, async () => {
    try {
      authorizeCron(req);
      if (!(await ensurePlatformCron())) throw new ApiError("The platform control store is not configured, so job health is unavailable.", 503);
      const { platformDb } = await import("@/lib/controlplane/db");
      const health = await criticalJobHealth(await platformDb());
      const res = json({ pass: "status", ok: true, ...health }, health.healthy || req.nextUrl.searchParams.get("strict") !== "1" ? 200 : 503);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      const res = errorResponse(err);
      res.headers.set("x-request-id", requestId);
      return res;
    }
  });
}

export const GET = status;
export const POST = status;
