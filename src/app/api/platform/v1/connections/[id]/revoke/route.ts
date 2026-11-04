/**
 * POST /api/platform/v1/connections/:id/revoke : terminal, immediate (admin).
 *
 * Body: `{ reason?, revokeRunner?, confirm? }`. A linked credential must send
 * `confirm` equal to the connection id (a person in the web app confirms in the
 * dialog instead). The next dispatch through the connection is refused.
 */
import { z } from "zod";
import { BrokerError } from "@/lib/capabilities/errors";
import { idempotencyKey, personOrCredentialCaller, runLifecycle } from "../../../_lib/connections";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { routeId } from "../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ reason: z.string().trim().max(300).optional(), revokeRunner: z.boolean().optional(), confirm: z.string().max(200).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await personOrCredentialCaller(req);
  const connectionId = routeId(id);
  const { confirm, ...rest } = parseWith(Body, await readJson(req));
  if (caller.via === "credential" && confirm !== connectionId) throw new BrokerError("invalid_request", "Revocation is terminal: send confirm equal to the connection id.", "Repeat with the connection id as confirm.");
  return runLifecycle(caller, "connection.revoke", { connectionId, ...rest }, idempotencyKey(req));
});
