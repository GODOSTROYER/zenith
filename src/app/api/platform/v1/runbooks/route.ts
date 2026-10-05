/**
 * GET  /api/platform/v1/runbooks   latest published version of each runbook (read).
 * POST /api/platform/v1/runbooks   publish a new signed, immutable version. Browser-only:
 *      signing a runbook is an authority act, so a person signed in to the web app does it.
 *      Body: `{ runbookId, definition }`. The server validates every step with the machine
 *      plane's own argument schemas, assigns the next version and signs it with the
 *      control-plane key.
 */
import { z } from "zod";
import { assertBrowserSession } from "../_lib/browser";
import { parseWith, platformRoute, readJson } from "../_lib/http";
import { callerOf } from "../_lib/principal";
import { withRunbooks } from "../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Publish = z.object({ runbookId: z.string().min(1).max(63), definition: z.unknown() }).strict();

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const limit = Math.max(1, Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? "50") || 50));
  const runbooks = await withRunbooks((rb) => rb.service.listRunbooks({ workspaceId: caller.workspaceId, principal: caller.principal, limit }));
  return { body: { runbooks } };
});

export const POST = platformRoute(async (req) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Publish, await readJson(req));
  const version = await withRunbooks((rb) => rb.service.publish({ workspaceId: caller.workspaceId, runbookId: body.runbookId, definition: body.definition, principal: caller.principal }));
  return { status: 201, body: { version } };
});
