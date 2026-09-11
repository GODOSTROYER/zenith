/**
 * Two editors on one record: the version check, the compare-and-swap that
 * enforces it, and what happens when the two writers are two connections to the
 * same file.
 */
import { afterAll, describe, expect, it } from "vitest";
import { HostedError, type EquipmentRequest, type StaleVersionDetails } from "@/lib/hosted/contracts";
import { IDENTITIES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { ctx, input } from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-data-conflict-");

const { SqliteBackend, TrackerDataStore, closeAllAppData, openAppData, sqliteBackendOf, trackerSql } = await import(
  "@/lib/hosted/data"
);

/**
 * `openAppData` with its backend narrowed to the SQLite connection.
 *
 * `OpenAppData.backend` is a union of the two backends this build ships, and
 * this file runs in the default `sqlite` store and asserts on statements only a
 * SQLite connection can run. `sqliteBackendOf` is the one escape hatch that
 * says so; narrowing once here keeps the assertions readable.
 */
const openSqlite = (appId: string, options: Parameters<typeof openAppData>[1] = {}) => {
  const opened = openAppData(appId, options);
  return { ...opened, backend: sqliteBackendOf(opened) };
};


const extraBackends: InstanceType<typeof SqliteBackend>[] = [];

afterAll(async () => {
  for (const backend of extraBackends) backend.close();
  closeAllAppData();
  removeDir(DATA_DIR);
});

let appCounter = 0;
function freshApp(): string {
  appCounter += 1;
  return `conflict-app-${appCounter}`;
}

async function refusal(fn: () => Promise<unknown>): Promise<HostedError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof HostedError) return error;
    throw error;
  }
  throw new Error("expected a HostedError, but the call succeeded");
}

describe("two-editor conflict", () => {
  it("refuses the second writer with the current record, then accepts the rebase", async () => {
    const appId = freshApp();
    const { store } = openSqlite(appId);
    const editorA = ctx("editor", IDENTITIES.editor, appId);
    const editorB = ctx("owner", IDENTITIES.owner, appId);

    const seed = await store.create(editorA, { writeId: uuid(), record: input({ title: "Dock" }) });

    // Both read version 1.
    const readByA = await store.get(editorA, seed.record.id);
    const readByB = await store.get(editorB, seed.record.id);
    expect(readByA?.version).toBe(1);
    expect(readByB?.version).toBe(1);

    // A writes first.
    const afterA = await store.update(editorA, seed.record.id, {
      writeId: uuid(),
      expectedVersion: 1,
      patch: { status: "approved" },
    });
    expect(afterA.record.version).toBe(2);

    // B writes against the version it read and is refused with what is stored now.
    const conflict = await refusal(() =>
      store.update(editorB, seed.record.id, { writeId: uuid(), expectedVersion: 1, patch: { quantity: 3 } })
    );
    expect(conflict.code).toBe("stale_version");
    expect(conflict.status).toBe(409);
    const details = conflict.details as StaleVersionDetails;
    expect(details.expectedVersion).toBe(1);
    expect(details.current.version).toBe(2);
    expect(details.current.status).toBe("approved");
    expect(details.current.quantity).toBe(1);
    expect(conflict.fix).toContain("new writeId");

    // Nothing of B's write landed.
    const untouched = await store.get(editorB, seed.record.id);
    expect(untouched?.version).toBe(2);
    expect(untouched?.quantity).toBe(1);

    // B re-bases on the current version and succeeds.
    const afterB = await store.update(editorB, seed.record.id, {
      writeId: uuid(),
      expectedVersion: details.current.version,
      patch: { quantity: 3 },
    });
    expect(afterB.record.version).toBe(3);
    expect(afterB.record.quantity).toBe(3);
    expect(afterB.record.status).toBe("approved");
    expect(afterB.record.updatedBy).toBe(IDENTITIES.owner.subject);
  });

  it("records no write id for a refused conflict, so the same id is still usable", async () => {
    const appId = freshApp();
    const { backend, store } = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const seed = await store.create(editor, { writeId: uuid(), record: input() });
    await store.update(editor, seed.record.id, { writeId: uuid(), expectedVersion: 1, patch: { quantity: 2 } });

    const writesBefore = backend.get<{ total: number }>(trackerSql.COUNT_WRITES)?.total;
    const reusable = uuid();
    const conflict = await refusal(() =>
      store.update(editor, seed.record.id, { writeId: reusable, expectedVersion: 1, patch: { quantity: 5 } })
    );
    expect(conflict.code).toBe("stale_version");
    expect(backend.get<{ total: number }>(trackerSql.COUNT_WRITES)?.total).toBe(writesBefore);

    // The refused write id was never reserved, so it still works on a rebase.
    const ok = await store.update(editor, seed.record.id, {
      writeId: reusable,
      expectedVersion: 2,
      patch: { quantity: 5 },
    });
    expect(ok.record.version).toBe(3);
  });
});

describe("compare-and-swap", () => {
  it("changes no row when the version does not match", async () => {
    const appId = freshApp();
    const { backend, store } = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const seed = await store.create(editor, { writeId: uuid(), record: input() });

    const params = (version: number) => [
      "Rewritten",
      seed.record.details,
      seed.record.category,
      seed.record.quantity,
      seed.record.priority,
      seed.record.status,
      seed.record.requestedFor,
      seed.record.neededBy,
      seed.record.updatedBy,
      seed.record.updatedByEmail,
      new Date().toISOString(),
      500,
      seed.record.id,
      version,
    ];

    expect(backend.run(trackerSql.UPDATE_REQUEST_CAS, params(2)).changes).toBe(0);
    expect((await store.get(editor, seed.record.id))?.title).toBe(seed.record.title);
    expect(backend.run(trackerSql.UPDATE_REQUEST_CAS, params(1)).changes).toBe(1);
    expect((await store.get(editor, seed.record.id))?.version).toBe(2);
  });

  it("lets exactly one of two connections win the same version", async () => {
    const appId = freshApp();
    const opened = openSqlite(appId);
    const editorA = ctx("editor", IDENTITIES.editor, appId);
    const editorB = ctx("owner", IDENTITIES.owner, appId);

    // A second real connection to the same file — a second broker process would
    // look exactly like this.
    const backendB = new SqliteBackend(opened.path);
    extraBackends.push(backendB);
    const storeB = new TrackerDataStore({ backend: backendB, appId });

    const seed = await opened.store.create(editorA, { writeId: uuid(), record: input({ title: "Chair" }) });

    // Both connections read version 1 before either writes.
    const seenByA = await opened.store.get(editorA, seed.record.id);
    const seenByB = await storeB.get(editorB, seed.record.id);
    expect(seenByA?.version).toBe(1);
    expect(seenByB?.version).toBe(1);

    // Honest about what this proves: the store's work is synchronous, so in
    // one thread these two calls serialise rather than truly overlap — which is
    // exactly what BEGIN IMMEDIATE would force across two processes anyway. The
    // claim under test is that a connection which read version 1 before the
    // other committed is refused, not that two threads raced. Real lock
    // contention is exercised in the next test.
    const started = Date.now();
    const outcomes = await Promise.allSettled([
      opened.store.update(editorA, seed.record.id, {
        writeId: uuid(),
        expectedVersion: 1,
        patch: { status: "approved" },
      }),
      storeB.update(editorB, seed.record.id, { writeId: uuid(), expectedVersion: 1, patch: { quantity: 4 } }),
    ]);
    const elapsed = Date.now() - started;

    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o) => o.status === "rejected");
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);

    const winner = (won[0] as PromiseFulfilledResult<{ record: EquipmentRequest }>).value.record;
    expect(winner.version).toBe(2);

    const loser = (lost[0] as PromiseRejectedResult).reason as HostedError;
    expect(loser).toBeInstanceOf(HostedError);
    expect(loser.code).toBe("stale_version");
    expect((loser.details as StaleVersionDetails).current.version).toBe(2);

    // The busy timeout is 5000 ms; a hang would show up as an elapsed time near it.
    expect(elapsed).toBeLessThan(2000);

    // Both connections agree on the stored state.
    expect((await storeB.get(editorB, seed.record.id))?.version).toBe(2);
    expect((await opened.store.get(editorA, seed.record.id))?.version).toBe(2);
  });

  it("fails fast rather than hanging when another connection holds the write lock", async () => {
    const appId = freshApp();
    const opened = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const seed = await opened.store.create(editor, { writeId: uuid(), record: input() });

    // A waiter with a deliberately short busy timeout, so the bound is visible
    // in a test rather than costing five seconds.
    const waiting = new SqliteBackend(opened.path, { busyTimeoutMs: 50 });
    extraBackends.push(waiting);
    const waitingStore = new TrackerDataStore({ backend: waiting, appId });

    opened.backend.exec(trackerSql.TX_BEGIN_IMMEDIATE);
    try {
      const started = Date.now();
      await expect(
        waitingStore.update(editor, seed.record.id, {
          writeId: uuid(),
          expectedVersion: 1,
          patch: { quantity: 2 },
        })
      ).rejects.toThrow(/locked|busy/i);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      opened.backend.exec(trackerSql.TX_ROLLBACK);
    }

    // With the lock released the same write goes through.
    const after = await waitingStore.update(editor, seed.record.id, {
      writeId: uuid(),
      expectedVersion: 1,
      patch: { quantity: 2 },
    });
    expect(after.record.version).toBe(2);
    expect(after.record.quantity).toBe(2);
  });
});
