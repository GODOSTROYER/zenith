import { requireWaitlistAccess, waitlistGateEnabled } from "@/lib/waitlist/access";
import { AgentError } from "./security";

/** An agent acts for its verified subject, never for a browser cookie or supplied email. */
export async function requireAgentWaitlistAccess(subject: string): Promise<void> {
  try {
    if (!waitlistGateEnabled()) return;
    // The admission authority resolves canonical email and creation time by ID.
    await requireWaitlistAccess({ id: subject, email: "" });
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
    if (status === 403)
      throw new AgentError("waitlist_required", "This account is waiting for access. Open /waitlist in Zenith to check its status.", 403);
    // Provider/storage failures must neither admit the subject nor expose internals.
    throw new AgentError("policy_unavailable", "Account admission could not be verified. Retry when the admission service is available.", 503);
  }
}
