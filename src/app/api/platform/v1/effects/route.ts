/**
 * GET /api/platform/v1/effects?operationId=...&unresolved=1
 *
 * External effects (provider calls whose outcome may be unknown) with their ledger state. A viewer or a
 * human-bound read credential may list; a foreign operation is the same empty answer as a missing one.
 */
import { notFound } from "@/lib/capabilities/errors";
import { platformEffects } from "@/lib/platform/effects";
import { platformRoute } from "../_lib/http";
import { callerOf } from "../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const operationId = req.nextUrl.searchParams.get("operationId") ?? undefined;
  if (operationId !== undefined && !ID.test(operationId)) throw notFound();
  const unresolvedOnly = req.nextUrl.searchParams.get("unresolved") === "1";
  const effects = await (await platformEffects()).list(caller.principal, caller.workspaceId, { operationId, unresolvedOnly });
  return { body: { effects } };
});
