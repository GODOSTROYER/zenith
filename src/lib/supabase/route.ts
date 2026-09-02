/**
 * Request-scoped Supabase client for Route Handlers that receive a
 * NextRequest (our /api/* layer). Reads the session from the request's
 * cookies; middleware has already refreshed it, so writes are not needed.
 * Identity is verified with getClaims() — never getSession().
 */
import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL, isSupabaseConfigured } from "./env";
import { userFromClaims, type SessionUser } from "@/lib/auth/session";

export async function sessionUserFromRequest(req: NextRequest): Promise<SessionUser | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll() {
        /* middleware owns refresh writes */
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  return data?.claims ? userFromClaims(data.claims) : null;
}
