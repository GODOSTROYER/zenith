/**
 * The three facts the landing page's CTA needs, and nothing else.
 *
 * It exists so `/` can be a static page: the CTA is the only part of the
 * landing that depends on who is asking, so it is the only part that has to be
 * fetched. Deliberately not /api/bootstrap, which reads the whole store.
 *
 * No identity is returned — not a name, not an email, not a role. "Is there a
 * session" is all a front door needs to know, and a public, uncached endpoint
 * should hand back the least it can.
 */
import { currentRequest, route, workspacesFor } from "@/lib/server/context";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const configured = isSupabaseConfigured();
  const user = currentRequest()?.user ?? null;
  return {
    /** Auth off (local demo mode) is reported as `configured: false`, not as a session. */
    configured,
    signedIn: configured && Boolean(user),
    hasWorkspace: workspacesFor(user).length > 0,
  };
});
