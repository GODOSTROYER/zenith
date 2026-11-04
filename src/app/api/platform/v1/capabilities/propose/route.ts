/**
 * POST /api/platform/v1/capabilities/propose
 *
 * Submit a `CapabilityRequest`; the broker decides (allow | require_approval |
 * deny), persists the decision and an operation, and answers
 * `{ operation, decision, replayed }`. 201 for a new operation, 200 when the
 * same idempotency key replays an earlier identical request. A `deny` outcome is
 * still a 201: the operation exists with status `denied` and its reasons — check
 * `decision.outcome`.
 *
 * The body is the request and nothing else. Plan facts, costs and risk floors
 * are never read from it (the schema is strict and `input` is opaque): they come
 * only from Zenith's own execution side, in-process.
 */
import { platformBroker } from "@/lib/capabilities/platform";
import { platformRoute, readJson } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const body = await readJson(req);
  const result = await (await platformBroker()).propose(body, caller.principal, { via: "rest" });
  return { status: result.replayed ? 200 : 201, body: result };
});
