/**
 * Server Supabase client for Server Components, Server Actions and Route
 * Handlers. A fresh client per request (never shared). Cookie writes from a
 * Server Component throw in Next — that's expected; middleware owns refresh.
 */
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL } from "./env";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: writes are impossible here and
          // unnecessary — middleware refreshes the session on every request.
        }
      },
    },
  });
}
