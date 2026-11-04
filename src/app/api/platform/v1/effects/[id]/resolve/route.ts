/**
 * POST /api/platform/v1/effects/:id/resolve
 *
 * Browser-only, like operation approval: a signed-in admin, same-origin, identity confirmed live, never an agent or
 * integration. The body names the `bindingDigest` the person reviewed (it covers this exact effect version and the
 * exact readback), so any later receipt, readback or state change makes the approval unusable. Confirming
 * "not applied" is further refused by the database while the dispatching lease still holds its fence, inside the
 * settle window, or after a late provider receipt.
 * Body: `{ decision: "confirm_applied" | "confirm_not_applied", bindingDigest: <64 hex>, reason }`.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformEffects } from "@/lib/platform/effects";
import { assertBrowserSession } from "../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const Body = z.object({
  decision: z.enum(["confirm_applied", "confirm_not_applied"]),
  bindingDigest: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  if (!ID.test(id)) throw notFound();
  const body = parseWith(Body, await readJson(req));
  const effect = await (await platformEffects()).resolve({ principal: caller.principal, workspaceId: caller.workspaceId, effectId: id, ...body });
  return { body: { effect } };
});
