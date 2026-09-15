/**
 * The alert outbox: the part that survives the process.
 *
 * `tests/alerts/delivery.test.ts` proves the bytes on the wire. This file
 * proves the thing a webhook receiver cannot see — that Zenith does not lose a
 * notification when it dies, and does not silently send one twice.
 *
 * Every crash here is simulated the only honest way: the state file is captured
 * at the exact moment of interest, the in-memory store and the delivery globals
 * are dropped, and the file is put back. What survives is what was on disk, so
 * a test that passes because the object was still in memory cannot pass here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlertChannel, AlertOutboxEntry, AlertRule } from "@/lib/domain/types";
import * as fixtures from "./_fixtures";

process.env.ZENITH_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-outbox-"));
process.env.ZENITH_SECRET_KEY = Buffer.alloc(32, 6).toString("base64");
// Collapses the delivery backoff, the same knob that collapses step durations.
process.env.ZENITH_FAST = "1";

const STATE = path.join(process.env.ZENITH_DATA, "state.json");

const { db, flush, resetDb } = await import("@/lib/db/store");
const {
  DELIVERY_COUNTERS,
  DELIVERY_FANOUT_LIMIT,
  IDEMPOTENCY_HEADER,
  OUTBOX_LEASE_MS,
  SIGNATURE_HEADER,
  bootReplayLeaseMs,
  channelTable,
  evaluateAll,
  flushDeliveries,
  idempotencyKeyFor,
  postgresSettleDeps,
  reclaimStale,
  replayOutbox,
  settleWithRetry,
  WEBHOOK_POLICY,
  WEBHOOK_TRANSPORT,
} = await import("@/lib/alerts");
type OutboxSettlement = Parameters<typeof settleWithRetry>[0][number];

// The settle-conflict tests below drive the real Postgres dependencies of
// `settleWithRetry` against a fake PostgREST: the store's own client seam, the
// store's own snapshot scope, and the real by-id reader in `pg/alerts`.
const pgAlerts = await import("@/lib/db/pg/alerts");
const { resetPgClient } = await import("@/lib/db/postgres-store");
const { runWithSnapshot } = await import("@/lib/db/request-snapshot");

const productionResolver = WEBHOOK_POLICY.resolveAll;
const productionTransport = WEBHOOK_TRANSPORT.request;

const { ACTOR: actor, NOW, ago, seedData } = fixtures;

/** A workspace with one project, one environment and one deployed revision. */
function seed(chaos?: string) {
  resetDb(seedData(chaos));
}

function channel(over: Partial<AlertChannel> = {}): AlertChannel {
  const c = fixtures.channelData(over);
  channelTable().push(c);
  return c;
}

/** One health rule that fires against a `seed("degrade")` store. */
function rule(over: Partial<AlertRule> = {}): AlertRule {
  const r: AlertRule = {
    id: "rule1",
    projectId: "p1",
    environmentId: "env1",
    kind: "health_degraded",
    enabled: true,
    createdBy: actor,
    createdAt: ago(10),
    ...over,
  };
  db().alertRules.push(r);
  return r;
}

type Call = { url: string; init: RequestInit };

/**
 * A `fetch` that answers from a queue of statuses. `"hang"` never settles —
 * that is a send this process will never finish, which is the whole point of
 * the rows those tests look at.
 */
function stubFetch(answers: (number | Error | "hang")[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  WEBHOOK_TRANSPORT.request = async (target, body, headers, signal) => {
    calls.push({
      url: target.url.toString(),
      init: { method: "POST", headers, body, signal } as RequestInit,
    });
    const next = answers[Math.min(i++, answers.length - 1)];
    if (next === "hang") return new Promise<Response>(() => {});
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  };
  return calls;
}

const header = (call: Call, name: string): string | undefined =>
  (call.init.headers as Record<string, string>)[name];

const onDisk = () =>
  JSON.parse(fs.readFileSync(STATE, "utf8")) as ReturnType<typeof db>;

/** Let every queued microtask — the drain, and the send it starts — run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * What a restart looks like: nothing in memory, everything from disk. An
 * optional snapshot rewinds the file to an earlier moment, which is how a crash
 * *at* that moment is reproduced.
 */
function restart(snapshot?: string): void {
  flush(); // no debounced write may land after the "crash"
  if (snapshot !== undefined) fs.writeFileSync(STATE, snapshot, "utf8");
  const g = globalThis as Record<string, unknown>;
  delete g.__zenithDb;
  delete g.__zenithDeliveryInFlight;
  delete g.__zenithDeliveryScheduled;
}

beforeEach(() => {
  // A hung send from the previous test must not be awaited by this one.
  const g = globalThis as Record<string, unknown>;
  delete g.__zenithDeliveryInFlight;
  delete g.__zenithDeliveryScheduled;
  WEBHOOK_POLICY.resolveAll = async () => ["93.184.216.34"];
  seed("degrade");
});
afterEach(() => {
  WEBHOOK_POLICY.resolveAll = productionResolver;
  WEBHOOK_TRANSPORT.request = productionTransport;
  resetPgClient(); // no fake PostgREST may outlive the test that installed it
  vi.unstubAllGlobals();
});

/* --------------------------------- intent --------------------------------- */

describe("intent is durable before anything is sent", () => {
  it("writes one outbox row per channel in the same save as the event", async () => {
    channel({ id: "a" });
    channel({ id: "b", kind: "slack", target: "https://hooks.slack.com/services/T/B/x" });
    rule();
    const calls = stubFetch(["hang"]);

    expect(evaluateAll(NOW)).toBe(1);
    // Nothing awaited in between: this is the evaluator's own save, and it must
    // already carry both the open event and the intent to tell somebody.
    flush();

    const saved = onDisk();
    expect(calls).toHaveLength(0); // not one byte has left yet
    expect(saved.alertEvents).toHaveLength(1);
    const eventId = saved.alertEvents[0].id;
    expect(saved.alertOutbox).toHaveLength(2);
    expect(saved.alertOutbox.map((r) => r.channelId).sort()).toEqual(["a", "b"]);
    for (const row of saved.alertOutbox) {
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.eventId).toBe(eventId);
      expect(row.transition).toBe("fired");
      expect(row.workspaceId).toBe("ws1");
      expect(row.idempotencyKey).toBe(idempotencyKeyFor(eventId, "fired", row.channelId));
      expect(row.settledAt).toBeUndefined();
    }

    // And the claim is durable too: `sending` reaches disk before the send.
    await tick();
    expect(calls).toHaveLength(2);
    for (const row of onDisk().alertOutbox) {
      expect(row.status).toBe("sending");
      expect(row.claimedAt).toBeTruthy();
    }
  });

  it("does not queue a second intent for a transition already queued", async () => {
    channel({ id: "a" });
    rule();
    stubFetch(["hang"]);

    evaluateAll(NOW);
    // A second pass over the same firing rule finds the event already open, so
    // nothing new is queued — and even a re-entrant enqueue is keyed out.
    evaluateAll(NOW + 1_000);
    flush();
    expect(onDisk().alertOutbox).toHaveLength(1);
  });

  it("`[]` channelIds still means deliver nowhere, durably", async () => {
    channel({ id: "a" });
    rule({ channelIds: [] });
    const calls = stubFetch([200]);

    expect(evaluateAll(NOW)).toBe(1);
    flush();
    // No row: there is nothing to deliver, so nothing may be replayed later.
    expect(onDisk().alertOutbox).toEqual([]);
    // `[]` — "Zenith tried and had nowhere to send" — not `undefined`.
    expect(onDisk().alertEvents[0].deliveries).toEqual([]);

    await flushDeliveries();
    expect(calls).toHaveLength(0);
    restart();
    expect(db().alertEvents[0].deliveries).toEqual([]);
  });
});

/* --------------------------------- replay --------------------------------- */

describe("a crash does not lose the notification", () => {
  it("replays a row that was still pending when the process died", async () => {
    channel({ id: "a" });
    rule();
    stubFetch(["hang"]);

    evaluateAll(NOW);
    flush();
    const pending = fs.readFileSync(STATE, "utf8");
    expect(JSON.parse(pending).alertOutbox[0].status).toBe("pending");
    await tick(); // the send starts and never comes back

    // Rewind to the instant after the evaluator's save: the event is open, the
    // intent is recorded, and nothing has been sent.
    restart(pending);
    expect(db().alertEvents[0].resolvedAt).toBeUndefined();
    expect(db().alertOutbox[0].status).toBe("pending");

    const calls = stubFetch([200]);
    expect(await replayOutbox()).toBe(1);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body as string).event).toBe("alert.fired");
    const row = onDisk().alertOutbox[0];
    expect(row.status).toBe("delivered");
    expect(row.settledAt).toBeTruthy();
    expect(row.attempts).toBe(1);
    // The honest per-event log the Observe and Settings screens read.
    expect(onDisk().alertEvents[0].deliveries).toHaveLength(1);
    expect(onDisk().alertEvents[0].deliveries?.[0]).toMatchObject({ channelId: "a", ok: true });
  });

  it("retries a send that was never settled, under the same idempotency key", async () => {
    channel({ id: "a", secret: "hunter2" });
    rule();

    // The receiver got attempt 1; the settle never reached disk. Capturing the
    // state file from inside `fetch` is exactly that moment.
    let midSend = "";
    const first: Call[] = [];
    WEBHOOK_TRANSPORT.request = async (target, body, headers, signal) => {
      const init = { method: "POST", headers, body, signal } as RequestInit;
      first.push({ url: target.url.toString(), init });
      if (!midSend) midSend = fs.readFileSync(STATE, "utf8");
      return new Response(null, { status: 200 });
    };

    evaluateAll(NOW);
    await flushDeliveries();
    expect(first).toHaveLength(1);
    const key = header(first[0], IDEMPOTENCY_HEADER);
    expect(key).toBe(idempotencyKeyFor(db().alertEvents[0].id, "fired", "a"));
    // The key travels next to the signature, not instead of it.
    expect(header(first[0], SIGNATURE_HEADER)).toMatch(/^sha256=/);
    expect(JSON.parse(midSend).alertOutbox[0].status).toBe("sending");

    // Crash after the send, before the settle. The claim is seconds old, and
    // boot reclaims it anyway: `claimDataDir` has just proved nobody else can
    // be holding it.
    restart(midSend);
    const second = stubFetch([200]);
    expect(await replayOutbox()).toBe(1);

    expect(second).toHaveLength(1);
    expect(header(second[0], IDEMPOTENCY_HEADER)).toBe(key);
    expect(header(second[0], SIGNATURE_HEADER)).toMatch(/^sha256=/);
    expect(onDisk().alertOutbox[0].status).toBe("delivered");
    // One record of one transition, not two — the duplicate is the receiver's
    // to drop, and the key is what lets it.
    expect(onDisk().alertEvents[0].deliveries).toHaveLength(1);
  });

  it("reclaims a claim older than the lease and leaves a live one alone", async () => {
    channel({ id: "a" });
    rule();
    stubFetch(["hang"]);

    evaluateAll(NOW);
    await tick();
    const row = db().alertOutbox[0];
    expect(row.status).toBe("sending");
    expect(row.claimedAt).toBeTruthy();

    // Inside the lease: this row may still be in flight, so it is not stolen.
    expect(reclaimStale(OUTBOX_LEASE_MS)).toBe(0);
    expect(db().alertOutbox[0].status).toBe("sending");

    row.claimedAt = new Date(Date.now() - OUTBOX_LEASE_MS - 1_000).toISOString();
    expect(reclaimStale(OUTBOX_LEASE_MS)).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.claimedAt).toBeUndefined();
    // Reclaiming is itself durable: the next boot must not re-decide it.
    expect(onDisk().alertOutbox[0].status).toBe("pending");
  });

  it("replays the close, so a receiver's open alert does not stick", async () => {
    // Healthy store: the open event below closes on the first pass.
    seed();
    channel({ id: "a" });
    rule();
    db().alertEvents.push({
      id: "ev-open",
      ruleId: "rule1",
      projectId: "p1",
      environmentId: "env1",
      firedAt: ago(5),
      summary: "api degraded in sandbox.",
      severity: "medium",
      detail: "…",
      simulated: true,
    });
    stubFetch(["hang"]);

    expect(evaluateAll(NOW)).toBe(1);
    flush();
    const closed = fs.readFileSync(STATE, "utf8");
    expect(JSON.parse(closed).alertEvents[0].resolvedAt).toBeTruthy();
    expect(JSON.parse(closed).alertOutbox[0].transition).toBe("resolved");
    await tick();

    restart(closed);
    const calls = stubFetch([200]);
    await replayOutbox();
    expect(JSON.parse(calls[0].init.body as string).event).toBe("alert.resolved");
    expect(onDisk().alertOutbox[0].status).toBe("delivered");
  });
});

/* ------------------------------ boot replay lease -------------------------- */

describe("boot reclaims only what it can prove is abandoned", () => {
  it("leaves a live claim alone where no single writer was proved", async () => {
    channel({ id: "a" });
    rule();
    stubFetch(["hang"]);

    evaluateAll(NOW);
    await tick(); // the claim is durable and the send never comes back
    restart(); // …and the process is replaced while that claim is seconds old

    expect(db().alertOutbox[0].status).toBe("sending");
    expect(db().alertOutbox[0].claimedAt).toBeTruthy();

    // A serverless instance never ran `claimDataDir`, so "nobody else owns
    // this directory" is not something this process knows. Same on Postgres.
    process.env.ZENITH_SERVERLESS = "1";
    try {
      expect(bootReplayLeaseMs()).toBe(OUTBOX_LEASE_MS);
      const calls = stubFetch([200]);
      expect(await replayOutbox(bootReplayLeaseMs())).toBe(0);
      expect(calls).toHaveLength(0);
      expect(db().alertOutbox[0].status).toBe("sending");
    } finally {
      delete process.env.ZENITH_SERVERLESS;
    }

    // One process, one data directory, the claim proved: lease 0, and the row
    // that a dead process was holding is taken back and sent.
    expect(bootReplayLeaseMs()).toBe(0);
    const calls = stubFetch([200]);
    expect(await replayOutbox(bootReplayLeaseMs())).toBe(1);
    expect(calls).toHaveLength(1);
    expect(onDisk().alertOutbox[0].status).toBe("delivered");
  });
});

/* -------------------------------- fan-out ---------------------------------- */

describe("delivery fan-out is bounded", () => {
  it("never has more than the limit in flight, however many channels fire", async () => {
    const channels = 20;
    for (let i = 0; i < channels; i++) channel({ id: `fan-${i}` });
    rule();

    let inFlight = 0;
    let peak = 0;
    WEBHOOK_TRANSPORT.request = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(null, { status: 200 });
    };

    expect(evaluateAll(NOW)).toBe(1);
    await flushDeliveries();

    expect(db().alertOutbox).toHaveLength(channels);
    expect(db().alertOutbox.every((r) => r.status === "delivered")).toBe(true);
    expect(peak).toBeLessThanOrEqual(DELIVERY_FANOUT_LIMIT);
    // And it is a *pool*, not a queue of one: the bound is a cap, not a stall.
    expect(peak).toBeGreaterThan(1);
  });
});

/* ----------------------------- a lost settle ------------------------------- */

/**
 * Driven against the *real* re-read, not a stub of one.
 *
 * The deps passed below are `postgresSettleDeps()` — the closure production
 * passes — over a fake PostgREST, so what decides each outcome is
 * `readOutboxRowsIn`'s own semantics rather than a test's idea of them. Only
 * the flush is injected, because the thing being simulated *is* a flush that
 * loses its version guard.
 */
describe("a settle that loses its version guard", () => {
  type Row = Record<string, unknown>;
  type Snap = Parameters<typeof pgAlerts.refreshOutbox>[0];

  /** A row as the table holds it: promoted columns, plus everything else in `data`. */
  const tableRow = (over: Row = {}): Row => ({
    id: "row-settle",
    workspace_id: "ws1",
    channel_id: "a",
    event_id: "ev-settle",
    status: "sending",
    claimed_at: ago(1),
    attempts: 1,
    idempotency_key: "zenith-fired-ev-settle-a",
    version: 4,
    updated_at: ago(0),
    data: { transition: "fired", createdAt: ago(2) },
    ...over,
  });

  /** What the claimant that won the row wrote: terminal, and nobody's to re-send. */
  const settledElsewhere = (id = "row-settle"): Row =>
    tableRow({
      id,
      status: "failed",
      claimed_at: null,
      version: 5,
      data: {
        transition: "fired",
        createdAt: ago(2),
        settledAt: ago(0),
        error: "the winner's reason",
      },
    });

  /** One row of this instance's batch, as `settle()` left it: terminal locally. */
  const settlement = (id = "row-settle"): OutboxSettlement => {
    const row: AlertOutboxEntry = {
      id,
      workspaceId: "ws1",
      channelId: "a",
      eventId: "ev-settle",
      transition: "fired",
      idempotencyKey: `zenith-fired-ev-settle-${id}`,
      status: "delivered",
      attempts: 1,
      createdAt: ago(2),
      settledAt: ago(0),
    };
    return { row, delivery: { channelId: "a", at: ago(0), ok: true, status: 200, attempts: 1 } };
  };

  /**
   * The drainer's snapshot: the rows it is settling, and no baseline for them
   * yet — every read below re-bases what it adopts, which is the half of the
   * job a claimable-window re-read could not do for a settled row.
   */
  const snapshotOf = (settled: readonly OutboxSettlement[]): Snap => ({
    data: { alertOutbox: settled.map((s) => s.row) } as unknown as Snap["data"],
    baseline: new Map(),
  });

  /**
   * A fake PostgREST over one `alert_outbox` table, installed on the store's own
   * client seam. Enough of the builder for the reads this file drives:
   * `.select("*")`, any number of `.in()` filters ANDed together, awaited last.
   */
  function fakePostgrest(table: Row[]) {
    const reads: { table: string; filters: [string, unknown[]][] }[] = [];
    let broken: string | undefined;
    const answer = (name: string, filters: [string, unknown[]][]) => {
      reads.push({ table: name, filters });
      if (broken) return { data: null, error: { message: broken } };
      const match = (r: Row) => filters.every(([column, values]) => values.includes(r[column]));
      const rows = table.filter(match);
      // PostgREST hands back copies; nothing the store does may reach back into
      // the table through what it read.
      return { data: rows.map((r) => structuredClone(r)), error: null };
    };
    const query = (name: string, filters: [string, unknown[]][]) => ({
      in: (column: string, values: unknown[]) => query(name, [...filters, [column, values]]),
      then: <T>(onOk: (r: ReturnType<typeof answer>) => T) =>
        Promise.resolve(onOk(answer(name, filters))),
    });
    resetPgClient({
      from: (name: string) => ({ select: () => query(name, []) }),
    } as unknown as SupabaseClient);
    return { reads, breakWith: (message: string) => void (broken = message) };
  }

  /** Production's own deps, with only the flush simulated. */
  const run = (
    settled: readonly OutboxSettlement[],
    snap: Snap,
    flush: () => Promise<void>
  ): Promise<Awaited<ReturnType<typeof settleWithRetry>>> =>
    runWithSnapshot(snap, () => settleWithRetry(settled, { ...postgresSettleDeps(), flush }));

  it("re-reads the row by id, in any state, and re-applies the settlement it lost", async () => {
    const before = DELIVERY_COUNTERS.duplicateSendPossible;
    const settled = settlement();
    const snap = snapshotOf([settled]);
    // The table still holds this instance's own claim: the conflict was a stale
    // version, not a lost row.
    const { reads } = fakePostgrest([tableRow({ version: 6 })]);
    let flushes = 0;

    const outcome = await run([settled], snap, async () => {
      // The first flush is the one that lost the race.
      if (++flushes === 1) throw new Error("alert_outbox version conflict");
    });

    expect(outcome).toBe("retried");
    expect(flushes).toBe(2);
    // By id and by nothing else. A `status in (pending, sending)` filter here is
    // exactly the defect this replaced.
    expect(reads).toEqual([{ table: "alert_outbox", filters: [["id", ["row-settle"]]] }]);
    expect(settled.row.status).toBe("delivered");
    expect(settled.row.settledAt).toBeTruthy();
    expect(settled.row.claimedAt).toBeUndefined();
    // …written on the table's version, which is what makes the second flush
    // something other than the same 409 again.
    expect([...snap.baseline.values()].map((b) => b.version)).toEqual([6]);
    expect(DELIVERY_COUNTERS.duplicateSendPossible).toBe(before);
  });

  it("keeps the winner's outcome, and counts no duplicate, when the row came back terminal", async () => {
    const before = DELIVERY_COUNTERS.duplicateSendPossible;
    const settled = settlement();
    const snap = snapshotOf([settled]);
    const { reads } = fakePostgrest([settledElsewhere()]);
    let flushes = 0;

    const outcome = await run([settled], snap, async () => {
      if (++flushes === 1) throw new Error("alert_outbox version conflict");
    });

    expect(outcome).toBe("settled-elsewhere");
    expect(reads[0].filters).toEqual([["id", ["row-settle"]]]);
    // The durable record is the winner's, and this instance now agrees with it.
    expect(settled.row.status).toBe("failed");
    expect(settled.row.error).toBe("the winner's reason");
    expect(settled.row.settledAt).toBe(ago(0));
    expect([...snap.baseline.values()].map((b) => b.version)).toEqual([5]);
    // The row is terminal: nobody will ever send it again, so there is no
    // duplicate to warn about. Counting one was a false alarm on every
    // ordinary lost race.
    expect(DELIVERY_COUNTERS.duplicateSendPossible).toBe(before);
    // The flush still runs — the event's delivery log is in that write too.
    expect(flushes).toBe(2);
  });

  it("is invisible to the claimable-window re-read, which is why the by-id one exists", async () => {
    fakePostgrest([settledElsewhere()]);
    const snap = snapshotOf([settlement()]);

    // `refreshOutbox` answers the drainer's question — what is left to send —
    // so it filters to pending/sending. A row the winner already settled is not
    // in that answer at all: nothing is adopted, nothing is re-based, and a
    // retry built on it conflicts a second time and cries duplicate over a row
    // that is finished.
    await pgAlerts.refreshOutbox(snap, ["ws1"]);
    expect(snap.baseline.size).toBe(0);
    expect(snap.data.alertOutbox[0].status).toBe("delivered"); // stale, this instance's

    // The by-id read asks the other question, and gets the answer.
    expect(await pgAlerts.readOutboxRowsIn(snap, ["row-settle"])).toEqual([]);
    expect(snap.data.alertOutbox[0].status).toBe("failed");
    expect(snap.baseline.size).toBe(1);
  });

  it("names and counts the duplicate when the row is claimable under a newer claim", async () => {
    const before = DELIVERY_COUNTERS.duplicateSendPossible;
    const settled = settlement();
    const snap = snapshotOf([settled]);
    // Another instance reclaimed the row at lease expiry and is sending it right
    // now; this process's outcome is never going to land.
    const table = [tableRow({ claimed_at: ago(0), version: 9 })];
    fakePostgrest(table);

    const outcome = await run([settled], snap, async () => {
      throw new Error("alert_outbox version conflict");
    });

    // The message left this server and the row is still claimable, so the
    // receiver will see it twice under the same idempotency key. That is a
    // counted, named outcome, not a warn line.
    expect(outcome).toBe("duplicate-send-possible");
    expect(DELIVERY_COUNTERS.duplicateSendPossible).toBe(before + 1);
    expect(table[0].status).toBe("sending"); // the newer claimant owns its fate
  });

  it("counts only the rows of a batch that can actually go out again", async () => {
    const before = DELIVERY_COUNTERS.duplicateSendPossible;
    const mine = settlement("row-mine");
    const theirs = settlement("row-theirs");
    const snap = snapshotOf([mine, theirs]);
    fakePostgrest([tableRow({ id: "row-mine", version: 7 }), settledElsewhere("row-theirs")]);

    const outcome = await run([mine, theirs], snap, async () => {
      throw new Error("alert_outbox version conflict");
    });

    expect(outcome).toBe("duplicate-send-possible");
    // One of the two is terminal elsewhere. A counter that said 2 here is the
    // false alarm the whole branch exists to stop.
    expect(DELIVERY_COUNTERS.duplicateSendPossible).toBe(before + 1);
    expect(mine.row.status).toBe("delivered");
    expect(theirs.row.status).toBe("failed");
  });

  it("counts the whole batch when the table cannot be re-read at all", async () => {
    const before = DELIVERY_COUNTERS.duplicateSendPossible;
    const settled = settlement();
    const snap = snapshotOf([settled]);
    fakePostgrest([tableRow()]).breakWith("connection terminated unexpectedly");

    const outcome = await run([settled], snap, async () => {
      throw new Error("alert_outbox unreachable");
    });

    // No answer is no way to tell a row somebody already settled from one
    // somebody is about to re-send, so the pessimistic reading is counted.
    expect(outcome).toBe("duplicate-send-possible");
    expect(DELIVERY_COUNTERS.duplicateSendPossible).toBe(before + 1);
  });
});

/* -------------------------------- outcomes -------------------------------- */

describe("terminal outcomes are persisted, not just logged", () => {
  it("keeps a permanent failure on the row and on the event", async () => {
    channel({ id: "a" });
    rule();
    const calls = stubFetch([404]);

    evaluateAll(NOW);
    await flushDeliveries();
    // A 4xx that is not 429 is a wrong URL, not a bad moment: one attempt.
    expect(calls).toHaveLength(1);

    restart(); // everything below is read back from the file
    const row = db().alertOutbox[0];
    expect(row.status).toBe("failed");
    expect(row.httpStatus).toBe(404);
    expect(row.attempts).toBe(1);
    expect(row.settledAt).toBeTruthy();
    expect(row.claimedAt).toBeUndefined();
    expect(row.error).toContain("Check the URL");
    const delivery = db().alertEvents[0].deliveries?.[0];
    expect(delivery).toMatchObject({ channelId: "a", ok: false, status: 404 });

    // A settled row is not re-driven: a wrong URL fails the same way forever.
    const later = stubFetch([200]);
    expect(await replayOutbox()).toBe(0);
    expect(later).toHaveLength(0);
  });

  it("records a retried failure with the attempts it made", async () => {
    channel({ id: "a" });
    rule();
    const calls = stubFetch([500]);

    evaluateAll(NOW);
    await flushDeliveries();
    expect(calls).toHaveLength(3);

    restart();
    const row = db().alertOutbox[0];
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(row.error).toContain("Tried 3 times");
    expect(db().alertEvents[0].deliveries?.[0].attempts).toBe(3);
  });

  it("settles honestly when the channel was deleted before the replay", async () => {
    channel({ id: "a" });
    rule();
    stubFetch(["hang"]);

    evaluateAll(NOW);
    flush();
    const pending = fs.readFileSync(STATE, "utf8");
    await tick();

    restart(pending);
    // The operator deleted the channel while the server was down.
    const settings = db().settings as { alertChannels?: AlertChannel[] };
    settings.alertChannels = [];
    const calls = stubFetch([200]);
    await replayOutbox();

    expect(calls).toHaveLength(0);
    const row = onDisk().alertOutbox[0];
    expect(row.status).toBe("failed");
    expect(row.error).toContain("was deleted before this alert could be sent");
    expect(onDisk().alertEvents[0].deliveries).toHaveLength(1);
  });
});
