/**
 * `POST /api/internal/slo/measurements` - where restore rehearsals and the capacity test report (PROD-OPS-01).
 *
 * Same bearer gate as every tick route (CRON_SECRET, constant time, refused when unset), checked first. Body is
 * one of:
 *
 *   { "kind": "recovery", "source": "restore-rehearsal" | "recovery-drill", "failureAt": ISO, "dataRecoveredThrough": ISO,
 *     "serviceRestoredAt": ISO, "recordedBy": "...", "reference": "run-id" }
 *       -> records an RPO and an RTO measurement; the server derives both numbers from the three instants.
 *   { "kind": "capacity", "sustainedRps": n, "p95Ms": n, "errorRate": 0..1, "durationSeconds": n, "concurrency": n,
 *     "environment": "label", "measuredAt": ISO, "recordedBy": "..." }
 *       -> records one capacity measurement.
 *
 * Records are append-only. The response says whether each figure is within the CURRENT provisional target; that is
 * information, not an approval.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { authorizeCron, ensurePlatformCron } from "@/lib/server/cron";
import { readWaitlistJson } from "@/lib/waitlist/http";
import { reportCapacityTest, reportRecoveryRehearsal } from "@/lib/slo/recovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

const time = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const who = z.string().trim().min(1).max(128);

const Body = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recovery"),
    source: z.enum(["restore-rehearsal", "recovery-drill"]),
    failureAt: time, dataRecoveredThrough: time, serviceRestoredAt: time,
    recordedBy: who,
    reference: z.string().max(120).optional(),
  }).strict(),
  z.object({
    kind: z.literal("capacity"),
    sustainedRps: z.number().finite().min(0).max(10_000_000),
    p95Ms: z.number().finite().min(0).max(3_600_000),
    errorRate: z.number().finite().min(0).max(1),
    durationSeconds: z.number().finite().positive().max(86_400),
    concurrency: z.number().int().min(1).max(100_000),
    environment: z.string().max(80),
    measuredAt: time,
    recordedBy: who,
  }).strict(),
]);

export async function POST(request: NextRequest): Promise<Response> {
  try {
    authorizeCron(request);
    const parsed = Body.safeParse(await readWaitlistJson(request));
    if (!parsed.success) throw new ApiError("Send a recovery or capacity measurement; see the route's header comment for the fields.", 400);
    if (!(await ensurePlatformCron())) throw new ApiError("The platform control store is not configured, so measurements cannot be recorded.", 503);
    const { platformDb } = await import("@/lib/controlplane/db");
    const sql = await platformDb();
    const body = parsed.data;
    try {
      if (body.kind === "recovery") {
        const { rpo, rto } = await reportRecoveryRehearsal(sql, body);
        return json({ recorded: [rpo, rto], label: "Provisional, not approved" }, 201);
      }
      return json({ recorded: [await reportCapacityTest(sql, body)], label: "Provisional, not approved" }, 201);
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === "invalid_input") throw new ApiError(error.message, 400);
      throw error;
    }
  } catch (error) { return errorResponse(error); }
}
