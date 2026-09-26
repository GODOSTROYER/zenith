/**
 * Real PostgreSQL contracts for migration 0009. The two explicit environment
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
const tables = ["waitlist_entries", "waitlist_admission_batches", "waitlist_rate_limits"] as const;
const signatures = [
  "public.zenith_waitlist_join(text,text,text)",
  "public.zenith_waitlist_list(text,bigint,integer)",
  "public.zenith_waitlist_admit(integer,text,text)",
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
      expect(rows[0].present, "Apply supabase/migrations/0009_waitlist.sql before this suite.").toBe(true);
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
      [email("empty-occupation"), "   ", "Deploy"],
      [email("empty-use-case"), "Engineer", "   "],
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

  it("grants only service_role the waitlist RPCs, tables and queue sequence", async () => {
    for (const signature of signatures) {
      const roles = await sql<{ role: string; allowed: boolean }[]>`
        select rolname as role, has_function_privilege(oid, ${signature}, 'EXECUTE') as allowed
        from pg_roles where rolname in ('service_role', 'anon', 'authenticated') order by rolname
      `;
      expect(roles, signature).toEqual([
        { role: "anon", allowed: false }, { role: "authenticated", allowed: false }, { role: "service_role", allowed: true },
      ]);
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
      expect(metadata).toEqual([{ relrowsecurity: true, policies: 0, public_grants: 0 }]);
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

  it.each(["anon", "authenticated"] as const)("refuses direct reads, writes and RPC invocation as %s", async (role) => {
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
