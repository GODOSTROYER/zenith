/**
 * Service-role client. SERVER ONLY — never import from client code.
 * Used by the test-account seeder and (later) admin operations.
 */
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./env";

export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL) are required for admin operations. Add them to .env.local — the service role key is server-only and must never ship to the browser."
    );
  }
  return createClient(SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
