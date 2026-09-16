/**
 * `agent.agent_credentials`, `agent.agent_link_codes` and
 * `agent.agent_rate_limits` against a real PostgreSQL — the database half of
 * the link protocol.
 *
 * ## Why this is SQL and not a call into the credential authority
 *
 * Every property here is a property of the *database*, and three of them are
 * only true because a statement is atomic:
 *
 *   - a double-submitted approval issues **one** credential, because
 *     `UPDATE … WHERE state='pending'` updates one row or none;
 *   - the device code is exchanged **once**, because the same statement that
 *     hands back `secret_ct` sets it to null;
 *   - a revoked or expired credential is refused, because the lookup predicate
 *     says so and not because some caller remembered to check.
 *
 * Proving those through `pgCredentialAuthority()` would prove that one
 * TypeScript function calls the statements correctly; it would not prove the
 * statements are exclusive. Those are different questions and this file asks
 * the second one. `tests/agent-link-authority.test.ts` (packet P1) asks the
 * first, against the file authority, where it can.
 *
 * The statements below are the ones LINK-PROTOCOL.md §3.3 specifies. If P1's
 * implementation drifts from them this suite keeps passing and P1's own suite
 * fails — which is the right way round: this file pins the contract, not the
 * caller.
 *
 * **One of them is not verbatim, on purpose.** §3.3 writes the exchange as a
 * plain `UPDATE … RETURNING secret_ct` and annotates it "postgres returns the
 * PRE-update value". Postgres does not: `RETURNING` reports the row after the
 * update, so that statement hands back `null`. The corrected form — a
 * `FOR UPDATE` sub-select in `FROM`, whose columns `RETURNING` reads — is
 * `exchangeStatement` below, and the scenario "cannot read the secret back
 * from a plain RETURNING" keeps the original on file as the counter-example.
 * Fix §3.3 when the plan is next revised; do not fix the code to match it.
 *
 * ## What it runs against
 *
 * The `postgres` job in `.github/workflows/ci.yml`: a disposable
 * `postgres:16.15-alpine` service with `supabase/migrations/0001`–`0007`
 * applied by `scripts/ci/apply-supabase-migrations.sh`. Both
 * `ZENITH_CONTRACT_POSTGRES=1` and `SUPABASE_DB_URL` are required — the flag
 * says you meant it, the URL says there is something to mean it about — and
 * without them the whole file skips with a line naming both, exactly as
 * `tests/hosted/authority/contract/_factories.ts:79-88` does.
 *
 * Every row this file writes carries this run's `contract-…` namespace (or its
 * hex equivalent, for the columns constrained to 64 hex characters), and
 * `afterAll` deletes them in reverse foreign-key order. Nothing here truncates
 * a table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "@/lib/hosted/authority/pg/client";

/* --------------------------- the lane's two gates -------------------------- */

const enabled = (): boolean =>
  process.env.ZENITH_CONTRACT_POSTGRES === "1" && Boolean(process.env.SUPABASE_DB_URL);

const skipReason = (): string => {
  const missing: string[] = [];
  if (process.env.ZENITH_CONTRACT_POSTGRES !== "1") missing.push("ZENITH_CONTRACT_POSTGRES=1");
  if (!process.env.SUPABASE_DB_URL) missing.push("SUPABASE_DB_URL=<postgres URI>");
  return missing.join(" and ");
};

if (!enabled())
  console.log(
    `[agent-link pg-contract] skipped: set ${skipReason()}. ` +
      "Nothing about agent.agent_credentials or agent.agent_link_codes has been verified by this run."
  );

/* ------------------------------ this run's ids ----------------------------- */

const PREFIX = `contract-${Math.random().toString(36).slice(2, 10)}`;
const id = (label: string): string => `${PREFIX}-${label}-${Math.random().toString(36).slice(2, 10)}`;

/** The hex namespace for the columns a CHECK constrains to 64 hex characters. */
const HEX = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const rand = (n: number): string =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const hex = (namespace: string = HEX): string => (namespace + rand(64)).slice(0, 64);

/**
 * A namespace for **one scenario's** codes.
 *
 * `HEX` alone is this *file's* namespace, so a sweep filtered on it sweeps every
 * scenario's fixtures — including rows an earlier `it` deliberately left
 * expired or approved. Any assertion of the form "this pass touched exactly
 * these rows" has to name only its own, or it is asserting the order the file
 * happens to run in.
 */
const namespace = (): string => HEX + rand(8);

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

/**
 * Reverse foreign-key order: `agent_link_codes.credential_id` references
 * `agent_credentials.id`, so the codes go first. `agent_rate_limits` has no
 * foreign keys and is keyed on `(scope, key, bucket)`, so it is cleaned by its
 * `key`, which this run namespaces the same way.
 */
const CLEANUP: readonly { table: string; column: string; hex?: boolean }[] = [
  { table: "agent_link_codes", column: "user_code_hash", hex: true },
  { table: "agent_credentials", column: "id" },
  { table: "agent_rate_limits", column: "key" },
];

/* ------------------------------- the client -------------------------------- */

let sql: Sql;

beforeAll(async () => {
  if (!enabled()) return;
  const { createPgAuthorityClient } = await import("@/lib/hosted/authority/pg/client");
  sql = createPgAuthorityClient(process.env.SUPABASE_DB_URL!);
  // Fail here, naming the migration, rather than inside the first scenario
  // with a bare "relation does not exist".
  const ledger = await sql`select version, name from agent.schema_migrations order by version`;
  expect(
    ledger.map((row) => `${String(row.version)}:${String(row.name)}`),
    "supabase/migrations/0006_agent_link.sql and 0007_agent_control.sql must both be applied"
  ).toEqual(["1:agent-link-v1", "2:agent-control-v1"]);
});

afterAll(async () => {
  if (!enabled() || !sql) return;
  for (const { table, column, hex: isHex } of CLEANUP)
    await sql.unsafe(`delete from agent.${table} where ${column} like $1`, [
      isHex ? `${HEX}%` : `${PREFIX}%`,
    ]);
  await sql.end({ timeout: 5 });
});

/* ------------------------------- the fixtures ------------------------------ */

interface CredentialRow {
  id: string;
  tokenHash: string;
}

/** One live credential, scoped to one project, expiring in `days`. */
async function credential(
  opts: { days?: number; revokedAt?: string | null; issuedAt?: string } = {}
): Promise<CredentialRow> {
  const row: CredentialRow = { id: id("cred"), tokenHash: hex() };
  await sql`
    insert into agent.agent_credentials
      (id, token_hash, subject, workspace_id, project_ids, environment_ids, app_ids, scopes,
       label, client_name, client_version, issued_at, expires_at, revoked_at, last_used_at, created_by)
    values (${row.id}, ${row.tokenHash}, ${id("subject")}, ${id("ws")},
            ${sql.json([id("prj")])}, ${null}, ${null},
            ${sql.json(["read", "plan", "write"])},
            'contract-laptop', 'Claude Code', '2.1.4',
            ${opts.issuedAt ?? iso()}, ${iso((opts.days ?? 30) * 86_400_000)},
            ${opts.revokedAt ?? null}, ${null}, ${id("subject")})
  `;
  return row;
}

/**
 * The authority's verify lookup, as SQL: an indexed equality on the digest of
 * an unguessable 256-bit token, plus the two liveness predicates. A miss and a
 * hit take the same path (LINK-PROTOCOL.md §4).
 */
const verify = async (tokenHash: string, now = iso()): Promise<Record<string, unknown>[]> =>
  sql`
    select id, scopes, expires_at from agent.agent_credentials
     where token_hash = ${tokenHash} and revoked_at is null and expires_at > ${now}
  `.then((rows) => rows as unknown as Record<string, unknown>[]);

/** One `pending` link code, ten minutes from now. */
async function linkCode(opts: { expiresAt?: string; state?: string; ns?: string } = {}): Promise<{
  userCodeHash: string;
  deviceCodeHash: string;
}> {
  const codes = { userCodeHash: hex(opts.ns), deviceCodeHash: hex(opts.ns) };
  await sql`
    insert into agent.agent_link_codes
      (user_code_hash, device_code_hash, state, client_name, client_version, label,
       requested_scopes, created_at, expires_at)
    values (${codes.userCodeHash}, ${codes.deviceCodeHash}, ${opts.state ?? "pending"},
            'Claude Code', '2.1.4', 'contract-laptop',
            ${sql.json(["read", "plan", "write", "logs"])},
            ${iso()}, ${opts.expiresAt ?? iso(600_000)})
  `;
  return codes;
}

/**
 * The exchange of LINK-PROTOCOL §3.3, corrected.
 *
 * §3.3 writes it as a plain `UPDATE … SET secret_ct = null … RETURNING
 * credential_id, secret_ct` and annotates it "postgres returns the PRE-update
 * value". **It does not.** `RETURNING` reports the row as the statement left
 * it, so that form hands back `null` and the agent gets no token — which is
 * what the `postgres` lane observed the first time it ran this file.
 *
 * The pre-update secret therefore has to come from somewhere that is not the
 * UPDATE's own target: a sub-select in `FROM`, read under `FOR UPDATE`. The
 * lock is not decoration. It is what preserves single use: a second poller
 * blocks on it, re-evaluates `state = 'approved'` against the committed row,
 * sees `consumed`, and matches nothing. `t.state = 'approved'` repeats the
 * guard on the target row so the UPDATE re-checks it too.
 */
const exchangeStatement = (deviceCodeHash: string, now = iso()) =>
  sql`
    update agent.agent_link_codes as t
       set state = 'consumed', secret_ct = null
      from (
        select device_code_hash, credential_id, secret_ct
          from agent.agent_link_codes
         where device_code_hash = ${deviceCodeHash} and state = 'approved' and expires_at > ${now}
         for update
      ) prev
     where t.device_code_hash = prev.device_code_hash and t.state = 'approved'
    returning prev.credential_id as credential_id, prev.secret_ct as secret_ct
  `;

/* ================================ the suite ================================ */

describe.skipIf(!enabled())("AgentLinkPostgres", () => {
  describe("credentials", () => {
    it("issues, verifies, revokes and then refuses — the whole lifetime of one bearer", async () => {
      const cred = await credential();

      expect((await verify(cred.tokenHash)).map((row) => row.id), "a live credential verifies").toEqual([
        cred.id,
      ]);

      const revoked = await sql`
        update agent.agent_credentials set revoked_at = ${iso()}
         where id = ${cred.id} and revoked_at is null
        returning id
      `;
      expect(revoked.length, "revocation touches exactly the one row").toBe(1);

      expect(await verify(cred.tokenHash), "a revoked credential is refused, not deleted").toEqual([]);

      // The row survives revocation on purpose: the Integrations screen shows
      // *revoked* rather than *vanished* (LINK-PROTOCOL.md §4 item 2).
      const kept = await sql`select revoked_at from agent.agent_credentials where id = ${cred.id}`;
      expect(kept.length).toBe(1);
      expect(kept[0].revoked_at).not.toBeNull();

      // Revoking twice is not a second revocation.
      const again = await sql`
        update agent.agent_credentials set revoked_at = ${iso()}
         where id = ${cred.id} and revoked_at is null
        returning id
      `;
      expect(again.length, "a second revoke changes nothing").toBe(0);
    });

    it("refuses a credential whose expiry has passed, on the predicate and not on a caller's memory", async () => {
      const cred = await credential({ days: 0, issuedAt: iso(-86_400_000) });
      // days: 0 puts expires_at at (about) now; ask a second into the future.
      expect(await verify(cred.tokenHash, iso(1_000))).toEqual([]);
    });

    it("refuses two credentials with one token hash", async () => {
      const first = await credential();
      await expect(
        sql`
          insert into agent.agent_credentials
            (id, token_hash, subject, workspace_id, project_ids, scopes, client_name,
             issued_at, expires_at, created_by)
          values (${id("cred")}, ${first.tokenHash}, ${id("subject")}, ${id("ws")},
                  ${sql.json([id("prj")])}, ${sql.json(["read"])}, 'Codex',
                  ${iso()}, ${iso(86_400_000)}, ${id("subject")})
        `,
        "agent_credentials.token_hash is unique"
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it("refuses a token hash that is not 64 hex characters, and a credential with no project", async () => {
      await expect(
        sql`
          insert into agent.agent_credentials
            (id, token_hash, subject, workspace_id, project_ids, scopes, client_name,
             issued_at, expires_at, created_by)
          values (${id("cred")}, 'za_not_a_digest', ${id("subject")}, ${id("ws")},
                  ${sql.json([id("prj")])}, ${sql.json(["read"])}, 'Codex',
                  ${iso()}, ${iso(86_400_000)}, ${id("subject")})
        `,
        "the CHECK keeps a raw secret out of the column that holds its digest"
      ).rejects.toThrow(/check constraint/i);

      await expect(
        sql`
          insert into agent.agent_credentials
            (id, token_hash, subject, workspace_id, project_ids, scopes, client_name,
             issued_at, expires_at, created_by)
          values (${id("cred")}, ${hex()}, ${id("subject")}, ${id("ws")},
                  ${sql.json([])}, ${sql.json(["read"])}, 'Codex',
                  ${iso()}, ${iso(86_400_000)}, ${id("subject")})
        `,
        "parseCredentials requires at least one project; so does the table"
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe("the link code", () => {
    it("moves pending to approved exactly once, however many times the form is submitted", async () => {
      const codes = await linkCode();
      const credentialId = (await credential()).id;
      const now = iso();

      const approve = () =>
        sql`
          update agent.agent_link_codes
             set state = 'approved', approved_at = ${now}, approved_by = ${id("subject")},
                 credential_id = ${credentialId}, secret_ct = ${Buffer.from("ciphertext")}
           where user_code_hash = ${codes.userCodeHash} and state = 'pending' and expires_at > ${now}
          returning user_code_hash
        `;

      // Two submissions of the same form, at the same time, from two sessions.
      const [first, second] = await Promise.all([approve(), approve()]);
      expect(
        first.length + second.length,
        "exactly one of two concurrent approvals updates the row"
      ).toBe(1);

      const after = await sql`
        select state, credential_id from agent.agent_link_codes
         where user_code_hash = ${codes.userCodeHash}
      `;
      expect(after[0].state).toBe("approved");
      expect(after[0].credential_id).toBe(credentialId);
    });

    it("hands the secret back once and destroys it in the same statement", async () => {
      const codes = await linkCode();
      const credentialId = (await credential()).id;
      const now = iso();
      await sql`
        update agent.agent_link_codes
           set state = 'approved', approved_at = ${now}, approved_by = ${id("subject")},
               credential_id = ${credentialId}, secret_ct = ${Buffer.from("za_the_issued_secret")}
         where user_code_hash = ${codes.userCodeHash} and state = 'pending'
      `;

      const exchange = () => exchangeStatement(codes.deviceCodeHash);

      const first = await exchange();
      expect(first.length, "the first poll is the exchange").toBe(1);
      expect(
        Buffer.from(first[0].secret_ct as Uint8Array).toString(),
        "the sub-select in FROM is read before the SET lands, which is the whole trick"
      ).toBe("za_the_issued_secret");
      expect(first[0].credential_id).toBe(credentialId);

      const second = await exchange();
      expect(second.length, "a second poll finds nothing to exchange — expired_token").toBe(0);

      const row = await sql`
        select state, secret_ct from agent.agent_link_codes where device_code_hash = ${codes.deviceCodeHash}
      `;
      expect(row[0].state).toBe("consumed");
      expect(row[0].secret_ct, "the ciphertext is gone, not merely unreachable").toBeNull();
    });

    it("cannot read the secret back from a plain RETURNING, which is why the statement is shaped that way", async () => {
      const codes = await linkCode();
      const credentialId = (await credential()).id;
      await sql`
        update agent.agent_link_codes
           set state = 'approved', approved_at = ${iso()}, approved_by = ${id("subject")},
               credential_id = ${credentialId}, secret_ct = ${Buffer.from("za_lost_to_returning")}
         where user_code_hash = ${codes.userCodeHash} and state = 'pending'
      `;

      // LINK-PROTOCOL §3.3 as written. One row is updated — so this looks like
      // it worked — and the column comes back null, because RETURNING reports
      // the row *after* the SET. This assertion is here so that nobody
      // "simplifies" the statement above back into this one.
      const naive = await sql`
        update agent.agent_link_codes
           set state = 'consumed', secret_ct = null
         where device_code_hash = ${codes.deviceCodeHash} and state = 'approved'
           and expires_at > ${iso()}
        returning credential_id, secret_ct
      `;
      expect(naive.length, "the row is updated either way").toBe(1);
      expect(
        naive[0].secret_ct,
        "RETURNING is post-update: the agent would be handed nothing"
      ).toBeNull();
    });

    it("gives two concurrent pollers one token between them", async () => {
      const codes = await linkCode();
      const credentialId = (await credential()).id;
      await sql`
        update agent.agent_link_codes
           set state = 'approved', credential_id = ${credentialId}, approved_at = ${iso()},
               approved_by = ${id("subject")}, secret_ct = ${Buffer.from("za_once")}
         where user_code_hash = ${codes.userCodeHash} and state = 'pending'
      `;

      const exchange = () => exchangeStatement(codes.deviceCodeHash);

      const [a, b] = await Promise.all([exchange(), exchange()]);
      expect(a.length + b.length, "one exchange, one expired_token").toBe(1);
      // And the one that won holds the plaintext, not a null the caller would
      // have to treat as "expired" after having already consumed the row.
      expect(Buffer.from([...a, ...b][0].secret_ct as Uint8Array).toString()).toBe("za_once");
    });

    it("sweeps expired codes and destroys their secrets, and a second pass finds nothing", async () => {
      // This scenario's own namespace: other scenarios leave `approved` and
      // `pending` rows behind, and a file-wide filter would sweep whichever of
      // them had aged past their ten minutes by the time this test ran.
      const ns = namespace();
      const stale = await linkCode({ ns, expiresAt: iso(-60_000) });
      await sql`
        update agent.agent_link_codes set state = 'approved', secret_ct = ${Buffer.from("za_never_collected")}
         where user_code_hash = ${stale.userCodeHash}
      `;
      const live = await linkCode({ ns });
      const now = iso();

      const sweep = () =>
        sql`
          update agent.agent_link_codes set state = 'expired', secret_ct = null
           where state in ('pending','approved') and expires_at <= ${now}
             and user_code_hash like ${`${ns}%`}
          returning user_code_hash
        `;

      const first = await sweep();
      expect(first.map((row) => row.user_code_hash)).toEqual([stale.userCodeHash]);
      expect((await sweep()).length, "the pass is idempotent").toBe(0);

      const rows = await sql`
        select user_code_hash, state, secret_ct from agent.agent_link_codes
         where user_code_hash in (${stale.userCodeHash}, ${live.userCodeHash})
      `;
      const swept = rows.find((row) => row.user_code_hash === stale.userCodeHash)!;
      expect(swept.state).toBe("expired");
      expect(swept.secret_ct, "an uncollected secret does not outlive its code").toBeNull();
      expect(rows.find((row) => row.user_code_hash === live.userCodeHash)!.state).toBe("pending");
    });

    it("refuses a state outside the five the protocol names", async () => {
      await expect(
        sql`
          insert into agent.agent_link_codes
            (user_code_hash, device_code_hash, state, client_name, requested_scopes, created_at, expires_at)
          values (${hex()}, ${hex()}, 'issued', 'Codex', ${sql.json(["read"])}, ${iso()}, ${iso(600_000)})
        `
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe("the durable rate limiter", () => {
    it("counts inside a window and starts the next one at one", async () => {
      const key = id("addr");
      const windowMs = 60_000;
      const bucketOf = (at: number): number => Math.floor(at / windowMs);
      const base = Date.now();

      const hit = async (at: number): Promise<number> => {
        const rows = await sql`
          insert into agent.agent_rate_limits (scope, key, bucket, count)
          values ('link.start', ${key}, ${bucketOf(at)}, 1)
          on conflict (scope, key, bucket) do update set count = agent.agent_rate_limits.count + 1
          returning count
        `;
        return Number(rows[0].count);
      };

      expect([await hit(base), await hit(base), await hit(base)]).toEqual([1, 2, 3]);
      expect(await hit(base + windowMs), "a new window is a new bucket, counted from one").toBe(1);

      // `delete from … where bucket < current - 1` on every check, as
      // control/rate-limit.ts:57 already does on the file store.
      const current = bucketOf(base + windowMs);
      const dropped = await sql`
        delete from agent.agent_rate_limits
         where key = ${key} and bucket < ${current - 1}
        returning bucket
      `;
      expect(dropped.length, "only buckets older than the previous one are swept").toBe(0);

      const later = bucketOf(base + 5 * windowMs);
      const swept = await sql`
        delete from agent.agent_rate_limits
         where key = ${key} and bucket < ${later - 1}
        returning bucket
      `;
      expect(swept.length).toBe(2);
    });

    it("keeps one row per scope, key and window, and refuses a negative count", async () => {
      const key = id("addr");
      await sql`
        insert into agent.agent_rate_limits (scope, key, bucket, count) values ('link.poll', ${key}, 1, 1)
      `;
      await expect(
        sql`insert into agent.agent_rate_limits (scope, key, bucket, count) values ('link.poll', ${key}, 1, 1)`,
        "the primary key is (scope, key, bucket)"
      ).rejects.toThrow(/duplicate key|unique/i);

      // A different scope is a different bucket: an unauthenticated caller's
      // address and a credential id must not share one counter.
      const other = await sql`
        insert into agent.agent_rate_limits (scope, key, bucket, count) values ('link.lookup', ${key}, 1, 1)
        returning scope
      `;
      expect(other[0].scope).toBe("link.lookup");

      await expect(
        sql`update agent.agent_rate_limits set count = -1 where scope = 'link.poll' and key = ${key} and bucket = 1`
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe("the schema itself", () => {
    it("keeps row level security on with no policies, so only the service role reaches it", async () => {
      const rows = await sql`
        select c.relname, c.relrowsecurity,
               (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'agent' and c.relkind = 'r'
         order by c.relname
      `;
      expect(rows.length, "0006 and 0007 create six tables between them").toBeGreaterThanOrEqual(3);
      for (const row of rows) {
        expect(row.relrowsecurity, `agent.${String(row.relname)} must enable row level security`).toBe(true);
        expect(Number(row.policies), `agent.${String(row.relname)} must carry no policy`).toBe(0);
      }
    });

    it("indexes the credential lookups the authorization path makes", async () => {
      const rows = await sql`
        select indexname, indexdef from pg_indexes where schemaname = 'agent' order by indexname
      `;
      const byName = new Map(rows.map((row) => [String(row.indexname), String(row.indexdef)]));
      expect([...byName.keys()]).toEqual(
        expect.arrayContaining([
          "agent_credentials_subject",
          "agent_credentials_live",
          "agent_link_codes_expiry",
        ])
      );
      // The partial index is the point: a full one would scan revoked rows on
      // every listing. No repository can expose a WHERE clause, so this is the
      // only place a migration that dropped it would be caught.
      expect(byName.get("agent_credentials_live")).toMatch(/where\s+\(?revoked_at is null\)?/i);
    });
  });
});
