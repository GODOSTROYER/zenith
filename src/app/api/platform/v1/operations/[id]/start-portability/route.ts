/**
 * POST /api/platform/v1/operations/:id/start-portability
 *
 * Browser-only. After a person approved a data.export, data.import,
 * resource.adopt or resource.release operation, the person it was proposed for
 * starts it here. Refused for any request carrying an `Authorization` header (an
 * integration starts its own approved operations through MCP), for a cross-origin
 * request and for an identity the provider does not confirm right now. The
 * operation must be a portability capability and already approved; nothing else
 * can be started by this route. Body: `{}`.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { startPortabilityOperation } from "@/lib/portability/start";
import { assertBrowserSession } from "../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const Body = z.object({}).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  parseWith(Body, await readJson(req));
  if (!ID.test(id)) throw notFound();
  const started = await startPortabilityOperation(await platformBroker(), { workspaceId: caller.workspaceId, operationId: id, caller: caller.principal });
  return { body: started };
});
