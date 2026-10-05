/**
 * POST /api/platform/v1/runbooks/runs/:id/approve
 *
 * Browser-only, like operation approval: a signed-in person, same-origin, identity confirmed
 * live, never an agent or integration. The body names the `bindingDigest` the person reviewed;
 * if it is not the run's current binding the approval is refused, so what was approved is
 * exactly what runs. The requester cannot approve their own run.
 * Body: `{ bindingDigest: <64 hex>, ttlSec? }`.
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
  const run = await withRunbooks(async (rb) => {
    const current = await rb.service.getRun(caller.workspaceId, routeId(id));
    if (current && current.bindingDigest !== body.bindingDigest) throw new BrokerError("digest_mismatch", "The run changed after you reviewed it; reload and review it again.");
    return rb.service.approveRun({ workspaceId: caller.workspaceId, runId: routeId(id), principal: caller.principal, ttlSec: body.ttlSec });
  });
  return { body: { run } };
});
