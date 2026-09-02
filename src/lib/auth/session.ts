/**
 * Who is signed in, from the server's point of view.
 * Verified via getClaims() (JWT signature check) — never getSession().
 */
import type { Role } from "@/lib/actions/core";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export interface SessionUser {
  id: string;
  email: string;
  /** display name from user_metadata (see NAME_KEYS), else the email's local part */
  name: string;
  /**
   * Workspace role granted by the operator through `app_metadata.role`.
   * Never read from `user_metadata`: that bag is writable by the user, so a
   * role there would be self-granted.
   */
  role?: Role;
}

const ROLES: readonly string[] = ["admin", "editor", "viewer"];

/**
 * Where a display name may live, best first. Email signup writes `full_name`;
 * OAuth providers each pick their own — Google sends `full_name`/`name`,
 * GitHub sends `user_name`/`preferred_username` and only sometimes a real name.
 */
const NAME_KEYS = ["full_name", "name", "user_name", "preferred_username"] as const;

const nameFromMetadata = (meta: Record<string, unknown>): string => {
  for (const key of NAME_KEYS) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

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
  const role = typeof app.role === "string" && ROLES.includes(app.role) ? (app.role as Role) : undefined;
  const name = nameFromMetadata(meta) || email.split("@")[0] || "you";
  return { id: claims.sub, email, name, role };
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
