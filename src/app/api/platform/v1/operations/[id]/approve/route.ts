/**
 * POST /api/platform/v1/operations/:id/approve
 *
 * Browser-only. A person signed in to the Zenith web app approves the EXACT
 * proposal they reviewed, identified by its `proposalDigest`. Refused for any
 * request carrying an `Authorization` header, for a cross-origin request, and
 * for an identity the provider does not confirm right now. A model, an
 * integration or the Navigator can never reach the service behind it.
 *
 * Body: `{ proposalDigest: <64 hex>, reason?: string }`.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { assertBrowserSession } from "../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const Body = z.object({ proposalDigest: z.string().regex(/^[0-9a-f]{64}$/), reason: z.string().max(2000).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  if (!ID.test(id)) throw notFound();
  return {
    body: await (await platformBroker()).approve({
      workspaceId: caller.workspaceId,
      operationId: id,
      proposalDigest: body.proposalDigest,
      approver: caller.principal,
      session: caller.session,
      reason: body.reason,
    }),
  };
});
