/** Single step-up seam for plugin trust. browser() must first verify the live
 * session, membership and origin. A verified AAL2 JWT must bind to that same
 * subject/session; caller headers and unverified cookie claims are not proof.
 * The MFA job can reuse this seam for its challenge flow. No dev bypass. */
import type { NextRequest } from "next/server";
import type { VerifiedIdentity } from "@/lib/hosted/contracts";
import { requireStepUp } from "@/lib/auth/mfa";
import { ApiError } from "@/lib/server/errors";
import { ControlError } from "./journal";

export async function assertPrivilegedConsent(req: NextRequest, identity: VerifiedIdentity, workspaceId?: string): Promise<void> {
  try {
    if (req.headers.has("authorization") || !identity.emailVerified || !identity.sessionId) {
      throw new ControlError("step_up_required", "Confirm this plugin trust action with MFA in the signed-in browser.", 403);
    }
    await requireStepUp(req, { subject: identity.subject, sessionId: identity.sessionId, workspaceId });
  } catch (error) {
    if (error instanceof ControlError) throw error;
    if (error instanceof ApiError && error.status < 500) {
      throw new ControlError("step_up_required", "Confirm this plugin trust action with MFA in the signed-in browser.", 403);
    }
    throw new ControlError("policy_unavailable", "Privileged consent cannot be verified.", 503);
  }
}
