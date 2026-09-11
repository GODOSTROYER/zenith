/**
 * The storage quota: the logical-byte measure itself, the counter that tracks
 * it, and what a refusal at the ceiling says and leaves behind.
 */
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, HostedError, type EquipmentRequest } from "@/lib/hosted/contracts";
import { IDENTITIES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { ctx, input } from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-data-quota-");

const { ROW_OVERHEAD_BYTES, closeAllAppData, logicalBytes, openAppData, trackerSql } = await import(
  "@/lib/hosted/data"
);

afterAll(() => {
  closeAllAppData();
  removeDir(DATA_DIR);
});

let appCounter = 0;
function freshApp(): string {
  appCounter += 1;
  return `quota-app-${appCounter}`;
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

const sample: EquipmentRequest = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Laptop",
  details: "",
  category: "laptop",
  quantity: 1,
  priority: "normal",
  status: "requested",
  requestedFor: "",
  neededBy: null,
  version: 1,
  createdBy: "sub",
  createdByEmail: "a@example.test",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedBy: "sub",
  updatedByEmail: "a@example.test",
  updatedAt: "2026-09-07T00:00:00.000Z",
};

describe("the logical-byte measure", () => {
  it("is the UTF-8 JSON size of the stored fields plus the fixed row allowance", () => {
    const expected =
      Buffer.byteLength(
        JSON.stringify({
          id: sample.id,
          title: sample.title,
          details: sample.details,
          category: sample.category,
          quantity: sample.quantity,
          priority: sample.priority,
          status: sample.status,
          requestedFor: sample.requestedFor,
          neededBy: sample.neededBy,
          version: sample.version,
          createdBy: sample.createdBy,
          createdByEmail: sample.createdByEmail,
          createdAt: sample.createdAt,
          updatedBy: sample.updatedBy,
          updatedByEmail: sample.updatedByEmail,
          updatedAt: sample.updatedAt,
        }),
        "utf8"
      ) + ROW_OVERHEAD_BYTES;
    expect(logicalBytes(sample)).toBe(expected);
  });

  it("counts bytes, not characters", () => {
    const ascii = logicalBytes({ ...sample, details: "aaaa" });
    const emoji = logicalBytes({ ...sample, details: "🚀🚀" });
    expect(ascii).toBeLessThan(emoji);
    // Two astral characters are four UTF-16 units but eight UTF-8 bytes.
    expect(emoji - logicalBytes({ ...sample, details: "" })).toBe(8);
  });

  it("does not depend on the order of the caller's object keys", () => {
    const reordered = { ...sample } as Record<string, unknown>;
    const rebuilt = Object.fromEntries(
      Object.keys(reordered).reverse().map((key) => [key, reordered[key]])
    ) as unknown as EquipmentRequest;
    expect(logicalBytes(rebuilt)).toBe(logicalBytes(sample));
  });
});

describe("the counter", () => {
  it("equals the sum of the stored rows and defaults to the pilot limit", async () => {
    const appId = freshApp();
    const { backend, store } = openAppData(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    expect(store.storageLimitBytes).toBe(DEFAULT_LIMITS.storageBytes);

    let expectedTotal = 0;
    for (const title of ["One", "Two", "Three", "Four"]) {
      const created = await store.create(editor, { writeId: uuid(), record: input({ title }) });
      expectedTotal += logicalBytes(created.record);
      await expect(store.storageBytes(appId)).resolves.toBe(expectedTotal);
    }
    expect(backend.get<{ total: number }>(trackerSql.SELECT_REQUESTS_LOGICAL_BYTES_SUM)?.total).toBe(expectedTotal);
  });

  it("follows an update up and back down", async () => {
    const appId = freshApp();
    const { backend, store } = openAppData(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);

    const created = await store.create(editor, { writeId: uuid(), record: input({ details: "short" }) });
    const grown = await store.update(editor, created.record.id, {
      writeId: uuid(),
      expectedVersion: 1,
      patch: { details: "x".repeat(500) },
    });
    expect(await store.storageBytes(appId)).toBe(logicalBytes(grown.record));
    expect(await store.storageBytes(appId)).toBeGreaterThan(logicalBytes(created.record));

    const shrunk = await store.update(editor, created.record.id, {
      writeId: uuid(),
      expectedVersion: 2,
      patch: { details: "" },
    });
    expect(await store.storageBytes(appId)).toBe(logicalBytes(shrunk.record));
    expect(backend.get<{ total: number }>(trackerSql.SELECT_REQUESTS_LOGICAL_BYTES_SUM)?.total).toBe(
      await store.storageBytes(appId)
    );
  });
});

describe("at the ceiling", () => {
  it("creates until the quota refuses, and the refusal discloses the measure", async () => {
    const measureApp = freshApp();
    const measure = openAppData(measureApp).store;
    const probe = await measure.create(ctx("editor", IDENTITIES.editor, measureApp), {
      writeId: uuid(),
      record: input(),
    });
    const perRecord = logicalBytes(probe.record);

    // Room for three records of that size and not a byte more.
    const appId = freshApp();
    const { backend, store } = openAppData(appId, { storageBytes: perRecord * 3 });
    const editor = ctx("editor", IDENTITIES.editor, appId);

    for (let i = 0; i < 3; i += 1) {
      const created = await store.create(editor, { writeId: uuid(), record: input() });
      expect(logicalBytes(created.record)).toBe(perRecord);
    }
    expect(await store.storageBytes(appId)).toBe(perRecord * 3);

    const denied = await refusal(() => store.create(editor, { writeId: uuid(), record: input() }));
    expect(denied.code).toBe("quota_exceeded");
    expect(denied.status).toBe(429);
    expect(denied.message).toContain("logical bytes");
    expect(denied.message).toContain(String(perRecord * 3));
    expect(denied.message).toContain("retained");
    expect(denied.details).toMatchObject({
      usedLogicalBytes: perRecord * 3,
      limitLogicalBytes: perRecord * 3,
      requiredLogicalBytes: perRecord,
    });
    expect(denied.fix).toBeTruthy();

    // The refusal left nothing behind: no row, no counter movement, no write id.
    expect(backend.get<{ total: number }>(trackerSql.COUNT_REQUESTS)?.total).toBe(3);
    expect(backend.get<{ total: number }>(trackerSql.COUNT_WRITES)?.total).toBe(3);
    expect(await store.storageBytes(appId)).toBe(perRecord * 3);
  });

  it("allows an update that shrinks a record even when the app is full", async () => {
    const appId = freshApp();
    const { store } = openAppData(appId, { storageBytes: 1_400 });
    const editor = ctx("editor", IDENTITIES.editor, appId);

    const created = await store.create(editor, { writeId: uuid(), record: input({ details: "d".repeat(600) }) });
    const used = await store.storageBytes(appId);
    expect(used).toBeLessThanOrEqual(1_400);
    expect(used).toBeGreaterThan(600);

    // Growing past the ceiling is refused …
    const denied = await refusal(() =>
      store.update(editor, created.record.id, {
        writeId: uuid(),
        expectedVersion: 1,
        patch: { details: "d".repeat(1_500) },
      })
    );
    expect(denied.code).toBe("quota_exceeded");
    expect(await store.storageBytes(appId)).toBe(used);
    expect((await store.get(editor, created.record.id))?.version).toBe(1);

    // … while shrinking is what lets a full app recover.
    const shrunk = await store.update(editor, created.record.id, {
      writeId: uuid(),
      expectedVersion: 1,
      patch: { details: "" },
    });
    expect(shrunk.record.version).toBe(2);
    const freed = await store.storageBytes(appId);
    expect(freed).toBeLessThan(used);

    // And the freed space is usable again.
    const after = await store.create(editor, { writeId: uuid(), record: input({ details: "" }) });
    expect(after.replayed).toBe(false);
  });

  it("accepts a record that lands exactly on the limit and refuses one byte more", async () => {
    const measureApp = freshApp();
    const measure = openAppData(measureApp).store;
    const probe = await measure.create(ctx("editor", IDENTITIES.editor, measureApp), {
      writeId: uuid(),
      record: input({ details: "boundary" }),
    });
    const exact = logicalBytes(probe.record);

    const appId = freshApp();
    const { store } = openAppData(appId, { storageBytes: exact });
    const editor = ctx("editor", IDENTITIES.editor, appId);

    const fits = await store.create(editor, { writeId: uuid(), record: input({ details: "boundary" }) });
    expect(logicalBytes(fits.record)).toBe(exact);
    expect(await store.storageBytes(appId)).toBe(exact);

    const overflows = await refusal(() =>
      store.create(editor, { writeId: uuid(), record: input({ details: "boundary" }) })
    );
    expect(overflows.code).toBe("quota_exceeded");
  });

  it("refuses a single record larger than the whole allowance", async () => {
    const appId = freshApp();
    const { store } = openAppData(appId, { storageBytes: 100 });
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const denied = await refusal(() => store.create(editor, { writeId: uuid(), record: input() }));
    expect(denied.code).toBe("quota_exceeded");
    expect(denied.details).toMatchObject({ usedLogicalBytes: 0, limitLogicalBytes: 100 });
    expect(await store.storageBytes(appId)).toBe(0);
  });
});
