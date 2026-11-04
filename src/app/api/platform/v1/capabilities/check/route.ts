/**
 * POST /api/platform/v1/capabilities/check
 *
 * Dry run: the decision `propose` would reach now — `{ decision }` — with
 * nothing persisted and nothing logged. Same validation, same scope
 * resolution, same policy evaluation, same uniform 404 for foreign ids.
 */
import { platformBroker } from "@/lib/capabilities/platform";
import { platformRoute, readJson } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const body = await readJson(req);
  return { body: await (await platformBroker()).check(body, caller.principal, { via: "rest" }) };
});
