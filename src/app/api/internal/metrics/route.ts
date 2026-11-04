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
import { usageExporter } from "@/lib/cost/usage-exporter";
import { ApiError } from "@/lib/server/errors";

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
    return new Response(metricsRegistry().renderPrometheus() + usageExporter().renderPrometheus(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

/** Trusted infrastructure collector ingress. Never accepts a browser cookie or tenant bearer token. */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    authorizeCron(req);
    if (!req.body) throw new ApiError("Usage report is required.", 400);
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > 16_384) { await reader.cancel(); throw new ApiError("Usage report exceeds the limit.", 413); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let report: unknown;
    try { report = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ApiError("Usage report is invalid.", 400); }
    const { platformDb } = await import("@/lib/controlplane/db");
    await usageExporter().record(await platformDb(), report);
    return Response.json({ accepted: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
