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
import type { IssuedInviteWire } from "@/lib/hosted/contracts";
import { hostedJson, hostedRoute } from "@/lib/server/hosted";

export const dynamic = "force-dynamic";

export const POST = hostedRoute<{ appId: string; inviteId: string }>(
  { appRole: "owner", verify: "live" },
  async (_req, { appId, inviteId }, { subject }) => {
    const issued: IssuedInviteWire = resendInvite(inviteId, subject, { appId });
    scheduleInviteDelivery();
    return hostedJson(issued, 201);
  }
);
