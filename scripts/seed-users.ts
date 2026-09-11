/**
 * Create the shared TEST accounts (local/dev only). Idempotent.
 * Requires SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in .env.local.
 *
 * Run: npm run seed:users
 */
import fs from "node:fs";
import path from "node:path";

// Minimal .env.local loader (no dotenv dependency).
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export const TEST_ACCOUNTS = [
  { email: "arnav@zenith.test", password: "zenith-owner-2026!", name: "Arnav (owner)", role: "admin" },
  { email: "claude@zenith.test", password: "zenith-claude-2026!", name: "Claude (tester)", role: "editor" },
  { email: "sai@zenith.test", password: "zenith-sai-2026!", name: "Sai (collaborator)", role: "editor" },
] as const;

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: existing, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listErr) throw listErr;
  const byEmail = new Map(existing.users.map((u) => [u.email?.toLowerCase(), u]));

  for (const acct of TEST_ACCOUNTS) {
    const found = byEmail.get(acct.email);
    if (found) {
      // Keep passwords in sync so the documented credentials always work.
      const { error } = await admin.auth.admin.updateUserById(found.id, {
        password: acct.password,
        email_confirm: true,
        user_metadata: { full_name: acct.name },
        app_metadata: { role: acct.role },
      });
      if (error) throw error;
      console.log(`✓ ${acct.email} (existing, refreshed)`);
      continue;
    }
    const { error } = await admin.auth.admin.createUser({
      email: acct.email,
      password: acct.password,
      email_confirm: true,
      user_metadata: { full_name: acct.name },
      app_metadata: { role: acct.role },
    });
    if (error) throw error;
    console.log(`✓ ${acct.email} (created)`);
  }
  console.log("\nTest accounts ready:");
  for (const a of TEST_ACCOUNTS) console.log(`  ${a.email}  /  ${a.password}`);
}

main().catch((e) => {
  console.error("✗ seed:users failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
