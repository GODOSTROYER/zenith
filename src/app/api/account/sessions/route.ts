/**
 * Sign out everywhere.
 *
 *   DELETE /api/account/sessions → { appSessionsEnded }
 *
 * Two session systems end here, in the order that makes the answer true: the
 * hosted app sessions first (they are opaque cookies this server issued and
 * nothing else can end them), then every Supabase refresh token for this user.
 * Doing it the other way round would leave a window where the identity is gone
 * and an app host is still serving pages to the same browser.
 *
 * This one includes the caller's own session — that is the point of it — so the
 * page that calls this navigates to /login afterwards.
 */
import { terminateAppSessionsForSubject } from "@/lib/hosted/access";
import { log } from "@/lib/log";
import { requireAccountUser } from "@/lib/server/account";
import { ApiError, route } from "@/lib/server/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const DELETE = route(async () => {
  const user = requireAccountUser();

  const appSessionsEnded = await terminateAppSessionsForSubject(user.id, "signed_out");
  if (appSessionsEnded)
    log.info("app sessions terminated by sign-out-everywhere", {
      scope: "hosted.access",
      ended: appSessionsEnded,
    });

  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "global" });
  if (error)
    throw new ApiError(`Your other sessions were not all ended: ${error.message}`, 502, {
      fix: `Try again. The ${appSessionsEnded} hosted app session${appSessionsEnded === 1 ? "" : "s"} already ended; the Zenith sign-ins have not.`,
    });

  return { appSessionsEnded };
});
