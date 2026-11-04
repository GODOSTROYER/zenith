/**
 * POST /api/platform/v1/effects/:id/readback
 *
 * Run the independent, read-only readback for one effect and record what it found. Never retries the effect and
 * never changes what the provider holds. Editors and admins (a viewer cannot cause provider reads). A confirmed
 * or retired effect is returned unchanged.
 */
import { notFound } from "@/lib/capabilities/errors";
import { platformEffects } from "@/lib/platform/effects";
import { platformRoute } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  const effect = await (await platformEffects()).readback(caller.principal, caller.workspaceId, id, AbortSignal.any([req.signal, AbortSignal.timeout(55_000)]));
  return { body: { effect } };
});
