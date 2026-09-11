/**
 * POST /auth/signout — ends the platform session and returns to the sign-in
 * page.
 *
 * Hosted apps hold their own sessions (`src/lib/hosted/access`), so signing
 * out of Zenith terminates every app session of this subject **before** the
 * identity provider is told and before the redirect is sent: the next request
 * an app host sees from that browser is denied. A failure to terminate them is
 * logged loudly rather than allowed to block sign-out, which must always work.
 */
import { NextResponse, type NextRequest } from "next/server";
import { terminateAppSessionsForSubject } from "@/lib/hosted/access";
import { log } from "@/lib/log";
import { ensureBoot } from "@/lib/server/boot";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { sessionUserFromRequest } from "@/lib/supabase/route";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (isSupabaseConfigured()) {
    const user = await sessionUserFromRequest(request);
    if (user) {
      try {
        await ensureBoot(); // the authority is opened by boot, not by this route
        const ended = await terminateAppSessionsForSubject(user.id, "signed_out");
        if (ended) log.info("app sessions terminated on sign-out", { scope: "hosted.access", ended });
      } catch (err) {
        log.error("app sessions were not terminated on sign-out", { scope: "hosted.access", error: err });
      }
    }
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.nextUrl.origin), { status: 303 });
}
