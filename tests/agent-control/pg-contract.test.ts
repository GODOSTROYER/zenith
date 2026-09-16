/**
 * `agent.agent_operations` against a real PostgreSQL — the claim, the fence,
 * the lease and the reconciliation, as database facts.
 *
 * ## Why this file exists at all
 *
 * ADR D-8 item 2 asks for "DB-enforced single-writer/fencing replacing the
 * `.zenith.lock` pid file", and item 3 asks for multi-instance lease and fence
 * tests **in separate connections**. A test that drives one `PgJournal`
 * instance twice proves that one object is careful. It says nothing about two
 * Vercel instances racing, which is the only situation the fence exists for.
 *
 * So every scenario here opens **two independent clients** — two real backend
 * connections, exactly as two serverless instances would have — and the
 * assertions are about what PostgreSQL did, not about what any TypeScript
 * decided. The statements are CONTROL-PLANE-ON-POSTGRES.md §4, copied
 * verbatim. If `journal-pg.ts` drifts from them, this suite keeps passing and
 * packet P2's own suite fails — which is the right way round: this file pins
 * the contract, not the caller.
 *
 * ## The five properties
 *
 *   1. two claims race, one wins, and the loser sees the row unchanged rather
 *      than an error it has to guess the meaning of;
 *   2. a finalize with a stale fence changes zero rows;
 *   3. a finalize whose authorization digest moved changes zero rows — a grant
 *      revoked mid-dispatch lands in `uncertain`, which is required behaviour
 *      and not a bug;
 *   4. a lease past `lease_until` reconciles to `uncertain` **once**, and the
 *      operation is never re-dispatched;
 *   5. `(workspace_id, subject, request_key)` is unique, so an idempotent
 *      prepare is a database fact on both stores.
 *
 * Skips loudly without `ZENITH_CONTRACT_POSTGRES=1` and `SUPABASE_DB_URL`;
 * `scripts/ci/postgres-lane-report.mjs` is what makes a silent skip in the
 * `postgres` job a failure rather than a green run.
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
    `[agent-control pg-contract] skipped: set ${skipReason()}. ` +
      "Nothing about the claim, the fence or the lease has been verified by this run."
  );

/* ------------------------------ this run's ids ----------------------------- */

const PREFIX = `contract-${Math.random().toString(36).slice(2, 10)}`;
const id = (label: string): string => `${PREFIX}-${label}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * A namespace for **one scenario's** operations.
 *
 * `PREFIX` is this *file's* namespace, so a sweep filtered on it sweeps every
 * scenario's fixtures. Two earlier scenarios deliberately leave rows that a
 * sweep would match — an `approved` row whose `expires_at` is already in the
 * past ("what expired while it waited") and `running` rows whose leases will
 * lapse if the file takes longer than `LEASE_MS` — so any assertion of the form
 * "this pass touched exactly these rows" must name only its own, or it is
 * really asserting the order and the speed the file happened to run at. The
 * `postgres` lane found this the first time it ran the suite: the expiry
 * scenario returned two ids where it expected one.
 */
const namespace = (label: string): string =>
  `${PREFIX}-${label}-${Math.random().toString(36).slice(2, 10)}`;
const hex = (): string =>
  Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

/** `LEASE_MS`, CONTROL-PLANE-ON-POSTGRES.md §4: longer than any one invocation. */
const LEASE_MS = 60_000;

/** Reverse foreign-key order: events reference operations. */
const CLEANUP: readonly { table: string; column: string }[] = [
  { table: "agent_operation_events", column: "operation_id" },
  { table: "agent_operations", column: "id" },
  { table: "agent_uploads", column: "id" },
];

/* ------------------------------- the clients ------------------------------- */

/**
 * Two connections, because one would prove nothing.
 *
 * `pgAuthorityClient()` is a `max: 1` singleton on purpose — it is the whole
 * connection budget of a Vercel instance. Reusing it for both sides of a race
 * would serialise the two "instances" on one socket, and the test would pass
 * whether or not the database enforced anything.
 */
let alpha: Sql;
let beta: Sql;

beforeAll(async () => {
  if (!enabled()) return;
  const { createPgAuthorityClient } = await import("@/lib/hosted/authority/pg/client");
  alpha = createPgAuthorityClient(process.env.SUPABASE_DB_URL!);
  beta = createPgAuthorityClient(process.env.SUPABASE_DB_URL!);
  const ledger = await alpha`select version, name from agent.schema_migrations order by version`;
  expect(
    ledger.map((row) => `${String(row.version)}:${String(row.name)}`),
    "supabase/migrations/0006_agent_link.sql, 0007_agent_control.sql and 0008_agent_workspace_scope.sql must all be applied"
  ).toEqual(["1:agent-link-v1", "2:agent-control-v1", "3:agent-workspace-scope-v1"]);
});

afterAll(async () => {
  if (!enabled() || !alpha) return;
  for (const { table, column } of CLEANUP)
    await alpha.unsafe(`delete from agent.${table} where ${column} like $1`, [`${PREFIX}%`]);
  await Promise.all([alpha.end({ timeout: 5 }), beta?.end({ timeout: 5 })]);
});

/* ------------------------------- the fixtures ------------------------------ */

interface Approved {
  id: string;
  workspaceId: string;
  subject: string;
  digest: string;
  fingerprint: string;
  requestKey: string;
}

/**
 * One operation reviewed and approved in the browser, waiting to be claimed.
 *
 * `ns` puts the row in a scenario's own namespace; without it the row carries
 * the file's, which is the right default for the scenarios that never sweep.
 */
async function approved(overrides: { expiresAt?: string; phase?: string; ns?: string } = {}): Promise<Approved> {
  const op: Approved = {
    id: `${overrides.ns ?? PREFIX}-op-${Math.random().toString(36).slice(2, 10)}`,
    workspaceId: id("ws"),
    subject: id("subject"),
    digest: hex(),
    fingerprint: hex(),
    requestKey: id("request"),
  };
  await alpha`
    insert into agent.agent_operations
      (id, workspace_id, subject, integration_id, request_key, intent_hash, digest, phase,
       action, project_id, environment_id, document, created_at, expires_at,
       approved_by, approval_role, approved_at)
    values (${op.id}, ${op.workspaceId}, ${op.subject}, ${id("cred")}, ${op.requestKey},
            ${hex()}, ${op.digest}, ${overrides.phase ?? "approved"},
            'deploy.apply', ${id("prj")}, ${id("env")},
            ${alpha.json({ id: op.id, phase: overrides.phase ?? "approved", fingerprint: op.fingerprint })},
            ${iso()}, ${overrides.expiresAt ?? iso(3_600_000)},
            ${id("approver")}, 'admin', ${iso()})
  `;
  return op;
}

/**
 * The claim of CONTROL-PLANE-ON-POSTGRES.md §4, as one statement, on whichever
 * connection is playing this instance.
 */
const claim = (
  sql: Sql,
  op: Approved,
  owner: string,
  opts: { now?: string; digest?: string; fingerprint?: string } = {}
) => {
  const now = opts.now ?? iso();
  return sql`
    update agent.agent_operations
       set phase = 'running',
           fence_token = fence_token + 1,
           lease_owner = ${owner},
           lease_until = ${iso(LEASE_MS)},
           attempts = attempts + 1,
           authorization_digest = ${op.digest},
           application_authorization_digest = ${op.fingerprint},
           document = ${sql.json({ id: op.id, phase: "running", fingerprint: opts.fingerprint ?? op.fingerprint })}
     where id = ${op.id}
       and phase = 'approved'
       and approved_by is not null
       and approval_role is not null
       and expires_at > ${now}
       and digest = ${opts.digest ?? op.digest}
       and (document ->> 'fingerprint') = ${opts.fingerprint ?? op.fingerprint}
    returning id, fence_token, document
  `;
};

/** The finalize of §4: guarded on the fence and on both authority digests. */
const finalize = (
  sql: Sql,
  op: Approved,
  fence: number,
  phase: "succeeded" | "failed",
  digests: { authorization?: string; application?: string } = {}
) =>
  sql`
    update agent.agent_operations
       set phase = ${phase}, finished_at = ${iso()},
           document = ${sql.json({ id: op.id, phase, fingerprint: op.fingerprint })},
           lease_owner = null, lease_until = null
     where id = ${op.id}
       and fence_token = ${fence}
       and phase = 'running'
       and expires_at > ${iso()}
       and authorization_digest = ${digests.authorization ?? op.digest}
       and application_authorization_digest = ${digests.application ?? op.fingerprint}
    returning id
  `;

/**
 * The reconciliation pass of §6, bounded and idempotent.
 *
 * `ns` is the scenario's namespace, not the file's: a `running` row another
 * scenario left inside its lease becomes a *lapsed* lease the moment the suite
 * takes longer than `LEASE_MS`, and this pass would then reconcile it and
 * report an id the caller never made.
 */
const reconcile = (sql: Sql, ns: string, now = iso()) =>
  sql`
    update agent.agent_operations
       set phase = 'uncertain', lease_owner = null, lease_until = null,
           document = jsonb_set(document, '{phase}', '"uncertain"')
     where phase = 'running' and lease_until is not null and lease_until <= ${now}
       and id like ${`${ns}%`}
    returning id
  `;

const phaseOf = async (opId: string): Promise<string> =>
  String((await alpha`select phase from agent.agent_operations where id = ${opId}`)[0].phase);

/* ================================ the suite ================================ */

describe.skipIf(!enabled())("AgentControlPostgres", () => {
  describe("the claim", () => {
    it("gives one of two racing instances the operation and the other nothing", async () => {
      const op = await approved();

      const [a, b] = await Promise.all([claim(alpha, op, "instance-a"), claim(beta, op, "instance-b")]);
      const won = [...a, ...b];
      expect(won.length, "exactly one claim, from two independent connections").toBe(1);
      expect(Number(won[0].fence_token), "the fence advances once per claim").toBe(1);

      const row = (await alpha`
        select phase, lease_owner, attempts, fence_token from agent.agent_operations where id = ${op.id}
      `)[0];
      expect(row.phase).toBe("running");
      expect(Number(row.attempts), "one dispatch, one attempt").toBe(1);
      expect(["instance-a", "instance-b"]).toContain(String(row.lease_owner));
    });

    it("leaves the loser a row to read rather than an error to interpret", async () => {
      const op = await approved();
      await claim(alpha, op, "instance-a");

      const second = await claim(beta, op, "instance-b");
      expect(second.length, "zero rows is the answer, not an exception").toBe(0);

      // §4: the caller then reads the row once and maps it — `running` means
      // "somebody else has it", which is `claimed:false` and not a failure.
      const row = (await beta`
        select phase, fence_token, lease_owner from agent.agent_operations where id = ${op.id}
      `)[0];
      expect(row.phase).toBe("running");
      expect(Number(row.fence_token), "the loser did not advance the fence").toBe(1);
      expect(row.lease_owner).toBe("instance-a");
    });

    it("serialises a claim behind an open transaction and still yields one winner", async () => {
      const op = await approved();
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Alpha claims inside a transaction and holds the row lock open.
      let alphaRows = 0;
      const alphaDone = alpha.begin(async (tx) => {
        const rows = await claim(tx as unknown as Sql, op, "instance-a");
        alphaRows = rows.length;
        await held;
        return rows;
      });
      while (alphaRows === 0) await new Promise((r) => setTimeout(r, 10));

      // Beta's identical statement blocks on the row lock rather than reading
      // a stale `approved` and dispatching a second time.
      let betaSettled = false;
      const betaDone = claim(beta, op, "instance-b").then((rows) => {
        betaSettled = true;
        return rows;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(betaSettled, "the second instance waits for the first to commit").toBe(false);

      release();
      await alphaDone;
      expect((await betaDone).length, "and then finds nothing left to claim").toBe(0);
      expect(await phaseOf(op.id)).toBe("running");
    });

    it("refuses to claim what the browser has not approved, or what expired while it waited", async () => {
      const prepared = await approved({ phase: "prepared" });
      expect((await claim(alpha, prepared, "instance-a")).length, "approval_required").toBe(0);
      expect(await phaseOf(prepared.id)).toBe("prepared");

      const stale = await approved({ expiresAt: iso(-1_000) });
      expect((await claim(alpha, stale, "instance-a")).length, "plan_expired").toBe(0);
      expect(await phaseOf(stale.id)).toBe("approved");
    });

    it("refuses a claim whose reviewed digest or state fingerprint moved", async () => {
      const wrongDigest = await approved();
      expect(
        (await claim(alpha, wrongDigest, "instance-a", { digest: hex() })).length,
        "the digest in the WHERE is the one the human approved"
      ).toBe(0);

      const moved = await approved();
      expect(
        (await claim(alpha, moved, "instance-a", { fingerprint: hex() })).length,
        "stale_plan: the state moved between review and dispatch"
      ).toBe(0);
      expect(await phaseOf(moved.id)).toBe("approved");
    });
  });

  describe("the fence", () => {
    it("refuses a finalize carrying the fence of an earlier claim", async () => {
      const op = await approved();
      const claimed = await claim(alpha, op, "instance-a");
      const fence = Number(claimed[0].fence_token);

      expect((await finalize(beta, op, fence - 1, "succeeded")).length, "a stale fence writes nothing").toBe(0);
      expect(await phaseOf(op.id)).toBe("running");

      expect((await finalize(alpha, op, fence, "succeeded")).length).toBe(1);
      expect(await phaseOf(op.id)).toBe("succeeded");
    });

    it("refuses a finalize whose authority moved while the action ran", async () => {
      const op = await approved();
      const fence = Number((await claim(alpha, op, "instance-a"))[0].fence_token);

      // A grant revoked, a role changed, an app unshared: the recomputed
      // application digest no longer matches the one written at claim.
      expect(
        (await finalize(alpha, op, fence, "succeeded", { application: hex() })).length,
        "zero rows, and the caller falls into the uncertain path"
      ).toBe(0);
      expect(await phaseOf(op.id)).toBe("running");

      // Which is what the coordinator then writes, guarded on the same fence.
      const uncertain = await alpha`
        update agent.agent_operations set phase = 'uncertain', lease_owner = null, lease_until = null
         where id = ${op.id} and fence_token = ${fence} and phase = 'running'
        returning id
      `;
      expect(uncertain.length).toBe(1);
      expect(await phaseOf(op.id)).toBe("uncertain");
    });

    it("renews a lease only for the holder of the current fence", async () => {
      const op = await approved();
      const fence = Number((await claim(alpha, op, "instance-a"))[0].fence_token);

      const renew = (withFence: number) =>
        alpha`
          update agent.agent_operations set lease_until = ${iso(LEASE_MS)}
           where id = ${op.id} and fence_token = ${withFence} and phase = 'running'
          returning id
        `;
      expect((await renew(fence)).length).toBe(1);
      expect((await renew(fence + 1)).length, "nobody else may extend this lease").toBe(0);
    });
  });

  describe("reconciliation", () => {
    it("turns an expired lease into uncertain once, and never back into a dispatch", async () => {
      const ns = namespace("lease");
      const op = await approved({ ns });
      const fence = Number((await claim(alpha, op, "instance-a"))[0].fence_token);

      // The instance froze. Nothing can renew the lease, so it lapses.
      await alpha`
        update agent.agent_operations set lease_until = ${iso(-1_000)} where id = ${op.id}
      `;

      const first = await reconcile(beta, ns);
      expect(first.map((row) => row.id), "the tick pass resolves it").toEqual([op.id]);
      expect(await phaseOf(op.id)).toBe("uncertain");

      const row = (await alpha`
        select document, lease_owner, lease_until from agent.agent_operations where id = ${op.id}
      `)[0];
      expect((row.document as { phase: string }).phase, "the stored Operation says so too").toBe("uncertain");
      expect(row.lease_owner).toBeNull();
      expect(row.lease_until).toBeNull();

      expect((await reconcile(beta, ns)).length, "a second pass reconciles nothing the first did").toBe(0);

      // The whole point: an uncertain operation is never replayed. The claim
      // only ever matches `phase='approved'`, and this row will never be that
      // again.
      expect((await claim(alpha, op, "instance-b")).length, "never re-dispatched").toBe(0);
      expect(
        (await finalize(alpha, op, fence, "succeeded")).length,
        "and the frozen instance cannot come back and call it a success"
      ).toBe(0);
      expect(await phaseOf(op.id)).toBe("uncertain");
    });

    it("leaves a live lease alone", async () => {
      const ns = namespace("live-lease");
      const op = await approved({ ns });
      await claim(alpha, op, "instance-a");
      expect(
        (await reconcile(beta, ns)).map((row) => row.id),
        "a running operation inside its lease is somebody's live request"
      ).toEqual([]);
      expect(await phaseOf(op.id)).toBe("running");
    });

    it("expires a proposal nobody reviewed, without touching one that is running", async () => {
      // The namespace is what makes "exactly these ids" an assertion about the
      // predicate rather than about what the rest of the file left lying
      // around: "refuses to claim what expired while it waited" deliberately
      // leaves an `approved` row whose `expires_at` has passed, and a file-wide
      // filter expires that one too.
      const ns = namespace("expiry");
      const forgotten = await approved({ ns, phase: "prepared", expiresAt: iso(-1_000) });
      const live = await approved({ ns });
      await claim(alpha, live, "instance-a");

      const expired = await alpha`
        update agent.agent_operations set phase = 'expired'
         where phase in ('prepared','approved') and expires_at <= ${iso()} and id like ${`${ns}%`}
        returning id
      `;
      expect(
        expired.map((row) => row.id),
        "only the unreviewed proposal: `running` is not a phase expiry may touch"
      ).toEqual([forgotten.id]);
      expect(await phaseOf(live.id)).toBe("running");

      // The lease, not the expiry, is what resolves a dispatch that stopped —
      // and it resolves it to `uncertain`, never to `expired`. Two phases, two
      // passes, and neither may do the other's work.
      expect((await reconcile(beta, ns)).length, "and its lease has not lapsed either").toBe(0);
      expect(await phaseOf(live.id)).toBe("running");
    });
  });

  describe("the operation row", () => {
    it("makes an idempotent prepare a database fact", async () => {
      const op = await approved();
      await expect(
        alpha`
          insert into agent.agent_operations
            (id, workspace_id, subject, integration_id, request_key, intent_hash, digest, phase,
             action, project_id, document, created_at, expires_at)
          values (${id("op")}, ${op.workspaceId}, ${op.subject}, ${id("cred")}, ${op.requestKey},
                  ${hex()}, ${hex()}, 'prepared', 'deploy.apply', ${id("prj")},
                  ${alpha.json({ phase: "prepared" })}, ${iso()}, ${iso(3_600_000)})
        `,
        "unique (workspace_id, subject, request_key)"
      ).rejects.toThrow(/duplicate key|unique/i);

      // The same request key under a different subject is a different
      // operation: the key is scoped by tenant and principal, never global.
      const other = await alpha`
        insert into agent.agent_operations
          (id, workspace_id, subject, integration_id, request_key, intent_hash, digest, phase,
           action, project_id, document, created_at, expires_at)
        values (${id("op")}, ${op.workspaceId}, ${id("subject")}, ${id("cred")}, ${op.requestKey},
                ${hex()}, ${hex()}, 'prepared', 'deploy.apply', ${id("prj")},
                ${alpha.json({ phase: "prepared" })}, ${iso()}, ${iso(3_600_000)})
        returning id
      `;
      expect(other.length).toBe(1);
    });

    it("refuses a phase outside the eight the contract names", async () => {
      const op = await approved();
      await expect(
        alpha`update agent.agent_operations set phase = 'dispatched' where id = ${op.id}`
      ).rejects.toThrow(/check constraint/i);
    });

    it("keeps an operation's events with it, and takes them when it goes", async () => {
      const op = await approved();
      const events = await alpha`
        insert into agent.agent_operation_events (operation_id, kind, at, document)
        values (${op.id}, 'prepared', ${iso()}, ${alpha.json({ note: "contract" })}),
               (${op.id}, 'approved', ${iso()}, ${alpha.json({ note: "contract" })})
        returning seq
      `;
      expect(events.length).toBe(2);
      expect(Number(events[1].seq), "the identity column orders the stream").toBeGreaterThan(
        Number(events[0].seq)
      );

      await expect(
        alpha`
          insert into agent.agent_operation_events (operation_id, kind, at, document)
          values (${id("missing")}, 'prepared', ${iso()}, ${alpha.json({})})
        `,
        "an event without its operation is not a thing that may exist"
      ).rejects.toThrow(/foreign key/i);

      await alpha`delete from agent.agent_operations where id = ${op.id}`;
      const orphans = await alpha`
        select count(*) as n from agent.agent_operation_events where operation_id = ${op.id}
      `;
      expect(Number(orphans[0].n), "on delete cascade").toBe(0);
    });
  });

  describe("the indexes the reconciliation scan depends on", () => {
    it("keeps both partial indexes, with their WHERE clauses", async () => {
      const rows = await alpha`
        select indexname, indexdef from pg_indexes where schemaname = 'agent' order by indexname
      `;
      const byName = new Map(rows.map((row) => [String(row.indexname), String(row.indexdef)]));
      expect([...byName.keys()]).toEqual(
        expect.arrayContaining([
          "agent_operations_scope",
          "agent_operations_review",
          "agent_operations_leased",
          "agent_operations_pending_expiry",
          "agent_operation_events_op",
          "agent_uploads_workspace",
        ])
      );
      // Without the WHERE these become full scans of every operation ever
      // recorded, on a route that runs every five minutes.
      expect(byName.get("agent_operations_leased")).toMatch(/where\s+\(?phase = 'running'/i);
      expect(byName.get("agent_operations_pending_expiry")).toMatch(/where\s+\(?phase = any/i);
      // And deliberately NOT a partial unique index on (project_id) where
      // phase='running': two approved operations on two projects of one
      // workspace may legitimately run at once (§4, "the single-flight
      // question"). If one is ever added, this assertion is where the decision
      // gets re-taken rather than absorbed.
      const singleFlight = [...byName.values()].filter(
        (def) => /unique/i.test(def) && /where/i.test(def) && /phase = 'running'/i.test(def)
      );
      expect(singleFlight, "no undiscussed single-flight index").toEqual([]);
    });
  });
});
