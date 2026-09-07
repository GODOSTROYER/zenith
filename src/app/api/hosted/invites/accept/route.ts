/**
 * `POST /api/hosted/invites/accept` — redeem an invitation link.
 *
 * The one hosted route whose caller is, by construction, an outsider. Someone
 * invited to an app may hold no workspace membership at all, so this handler
 * never touches `requireWorkspace()` or `resolveActor()` — both of which refuse
 * a non-member — and reads nothing from the request but the token.
 *
 * Who is calling comes from the identity provider, live: the invitation is
 * bound to a verified address, and a claim read out of a cookie is not evidence
 * that the address is still theirs.
 *
 * Workstream W5 (hosted R3).
 */
import { z } from "zod";
import { acceptInvite } from "@/lib/hosted/access";
import { hostedRoute, readJsonBody, verifiedIdentity } from "@/lib/hosted/access/http";

export const dynamic = "force-dynamic";

const Accept = z.object({ token: z.string().trim().min(1).max(400) }).strict();

export const POST = hostedRoute(async (req) => {
  const identity = await verifiedIdentity(req);
  const { token } = await readJsonBody(req, Accept);
  const { app, grant } = acceptInvite(token, identity);
  return {
    app: { id: app.id, slug: app.slug, name: app.name },
    grant,
    launchUrl: `/api/hosted/apps/${encodeURIComponent(app.id)}/launch`,
  };
});
