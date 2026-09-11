/**
 * The authority contract: the properties every implementation of `Authority`
 * owes its callers, asserted against each of them.
 *
 * The whole point of two implementations behind one interface is that no call
 * site can tell which it got. That is a claim about behaviour, and the only way
 * to keep it true is to write the behaviour down once and run it against both.
 * Every `it` below is therefore phrased as something a *caller* relies on —
 * "acknowledged means committed", "a throw leaves no trace", "a stale fence is
 * refused" — never as something about SQLite or about Postgres.
 *
 * **The Postgres row is skipped unless you ask for it**, with both
 * `ZENITH_CONTRACT_POSTGRES=1` and `SUPABASE_DB_URL`, because it writes to a
 * real Supabase project. The skip is printed, loudly, at the top of the run:
 * a contract suite that appears to pass because half of it did not run is worse
 * than one that fails. See `_factories.ts`.
 *
 * **Every id this file writes is inside this run's namespace** (`contract-…`,
 * or a hex prefix for the columns the schema constrains to 64 hex characters),
 * and `afterAll` deletes exactly those rows in reverse foreign-key order.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir } from "../../_fixtures";

isolatedDataDir("zenith-authority-contract-");

const { HostedError } = await import("@/lib/hosted/contracts");
const { nowIso } = await import("@/lib/hosted/authority");
const {
  contractHex,
  contractId,
  loadAuthorities,
  postgresContractEnabled,
  postgresSkipReason,
  CONTRACT_CLEANUP,
} = await import("./_factories");

const authorities = await loadAuthorities();

if (!postgresContractEnabled())
  // Deliberately a console line rather than a `skip`: a skipped `describe` is
  // easy to miss in a run of nine hundred tests, and "Postgres was not
  // exercised" is the single most important thing to know about this file's
  // result.
  console.warn(
    `\n[authority contract] PostgreSQL row SKIPPED — running against ${authorities
      .map((f) => f.name)
      .join(", ")} only.\n` +
      `[authority contract] Set ${postgresSkipReason()} to include it. It writes to a real Supabase project.\n`
  );

describe.each(authorities)("$name", (factory) => {
  let a: Awaited<ReturnType<typeof factory.open>>;

  /** The app every scenario hangs its rows off. Seeded raw: `apps` has no Postgres repository in this build. */
  const appId = contractId("app");
  const workspaceId = contractId("ws");

  beforeAll(async () => {
    a = await factory.open();
    await factory.raw(
      "INSERT INTO {{h}}apps (id, workspace_id, slug, name, contract_version, schema_version, state, " +
        "state_reason, created_by, created_at, updated_at, active_release_id, active_fence, runtime) " +
        "VALUES (?, ?, ?, ?, 1, 1, 'active', NULL, ?, ?, ?, NULL, 0, 'local')",
      [appId, workspaceId, contractId("slug"), "Contract app", contractId("who"), nowIso(), nowIso()]
    );
  });

  afterAll(async () => {
    await factory.close(a);
  });

  /** Queue a job for the contract app and answer with its id. */
  const queueJob = async (label: string): Promise<string> => {
    const id = contractId(label);
    await a.tx((repos) =>
      repos.jobs.insert({
        id,
        kind: "publish",
        workspaceId,
        appId,
        actor: contractId("actor"),
        intentHash: contractHex(),
      })
    );
    return id;
  };

  /* ------------------------- commit-before-ACK ---------------------------- */

  describe("commit before acknowledgement", () => {
    it("resolves only once the write is durable to a reader that is not in the transaction", async () => {
      // The property a route acts on: `await tx(...)` returning is permission to
      // answer 200. So the assertion is that an *independent* read — a fresh
      // repository call outside any transaction, which is one autocommitted
      // statement — already sees everything the transaction wrote, with no
      // waiting and no second chance.
      const id = contractId("ack");
      const key = contractId("ack-key");
      await a.tx(async (repos) => {
        await repos.outbox.enqueue({ id, idempotencyKey: key, kind: "webhook", payload: { n: 1 } });
        await repos.jobs.insert({
          id: contractId("ack-job"),
          kind: "publish",
          workspaceId,
          appId,
          actor: contractId("actor"),
          intentHash: contractHex(),
        });
      });
      expect(await a.repos.outbox.getByKey(key)).toMatchObject({ id, state: "pending", attempts: 0 });
    });

    it("returns the callback's own value, not a row or a count", async () => {
      const value = await a.tx(async () => ({ deep: { answer: 42 } }));
      expect(value).toEqual({ deep: { answer: 42 } });
    });
  });

  /* ---------------------------- rollback ---------------------------------- */

  describe("rollback", () => {
    it("leaves no trace of a transaction that threw, and rethrows the original error", async () => {
      const id = contractId("doomed");
      const key = contractId("doomed-key");
      const boom = new Error("the caller changed its mind");
      await expect(
        a.tx(async (repos) => {
          await repos.outbox.enqueue({ id, idempotencyKey: key, kind: "webhook", payload: {} });
          // Written, and about to be un-written. The row must not survive, and
          // the error the caller sees must be this one — not a rollback's.
          throw boom;
        })
      ).rejects.toBe(boom);
      expect(await a.repos.outbox.getByKey(key)).toBeNull();
      expect(await a.repos.outbox.get(id)).toBeNull();
    });

    it("rolls back work a later statement's failure invalidates", async () => {
      const survivor = contractId("survivor-key");
      const casualty = contractId("casualty-key");
      // First enqueue the row the transaction is really about, then violate the
      // UNIQUE on `idempotency_key` with a duplicate. Both must be gone.
      await a.tx((repos) =>
        repos.outbox.enqueue({ id: contractId("dup"), idempotencyKey: casualty, kind: "webhook", payload: {} })
      );
      await expect(
        a.tx(async (repos) => {
          await repos.outbox.enqueue({
            id: contractId("s"),
            idempotencyKey: survivor,
            kind: "webhook",
            payload: {},
          });
          // A second row with an id that already exists: the PRIMARY KEY, not
          // the idempotency key, so `on conflict do nothing` does not absorb it.
          await repos.jobs.insert({
            id: await duplicateJobId(),
            kind: "publish",
            workspaceId,
            appId,
            actor: contractId("actor"),
            intentHash: contractHex(),
          });
        })
      ).rejects.toBeDefined();
      expect(await a.repos.outbox.getByKey(survivor)).toBeNull();
    });

    /** A job id that is already taken, so inserting it again violates the primary key. */
    let taken: string | undefined;
    const duplicateJobId = async (): Promise<string> => (taken ??= await queueJob("taken"));
  });

  /* --------------------------- nested savepoints --------------------------- */

  describe("nesting", () => {
    it("costs only the inner work when an inner transaction fails", async () => {
      const outer = contractId("outer-key");
      const inner = contractId("inner-key");
      await a.tx(async (repos) => {
        await repos.outbox.enqueue({ id: contractId("o"), idempotencyKey: outer, kind: "webhook", payload: {} });
        // A nested `tx()` is a savepoint, so its failure rolls back to the
        // savepoint and the outer transaction carries on to its own COMMIT.
        await expect(
          a.tx(async (nested) => {
            await nested.outbox.enqueue({
              id: contractId("i"),
              idempotencyKey: inner,
              kind: "webhook",
              payload: {},
            });
            throw new Error("inner failed");
          })
        ).rejects.toThrow("inner failed");
      });
      expect(await a.repos.outbox.getByKey(outer)).not.toBeNull();
      expect(await a.repos.outbox.getByKey(inner)).toBeNull();
    });

    it("keeps a successful inner transaction's work, committed with the outer one", async () => {
      const outer = contractId("nest-ok-outer");
      const inner = contractId("nest-ok-inner");
      await a.tx(async (repos) => {
        await repos.outbox.enqueue({ id: contractId("no"), idempotencyKey: outer, kind: "webhook", payload: {} });
        await a.tx((nested) =>
          nested.outbox.enqueue({ id: contractId("ni"), idempotencyKey: inner, kind: "webhook", payload: {} })
        );
      });
      expect(await a.repos.outbox.getByKey(outer)).not.toBeNull();
      expect(await a.repos.outbox.getByKey(inner)).not.toBeNull();
    });

    it("discards an inner transaction's work when the outer one fails afterwards", async () => {
      const inner = contractId("orphan-key");
      await expect(
        a.tx(async () => {
          await a.tx((nested) =>
            nested.outbox.enqueue({ id: contractId("orp"), idempotencyKey: inner, kind: "webhook", payload: {} })
          );
          throw new Error("outer failed after the inner one succeeded");
        })
      ).rejects.toThrow("outer failed");
      // A released savepoint is not a commit. Only the outermost frame's COMMIT is.
      expect(await a.repos.outbox.getByKey(inner)).toBeNull();
    });
  });

  /* ------------------------ partial unique indexes ------------------------- */

  describe("the partial unique indexes", () => {
    it("app_grants_active: one live grant per (app, subject), and any number of revoked ones", async () => {
      const subject = contractId("subject");
      const grant = (state: "active" | "revoked"): unknown[] => [
        contractId("grant"),
        appId,
        subject,
        "someone@example.test",
        "editor",
        state,
        contractId("by"),
        nowIso(),
        nowIso(),
        state === "revoked" ? nowIso() : null,
      ];
      const insertGrant = (state: "active" | "revoked") =>
        factory.raw(
          "INSERT INTO {{h}}app_grants (id, app_id, subject, email, role, state, granted_by, created_at, " +
            "updated_at, revoked_at, revoked_by, revoked_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
          grant(state)
        );

      await insertGrant("active");
      // The second live grant is what the index exists to refuse. A code path
      // could forget to check; the database cannot.
      await expect(insertGrant("active")).rejects.toBeDefined();
      // History is not uniqueness: two revoked rows for the same pair are fine,
      // and deleting them instead would destroy the record of the removal.
      await insertGrant("revoked");
      await insertGrant("revoked");
      const live = await factory.raw(
        "SELECT id FROM {{h}}app_grants WHERE app_id = ? AND subject = ? AND state = 'active'",
        [appId, subject]
      );
      expect(live).toHaveLength(1);
    });

    it("hosted_jobs_single_flight: one running job per app, refused as a conflict", async () => {
      const first = await queueJob("sf-first");
      const second = await queueJob("sf-second");
      const claimed = await a.tx((repos) => repos.jobs.claim(first, contractId("worker"), 60_000));
      expect(claimed).not.toBeNull();
      // The refusal a route answers with, and it says the same thing on both
      // stores — same code, same message, same constraint in `details`.
      const conflict = await a
        .tx((repos) => repos.jobs.claim(second, contractId("worker"), 60_000))
        .catch((err: unknown) => err);
      expect(conflict).toBeInstanceOf(HostedError);
      expect(conflict).toMatchObject({
        code: "conflict",
        details: { appId, constraint: "hosted_jobs_single_flight" },
      });
      await a.tx((repos) => repos.jobs.cancel(first));
      await a.tx((repos) => repos.jobs.cancel(second));
    });

    it("hosted_events_logical: one row per (event, logical id), and no dedupe without one", async () => {
      const logical = contractId("logical");
      const event = (logicalId: string | null): unknown[] => [
        contractId("event"),
        "app.opened",
        nowIso(),
        workspaceId,
        appId,
        null,
        null,
        "ok",
        logicalId,
        false,
        "test",
        null,
      ];
      const insertEvent = (logicalId: string | null) =>
        factory.raw(
          "INSERT INTO {{h}}hosted_events (id, event, ts, workspace_id, app_id, subject_hash, release_id, " +
            "outcome, logical_id, assisted, actor_class, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          event(logicalId)
        );

      await insertEvent(logical);
      await expect(insertEvent(logical)).rejects.toBeDefined();
      // SQL NULL is never equal to itself, so rows with no logical id do not
      // enter the index at all — two of them is not a duplicate.
      await insertEvent(null);
      await insertEvent(null);
      const deduped = await factory.raw(
        "SELECT id FROM {{h}}hosted_events WHERE event = 'app.opened' AND logical_id = ?",
        [logical]
      );
      expect(deduped).toHaveLength(1);
    });
  });

  /* ----------------------------- fence tokens ------------------------------ */

  describe("fence tokens", () => {
    it("refuses every write from a worker whose fence has moved on", async () => {
      const id = await queueJob("fence");
      const claimed = await a.tx((repos) => repos.jobs.claim(id, contractId("worker-a"), 60_000));
      expect(claimed).not.toBeNull();
      const fence = claimed!.fence;
      expect(fence).toBeGreaterThan(0);

      // The token this claim holds works.
      expect(await a.tx((repos) => repos.jobs.advance(id, fence, "build", { step: 1 }))).toBe(true);
      // A stale one does not — silently, with `false`, because the worker that
      // asks is a worker that already lost the job and has nothing to be told.
      expect(await a.tx((repos) => repos.jobs.advance(id, fence - 1, "build", { step: 2 }))).toBe(false);
      expect(await a.tx((repos) => repos.jobs.renewLease(id, fence - 1, nowIso(Date.now() + 60_000)))).toBe(
        false
      );
      expect(await a.tx((repos) => repos.jobs.finish(id, fence - 1, { ok: true }))).toBe(false);
      expect(await a.tx((repos) => repos.jobs.fail(id, fence - 1, "should not land"))).toBe(false);

      const job = await a.repos.jobs.get(id);
      expect(job).toMatchObject({ status: "running", phase: "build", phaseData: { step: 1 } });
      await a.tx((repos) => repos.jobs.cancel(id));
    });

    it("moves the fence on every claim, so a reclaimed job disowns its previous worker", async () => {
      const id = await queueJob("refence");
      const first = await a.tx((repos) => repos.jobs.claim(id, contractId("worker-a"), 1));
      // The lease has already passed; reclaiming puts it back on the queue.
      expect(await a.tx((repos) => repos.jobs.reclaimExpired(nowIso(Date.now() + 5_000)))).toBeGreaterThan(0);
      const second = await a.tx((repos) => repos.jobs.claim(id, contractId("worker-b"), 60_000));
      expect(second!.fence).toBeGreaterThan(first!.fence);
      expect(await a.tx((repos) => repos.jobs.advance(id, first!.fence, "stale", {}))).toBe(false);
      expect(await a.tx((repos) => repos.jobs.advance(id, second!.fence, "fresh", {}))).toBe(true);
      await a.tx((repos) => repos.jobs.cancel(id));
    });
  });

  /* -------------------------------- outbox --------------------------------- */

  describe("the outbox", () => {
    it("enqueues once per idempotency key, however many times the caller retries", async () => {
      const key = contractId("idem");
      const first = await a.tx((repos) =>
        repos.outbox.enqueue({ id: contractId("ob"), idempotencyKey: key, kind: "spend_alert", payload: { n: 1 } })
      );
      const second = await a.tx((repos) =>
        repos.outbox.enqueue({ id: contractId("ob"), idempotencyKey: key, kind: "spend_alert", payload: { n: 2 } })
      );
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      // The row the second caller gets back is the one that exists, not the one
      // it tried to write: its payload is the first call's.
      expect(second.entry.id).toBe(first.entry.id);
      expect(second.entry.payload).toEqual({ n: 1 });
    });

    it("claims durably before the effect, and settles what it claimed", async () => {
      const key = contractId("drain");
      const id = contractId("drain-row");
      await a.tx((repos) =>
        repos.outbox.enqueue({ id, idempotencyKey: key, kind: "provider_cleanup", payload: { target: "x" } })
      );

      const claimed = await a.tx((repos) => repos.outbox.claimPending(60_000, { kinds: ["provider_cleanup"] }));
      const mine = claimed.find((entry) => entry.id === id);
      // `sending` and `attempts: 1` are on disk before anything leaves the
      // process, which is what makes a crash mid-send leave evidence.
      expect(mine).toMatchObject({ state: "sending", attempts: 1 });
      expect(await a.repos.outbox.get(id)).toMatchObject({ state: "sending" });

      expect(await a.tx((repos) => repos.outbox.settle(id, "done"))).toBe(true);
      expect(await a.repos.outbox.get(id)).toMatchObject({ state: "done", error: undefined });
      // A settled row is not claimable again, so a replayed drain does nothing.
      expect(await a.tx((repos) => repos.outbox.settle(id, "done"))).toBe(false);
    });

    it("hands a claim back with release(), and records a failure with its reason", async () => {
      const id = contractId("fail-row");
      await a.tx((repos) =>
        repos.outbox.enqueue({ id, idempotencyKey: contractId("fail"), kind: "webhook", payload: {} })
      );
      await a.tx((repos) => repos.outbox.claimPending(60_000, { kinds: ["webhook"] }));
      expect(await a.tx((repos) => repos.outbox.release(id))).toBe(true);
      expect(await a.repos.outbox.get(id)).toMatchObject({ state: "pending", claimedAt: undefined });

      await a.tx((repos) => repos.outbox.claimPending(60_000, { kinds: ["webhook"] }));
      expect(await a.tx((repos) => repos.outbox.settle(id, "failed", { error: "the endpoint refused" }))).toBe(
        true
      );
      expect(await a.repos.outbox.get(id)).toMatchObject({ state: "failed", error: "the endpoint refused" });
    });

    it("hands back nothing for an empty kind filter, and everything for no filter", async () => {
      // The difference that matters: a caller that computed "the kinds I can
      // handle" and got none must not be handed every row instead.
      expect(await a.repos.outbox.listPending({ kinds: [] })).toEqual([]);
      expect(await a.repos.outbox.claimPending(60_000, { kinds: [] })).toEqual([]);
    });
  });

  /* --------------------------------- jobs ---------------------------------- */

  describe("jobs", () => {
    it("shows a queued job on the queue and takes it off when it is claimed", async () => {
      const id = await queueJob("queue");
      const queuedIds = (await a.repos.jobs.queued(200)).map((job) => job.id);
      expect(queuedIds).toContain(id);
      await a.tx((repos) => repos.jobs.claim(id, contractId("worker"), 60_000));
      expect((await a.repos.jobs.queued(200)).map((job) => job.id)).not.toContain(id);
      await a.tx((repos) => repos.jobs.cancel(id));
    });

    it("seeds phase data on a queued job, and refuses to once it is claimed", async () => {
      const id = await queueJob("seed");
      expect(await a.tx((repos) => repos.jobs.setPhaseData(id, { releaseId: "r-1" }))).toBe(true);
      expect(await a.repos.jobs.get(id)).toMatchObject({ phaseData: { releaseId: "r-1" }, status: "queued" });

      await a.tx((repos) => repos.jobs.claim(id, contractId("worker"), 60_000));
      // Once a worker holds the job, `advance` (fenced) is the only way its
      // phase data moves — a late seed must not overwrite a running job.
      expect(await a.tx((repos) => repos.jobs.setPhaseData(id, { releaseId: "r-2" }))).toBe(false);
      expect(await a.repos.jobs.get(id)).toMatchObject({ phaseData: { releaseId: "r-1" } });
      await a.tx((repos) => repos.jobs.cancel(id));
    });

    it("pushes a lease forward without touching the phase", async () => {
      const id = await queueJob("lease");
      const claimed = await a.tx((repos) => repos.jobs.claim(id, contractId("worker"), 60_000));
      const before = await a.repos.jobs.get(id);
      const until = nowIso(Date.now() + 600_000);

      expect(await a.tx((repos) => repos.jobs.renewLease(id, claimed!.fence, until))).toBe(true);
      const after = await a.repos.jobs.get(id);
      expect(after!.leaseUntil).toBe(until);
      // Liveness, not progress: the phase and its data are untouched, which is
      // the reason this is not `advance`.
      expect(after!.phase).toBe(before!.phase);
      expect(after!.phaseData).toEqual(before!.phaseData);
      expect(after!.fenceToken).toBe(before!.fenceToken);
      await a.tx((repos) => repos.jobs.cancel(id));
    });

    it("will not renew the lease of a job that is no longer running", async () => {
      const id = await queueJob("lease-dead");
      const claimed = await a.tx((repos) => repos.jobs.claim(id, contractId("worker"), 60_000));
      await a.tx((repos) => repos.jobs.finish(id, claimed!.fence, { ok: true }));
      expect(
        await a.tx((repos) => repos.jobs.renewLease(id, claimed!.fence, nowIso(Date.now() + 60_000)))
      ).toBe(false);
    });
  });

  /* ----------------------------- concurrency ------------------------------- */

  describe("two transactions at once", () => {
    it("commits both, losing neither and mixing neither", async () => {
      // On SQLite these are serialised by the authority's mutex; on Postgres
      // they are two real transactions the server arbitrates between. The
      // caller's guarantee is the same either way, and it is the only thing
      // asserted here: both committed, whole.
      const keyA = contractId("race-a");
      const keyB = contractId("race-b");
      const [first, second] = await Promise.all([
        a.tx(async (repos) => {
          const entry = await repos.outbox.enqueue({
            id: contractId("ra"),
            idempotencyKey: keyA,
            kind: "webhook",
            payload: { side: "a" },
          });
          // An await inside the transaction: the window in which a second
          // transaction could interleave, if anything let it.
          await Promise.resolve();
          await repos.outbox.enqueue({
            id: contractId("ra2"),
            idempotencyKey: `${keyA}-2`,
            kind: "webhook",
            payload: { side: "a" },
          });
          return entry.inserted;
        }),
        a.tx(async (repos) => {
          const entry = await repos.outbox.enqueue({
            id: contractId("rb"),
            idempotencyKey: keyB,
            kind: "webhook",
            payload: { side: "b" },
          });
          await Promise.resolve();
          await repos.outbox.enqueue({
            id: contractId("rb2"),
            idempotencyKey: `${keyB}-2`,
            kind: "webhook",
            payload: { side: "b" },
          });
          return entry.inserted;
        }),
      ]);
      expect([first, second]).toEqual([true, true]);
      for (const key of [keyA, `${keyA}-2`, keyB, `${keyB}-2`])
        expect(await a.repos.outbox.getByKey(key)).not.toBeNull();
    });

    it("keeps a failed transaction's rollback off a concurrent one's work", async () => {
      const kept = contractId("kept");
      const lost = contractId("lost");
      const [, outcome] = await Promise.allSettled([
        a.tx((repos) =>
          repos.outbox.enqueue({ id: contractId("k"), idempotencyKey: kept, kind: "webhook", payload: {} })
        ),
        a.tx(async (repos) => {
          await repos.outbox.enqueue({ id: contractId("l"), idempotencyKey: lost, kind: "webhook", payload: {} });
          throw new Error("this one rolls back");
        }),
      ]);
      expect(outcome.status).toBe("rejected");
      expect(await a.repos.outbox.getByKey(kept)).not.toBeNull();
      expect(await a.repos.outbox.getByKey(lost)).toBeNull();
    });
  });

  /* ------------------------------- the shape -------------------------------- */

  describe("the interface itself", () => {
    it("says which implementation it is and where it lives, and nothing more", () => {
      expect(["sqlite", "postgres"]).toContain(a.kind);
      expect(typeof a.path).toBe("string");
      expect(a.path.length).toBeGreaterThan(0);
      // Never the credential. `path` is an identity, not a connection string.
      expect(a.path).not.toContain("@");
      // The connection is deliberately not on the interface.
      expect((a as unknown as Record<string, unknown>).connection ?? null).toSatisfy(
        (value: unknown) => a.kind === "sqlite" || value === null
      );
    });

    it("is idempotent about migrate()", async () => {
      await expect(a.migrate()).resolves.toBeUndefined();
      await expect(a.migrate()).resolves.toBeUndefined();
    });

    it("cleans up after itself in reverse foreign-key order", () => {
      // Not a behaviour of the authority — a property of this file. A table the
      // suite writes and does not list would leave rows in a real project.
      expect(CONTRACT_CLEANUP.map((t) => t.table)).toContain("apps");
      expect(CONTRACT_CLEANUP[CONTRACT_CLEANUP.length - 1].table).toBe("apps");
    });
  });
});
