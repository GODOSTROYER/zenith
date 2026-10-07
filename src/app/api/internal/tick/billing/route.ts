/**
 * `POST /api/internal/tick/billing` - one billing pass (PROD-MAN-06): collect usage from durable records, invoice ended
 * periods once, re-derive every account's standing (dunning). Same bearer gate as every tick route, checked first.
 *
 * Level-triggered and idempotent, so a late or repeated pass is only late. With `ZENITH_BILLING` unset or `disabled`
 * (BYOC and self-hosted) it answers `{ enabled: false }` without touching the store. Control-store only; never boots the
 * legacy product. Add `billing` to the tick workflow's pass list to schedule it (docs/build/production/verify/PROD-MAN-06.md).
 */
import type { NextRequest } from "next/server";
import { billingConfigFromEnv } from "@/lib/billing/config";
import { runBillingTick } from "@/lib/billing/service";
import { withRequestId } from "@/lib/log";
import { authorizeCron, ensurePlatformCron } from "@/lib/server/cron";
import { ApiError, errorResponse, json } from "@/lib/server/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function tick(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  return withRequestId(requestId, async () => {
    try {
      authorizeCron(req);
      if (billingConfigFromEnv().mode !== "managed") return json({ pass: "billing", ok: true, enabled: false });
      if (!(await ensurePlatformCron())) throw new ApiError("The platform control store is not configured, so billing cannot run.", 503);
      const { platformDb } = await import("@/lib/controlplane/db");
      const result = await runBillingTick(await platformDb(), { now: new Date() });
      const res = json({ pass: "billing", ok: true, ...result });
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      const res = errorResponse(err);
      res.headers.set("x-request-id", requestId);
      return res;
    }
  });
}

export const GET = tick;
export const POST = tick;
