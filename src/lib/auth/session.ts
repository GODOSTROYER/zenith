/**
 * Who is signed in, from the server's point of view.
 * Verified via getClaims() (JWT signature check) — never getSession().
 */
import type { Role } from "@/lib/actions/core";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export interface SessionUser {
  id: string;
  email: string;
  /** display name from user_metadata.full_name, else the email's local part */
  name: string;
  /**
   * Workspace role granted by the operator through `app_metadata.role`.
   * Never read from `user_metadata`: that bag is writable by the user, so a
   * role there would be self-granted.
   */
  role?: Role;
}

const ROLES: readonly string[] = ["admin", "editor", "viewer"];

/** Verified JWT claims → SessionUser. The one place claims are interpreted. */
export function userFromClaims(claims: {
  sub?: string;
  email?: unknown;
  user_metadata?: unknown;
  app_metadata?: unknown;
}): SessionUser | null {
  if (!claims.sub) return null;
  const email = typeof claims.email === "string" ? claims.email : "";
  const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
  const app = (claims.app_metadata ?? {}) as Record<string, unknown>;
  const fullName = typeof meta.full_name === "string" ? meta.full_name : "";
  const role = typeof app.role === "string" && ROLES.includes(app.role) ? (app.role as Role) : undefined;
  return { id: claims.sub, email, name: fullName || email.split("@")[0] || "you", role };
}

export async function getSessionUser(): Promise<SessionUser | null> {
  if (!isSupabaseConfigured()) return null;
  // Imported here, not at module scope: `userFromClaims` above is pure and gets
  // imported by the /api layer (and by tests), which must not drag in
  // next/headers just to read a claim.
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims ? userFromClaims(data.claims) : null;
}
