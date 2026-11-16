/**
 * POST /api/platform/v1/standing-grants/:id/revoke
 *
 * Browser-only. The administrator who created the grant, or any admin, withdraws it. Takes effect at
 * once, including for operations that were already approved under it but not yet dispatched: the
 * dispatch gates stop counting an approval whose standing grant is revoked or expired.
 * Body: `{ reason?: string }`.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { assertBrowserSession } from "../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const Body = z.object({ reason: z.string().max(300).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  if (!ID.test(id)) throw notFound();
  const grant = await (await platformBroker()).revokeStandingGrant({ workspaceId: caller.workspaceId, id, actor: caller.principal, session: caller.session, reason: body.reason });
  return { body: { grant } };
});
