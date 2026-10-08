/** Single step-up seam for plugin trust. browser() must first verify the live
 * session, membership and origin. A verified AAL2 JWT must bind to that same
 * subject/session; caller headers and unverified cookie claims are not proof.
 * The MFA job can reuse this seam for its challenge flow. No dev bypass. */
import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import type { VerifiedIdentity } from "@/lib/hosted/contracts";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/supabase/env";
import { ControlError } from "./journal";

interface ConsentClient {
  auth: { getClaims(): Promise<{ data: { claims: Record<string, unknown> } | null; error: unknown }> };
}
function provider(req: NextRequest): ConsentClient {
  if (!isSupabaseConfigured()) throw new ControlError("policy_unavailable", "Privileged consent cannot be verified.", 503);
  return createServerClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, { cookies: {
    getAll: () => req.cookies.getAll(), setAll: () => { /* verification never writes cookies */ },
  } });
}
export async function assertPrivilegedConsent(req: NextRequest, identity: VerifiedIdentity,
  createClient: (request: NextRequest) => ConsentClient = provider): Promise<void> {
  try {
    if (req.headers.has("authorization") || !identity.emailVerified || !identity.sessionId) {
      throw new ControlError("step_up_required", "Confirm this plugin trust action with MFA in the signed-in browser.", 403);
    }
    const answer = await createClient(req).auth.getClaims();
    if (answer.error || !answer.data) throw new ControlError("policy_unavailable", "Privileged consent cannot be verified.", 503);
    const claims = answer.data.claims;
    if (claims.sub !== identity.subject || claims.session_id !== identity.sessionId || claims.aal !== "aal2" ||
        typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
      throw new ControlError("step_up_required", "Confirm this plugin trust action with MFA in the signed-in browser.", 403);
    }
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError("policy_unavailable", "Privileged consent cannot be verified.", 503);
  }
}
