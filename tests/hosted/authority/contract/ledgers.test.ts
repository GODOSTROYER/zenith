/**
 * The ledger contract: `quotas`, `usage`, `revocations` and `events`, asserted
 * against every implementation of `Authority`.
 *
 * These four tables are the ones the product *counts* with — admission, spend,
 * reconciliation after a restore, and analytics — so the property that matters
 * is arithmetic, not shape: a total that is one short, a sequence number that
 * was handed out twice, or an event that was recorded twice because a retry was
 * safe are all failures no type can catch. Each `it` below is therefore phrased
 * as something a caller relies on ("the count a caller acts on is the count that
 * committed", "two appends never share a number"), never as something about
 * SQLite or about Postgres.
 *
 * **The Postgres row is skipped unless you ask for it**, with both
 * `ZENITH_CONTRACT_POSTGRES=1` and `SUPABASE_DB_URL` — it writes to a real
 * Supabase project. See `_factories.ts`.
 *
 * **Every id this file writes is inside this run's namespace** (`contract-…`)
 * and `afterAll` hands cleanup to `factory.close`, which deletes exactly those
 * rows. The reads are scoped to this run's workspace and app for the same
 * reason: on a shared project the ledgers already hold other runs' rows, so an
 * unscoped `count()` would assert about somebody else's data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir } from "../../_fixtures";

isolatedDataDir("zenith-authority-ledgers-");

const { nowIso } = await import("@/lib/hosted/authority");
const { contractId, loadAuthorities } = await import("./_factories");

const authorities = await loadAuthorities();

describe.each(authorities)("$name ledgers", (factory) => {
  let a: Awaited<ReturnType<typeof factory.open>>;

  /** The app every scenario hangs its rows off, and the workspace that scopes every read. */
  const appId = contractId("app");
  const workspaceId = contractId("ws");

  beforeAll(async () => {
    a = await factory.open();
    await factory.raw(
      "INSERT INTO {{h}}apps (id, workspace_id, slug, name, contract_version, schema_version, state, " +
        "state_reason, created_by, created_at, updated_at, active_release_id, active_fence, runtime) " +
        "VALUES (?, ?, ?, ?, 1, 1, 'active', NULL, ?, ?, ?, NULL, 0, 'local')",
      [appId, workspaceId, contractId("slug"), "Ledger contract app", contractId("who"), nowIso(), nowIso()]
    );
  });

  afterAll(async () => {
    await factory.close(a);
  });

  /* -------------------------------- quotas --------------------------------- */

  describe("quota counters", () => {
    it("hands each caller the total that committed, and counts denials separately", async () => {
      const day = "2026-03-01";
      expect(await a.repos.quotas.get(appId, day)).toEqual({ appId, day, requests: 0, denied: 0 });

      expect(await a.repos.quotas.increment(appId, day, false)).toEqual({
        appId,
        day,
        requests: 1,
        denied: 0,
      });
      // A denial still counts as a request — PLAN-R3 R3-12: every request that
      // resolves to a known app host counts, whatever its outcome.
      expect(await a.repos.quotas.increment(appId, day, true)).toEqual({
        appId,
        day,
        requests: 2,
        denied: 1,
      });
      expect(await a.repos.quotas.get(appId, day)).toEqual({ appId, day, requests: 2, denied: 1 });

      expect(await a.repos.quotas.resetDay(appId, day)).toBe(1);
      expect(await a.repos.quotas.get(appId, day)).toEqual({ appId, day, requests: 0, denied: 0 });
    });

    it("loses neither of two increments that land at once", async () => {
      // The reason `increment` is one upsert with RETURNING rather than a read
      // and a write: two concurrent requests must see two *different* totals,
      // and the pair of them must be 1 and 2 — never 1 and 1, which is how a
      // read-modify-write admits one request too many.
      const day = "2026-03-02";
      const [first, second] = await Promise.all([
        a.repos.quotas.increment(appId, day, false),
        a.repos.quotas.increment(appId, day, true),
      ]);
      expect([first.requests, second.requests].sort()).toEqual([1, 2]);
      expect(await a.repos.quotas.get(appId, day)).toEqual({ appId, day, requests: 2, denied: 1 });
      await a.repos.quotas.resetDay(appId, day);
    });

    it("lists an app's days newest first, honours sinceDay, and forgets them all on request", async () => {
      const days = ["2026-03-10", "2026-03-11", "2026-03-12"];
      for (const day of days) await a.repos.quotas.increment(appId, day, false);

      expect((await a.repos.quotas.listByApp(appId)).map((c) => c.day)).toEqual([...days].reverse());
      expect((await a.repos.quotas.listByApp(appId, { sinceDay: "2026-03-11" })).map((c) => c.day)).toEqual([
        "2026-03-12",
        "2026-03-11",
      ]);
      expect(await a.repos.quotas.listByApp(appId, { limit: 1 })).toHaveLength(1);

      // No `day` means every counter for the app, which is the fixture's reset.
      expect(await a.repos.quotas.resetDay(appId)).toBe(3);
      expect(await a.repos.quotas.listByApp(appId)).toEqual([]);
      // Removing a counter that is not there is 0, not a failure.
      expect(await a.repos.quotas.resetDay(appId, "2026-03-10")).toBe(0);
    });
  });

  /* --------------------------------- usage --------------------------------- */

  describe("the usage ledger", () => {
    const before = "2026-04-01T00:00:00.000Z";
    const at1 = "2026-04-02T00:00:00.000Z";
    const at2 = "2026-04-03T00:00:00.000Z";

    it("sums and lists exactly the slice it was asked for, with an inclusive lower bound", async () => {
      const ws = contractId("usage-ws");
      const appEntry = await a.repos.usage.append({
        id: contractId("usage-a"),
        workspaceId: ws,
        appId,
        kind: "build_ms",
        amount: 1_500,
        at: before,
      });
      expect(appEntry).toMatchObject({ workspaceId: ws, appId, kind: "build_ms", amount: 1_500, at: before });

      await a.repos.usage.append({
        id: contractId("usage-b"),
        workspaceId: ws,
        appId,
        kind: "requests",
        amount: 10,
        at: at1,
        note: "the note survives",
      });
      await a.repos.usage.append({
        id: contractId("usage-c"),
        workspaceId: ws,
        kind: "provider_usd",
        amount: 0.25,
        at: at2,
      });

      // `since` is inclusive, so the row written exactly at the bound is in.
      expect(await a.repos.usage.sumSince({ workspaceId: ws, since: at1 })).toBeCloseTo(10.25, 10);
      expect(await a.repos.usage.sumSince({ workspaceId: ws, since: before })).toBeCloseTo(1_510.25, 10);
      // One millisecond past the newest row is an empty slice, and an empty
      // slice totals 0 rather than null.
      expect(await a.repos.usage.sumSince({ workspaceId: ws, since: "2026-04-03T00:00:00.001Z" })).toBe(0);

      // The list covers the same slice the total does, oldest first.
      const listed = await a.repos.usage.listSince({ workspaceId: ws, since: at1 });
      expect(listed.map((e) => e.at)).toEqual([at1, at2]);
      expect(listed[0]).toMatchObject({ appId, kind: "requests", amount: 10, note: "the note survives" });
      // A row written without an app or a note carries neither back.
      expect(listed[1].appId).toBeUndefined();
      expect(listed[1].note).toBeUndefined();
    });

    it("narrows by app and by kind, and never by a workspace it was not given", async () => {
      const ws = contractId("usage-filter-ws");
      const other = contractId("usage-other-ws");
      await a.repos.usage.append({
        id: contractId("usage-d"),
        workspaceId: ws,
        appId,
        kind: "emails",
        amount: 3,
        at: at1,
      });
      await a.repos.usage.append({
        id: contractId("usage-e"),
        workspaceId: ws,
        kind: "emails",
        amount: 5,
        at: at1,
      });
      await a.repos.usage.append({
        id: contractId("usage-f"),
        workspaceId: ws,
        appId,
        kind: "storage_bytes",
        amount: 900,
        at: at1,
      });
      await a.repos.usage.append({
        id: contractId("usage-g"),
        workspaceId: other,
        appId,
        kind: "emails",
        amount: 99,
        at: at1,
      });

      expect(await a.repos.usage.sumSince({ workspaceId: ws, since: before, kind: "emails" })).toBe(8);
      expect(await a.repos.usage.sumSince({ workspaceId: ws, since: before, appId })).toBe(903);
      expect(
        await a.repos.usage.sumSince({ workspaceId: ws, since: before, appId, kind: "emails" })
      ).toBe(3);
      // The other workspace's 99 is in neither, which is the whole point of the
      // shared `where`: the total and the list cover the same rows.
      expect(await a.repos.usage.sumSince({ workspaceId: ws, since: before })).toBe(908);
      expect(
        (await a.repos.usage.listSince({ workspaceId: ws, since: before, kind: "emails" })).map((e) => e.amount)
      ).toEqual([3, 5]);
      expect(await a.repos.usage.listSince({ workspaceId: ws, since: before }, { limit: 1 })).toHaveLength(1);
    });
  });

  /* ------------------------------ revocations ------------------------------ */

  describe("the revocation ledger", () => {
    const revocation = (label: string) => ({
      appId,
      grantId: contractId(label),
      subject: contractId("subject"),
      by: contractId("by"),
      reason: "the contract suite revoked it",
    });

    it("numbers every append, monotonically, and says so through maxSeq", async () => {
      const start = await a.repos.revocations.maxSeq();
      const first = await a.repos.revocations.append(revocation("rev-a"));
      expect(first.seq).toBeGreaterThan(start);
      expect(first).toMatchObject({ appId, reason: "the contract suite revoked it" });
      expect(typeof first.at).toBe("string");

      const second = await a.repos.revocations.append(revocation("rev-b"));
      expect(second.seq).toBeGreaterThan(first.seq);
      expect(await a.repos.revocations.maxSeq()).toBe(second.seq);
    });

    it("never hands two concurrent appends the same number", async () => {
      // The reconciliation read is "everything after the sequence my snapshot
      // recorded". A number handed out twice makes one of those revocations
      // invisible to it, which re-admits somebody a restore was meant to keep
      // out (G23) — so this is the property, not an implementation detail.
      const start = await a.repos.revocations.maxSeq();
      const appended = await Promise.all(
        ["c", "d", "e", "f"].map((label) => a.repos.revocations.append(revocation(`rev-${label}`)))
      );
      const seqs = appended.map((entry) => entry.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      for (const seq of seqs) expect(seq).toBeGreaterThan(start);
      expect(await a.repos.revocations.maxSeq()).toBe(Math.max(...seqs));
    });

    it("reads back everything above a sequence, oldest first", async () => {
      const start = await a.repos.revocations.maxSeq();
      const one = await a.repos.revocations.append(revocation("rev-after-a"));
      const two = await a.repos.revocations.append(revocation("rev-after-b"));

      const after = await a.repos.revocations.listAfter(start);
      expect(after.map((entry) => entry.seq)).toEqual([one.seq, two.seq]);
      expect(after[0]).toMatchObject({ appId, grantId: one.grantId, by: one.by, subject: one.subject });
      // `listAfter` is exclusive: asking above the newest row is an empty read,
      // which is how a reconciler learns it is caught up.
      expect(await a.repos.revocations.listAfter(two.seq)).toEqual([]);
      expect(await a.repos.revocations.listAfter(start, { limit: 1 })).toHaveLength(1);
    });
  });

  /* -------------------------------- events --------------------------------- */

  describe("hosted events", () => {
    const ts1 = "2026-05-01T00:00:00.000Z";
    const ts2 = "2026-05-02T00:00:00.000Z";

    const newEvent = (over: Partial<Parameters<typeof a.repos.events.append>[0]> = {}) => ({
      id: contractId("event"),
      event: "app.opened" as const,
      workspaceId,
      appId,
      outcome: "ok" as const,
      assisted: false,
      actorClass: "test" as const,
      ts: ts1,
      ...over,
    });

    it("records one row per logical operation, however many times a retry repeats it", async () => {
      const ws = contractId("events-dedupe-ws");
      const logicalId = contractId("logical");
      const first = await a.repos.events.append(newEvent({ workspaceId: ws, logicalId }));
      expect(first.inserted).toBe(true);

      // The retry case: same logical operation, different row id and different
      // payload. It must not be recorded twice, and the caller must be handed
      // the row that exists rather than the one it tried to write.
      const second = await a.repos.events.append(
        newEvent({ workspaceId: ws, logicalId, outcome: "error", props: { attempt: 2 } })
      );
      expect(second.inserted).toBe(false);
      expect(second.event.id).toBe(first.event.id);
      expect(second.event.outcome).toBe("ok");
      expect(await a.repos.events.count({ workspaceId: ws })).toBe(1);
    });

    it("does not dedupe rows that name no logical operation", async () => {
      // SQL NULL is never equal to itself, so these rows do not enter the
      // partial unique index at all — two of them is not a duplicate.
      const ws = contractId("events-null-ws");
      const one = await a.repos.events.append(newEvent({ workspaceId: ws }));
      const two = await a.repos.events.append(newEvent({ workspaceId: ws }));
      expect([one.inserted, two.inserted]).toEqual([true, true]);
      expect(one.event.logicalId).toBeUndefined();
      expect(await a.repos.events.count({ workspaceId: ws })).toBe(2);
    });

    it("carries props through as JSON, and the flags as themselves", async () => {
      const ws = contractId("events-props-ws");
      const props = { count: 3, code: "E_LIMIT", retried: true, ratio: 0.5 };
      const written = await a.repos.events.append(
        newEvent({ workspaceId: ws, assisted: true, actorClass: "founder", props })
      );
      expect(written.inserted).toBe(true);

      const [read] = await a.repos.events.listSince({ workspaceId: ws });
      expect(read.props).toEqual(props);
      expect(read.assisted).toBe(true);
      expect(read.actorClass).toBe("founder");
      // A row written without props carries none back, rather than an empty
      // object a caller would have to tell apart from a real one.
      await a.repos.events.append(newEvent({ workspaceId: ws, ts: ts2 }));
      const all = await a.repos.events.listSince({ workspaceId: ws });
      expect(all[1].props).toBeUndefined();
    });

    it("counts and lists the same slice, oldest first", async () => {
      const ws = contractId("events-slice-ws");
      const older = await a.repos.events.append(newEvent({ workspaceId: ws, ts: ts1 }));
      const newer = await a.repos.events.append(
        newEvent({ workspaceId: ws, ts: ts2, event: "release.activated", outcome: "denied" })
      );

      expect((await a.repos.events.listSince({ workspaceId: ws })).map((e) => e.id)).toEqual([
        older.event.id,
        newer.event.id,
      ]);
      // `since` is inclusive, so the row written exactly at the bound is in.
      expect((await a.repos.events.listSince({ workspaceId: ws, since: ts2 })).map((e) => e.id)).toEqual([
        newer.event.id,
      ]);
      expect(await a.repos.events.count({ workspaceId: ws })).toBe(2);
      expect(await a.repos.events.count({ workspaceId: ws, since: ts2 })).toBe(1);
      expect(await a.repos.events.count({ workspaceId: ws, event: "release.activated" })).toBe(1);
      expect(await a.repos.events.count({ workspaceId: ws, appId })).toBe(2);
      expect(await a.repos.events.count({ workspaceId: ws, appId: contractId("nobody") })).toBe(0);
      expect(await a.repos.events.listSince({ workspaceId: ws }, { limit: 1 })).toHaveLength(1);
    });
  });
});
