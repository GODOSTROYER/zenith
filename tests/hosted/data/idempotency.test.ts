/**
 * Write ids: replaying a retried mutation, refusing a reused id that carries a
 * different intent, surviving a restart, and the retention sweep.
 */
import { afterAll, describe, expect, it } from "vitest";
import { HostedError, TRACKER_LIMITS } from "@/lib/hosted/contracts";
import { IDENTITIES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { ctx, input } from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-data-idempotency-");

const { closeAllAppData, closeAppData, openAppData, sqliteBackendOf, trackerSql, writeIntentHash } = await import(
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


afterAll(async () => {
  closeAllAppData();
  removeDir(DATA_DIR);
});

let appCounter = 0;
function freshApp(): string {
  appCounter += 1;
  return `idem-app-${appCounter}`;
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

describe("create replay", () => {
  it("returns the identical record and writes no second row", async () => {
    const appId = freshApp();
    const { backend, store } = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const writeId = uuid();
    const body = { writeId, record: input({ title: "Keyboard", category: "peripheral" }) };

    const first = await store.create(editor, body);
    expect(first.replayed).toBe(false);

    const second = await store.create(editor, body);
    expect(second.replayed).toBe(true);
    expect(second.record).toEqual(first.record);

    expect(backend.get<{ total: number }>(trackerSql.COUNT_REQUESTS)?.total).toBe(1);
    expect(backend.get<{ total: number }>(trackerSql.COUNT_WRITES)?.total).toBe(1);
    await expect(store.storageBytes(appId)).resolves.toBe(
      backend.get<{ total: number }>(trackerSql.SELECT_REQUESTS_LOGICAL_BYTES_SUM)?.total
    );
  });

  it("treats an omitted default as the same intent as the value it defaults to", async () => {
    const appId = freshApp();
    const { store } = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const writeId = uuid();

    const first = await store.create(editor, {
      writeId,
      record: { title: "Cable", category: "peripheral" },
    });
    const retry = await store.create(editor, {
      writeId,
      record: { title: "Cable", category: "peripheral", quantity: 1, priority: "normal", status: "requested" },
    });
    expect(retry.replayed).toBe(true);
    expect(retry.record.id).toBe(first.record.id);
  });

  it("refuses the same write id carrying a different body", async () => {
    const appId = freshApp();
    const { backend, store } = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const writeId = uuid();

    await store.create(editor, { writeId, record: input({ title: "Original" }) });
    const conflict = await refusal(() =>
      store.create(editor, { writeId, record: input({ title: "Different" }) })
    );
    expect(conflict.code).toBe("idempotency_conflict");
    expect(conflict.status).toBe(409);
    expect(conflict.fix).toContain("new writeId");
    expect(backend.get<{ total: number }>(trackerSql.COUNT_REQUESTS)?.total).toBe(1);
  });

  it("refuses a write id reused by a different subject or for a different operation", async () => {
    const appId = freshApp();
    const { store } = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const owner = ctx("owner", IDENTITIES.owner, appId);
    const writeId = uuid();
    const record = input({ title: "Shared id" });

    const created = await store.create(editor, { writeId, record });

    // Same body, different subject — the subject is part of the canonical intent.
    const bySomeoneElse = await refusal(() => store.create(owner, { writeId, record }));
    expect(bySomeoneElse.code).toBe("idempotency_conflict");

    // Same id used for an update instead of a create.
    const asUpdate = await refusal(() =>
      store.update(editor, created.record.id, { writeId, expectedVersion: 1, patch: { quantity: 2 } })
    );
    expect(asUpdate.code).toBe("idempotency_conflict");
  });

  it("re-checks the role before replaying", async () => {
    const appId = freshApp();
    const { store } = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const viewer = ctx("viewer", IDENTITIES.viewer, appId);
    const writeId = uuid();
    const body = { writeId, record: input() };

    await store.create(editor, body);
    const refused = await refusal(() => store.create(viewer, body));
    expect(refused.code).toBe("forbidden");
  });
});

describe("update replay", () => {
  it("returns the record as it was written, not as it is now", async () => {
    const appId = freshApp();
    const { backend, store } = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const seed = await store.create(editor, { writeId: uuid(), record: input() });

    const writeId = uuid();
    const body = { writeId, expectedVersion: 1, patch: { status: "approved" as const } };
    const first = await store.update(editor, seed.record.id, body);
    expect(first.record.version).toBe(2);

    // Someone else moves the record on.
    await store.update(editor, seed.record.id, {
      writeId: uuid(),
      expectedVersion: 2,
      patch: { quantity: 9 },
    });

    // The original caller retries its lost acknowledgement and gets its own result.
    const replay = await store.update(editor, seed.record.id, body);
    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(first.record);
    expect(replay.record.version).toBe(2);

    // And the retry applied nothing: the record is still at version 3.
    expect((await store.get(editor, seed.record.id))?.version).toBe(3);
    expect(backend.get<{ total: number }>(trackerSql.COUNT_WRITES)?.total).toBe(3);
  });
});

describe("across a restart", () => {
  it("replays a write id recorded before the database was closed", async () => {
    const appId = freshApp();
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const writeId = uuid();
    const body = { writeId, record: input({ title: "Survives a restart" }) };

    const before = openSqlite(appId);
    const created = await before.store.create(editor, body);
    const bytesBefore = await before.store.storageBytes(appId);
    expect(closeAppData(appId)).toBe(1);

    const after = openSqlite(appId);
    expect(after.backend).not.toBe(before.backend);

    const replay = await after.store.create(editor, body);
    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(created.record);

    expect(after.backend.get<{ total: number }>(trackerSql.COUNT_REQUESTS)?.total).toBe(1);
    await expect(after.store.storageBytes(appId)).resolves.toBe(bytesBefore);
    await expect(after.store.get(editor, created.record.id)).resolves.toEqual(created.record);
  });
});

describe("retention sweep", () => {
  it("drops write ids past the retention window and keeps the records", async () => {
    const appId = freshApp();
    const { backend, store } = openSqlite(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const writeId = uuid();
    const body = { writeId, record: input({ title: "Old write" }) };
    const created = await store.create(editor, body);

    // Nothing expires yet.
    await expect(store.purgeExpiredWrites(new Date())).resolves.toBe(0);
    expect((await store.create(editor, body)).replayed).toBe(true);

    // One millisecond past the window, the id is no longer replayable.
    const later = new Date(Date.now() + TRACKER_LIMITS.writeIdRetentionMs + 1);
    await expect(store.purgeExpiredWrites(later)).resolves.toBe(1);
    expect(backend.get<{ total: number }>(trackerSql.COUNT_WRITES)?.total).toBe(0);
    expect(backend.get<{ total: number }>(trackerSql.COUNT_REQUESTS)?.total).toBe(1);
    await expect(store.get(editor, created.record.id)).resolves.toMatchObject({ id: created.record.id });

    // The same body under the same id now creates a second record — which is
    // precisely why the retention window is part of the published contract.
    const afterPurge = await store.create(editor, body);
    expect(afterPurge.replayed).toBe(false);
    expect(afterPurge.record.id).not.toBe(created.record.id);
  });
});

describe("intent hash", () => {
  it("does not depend on the order the body's keys were written in", async () => {
    const a = writeIntentHash("create", "app", "sub", null, { writeId: "w", record: { title: "A", quantity: 2 } });
    const b = writeIntentHash("create", "app", "sub", null, { record: { quantity: 2, title: "A" }, writeId: "w" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the operation, the app, the subject, the record and the body", async () => {
    const base = writeIntentHash("update", "app", "sub", "rec", { patch: { quantity: 1 } });
    expect(writeIntentHash("create", "app", "sub", "rec", { patch: { quantity: 1 } })).not.toBe(base);
    expect(writeIntentHash("update", "other", "sub", "rec", { patch: { quantity: 1 } })).not.toBe(base);
    expect(writeIntentHash("update", "app", "other", "rec", { patch: { quantity: 1 } })).not.toBe(base);
    expect(writeIntentHash("update", "app", "sub", "other", { patch: { quantity: 1 } })).not.toBe(base);
    expect(writeIntentHash("update", "app", "sub", "rec", { patch: { quantity: 2 } })).not.toBe(base);
  });
});
