/**
 * Real PostgreSQL contracts for migrations 0009 through 0012. The two explicit environment
 * gates are required; the lane report recognizes the WaitlistPostgres label.
 * Each connection has its own single-socket pool, so races reach the database.
 * Fixtures use a unique email/actor namespace and cleanup never truncates data.
 * Admission results are checked inside their transaction: an unexpected real
 * queue entry causes rollback, not admission of someone outside this suite.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const enabled = process.env.ZENITH_CONTRACT_POSTGRES === "1" && Boolean(process.env.SUPABASE_DB_URL);
const prefix = `contract-waitlist-${randomUUID()}`;
const actor = `${prefix}-operator`;
const email = (label: string) => `${prefix}-${label}@example.test`;
const tables = ["waitlist_entries", "waitlist_admission_batches", "waitlist_admission_previews", "waitlist_rate_limits"] as const;
const signatures = [
  "public.zenith_waitlist_join(text,text,text)",
  "public.zenith_waitlist_join_profile(text,text,text,jsonb,text)",
  "public.zenith_waitlist_features_valid(jsonb)",
  "public.zenith_waitlist_list(text,bigint,integer)",
  "public.zenith_waitlist_admit(integer,text,text)",
  "public.zenith_waitlist_preview(text,text,integer,uuid[])",
  "public.zenith_waitlist_admit_preview(uuid,text,text)",
  "public.zenith_waitlist_history(integer)",
  "public.zenith_waitlist_history_detail(text,integer,integer)",
  "public.zenith_waitlist_list_filtered(text,bigint,integer,text)",
  "public.zenith_waitlist_admitted(text)",
  "public.zenith_waitlist_rate_limit(text,integer,integer)",
] as const;

if (!enabled) {
  console.log(
    "[waitlist pg-contract] skipped: set ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. " +
      "Waitlist FIFO, admission races and database privileges were not verified."
  );
}

type Db = postgres.Sql | postgres.TransactionSql;
type Entry = {
  id: string;
  email: string;
  occupation: string;
  use_case: string;
  position: number;
  status: "queued" | "admitted";
  created_at: string;
  admitted_at: string | null;
  admitted_by: string | null;
};
type Page = { entries: Entry[]; total: number; queued: number; admitted: number; nextCursor: number | null };
type Preview = { id: string; mode: "selected" | "next" | "all"; count: number; entries: Entry[]; createdAt: string; expiresAt: string };
type Batch = { requestId: string; actorId: string; requestedCount: number; admittedCount: number; createdAt: string; mode: Preview["mode"] };
type AdmissionResult = { count: number; requestId: string };
type BatchDetail = { batch: Batch; entries: Entry[]; nextOffset: number | null };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

let sql: postgres.Sql;
let alpha: postgres.Sql;
let beta: postgres.Sql;
let baseline: { total: number; admitted: number };
let schemaReady = false;

function asService<T>(client: postgres.Sql, action: (tx: postgres.TransactionSql) => Promise<T>) {
  return client.begin(async (tx) => {
    await tx`set local role service_role`;
    return action(tx);
  });
}

async function join(db: Db, address: string, occupation = "Engineer", useCase = "Operate an application") {
  await db`select public.zenith_waitlist_join(${address}, ${occupation}, ${useCase})`;
}

async function list(db: Db, status: string | null = null, after = 0, limit = 200): Promise<Page> {
  const rows = await db<{ result: Page }[]>`
    select public.zenith_waitlist_list(${status}, ${after}, ${limit}) as result
  `;
  return rows[0].result;
}

async function admit(db: Db, count: number | null, requestId = randomUUID(), actorId = actor): Promise<Entry[]> {
  const rows = await db<{ result: Entry[] }[]>`
    select public.zenith_waitlist_admit(${count}, ${actorId}, ${requestId}) as result
  `;
  const entries = rows[0].result;
  expect(
    entries.every((entry) => entry.email.startsWith(`${prefix}-`)),
    "Admission encountered a non-fixture entry; roll back and use a disposable empty queue."
  ).toBe(true);
  return entries;
}

async function preview(db: Db, mode: string | null, count: number | null = null, entryIds: string[] | null = null, actorId = actor): Promise<Preview> {
  const rows = await db<{ result: Preview }[]>`
    select public.zenith_waitlist_preview(${mode}, ${actorId}, ${count}, ${entryIds}::uuid[]) as result
  `;
  return rows[0].result;
}

async function savedEntries(db: Db, requestId: string): Promise<Entry[]> {
  const [row] = await db<{ entries: Entry[] }[]>`
    select entries from public.waitlist_admission_batches where request_id = ${requestId}
  `;
  expect(row, "Every successful admission must retain its complete audit.").toBeDefined();
  expect(row.entries.every((entry) => entry.email.startsWith(`${prefix}-`)),
    "Preview admission encountered a non-fixture entry; roll back.").toBe(true);
  return row.entries;
}

async function admitPreview(db: Db, previewId: string, requestId = randomUUID(), actorId = actor): Promise<AdmissionResult> {
  const rows = await db<{ result: AdmissionResult }[]>`
    select public.zenith_waitlist_admit_preview(${previewId}::uuid, ${actorId}, ${requestId}) as result
  `;
  // Inspect the durable audit inside this transaction, so any unexpected real
  // queue entry still rolls back even though the RPC returns only metadata.
  const entries = await savedEntries(db, requestId);
  expect(rows[0].result).toEqual({ count: entries.length, requestId });
  return rows[0].result;
}

async function history(db: Db, limit = 50): Promise<{ batches: Batch[] }> {
  const rows = await db<{ result: { batches: Batch[] } }[]>`
    select public.zenith_waitlist_history(${limit}) as result
  `;
  return rows[0].result;
}

async function historyDetail(db: Db, requestId: string, offset = 0, limit = 100): Promise<BatchDetail | null> {
  const rows = await db<{ result: BatchDetail | null }[]>`
    select public.zenith_waitlist_history_detail(${requestId}, ${offset}, ${limit}) as result
  `;
  return rows[0].result;
}

async function filtered(db: Db, query = "", status: string | null = null, after = 0, limit = 100): Promise<Page & { matched: number }> {
  const rows = await db<{ result: Page & { matched: number } }[]>`
    select public.zenith_waitlist_list_filtered(${status}, ${after}, ${limit}, ${query}) as result
  `;
  return rows[0].result;
}

async function admitted(db: Db, address: string): Promise<boolean> {
  const rows = await db<{ result: boolean }[]>`
    select public.zenith_waitlist_admitted(${address}) as result
  `;
  return rows[0].result;
}

async function fixtures(labels: string[]): Promise<Entry[]> {
  return asService(alpha, async (tx) => {
    for (const label of labels) await join(tx, email(label));
    const page = await list(tx, "queued");
    return page.entries.filter((entry) => entry.email.startsWith(`${prefix}-`));
  });
}

async function cleanup() {
  if (!sql || !schemaReady) return;
  await sql`delete from public.waitlist_admission_batches where actor_id like ${`${prefix}-%`}`;
  await sql`delete from public.waitlist_admission_previews where actor_id like ${`${prefix}-%`}`;
  await sql`delete from public.waitlist_entries where email like ${`${prefix}-%`}`;
  await sql`delete from public.waitlist_rate_limits where key like ${`${prefix}-%`}`;
}

/**
 * A executes a real RPC and holds its transaction open. B uses another backend;
 * observe it blocked by A in PostgreSQL before allowing A to commit. No test
 * code acquires the production advisory lock: the RPCs themselves must provide
 * the observed blocking and produce the correct result after the first commit.
 */
async function contend<A, B>(
  first: (tx: postgres.TransactionSql) => Promise<A>,
  second: (tx: postgres.TransactionSql) => Promise<B>
): Promise<{ first: A; second: B }> {
  const [{ pid: alphaPid }] = await alpha<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const [{ pid: betaPid }] = await beta<{ pid: number }[]>`select pg_backend_pid() as pid`;
  expect(betaPid).not.toBe(alphaPid);
  let pending: Promise<Outcome<B>> | undefined;
  try {
    const firstResult = await asService(alpha, async (tx) => {
      const result = await first(tx);
      pending = asService(beta, second).then(
        (value): Outcome<B> => ({ ok: true, value: value as B }),
        (error: unknown): Outcome<B> => ({ ok: false, error })
      );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const rows = await sql<{ blocked: boolean }[]>`
          select ${alphaPid} = any(pg_blocking_pids(${betaPid})) as blocked
        `;
        if (rows[0].blocked) return result;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("The competing waitlist RPC never blocked on the first transaction.");
    });
    if (!pending) throw new Error("The competing waitlist request was not started.");
    const secondResult = await pending;
    if (!secondResult.ok) throw secondResult.error;
    return { first: firstResult as A, second: secondResult.value };
  } finally {
    // Always release A and drain B before fixture cleanup, even on failure.
    if (pending) await pending;
  }
}

describe.skipIf(!enabled)("WaitlistPostgres", () => {
  beforeAll(async () => {
    const connect = () => postgres(process.env.SUPABASE_DB_URL!, {
      max: 1, prepare: false, connect_timeout: 10, idle_timeout: 20, onnotice: () => {},
    });
    sql = connect();
    alpha = connect();
    beta = connect();
    for (const signature of signatures) {
      const rows = await sql<{ present: boolean }[]>`
        select to_regprocedure(${signature}) is not null as present
      `;
      expect(rows[0].present, "Apply supabase/migrations/0009 through 0012 before this suite.").toBe(true);
    }
    schemaReady = true;
    const roles = await sql<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolname, rolbypassrls, rolsuper from pg_roles
      where rolname in ('service_role', 'anon', 'authenticated') order by rolname
    `;
    expect(roles.map((role) => role.rolname)).toEqual(["anon", "authenticated", "service_role"]);
    expect(roles.find((role) => role.rolname === "service_role")?.rolbypassrls,
      "The disposable service_role stand-in must have BYPASSRLS, matching Supabase.").toBe(true);
    for (const role of roles.filter((role) => role.rolname !== "service_role")) {
      expect(role.rolbypassrls || role.rolsuper, `${role.rolname} must enforce RLS`).toBe(false);
    }
  });

  beforeEach(async () => {
    const rows = await sql<{ total: number; admitted: number; foreign_queued: number }[]>`
      select count(*)::integer as total,
        count(*) filter (where status = 'admitted')::integer as admitted,
        count(*) filter (where status = 'queued' and email not like ${`${prefix}-%`})::integer as foreign_queued
      from public.waitlist_entries
    `;
    expect(rows[0].foreign_queued, "Use a disposable queue: existing queued users must not be admitted by tests.").toBe(0);
    baseline = rows[0];
  });

  afterEach(cleanup);
  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await Promise.all([sql, alpha, beta].filter(Boolean).map((client) => client.end({ timeout: 5 })));
    }
  });

  it("lets only Supabase Auth invoke the signup hook and read admitted email/status columns", async () => {
    const [permissions] = await sql`
      select p.prosecdef as security_definer,
        has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE') as auth_execute,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_execute,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
      from pg_proc p where p.oid = 'public.zenith_before_user_created(jsonb)'::regprocedure
    `;
    expect(permissions).toEqual({ security_definer: false, auth_execute: true, anon_execute: false, user_execute: false, service_execute: false });
    await fixtures(["hook-queued", "hook-admitted"]);
    await sql`update public.waitlist_entries set status='admitted', admitted_at=now(), admitted_by=${actor} where email=${email("hook-admitted")}`;
    const visible = await alpha.begin(async (tx) => {
      await tx`set local role supabase_auth_admin`;
      return tx`select email, status from public.waitlist_entries where email like ${`${prefix}-%`}`;
    });
    expect(visible).toEqual([{ email: email("hook-admitted"), status: "admitted" }]);
    await expect(alpha.begin(async (tx) => {
      await tx`set local role supabase_auth_admin`;
      return tx`select name from public.waitlist_entries`;
    })).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects absent/queued signups identically and admits the email only after operator admission", async () => {
    const invoke = (event: postgres.JSONValue) => alpha.begin(async (tx) => {
      await tx`set local role supabase_auth_admin`;
      const [row] = await tx`select public.zenith_before_user_created(${tx.json(event)}) as result`;
      return row.result;
    });
    const refusal = { error: { http_code: 403, message: "ZENITH_WAITLIST_REQUIRED: Join the Zenith waitlist before signing in." } };
    const address = email("hook-flow");
    const event = { user: { email: address, app_metadata: { provider: "google" } } };
    expect(await invoke(event)).toEqual(refusal);
    await fixtures(["hook-flow"]);
    expect(await invoke(event)).toEqual(refusal);
    // A caller cannot bypass this new-account hook using identity metadata,
    // a forged grandfather timestamp, an operator-looking role, or phone auth.
    for (const malformed of [
      {}, null, { user: {} }, { user: { email: null } }, { user: { email: 123 } },
      { user: { email: "  " } }, { user: { phone: "+1234567890", is_anonymous: true } },
      { user: { email: address, created_at: "2000-01-01T00:00:00Z", role: "service_role", user_metadata: { status: "admitted", email: address } } },
    ]) expect(await invoke(malformed)).toEqual(refusal);
    await asService(beta, (tx) => admit(tx, 1));
    expect(await invoke(event)).toEqual({});
    expect(await invoke({ user: { email: ` ${address.toUpperCase()} `, app_metadata: { provider: "email" } } })).toEqual({});
    expect(await invoke({ user: { email: email("not-admitted"), user_metadata: { email: address, status: "admitted" } } })).toEqual(refusal);
    // Repeated activation checks have no side effects or extra admissions.
    expect(await invoke(event)).toEqual({});
    expect((await asService(beta, (tx) => list(tx, "admitted"))).entries.filter((entry) => entry.email === address)).toHaveLength(1);
  });

  it("normalizes duplicate joins and preserves the original answers, position and admission", async () => {
    await asService(alpha, (tx) => join(tx, `  ${email("duplicate").toUpperCase()}  `, " Engineer ", " Ship safely "));
    const before = await asService(alpha, (tx) => list(tx, "queued"));
    expect(before.entries).toHaveLength(1);
    const original = before.entries[0];
    expect(original).toMatchObject({ email: email("duplicate"), occupation: "Engineer", use_case: "Ship safely", status: "queued" });
    await asService(beta, (tx) => join(tx, email("duplicate"), "Changed", "Changed"));
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual([original]);
    expect(await asService(alpha, (tx) => admitted(tx, email("duplicate")))).toBe(false);
    const [entry] = await asService(alpha, (tx) => admit(tx, 1));
    await asService(beta, (tx) => join(tx, email("duplicate").toUpperCase(), "Changed again", "Changed again"));
    const page = await asService(alpha, (tx) => list(tx, "admitted", original.position - 1));
    expect(page.entries).toEqual([entry]);
    expect(entry).toMatchObject({ ...original, status: "admitted", admitted_by: actor, admitted_at: expect.any(String) });
    expect(await asService(beta, (tx) => admitted(tx, ` ${email("duplicate").toUpperCase()} `))).toBe(true);
    expect(await asService(beta, (tx) => admitted(tx, email("missing")))).toBe(false);
  });

  it("enforces email 254, occupation 120 and use-case 2000 boundaries in PostgreSQL", async () => {
    const atLength = (length: number) => `${prefix}-${"a".repeat(length - prefix.length - 14)}@example.test`;
    expect(atLength(254)).toHaveLength(254);
    await asService(alpha, (tx) => join(tx, atLength(254), "o".repeat(120), "u".repeat(2000)));
    const invalid = [
      [atLength(255), "Engineer", "Deploy"],
      [email("occupation-overflow"), "o".repeat(121), "Deploy"],
      [email("use-case-overflow"), "Engineer", "u".repeat(2001)],
      [`${prefix}-invalid`, "Engineer", "Deploy"],
      [`${prefix}-space @example.test`, "Engineer", "Deploy"],
    ];
    for (const [address, occupation, useCase] of invalid) {
      await expect(asService(alpha, (tx) => join(tx, address, occupation, useCase)))
        .rejects.toMatchObject({ code: "23514" });
    }
    const page = await asService(alpha, (tx) => list(tx, "queued"));
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ email: atLength(254), occupation: "o".repeat(120), use_case: "u".repeat(2000) });
  });

  it("accepts email alone and persists bounded optional profile answers", async () => {
    await asService(alpha, async (tx) => {
      await tx`select public.zenith_waitlist_join_profile(${email("minimal")})`;
      await tx`select public.zenith_waitlist_join_profile(${email("profile")}, ' Alex ', ' Founder ', ${tx.json(["Deployments", "Custom workflow"])}, '')`;
      await tx`select public.zenith_waitlist_join_profile(${email("profile")}, 'Replacement', '', ${tx.json(["Changed"])}, '')`;
    });
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toMatchObject([
      { email: email("minimal"), name: "", occupation: "", features: [], use_case: "" },
      { email: email("profile"), name: "Alex", occupation: "Founder", features: ["Deployments", "Custom workflow"], use_case: "" },
    ]);
    for (const features of [[""], ["x".repeat(121)], [12], {}, Array(13).fill("Custom")]) {
      await expect(asService(alpha, (tx) => tx`select public.zenith_waitlist_join_profile(${email("invalid-profile")}, '', '', ${tx.json(features)}, '')`))
        .rejects.toMatchObject({ code: "23514" });
    }
    await expect(asService(alpha, (tx) => tx`select public.zenith_waitlist_join_profile(${email("name-overflow")}, ${"x".repeat(121)})`))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("lists stable FIFO pages with global counts and admits the oldest queued positions", async () => {
    const entries = await fixtures(["first", "second", "third", "fourth"]);
    expect(entries.map((entry) => entry.email)).toEqual(["first", "second", "third", "fourth"].map(email));
    const positions = entries.map((entry) => entry.position);
    expect(new Set(positions).size).toBe(4);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const first = await asService(alpha, (tx) => list(tx, "queued", positions[0] - 1, 2));
    expect(first).toMatchObject({ total: baseline.total + 4, queued: 4, admitted: baseline.admitted, nextCursor: positions[1] });
    expect(first.entries).toEqual(entries.slice(0, 2));
    const second = await asService(alpha, (tx) => list(tx, "queued", first.nextCursor!, 2));
    expect(second.entries).toEqual(entries.slice(2));
    expect(second.nextCursor).toBeNull();
    const batch = await asService(alpha, (tx) => admit(tx, 2));
    expect(batch.map((entry) => entry.id)).toEqual(entries.slice(0, 2).map((entry) => entry.id));
    const remaining = await asService(alpha, (tx) => list(tx, "queued"));
    expect(remaining.entries).toEqual(entries.slice(2));
    expect(remaining).toMatchObject({ total: baseline.total + 4, queued: 2, admitted: baseline.admitted + 2 });
    expect(new Set(batch.map((entry) => entry.admitted_at)).size).toBe(1);
    expect(batch.every((entry) => entry.status === "admitted" && entry.admitted_by === actor)).toBe(true);
  });

  it.each([0, -1, 1001, null])("refuses an admission count of %s without changing the queue", async (count) => {
    const entries = await fixtures(["count-boundary"]);
    const requestId = randomUUID();
    await expect(asService(alpha, (tx) => admit(tx, count, requestId))).rejects.toMatchObject({ code: "22023" });
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual(entries);
    const batches = await sql`select request_id from public.waitlist_admission_batches where request_id = ${requestId}`;
    expect(batches).toHaveLength(0);
  });

  it("accepts both count boundaries and never fills a batch with already admitted users", async () => {
    const entries = await fixtures(["count-one", "count-thousand"]);
    expect((await asService(alpha, (tx) => admit(tx, 1))).map((entry) => entry.id)).toEqual([entries[0].id]);
    expect((await asService(alpha, (tx) => admit(tx, 1000))).map((entry) => entry.id)).toEqual([entries[1].id]);
    expect(await asService(alpha, (tx) => admit(tx, 1000))).toEqual([]);
  });

  it("replays UUID requests exactly and rejects changed count or actor without admitting more", async () => {
    const entries = await fixtures(["replay-first", "replay-second", "replay-third"]);
    const requestId = randomUUID();
    const first = await asService(alpha, (tx) => admit(tx, 1, requestId));
    expect(await asService(beta, (tx) => admit(tx, 1, requestId))).toEqual(first);
    await expect(asService(beta, (tx) => admit(tx, 2, requestId))).rejects.toMatchObject({ code: "ZW409" });
    await expect(asService(beta, (tx) => admit(tx, 1, requestId, `${prefix}-another-operator`)))
      .rejects.toMatchObject({ code: "ZW409" });
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual(entries.slice(1));
    const batches = await sql<{ entries: Entry[]; requested_count: number; actor_id: string }[]>`
      select entries, requested_count, actor_id from public.waitlist_admission_batches where request_id = ${requestId}
    `;
    expect(batches).toEqual([{ entries: first, requested_count: 1, actor_id: actor }]);
  });

  it("persists empty batches so replay cannot admit a later join", async () => {
    const requestId = randomUUID();
    expect(await asService(alpha, (tx) => admit(tx, 2, requestId))).toEqual([]);
    const entries = await fixtures(["joined-after-empty-batch"]);
    expect(await asService(beta, (tx) => admit(tx, 2, requestId))).toEqual([]);
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual(entries);
    expect((await asService(alpha, (tx) => admit(tx, 2))).map((entry) => entry.id)).toEqual([entries[0].id]);
  });

  it("deduplicates simultaneous case-varied joins on independent connections", async () => {
    await contend(
      (tx) => join(tx, email("concurrent-duplicate"), "Original", "Original answer"),
      (tx) => join(tx, ` ${email("concurrent-duplicate").toUpperCase()} `, "Replacement", "Replacement answer")
    );
    const page = await asService(alpha, (tx) => list(tx, "queued"));
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ email: email("concurrent-duplicate"), occupation: "Original", use_case: "Original answer" });
  });

  it("serializes overlapping batches into disjoint consecutive FIFO admissions", async () => {
    const entries = await fixtures(["race-a", "race-b", "race-c", "race-d", "race-e"]);
    const result = await contend((tx) => admit(tx, 3), (tx) => admit(tx, 3));
    expect(result.first.map((entry) => entry.id)).toEqual(entries.slice(0, 3).map((entry) => entry.id));
    expect(result.second.map((entry) => entry.id)).toEqual(entries.slice(3).map((entry) => entry.id));
    expect(new Set([...result.first, ...result.second].map((entry) => entry.id)).size).toBe(5);
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual([]);
  });

  it("replays a concurrently retried request instead of admitting a second batch", async () => {
    const entries = await fixtures(["same-request-a", "same-request-b", "same-request-c"]);
    const requestId = randomUUID();
    const result = await contend((tx) => admit(tx, 2, requestId), (tx) => admit(tx, 2, requestId));
    expect(result.second).toEqual(result.first);
    expect(result.first.map((entry) => entry.id)).toEqual(entries.slice(0, 2).map((entry) => entry.id));
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual(entries.slice(2));
    const batches = await sql`select request_id from public.waitlist_admission_batches where request_id = ${requestId}`;
    expect(batches).toHaveLength(1);
  });

  it("waits for an earlier joining transaction before admitting the queue", async () => {
    const [existing] = await fixtures(["before-pending-join"]);
    const result = await contend(
      (tx) => join(tx, email("pending-join")),
      (tx) => admit(tx, 2)
    );
    expect(result.second.map((entry) => entry.email)).toEqual([existing.email, email("pending-join")]);
    expect(result.second[1].position).toBeGreaterThan(existing.position);
  });

  it("persists an actor-bound FIFO preview without changing the queue", async () => {
    const entries = await fixtures(["preview-a", "preview-b", "preview-c"]);
    const snapshot = await asService(alpha, (tx) => preview(tx, "next", 2));
    expect(snapshot).toMatchObject({ mode: "next", count: 2, entries: entries.slice(0, 2) });
    expect(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.createdAt)).toBe(86_400_000);
    const stored = await sql`select actor_id, mode, entry_ids, entry_count from public.waitlist_admission_previews where id = ${snapshot.id}`;
    expect(stored).toEqual([{ actor_id: actor, mode: "next", entry_ids: entries.slice(0, 2).map((entry) => entry.id), entry_count: 2 }]);
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual(entries);
    expect(await sql`select request_id from public.waitlist_admission_batches where actor_id = ${actor}`).toHaveLength(0);
    expect(await asService(alpha, (tx) => preview(tx, "next", 1000))).toMatchObject({ count: 3, entries });
  });

  it("validates preview modes, counts and exact unique selected IDs", async () => {
    const entries = await fixtures(["selected-a", "selected-b", "selected-c"]);
    await asService(alpha, (tx) => admit(tx, 1));
    const selected = await asService(alpha, (tx) => preview(tx, "selected", null, [entries[2].id, entries[0].id, entries[1].id]));
    expect(selected).toMatchObject({ mode: "selected", count: 2, entries: entries.slice(1) });
    const invalid: [string | null, number | null, string[] | null][] = [
      [null, null, null], ["unknown", null, null], ["next", null, null], ["next", 0, null],
      ["next", 1001, null], ["next", 1, [entries[1].id]], ["all", 1, null],
      ["all", null, [entries[1].id]], ["selected", 1, [entries[1].id]],
      ["selected", null, null], ["selected", null, []],
      ["selected", null, [entries[1].id, entries[1].id]], ["selected", null, [randomUUID()]],
      ["selected", null, Array.from({ length: 1001 }, () => randomUUID())],
    ];
    for (const [mode, count, ids] of invalid) {
      await expect(asService(alpha, (tx) => preview(tx, mode, count, ids))).rejects.toMatchObject({ code: "22023" });
    }
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual(entries.slice(1));
    expect(await sql`select id from public.waitlist_admission_previews where actor_id = ${actor}`).toHaveLength(1);
  });

  it("captures all queued IDs beyond display/count limits and excludes later arrivals", async () => {
    await asService(alpha, (tx) => tx`
      insert into public.waitlist_entries (email, occupation, use_case)
      select ${`${prefix}-all-`} || n || '@example.test', 'Engineer', 'Deploy'
      from generate_series(1, 1001) as n order by n
    `);
    const snapshot = await asService(alpha, (tx) => preview(tx, "all"));
    expect(snapshot.count).toBe(1001);
    expect(snapshot.entries).toHaveLength(100);
    expect(snapshot.entries.map((entry) => entry.position)).toEqual(
      snapshot.entries.map((entry) => entry.position).sort((a, b) => a - b)
    );
    await asService(beta, (tx) => join(tx, email("after-all-preview")));
    const result = await asService(alpha, (tx) => admitPreview(tx, snapshot.id));
    expect(result).toEqual({ count: 1001, requestId: expect.any(String) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(200);
    const stored = await savedEntries(sql, result.requestId);
    expect(stored).toHaveLength(1001);
    expect(stored.slice(0, 100).map((entry) => entry.id)).toEqual(snapshot.entries.map((entry) => entry.id));
    const firstPage = await asService(alpha, (tx) => historyDetail(tx, result.requestId));
    expect(firstPage?.entries).toEqual(stored.slice(0, 100));
    expect(firstPage?.nextOffset).toBe(100);
    const lastPage = await asService(alpha, (tx) => historyDetail(tx, result.requestId, 1000));
    expect(lastPage?.entries).toEqual(stored.slice(1000));
    expect(lastPage?.nextOffset).toBeNull();
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries.map((entry) => entry.email)).toEqual([email("after-all-preview")]);
  });

  it("waits for an in-flight join when creating a preview and locks later joins out of its snapshot", async () => {
    const [first] = await fixtures(["preview-before-pending"]);
    const result = await contend((tx) => join(tx, email("preview-pending")), (tx) => preview(tx, "all"));
    expect(result.second.entries.map((entry) => entry.email)).toEqual([first.email, email("preview-pending")]);
    const later = await contend((tx) => preview(tx, "all"), (tx) => join(tx, email("preview-later")));
    const applied = await asService(alpha, (tx) => admitPreview(tx, later.first.id));
    expect(applied.count).toBe(2);
    expect((await savedEntries(sql, applied.requestId)).map((entry) => entry.email)).toEqual([first.email, email("preview-pending")]);
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries.map((entry) => entry.email)).toEqual([email("preview-later")]);
  });

  it("serializes overlapping snapshots and admits each captured queued entry only once", async () => {
    const entries = await fixtures(["overlap-a", "overlap-b", "overlap-c", "overlap-d"]);
    const first = await asService(alpha, (tx) => preview(tx, "selected", null, entries.slice(0, 2).map((entry) => entry.id)));
    const second = await asService(alpha, (tx) => preview(tx, "selected", null, entries.slice(1, 3).map((entry) => entry.id)));
    const result = await contend((tx) => admitPreview(tx, first.id), (tx) => admitPreview(tx, second.id));
    expect(result.first.count).toBe(2);
    expect(result.second.count).toBe(1);
    expect((await savedEntries(sql, result.first.requestId)).map((entry) => entry.id)).toEqual(entries.slice(0, 2).map((entry) => entry.id));
    expect((await savedEntries(sql, result.second.requestId)).map((entry) => entry.id)).toEqual([entries[2].id]);
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual(entries.slice(3));
  });

  it("replays concurrent preview requests exactly and consumes a preview only once", async () => {
    const entries = await fixtures(["snapshot-replay-a", "snapshot-replay-b"]);
    const snapshot = await asService(alpha, (tx) => preview(tx, "next", 1));
    const requestId = randomUUID();
    const result = await contend((tx) => admitPreview(tx, snapshot.id, requestId), (tx) => admitPreview(tx, snapshot.id, requestId));
    expect(result.second).toEqual(result.first);
    expect(result.first).toEqual({ count: 1, requestId });
    expect((await savedEntries(sql, requestId)).map((entry) => entry.id)).toEqual([entries[0].id]);
    await sql`update public.waitlist_entries set occupation = 'Changed after admission' where id = ${entries[0].id}`;
    await sql`update public.waitlist_admission_previews set expires_at = clock_timestamp() - interval '1 second' where id = ${snapshot.id}`;
    expect(await asService(alpha, (tx) => admitPreview(tx, snapshot.id, requestId))).toEqual(result.first);
    await expect(asService(alpha, (tx) => admitPreview(tx, snapshot.id))).rejects.toMatchObject({ code: "ZW409" });
    await expect(asService(alpha, (tx) => admitPreview(tx, snapshot.id, requestId, `${prefix}-other`))).rejects.toMatchObject({ code: "ZW409" });
    expect(await sql`select request_id from public.waitlist_admission_batches where preview_id = ${snapshot.id}`).toHaveLength(1);
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual(entries.slice(1));
  });

  it("rejects another operator, missing previews and expired unused previews without admissions", async () => {
    const entries = await fixtures(["snapshot-private"]);
    const snapshot = await asService(alpha, (tx) => preview(tx, "all"));
    await expect(asService(beta, (tx) => admitPreview(tx, snapshot.id, randomUUID(), `${prefix}-other`))).rejects.toMatchObject({ code: "ZW409" });
    await expect(asService(beta, (tx) => admitPreview(tx, randomUUID()))).rejects.toMatchObject({ code: "ZW409" });
    await sql`update public.waitlist_admission_previews set expires_at = clock_timestamp() - interval '1 second' where id = ${snapshot.id}`;
    await expect(asService(alpha, (tx) => admitPreview(tx, snapshot.id))).rejects.toMatchObject({ code: "ZW410" });
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries).toEqual(entries);
    expect(await sql`select request_id from public.waitlist_admission_batches where actor_id = ${actor}`).toHaveLength(0);
  });

  it.each(["selected", "next", "all"] as const)("prevents request-key reuse across legacy admission and %s previews", async (mode) => {
    const entries = await fixtures(["key-mode-a", "key-mode-b", "key-mode-c"]);
    const makePreview = (ids: string[]) => asService(alpha, (tx) => preview(tx, mode, mode === "next" ? 1 : null, mode === "selected" ? ids : null));
    const snapshot = await makePreview([entries[0].id]);
    const oldKey = randomUUID();
    await asService(alpha, (tx) => admit(tx, snapshot.count, oldKey));
    await expect(asService(alpha, (tx) => admitPreview(tx, snapshot.id, oldKey))).rejects.toMatchObject({ code: "ZW409" });
    await asService(alpha, (tx) => join(tx, email("key-mode-later")));
    const next = await asService(alpha, (tx) => preview(tx, "next", 1));
    const newKey = randomUUID();
    await asService(alpha, (tx) => admitPreview(tx, next.id, newKey));
    await expect(asService(alpha, (tx) => admit(tx, next.count, newKey))).rejects.toMatchObject({ code: "ZW409" });
    await expect(asService(alpha, (tx) => admitPreview(tx, snapshot.id, newKey))).rejects.toMatchObject({ code: "ZW409" });
  });

  it("persists zero-count previews and batches without admitting later arrivals", async () => {
    const [entry] = await fixtures(["empty-selected"]);
    await asService(alpha, (tx) => admit(tx, 1));
    const snapshot = await asService(alpha, (tx) => preview(tx, "selected", null, [entry.id]));
    expect(snapshot).toMatchObject({ count: 0, entries: [] });
    await asService(alpha, (tx) => join(tx, email("after-empty-preview")));
    const requestId = randomUUID();
    expect(await asService(alpha, (tx) => admitPreview(tx, snapshot.id, requestId))).toEqual({ count: 0, requestId });
    expect(await asService(beta, (tx) => admitPreview(tx, snapshot.id, requestId))).toEqual({ count: 0, requestId });
    await expect(asService(alpha, (tx) => admitPreview(tx, snapshot.id))).rejects.toMatchObject({ code: "ZW409" });
    expect((await asService(alpha, (tx) => list(tx, "queued"))).entries.map((item) => item.email)).toEqual([email("after-empty-preview")]);
    expect((await asService(alpha, (tx) => history(tx))).batches[0]).toMatchObject({ requestId, requestedCount: 0, admittedCount: 0, mode: "selected" });
  });

  it("records newest-first exact admission history including overlap and legacy batches", async () => {
    await fixtures(["history-a", "history-b", "history-c"]);
    const snapshot = await asService(alpha, (tx) => preview(tx, "all"));
    const legacyKey = randomUUID();
    await asService(alpha, (tx) => admit(tx, 1, legacyKey));
    const previewKey = randomUUID();
    expect(await asService(alpha, (tx) => admitPreview(tx, snapshot.id, previewKey))).toEqual({ count: 2, requestId: previewKey });
    expect((await asService(alpha, (tx) => history(tx, 2))).batches).toEqual([
      { requestId: previewKey, actorId: actor, mode: "all", requestedCount: 3, admittedCount: 2, createdAt: expect.any(String) },
      { requestId: legacyKey, actorId: actor, mode: "next", requestedCount: 1, admittedCount: 1, createdAt: expect.any(String) },
    ]);
    expect((await asService(alpha, (tx) => history(tx, 1))).batches).toHaveLength(1);
    for (const limit of [0, 101]) await expect(asService(alpha, (tx) => history(tx, limit))).rejects.toMatchObject({ code: "22023" });
  });

  it("returns immutable saved history details and null for an unknown request", async () => {
    const [entry] = await fixtures(["history-detail"]);
    const snapshot = await asService(alpha, (tx) => preview(tx, "selected", null, [entry.id]));
    const requestId = randomUUID();
    await asService(alpha, (tx) => admitPreview(tx, snapshot.id, requestId));
    const stored = await savedEntries(sql, requestId);
    await sql`update public.waitlist_entries set occupation = 'Changed after batch' where id = ${entry.id}`;
    const detail = await asService(alpha, (tx) => historyDetail(tx, requestId));
    expect(detail).toEqual({
      batch: { requestId, actorId: actor, mode: "selected", requestedCount: 1, admittedCount: 1, createdAt: expect.any(String) },
      entries: stored, nextOffset: null,
    });
    expect(detail?.batch).toEqual((await asService(alpha, (tx) => history(tx, 1))).batches[0]);
    expect(await asService(alpha, (tx) => historyDetail(tx, randomUUID()))).toBeNull();
    await expect(asService(alpha, (tx) => historyDetail(tx, ""))).rejects.toMatchObject({ code: "22023" });
  });

  it("paginates immutable history rows with bounded pages and validates offsets", async () => {
    const entries = await fixtures(["detail-page-a", "detail-page-b", "detail-page-c"]);
    const snapshot = await asService(alpha, (tx) => preview(tx, "all"));
    const applied = await asService(alpha, (tx) => admitPreview(tx, snapshot.id));
    const first = await asService(alpha, (tx) => historyDetail(tx, applied.requestId, 0, 2));
    const second = await asService(alpha, (tx) => historyDetail(tx, applied.requestId, first!.nextOffset!, 2));
    expect(first?.entries.map((entry) => entry.id)).toEqual(entries.slice(0, 2).map((entry) => entry.id));
    expect(first?.nextOffset).toBe(2);
    expect(second?.entries.map((entry) => entry.id)).toEqual([entries[2].id]);
    expect(second?.nextOffset).toBeNull();
    expect(second?.batch).toEqual(first?.batch);
    expect(first?.batch).not.toHaveProperty("entryIds");
    for (const offset of [3, 2_147_483_647]) {
      expect(await asService(alpha, (tx) => historyDetail(tx, applied.requestId, offset))).toMatchObject({ entries: [], nextOffset: null });
    }
    for (const [offset, limit] of [[-1, 100], [0, 0], [0, 101]]) {
      await expect(asService(alpha, (tx) => historyDetail(tx, applied.requestId, offset, limit))).rejects.toMatchObject({ code: "22023" });
    }
    const [overload] = await sql`select to_regprocedure('public.zenith_waitlist_history_detail(text)') is null as removed`;
    expect(overload.removed).toBe(true);
  });

  it("filters literal profile text with cursor-independent matched counts and global totals", async () => {
    await asService(alpha, async (tx) => {
      await tx`select public.zenith_waitlist_join_profile(${email("search-a")}, 'Alpha 100%', 'Founder', ${tx.json(["Private_network", 'Quote"slash\\marker'])}, 'Automate releases')`;
      await tx`select public.zenith_waitlist_join_profile(${email("search-b")}, 'Alpha team', 'Engineer', ${tx.json(["Custom domains"])}, 'Operate services')`;
      await tx`select public.zenith_waitlist_join_profile(${email("search-c")}, 'Beta', 'Designer', ${tx.json([])}, 'Build experiences')`;
    });
    const first = await asService(alpha, (tx) => filtered(tx, "  ALPHA  ", "queued", 0, 1));
    expect(first).toMatchObject({ matched: 2, total: baseline.total + 3, queued: 3, admitted: baseline.admitted });
    expect(first.entries.map((entry) => entry.email)).toEqual([email("search-a")]);
    const second = await asService(alpha, (tx) => filtered(tx, "alpha", "queued", first.nextCursor!, 1));
    expect(second).toMatchObject({ matched: 2, nextCursor: null });
    expect(second.entries.map((entry) => entry.email)).toEqual([email("search-b")]);
    for (const query of ["%", "_", "founder", "automate", "PRIVATE_NETWORK", 'quote"slash\\marker', email("search-a")]) {
      expect((await asService(alpha, (tx) => filtered(tx, query, "queued"))).entries.map((entry) => entry.email)).toEqual([email("search-a")]);
    }
    expect((await asService(alpha, (tx) => filtered(tx, "[", "queued"))).matched).toBe(0);
    await asService(alpha, (tx) => admit(tx, 1));
    expect(await asService(alpha, (tx) => filtered(tx, email("search-a"), "admitted"))).toMatchObject({ matched: 1, queued: 2, admitted: baseline.admitted + 1 });
    expect((await asService(alpha, (tx) => filtered(tx, "not present", "queued"))).matched).toBe(0);
    await expect(asService(alpha, (tx) => filtered(tx, "x".repeat(255)))).rejects.toMatchObject({ code: "22023" });
  });

  it("grants only service_role the waitlist RPCs, tables and queue sequence", async () => {
    for (const signature of signatures) {
      const roles = await sql<{ role: string; allowed: boolean }[]>`
        select rolname as role, has_function_privilege(oid, ${signature}, 'EXECUTE') as allowed
        from pg_roles where rolname in ('service_role', 'anon', 'authenticated') order by rolname
      `;
      expect(roles, signature).toEqual([
        { role: "anon", allowed: false }, { role: "authenticated", allowed: false }, { role: "service_role", allowed: true },
      ]);
      const security = await sql<{ prosecdef: boolean; fixed_path: boolean; auth_execute: boolean }[]>`
        select p.prosecdef, 'search_path=pg_catalog, pg_temp' = any(p.proconfig) as fixed_path,
          has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE') as auth_execute
        from pg_proc p where p.oid = to_regprocedure(${signature})
      `;
      expect(security, signature).toEqual([{ prosecdef: false, fixed_path: true, auth_execute: false }]);
      const publicAcl = await sql`
        select acl.privilege_type from pg_proc p,
          lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        where p.oid = to_regprocedure(${signature}) and acl.grantee = 0
      `;
      expect(publicAcl, `${signature} must revoke PUBLIC execute`).toHaveLength(0);
    }
    for (const table of tables) {
      const metadata = await sql<{ relrowsecurity: boolean; policies: number; public_grants: number }[]>`
        select c.relrowsecurity,
          (select count(*)::integer from pg_policy p where p.polrelid = c.oid) as policies,
          (select count(*)::integer from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl where acl.grantee = 0) as public_grants
        from pg_class c where c.oid = to_regclass(${'public.' + table})
      `;
      expect(metadata).toEqual([{ relrowsecurity: true, policies: table === "waitlist_entries" ? 1 : 0, public_grants: 0 }]);
      for (const role of ["anon", "authenticated"] as const) {
        const privileges = await sql<{ allowed: boolean }[]>`
          select has_table_privilege(${role}, ${'public.' + table}, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed
        `;
        expect(privileges[0].allowed, `${role} ${table}`).toBe(false);
      }
    }
    const sequence = await sql<{ role: string; allowed: boolean }[]>`
      select rolname as role,
        has_sequence_privilege(oid, 'public.waitlist_entries_position_seq', 'USAGE,SELECT,UPDATE') as allowed
      from pg_roles where rolname in ('service_role', 'anon', 'authenticated') order by rolname
    `;
    expect(sequence).toEqual([
      { role: "anon", allowed: false }, { role: "authenticated", allowed: false }, { role: "service_role", allowed: true },
    ]);
  });

  it.each(["anon", "authenticated", "supabase_auth_admin"] as const)("refuses direct reads, writes and RPC invocation as %s", async (role) => {
    await fixtures(["private-entry"]);
    const attempts: ((tx: postgres.TransactionSql) => Promise<unknown>)[] = [
      ...tables.map((table) => async (tx: postgres.TransactionSql) => tx.unsafe(`select * from public.${table}`)),
      async (tx) => tx`insert into public.waitlist_entries (email, occupation, use_case) values (${email("unauthorized")}, 'Engineer', 'Deploy')`,
      async (tx) => tx`update public.waitlist_entries set occupation = 'Stolen' where email = ${email("private-entry")}`,
      async (tx) => tx`delete from public.waitlist_entries where email = ${email("private-entry")}`,
      async (tx) => tx`select nextval('public.waitlist_entries_position_seq')`,
      (tx) => join(tx, email("unauthorized-rpc")),
      (tx) => list(tx),
      (tx) => admit(tx, 1),
      (tx) => preview(tx, "all"),
      (tx) => admitPreview(tx, randomUUID()),
      (tx) => history(tx),
      (tx) => historyDetail(tx, randomUUID()),
      (tx) => filtered(tx),
      (tx) => admitted(tx, email("private-entry")),
      async (tx) => tx`select public.zenith_waitlist_rate_limit(${`${prefix}-denied`}, 1, 60)`,
    ];
    for (const attempt of attempts) {
      await expect(alpha.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await attempt(tx);
        // If a permission regresses, even a successful write is rolled back.
        throw new Error(`The ${role} action unexpectedly succeeded.`);
      })).rejects.toMatchObject({ code: "42501" });
    }
    const page = await asService(alpha, (tx) => list(tx, "queued"));
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].occupation).toBe("Engineer");
  });

  it("enforces RLS even with temporary browser SELECT grants and rolls those grants back", async () => {
    await fixtures(["rls-private"]);
    await asService(alpha, (tx) => preview(tx, "all"));
    await asService(alpha, (tx) => admit(tx, 1));
    await sql`insert into public.waitlist_rate_limits (key, hits, expires_at)
      values (${`${prefix}-rls-private`}, 1, clock_timestamp() + interval '1 hour')`;
    const rollback = new Error("Roll back the temporary RLS-test grants.");
    await expect(sql.begin(async (tx) => {
      for (const table of tables) {
        await tx.unsafe(`grant select on public.${table} to anon, authenticated`);
      }
      for (const role of ["anon", "authenticated"] as const) {
        await tx.unsafe(`set local role ${role}`);
        for (const table of tables) {
          expect(await tx.unsafe(`select * from public.${table}`), `${role} cannot see ${table}`).toHaveLength(0);
        }
        await tx`reset role`;
      }
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it("enforces the rate-limit quota and resets an expired counter as service_role", async () => {
    // Rate-limit cleanup is global; rollback restores any unrelated expired
    // rows it might clean, as well as this test's counters.
    const rollback = new Error("Roll back the rate-limit contract fixture.");
    await expect(asService(alpha, async (tx) => {
      const key = `${prefix}-limit`;
      const consume = async () => {
        const rows = await tx<{ allowed: boolean }[]>`
          select public.zenith_waitlist_rate_limit(${key}, 2, 86400) as allowed
        `;
        return rows[0].allowed;
      };
      expect(await consume()).toBe(true);
      expect(await consume()).toBe(true);
      expect(await consume()).toBe(false);
      const rows = await tx<{ hits: number }[]>`select hits from public.waitlist_rate_limits where key = ${key}`;
      expect(rows).toEqual([{ hits: 2 }]);
      await tx`update public.waitlist_rate_limits set expires_at = clock_timestamp() - interval '1 second' where key = ${key}`;
      expect(await consume()).toBe(true);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
