/**
 * A second writer holding the database, from a real OS thread.
 *
 * `DatabaseSync` is synchronous, so a contender that lives on this thread
 * could never release the lock while we wait for it — the wait would be the
 * thing preventing the release. A worker thread is the only honest way to
 * prove that `busy_timeout` does what the pragma says: it holds a real
 * `BEGIN IMMEDIATE` on the same file while this thread blocks inside SQLite.
 *
 * Two outcomes are asserted. A hold shorter than the timeout costs a wait and
 * then commits. A hold longer than it surfaces a `HostedError` naming the
 * cause and the fix, rather than hanging or half-writing.
 */
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-authority-busy-");

const { closeAuthority, openAuthority, sqliteConnection } = await import("@/lib/hosted/authority");
const { uuid } = await import("./_helpers");

const a = openAuthority();
const db = sqliteConnection(a);

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

/**
 * Worker body: take the write lock, say so, hold it, let it go.
 *
 * CommonJS because `eval: true` runs the string as a script; it needs nothing
 * but `node:sqlite` and the flag it was handed.
 */
const HOLDER = `
const { DatabaseSync } = require("node:sqlite");
const { workerData } = require("node:worker_threads");
const flag = new Int32Array(workerData.flag);
const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 250;");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO hosted_events (id, event, ts, workspace_id, outcome, assisted, actor_class) VALUES (?, 'app.opened', ?, 'ws-one', 'ok', 0, 'test')")
  .run(workerData.rowId, new Date().toISOString());
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
db.exec("ROLLBACK");
db.close();
`;

/** Start a holder and block until it reports the lock is taken. */
function holdWriteLock(holdMs: number): { worker: Worker; exited: Promise<number> } {
  const shared = new SharedArrayBuffer(4);
  const flag = new Int32Array(shared);
  const worker = new Worker(HOLDER, {
    eval: true,
    workerData: { file: a.path, flag: shared, holdMs, rowId: uuid() },
  });
  const exited = new Promise<number>((resolve) => worker.on("exit", resolve));
  // Blocks this thread, not the worker's: the flag flips from the other core.
  Atomics.wait(flag, 0, 0, 10_000);
  expect(Atomics.load(flag, 0)).toBe(1);
  return { worker, exited };
}

const countApps = (): number =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM apps").get()?.n ?? -1);

describe("a second writer holding the database", () => {
  it("waits for a hold shorter than the busy timeout, then commits", async () => {
    const { exited } = holdWriteLock(400);
    const started = Date.now();

    const app = await a.tx((repos) =>
      repos.apps.insert({
        id: uuid(),
        workspaceId: "ws-one",
        slug: "waited-for-the-lock",
        name: "Waited for the lock",
        createdBy: "founder",
        runtime: "local",
      })
    );
    const waited = Date.now() - started;

    expect((await a.repos.apps.get(app.id))?.slug).toBe("waited-for-the-lock");
    expect(waited).toBeGreaterThan(100);
    expect(waited).toBeLessThan(5_000);
    await exited;
  });

  it("surfaces a HostedError naming its fix when the hold outlasts the timeout", async () => {
    const before = countApps();
    const { exited } = holdWriteLock(6_500);
    const started = Date.now();

    let thrown: unknown;
    try {
      await a.tx(
        (repos) =>
          repos.apps.insert({
            id: uuid(),
            workspaceId: "ws-one",
            slug: "never-written",
            name: "Never written",
            createdBy: "founder",
            runtime: "local",
          }),
        // One attempt: five would each wait out the full five-second busy
        // timeout, and the point being proved is that it refuses rather than
        // hangs, not how many times it is willing to try.
        { attempts: 1 }
      );
    } catch (err) {
      thrown = err;
    }
    const waited = Date.now() - started;

    const error = thrown as Error & { code?: string; fix?: string; details?: { reason?: string } };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("policy_unavailable");
    expect(error.details?.reason).toBe("sqlite_busy");
    expect(error.fix).toMatch(/ZENITH_DATA|Retry/);
    expect(waited).toBeGreaterThan(4_000);
    expect(waited).toBeLessThan(15_000);

    // Nothing was half written, and the connection is not stuck in a transaction.
    expect(await a.repos.apps.getBySlug("never-written")).toBeNull();
    expect(db.isTransaction).toBe(false);

    await exited;
    // The holder rolled back, so its own row is gone and the count is untouched.
    expect(countApps()).toBe(before);
    expect(await a.repos.events.count()).toBe(0);
  }, 30_000);
});
