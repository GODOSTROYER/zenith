/**
 * `DELETE /api/hosted/apps/:appId/invites/:inviteId` — withdraw an outstanding
 * invitation.
 *
 * The link stops working at the moment this returns: acceptance requires the
 * invitation to still be `pending`, and this is what moves it off that state.
 * An invitation belonging to another app answers as one that does not exist.
 *
 * Workstream W5 (hosted R3).
 */
import { revokeInvite } from "@/lib/hosted/access";
import type { AppInviteWire } from "@/lib/hosted/contracts";
import { hostedRoute } from "@/lib/server/hosted";

export const dynamic = "force-dynamic";

export const DELETE = hostedRoute<{ appId: string; inviteId: string }>(
  { appRole: "owner", verify: "live" },
  async (_req, { appId, inviteId }, { subject }): Promise<AppInviteWire> => ({
    invite: revokeInvite(inviteId, subject, { appId }),
  })
);
