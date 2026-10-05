/**
 * POST /api/platform/v1/connections/:id/rotate : stage and verify new access (admin; browser only).
 *
 * Body: `{ patch: { ...provider fields }, promote?, retirePreviousRunner? }`. The
 * current access keeps serving; nothing switches until the verified candidate is
 * promoted (here with `promote: true`, or through rotation/promote).
 */
import { z } from "zod";
import { browserCaller, idempotencyKey, runLifecycle } from "../../../_lib/connections";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { routeId } from "../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ patch: z.record(z.string(), z.unknown()), promote: z.boolean().optional(), retirePreviousRunner: z.boolean().optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await browserCaller(req);
  return runLifecycle(caller, "connection.rotate", { connectionId: routeId(id), ...parseWith(Body, await readJson(req)) }, idempotencyKey(req));
});
