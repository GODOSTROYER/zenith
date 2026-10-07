/**
 * `GET /api/internal/metrics` - Prometheus text exposition of the control plane (PROD-OPS-02).
 *
 * Same bearer gate as every tick route (CRON_SECRET, constant time, refused when
 * unset). Each scrape also runs one bounded sampling pass over the control store
 * (queue depth, active operations, maintenance mode); if the store does not
 * answer, `zenith_control_store_up` is 0 and the scrape still succeeds with the
 * process-local series, so "the control plane is degraded" is observable
 * precisely when the control plane is degraded.
 *
 * This process's series only. A multi-instance deployment scrapes each instance
 * (or pushes OTLP, see deploy/observability/README.md).
 */
import type { NextRequest } from "next/server";
import { authorizeCron } from "@/lib/server/cron";
import { errorResponse } from "@/lib/server/errors";
import { platformConfigured } from "@/lib/ops/runtime";
import { sampleControlPlane } from "@/lib/ops/sampler";
import { opsMetrics } from "@/lib/ops/telemetry/catalog";
import { metricsRegistry } from "@/lib/ops/telemetry/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(req: NextRequest): Promise<Response> {
  try {
    authorizeCron(req);
    opsMetrics();
    if (platformConfigured()) {
      try {
        const { platformDb } = await import("@/lib/controlplane/db");
        await sampleControlPlane(await platformDb());
      } catch { opsMetrics().controlStoreUp.set({}, 0); }
    }
    return new Response(metricsRegistry().renderPrometheus(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
