/**
 * `POST /api/hosted/session/terminate` — end this person's app sessions.
 *
 * Called by platform sign-out **before** it responds (R3-10, G13): the platform
 * session going away has to take the app sessions with it, or a signed-out
 * browser keeps working app tabs on every app host it had open.
 *
 * Deliberately **not** identity-verified against the provider. This is the one
 * grant-adjacent call where the session may already be gone by the time it
 * runs, and it only ever removes access — a caller who somehow reached it can
 * end their own sessions and nobody else's.
 */
import { terminateAppSessionsForSubject } from "@/lib/hosted/access";
import type { SessionsTerminatedWire } from "@/lib/hosted/contracts";
import { hostedRoute, signedInUser } from "@/lib/server/hosted";

export const dynamic = "force-dynamic";

export const POST = hostedRoute(async (): Promise<SessionsTerminatedWire> => {
  const user = signedInUser();
  return { terminated: terminateAppSessionsForSubject(user.id, "signed_out") };
});
