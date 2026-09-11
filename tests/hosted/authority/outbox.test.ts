/**
 * The transactional outbox: intent committed with its cause, effect performed
 * after, and a crash between the two costing a repeat rather than a loss.
 *
 * The crash is simulated the way it actually happens — the row is claimed and
 * the process never comes back to settle it — rather than by a handler that
 * throws, which is a different failure with a different outcome. Both are
 * asserted separately.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-authority-outbox-");

const {
  closeAuthority,
  drainOutbox,
  flushOutbox,
  openAuthority,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  registerOutboxHandler,
  replayOutbox,
} = await import("@/lib/hosted/authority");
const { seedApp, uuid } = await import("./_helpers");

const a = openAuthority();

/** Every idempotency key each handler was asked to perform, in order. */
let delivered: string[] = [];
let unregister: (() => void)[] = [];

beforeEach(() => {
  delivered = [];
});

// Each test owns the whole outbox: a row or a handler left behind by the last
// one would be claimed by this one, and the counts would stop meaning anything.
afterEach(() => {
  for (const off of unregister) off();
  unregister = [];
  a.db.exec("DELETE FROM hosted_outbox");
});

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

const on = (kind: "invite_email" | "webhook" | "spend_alert", handler: (key: string) => void) => {
  unregister.push(
    registerOutboxHandler(kind, async (entry) => {
      handler(entry.idempotencyKey);
    })
  );
};

const enqueue = (kind: "invite_email" | "webhook" | "spend_alert", key: string, payload = {}) =>
  a.tx(() => a.repos.outbox.enqueue({ id: uuid(), idempotencyKey: key, kind, payload }));

describe("enqueue", () => {
  it("writes one row per idempotency key, inside the caller's transaction", () => {
    const app = seedApp(a, { slug: "outbox-app" });
    const key = `invite-${app.id}`;

    const both = a.tx(() => {
      const grant = a.repos.grants.insert({
        id: uuid(),
        appId: app.id,
        subject: "recipient",
        email: "recipient@example.test",
        role: "viewer",
        grantedBy: "founder",
      });
      const first = a.repos.outbox.enqueue({
        id: uuid(),
        idempotencyKey: key,
        kind: "invite_email",
        payload: { grantId: grant.id },
      });
      // A retry of the same logical effect inside the same transaction.
      const second = a.repos.outbox.enqueue({
        id: uuid(),
        idempotencyKey: key,
        kind: "invite_email",
        payload: { grantId: grant.id },
      });
      return { first, second };
    });

    expect(both.first.inserted).toBe(true);
    expect(both.second.inserted).toBe(false);
    expect(both.second.entry.id).toBe(both.first.entry.id);
    expect(a.repos.outbox.listPending()).toHaveLength(1);
    expect(a.repos.outbox.getByKey(key)).toMatchObject({
      state: "pending",
      attempts: 0,
      kind: "invite_email",
      payload: { grantId: both.first.entry.payload.grantId },
    });
  });
});

describe("drainOutbox", () => {
  it("hands the handler a row that is already durably claimed, then settles it", async () => {
    const key = `claim-first-${uuid()}`;
    const seen: { state: string; attempts: number }[] = [];
    unregister.push(
      registerOutboxHandler("webhook", async (entry) => {
        seen.push({ state: entry.state, attempts: entry.attempts });
        // What another process would see while this effect is in flight.
        const onDisk = a.repos.outbox.getByKey(entry.idempotencyKey);
        expect(onDisk?.state).toBe("sending");
        expect(onDisk?.claimedAt).toBeTruthy();
        delivered.push(entry.idempotencyKey);
      })
    );
    enqueue("webhook", key);

    expect(await drainOutbox({ kinds: ["webhook"] })).toEqual({ done: 1, failed: 0 });
    expect(seen).toEqual([{ state: "sending", attempts: 1 }]);
    expect(delivered).toEqual([key]);
    expect(a.repos.outbox.getByKey(key)).toMatchObject({
      state: "done",
      attempts: 1,
      error: undefined,
    });
    expect(await drainOutbox({ kinds: ["webhook"] })).toEqual({ done: 0, failed: 0 });
    expect(delivered).toEqual([key]);
  });

  it("leaves a kind nobody handles pending and visible rather than failing it", async () => {
    const handled = `handled-${uuid()}`;
    const orphan = `orphan-${uuid()}`;
    on("webhook", (key) => delivered.push(key));
    enqueue("webhook", handled);
    enqueue("spend_alert", orphan);

    expect(await drainOutbox({ kinds: ["webhook"] })).toEqual({ done: 1, failed: 0 });
    expect(delivered).toEqual([handled]);
    expect(a.repos.outbox.getByKey(orphan)).toMatchObject({ state: "pending", attempts: 0 });
    expect(a.repos.outbox.listPending({ kinds: ["spend_alert"] })).toHaveLength(1);
  });

  it("retries a failing handler to the attempt limit, then settles failed with its reason", async () => {
    const key = `always-fails-${uuid()}`;
    let calls = 0;
    unregister.push(
      registerOutboxHandler("spend_alert", async () => {
        calls++;
        throw new Error("the provider refused the request");
      })
    );
    enqueue("spend_alert", key);

    expect(await drainOutbox({ kinds: ["spend_alert"] })).toEqual({ done: 0, failed: 1 });
    expect(calls).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(a.repos.outbox.getByKey(key)).toMatchObject({
      state: "failed",
      attempts: OUTBOX_MAX_ATTEMPTS,
      error: "the provider refused the request",
    });
    // Terminal: a failed row is not picked up again.
    expect(await drainOutbox({ kinds: ["spend_alert"] })).toEqual({ done: 0, failed: 0 });
    expect(calls).toBe(OUTBOX_MAX_ATTEMPTS);
  });
});

describe("crash between the claim and the effect", () => {
  it("leaves the row sending, and replayOutbox delivers it exactly once per key", async () => {
    const key = `crashed-${uuid()}`;
    on("invite_email", (k) => delivered.push(k));
    enqueue("invite_email", key);

    // The process claimed the row and died before the effect ran: no handler
    // was called, and the row is durably `sending`.
    const claimed = a.tx(() => a.repos.outbox.claimPending(OUTBOX_LEASE_MS, { kinds: ["invite_email"] }));
    expect(claimed.map((entry) => entry.idempotencyKey)).toEqual([key]);
    expect(a.repos.outbox.getByKey(key)).toMatchObject({ state: "sending", attempts: 1 });
    expect(delivered).toEqual([]);

    // A drain will not touch it — the lease is live and it is nobody's to take.
    expect(await drainOutbox({ kinds: ["invite_email"] })).toEqual({ done: 0, failed: 0 });
    expect(delivered).toEqual([]);

    // Boot does: the data-directory claim proves no other writer holds it.
    const replayed = await replayOutbox();
    expect(replayed).toMatchObject({ reclaimed: 1, done: 1, failed: 0 });
    expect(delivered).toEqual([key]);
    expect(a.repos.outbox.getByKey(key)).toMatchObject({ state: "done", attempts: 2 });

    // A second boot has nothing to repeat.
    expect(await replayOutbox()).toMatchObject({ reclaimed: 0, done: 0, failed: 0 });
    expect(delivered).toEqual([key]);
  });
});

describe("flushOutbox", () => {
  it("drains every registered kind and answers with the totals", async () => {
    on("webhook", (key) => delivered.push(key));
    on("invite_email", (key) => delivered.push(key));
    const keys = [`flush-a-${uuid()}`, `flush-b-${uuid()}`, `flush-c-${uuid()}`];
    enqueue("webhook", keys[0]);
    enqueue("invite_email", keys[1]);
    enqueue("webhook", keys[2]);

    expect(await flushOutbox()).toEqual({ done: 3, failed: 0 });
    expect(delivered.sort()).toEqual([...keys].sort());
    expect(a.repos.outbox.listPending()).toHaveLength(0);
  });
});
