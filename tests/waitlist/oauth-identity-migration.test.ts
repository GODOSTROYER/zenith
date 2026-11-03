import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Executes the append-only hook migration; real PostgreSQL coverage remains in pg-contract. */
describe("OAuth identity establishment preserves product admission", () => {
  const db = new PGlite();
  const refusal = { error: { http_code: 403, message: "ZENITH_WAITLIST_REQUIRED: Join the Zenith waitlist before signing in." } };
  beforeAll(async () => {
    await db.exec(`
      create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
      create table public.waitlist_entries (email text primary key, status text not null);
      grant usage on schema public to supabase_auth_admin;
      grant select(email,status) on public.waitlist_entries to supabase_auth_admin;
      insert into public.waitlist_entries values ('admitted@example.test','admitted');
    `);
    await db.exec(await readFile(new URL("../../supabase/migrations/0028_github_waitlist_identity.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => db.close());
  async function invoke(event: unknown) {
    return db.transaction(async (tx) => {
      await tx.exec("set local role supabase_auth_admin");
      const result = await tx.query<{ result: unknown }>("select public.zenith_before_user_created($1::jsonb) as result", [JSON.stringify(event)]);
      return result.rows[0].result;
    });
  }
  it.each(["google", "github"])("lets Auth establish a %s waiting identity without granting membership or admission", async (provider) => {
    expect(await invoke({ user: { email: "waiting@example.test", app_metadata: { provider } } })).toEqual({});
    expect(await invoke({ user: { email: "", app_metadata: { provider } } })).toEqual(refusal);
    expect(await invoke({ user: { email: "waiting@example.test", user_metadata: { provider, app_metadata: { provider } } } })).toEqual(refusal);
    expect((await db.query("select * from public.waitlist_entries where email = 'waiting@example.test'")).rows).toEqual([]);
  });
  it("keeps unknown providers and email signup gated while honoring canonical admitted email", async () => {
    for (const provider of ["email", "gitlab", "", null]) {
      expect(await invoke({ user: { email: "waiting@example.test", app_metadata: { provider } } })).toEqual(refusal);
    }
    expect(await invoke({ user: { email: " ADMITTED@example.test ", app_metadata: { provider: "email" } } })).toEqual({});
  });
  it("preserves invoker security and Auth-only execution", async () => {
    const result = await db.query<{ definer: boolean; anon: boolean; authenticated: boolean; service: boolean; auth: boolean }>(`
      select prosecdef as definer,
        has_function_privilege('anon', oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', oid, 'EXECUTE') as service,
        has_function_privilege('supabase_auth_admin', oid, 'EXECUTE') as auth
      from pg_proc where oid = 'public.zenith_before_user_created(jsonb)'::regprocedure
    `);
    expect(result.rows).toEqual([{ definer: false, anon: false, authenticated: false, service: false, auth: true }]);
  });
});
