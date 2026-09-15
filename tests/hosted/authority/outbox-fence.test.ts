/**
 * Two claimants, one outbox row: only the fence holder may settle it.
 *
 * The hole this closes: `settle` and `release` were guarded on
 * `state = 'sending'` alone. A drain that stalled past its 120 s lease was
 * reclaimed, a second drain took the row and re-sent it, and then the first
 * drain woke up and settled the row *the second one was still working on* —
 * erasing its attempt count and, if its send had failed, the failure itself.
 * `hosted_jobs` never had this hole because every write there carries a fence
 * token; the outbox now carries one too, using the `attempts` value the claim
 * itself wrote, so no schema change was needed to get the same guarantee.
 *
 * SQLite here. The Postgres twin runs the same statements and is covered by the
 * cross-store contract suite (`./contract/contract.test.ts`), which asserts the
 * identical refusals against whichever backend it is pointed at.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-authority-outbox-fence-");

const {
  closeAuthority,
  drainOutbox,
  openAuthority,
  OUTBOX_LEASE_MS,
  registerOutboxHandler,
  sqliteConnection,
} = await import("@/lib/hosted/authority");
// The token itself, from the repository that defines what it is.
const { outboxFence } = await import("@/lib/hosted/authority/repos/outbox");

const a = openAuthority();
let unregister: (() => void)[] = [];

afterEach(() => {
  for (const off of unregister) off();
  unregister = [];
  sqliteConnection(a).exec("DELETE FROM hosted_outbox");
});

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

const enqueue = (key: string) =>
  a.tx((repos) =>
    repos.outbox.enqueue({ id: crypto.randomUUID(), idempotencyKey: key, kind: "webhook", payload: {} })
  );

const claim = async (leaseMs: number) =>
  (await a.tx((repos) => repos.outbox.claimPending(leaseMs, { kinds: ["webhook"] })))[0];

describe("a stale claimant", () => {
  it("cannot settle, release or renew over the new owner", async () => {
    const { entry } = await enqueue(`fence-${crypto.randomUUID()}`);
    const first = await claim(OUTBOX_LEASE_MS);
    const staleFence = outboxFence(first);

    // The first drain stalls. Its lease runs out and a second drain reclaims
    // and re-takes the row — this is the moment a second email goes out.
    const second = await claim(0);
    const liveFence = outboxFence(second);
    expect(second.id).toBe(entry.id);
    expect(liveFence).toBeGreaterThan(staleFence);

    // The first drain's transport finally returns.
    expect(await a.tx((repos) => repos.outbox.settle(entry.id, "done", { fence: staleFence }))).toBe(false);
    expect(await a.tx((repos) => repos.outbox.release(entry.id, staleFence))).toBe(false);
    expect(await a.tx((repos) => repos.outbox.renew(entry.id, staleFence))).toBe(false);
    // Nothing it did moved the row: it is still the second drain's to finish.
    expect(await a.repos.outbox.get(entry.id)).toMatchObject({ state: "sending" });

    // And the owner still can — including recording a failure, which the old
    // unfenced settle would have silently overwritten with the stale success.
    expect(await a.tx((repos) => repos.outbox.renew(entry.id, liveFence))).toBe(true);
    expect(
      await a.tx((repos) =>
        repos.outbox.settle(entry.id, "failed", { fence: liveFence, error: "the endpoint refused" })
      )
    ).toBe(true);
    expect(await a.repos.outbox.get(entry.id)).toMatchObject({
      state: "failed",
      error: "the endpoint refused",
    });
  });
});

describe("a drain whose lease is taken while its handler works", () => {
  it("stops instead of settling, and does not count the row as its own", async () => {
    const key = `lost-${crypto.randomUUID()}`;
    const { entry } = await enqueue(key);
    let calls = 0;

    unregister.push(
      registerOutboxHandler("webhook", async () => {
        calls++;
        // On the first attempt the row is reclaimed underneath this handler by
        // another drain, exactly as a 120 s stall would cause.
        if (calls === 1) {
          await a.tx((repos) => repos.outbox.claimPending(0, { kinds: ["webhook"] }));
          throw new Error("slow transport");
        }
      })
    );

    // The drain claims, the handler loses the lease, the renewal between
    // attempts tells it so, and it stops: no settle, and nothing counted.
    expect(await drainOutbox({ kinds: ["webhook"] })).toEqual({ done: 0, failed: 0 });
    expect(calls).toBe(1);
    // The row belongs to the drain that reclaimed it and is still `sending`,
    // ready for that drain — or the next boot replay — to finish.
    expect(await a.repos.outbox.get(entry.id)).toMatchObject({ state: "sending" });
  });
});
