/**
 * POST /api/platform/v1/runbooks/schedules/:id/approve
 *
 * Browser-only. Approves the exact schedule binding (runbook version digest, targets, windows,
 * cadence, bounds). Raw-command schedules are approved for at most 24 hours at a time and stop
 * running when that lapses until a person approves again. Body: `{ bindingDigest, ttlSec? }`.
 */
import { z } from "zod";
import { BrokerError } from "@/lib/capabilities/errors";
import { assertBrowserSession } from "../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { routeId, withRunbooks } from "../../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ bindingDigest: z.string().regex(/^[0-9a-f]{64}$/), ttlSec: z.number().int().min(60).max(7 * 86400).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  const schedule = await withRunbooks(async (rb) => {
    const current = await rb.store.getSchedule(caller.workspaceId, routeId(id));
    if (current && current.bindingDigest !== body.bindingDigest) throw new BrokerError("digest_mismatch", "The schedule changed after you reviewed it; reload and review it again.");
    return rb.service.approveSchedule({ workspaceId: caller.workspaceId, scheduleId: routeId(id), principal: caller.principal, ttlSec: body.ttlSec });
  });
  return { body: { schedule } };
});
