/**
 * `POST /api/hosted/apps/:appId/invites/:inviteId/resend` — mint a fresh link
 * and kill the old one.
 *
 * There is no "show me that link again": the token was never stored in clear.
 * Resend is the answer, and it supersedes the previous invitation in the same
 * transaction that writes the replacement, so exactly one link is live at a
 * time.
 *
 * Workstream W5 (hosted R3).
 */
import { resendInvite, scheduleInviteDelivery } from "@/lib/hosted/access";
import { hostedJson, hostedRoute, verifiedOwner } from "@/lib/hosted/access/http";

export const dynamic = "force-dynamic";

export const POST = hostedRoute<{ appId: string; inviteId: string }>(
  async (req, { appId, inviteId }) => {
    const { identity } = await verifiedOwner(req, appId);
    const issued = resendInvite(inviteId, identity.subject, { appId });
    scheduleInviteDelivery();
    return hostedJson(issued, 201);
  }
);
