import type { NextRequest } from "next/server";
import { getWaitlistAccess, requireWaitlistAccess, waitlistGateEnabled } from "./access";

/** Check admission before loading a tenant snapshot or accepting invitations. */
export async function requireProductRequestAccess(request: NextRequest): Promise<void> {
  if (!waitlistGateEnabled()) return;
  const { sessionUserFromRequest } = await import("@/lib/supabase/route");
  await requireWaitlistAccess(await sessionUserFromRequest(request));
}

/** Layouts also protect server-rendered reads that do not pass through route(). */
export async function requireProductPageAccess(): Promise<void> {
  if (!waitlistGateEnabled()) return;
  const { getSessionUser } = await import("@/lib/auth/session");
  const { redirect } = await import("next/navigation");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!(await getWaitlistAccess(user)).allowed) redirect("/waitlist");
}
