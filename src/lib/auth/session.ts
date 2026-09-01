/**
 * Who is signed in, from the server's point of view.
 * Verified via getClaims() (JWT signature check) — never getSession().
 */
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export interface SessionUser {
  id: string;
  email: string;
  /** display name from user_metadata.full_name, else the email's local part */
  name: string;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  const email = typeof claims.email === "string" ? claims.email : "";
  const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
  const fullName = typeof meta.full_name === "string" ? meta.full_name : "";
  return {
    id: claims.sub,
    email,
    name: fullName || email.split("@")[0] || "you",
  };
}
