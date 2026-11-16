/**
 * Browser-only adapter to the existing connection actions. A stale tab must
 * never create a connection in the workspace selected by a different tab:
 * compare the explicit UI workspace with the product action's cookie scope.
 */
import { z } from "zod";
import { buildCtx } from "@/lib/server/scope";
import { requireWorkspace } from "@/lib/server/workspace";
import { runAction } from "@/lib/actions/core";
import { notFound } from "@/lib/capabilities/errors";
import { assertBrowserSession } from "@/app/api/platform/v1/_lib/browser";
import { parseWith, platformRoute, readJson } from "@/app/api/platform/v1/_lib/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const Body = z.object({ actionId: z.enum(["connection.createAws", "connection.verifyAws"]), input: z.unknown(), idempotencyKey: z.string().min(1).max(100).optional() }).strict();
export const POST = platformRoute(async (req) => {
  const caller = await assertBrowserSession(req);
  if (requireWorkspace().id !== caller.workspaceId) throw notFound();
  const body = parseWith(Body, await readJson(req));
  const ctx = buildCtx({}, { type: "user", id: caller.principal.id, name: caller.principal.name });
  return { body: await runAction(body.actionId, ctx, body.input, { mode: "execute", idempotencyKey: body.idempotencyKey }) };
});
