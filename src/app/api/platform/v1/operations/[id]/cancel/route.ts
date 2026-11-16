/**
 * POST /api/platform/v1/operations/:id/cancel
 *
 * Cancel an operation that has not started executing. The requester, the human
 * an agent proposed it for, and any editor or admin may; an integration may
 * cancel only what it proposed. Body: `{ reason?: string }`.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const Body = z.object({ reason: z.string().max(300).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  const body = parseWith(Body, await readJson(req));
  if (!ID.test(id)) throw notFound();
  const operation = await (await platformBroker()).cancelOperation({ workspaceId: caller.workspaceId, operationId: id, principal: caller.principal, reason: body.reason });
  return { body: { operation } };
});
