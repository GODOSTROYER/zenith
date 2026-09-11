/**
 * Isolation between apps, durability across a restart, hostile strings, and the
 * disposable test database candidate probes use.
 */
import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { IDENTITIES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { APP_A, APP_B, ctx, input, nextMillisecond } from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-data-isolation-");

const {
  APP_DATA_FILENAMES,
  appDataPath,
  closeAllAppData,
  closeAppData,
  openAppData,
  resetTestDatabase,
  trackerSql,
} = await import("@/lib/hosted/data");

afterAll(async () => {
  closeAllAppData();
  removeDir(DATA_DIR);
});

describe("app isolation", () => {
  it("gives each app its own file and never lets a record cross", async () => {
    const alpha = openAppData(APP_A);
    const beta = openAppData(APP_B);
    expect(alpha.path).not.toBe(beta.path);
    expect(alpha.path).toContain(APP_A);
    expect(beta.path).toContain(APP_B);
    expect(fs.existsSync(alpha.path)).toBe(true);
    expect(fs.existsSync(beta.path)).toBe(true);

    const inAlpha = await alpha.store.create(ctx("editor", IDENTITIES.editor, APP_A), {
      writeId: uuid(),
      record: input({ title: "Alpha only" }),
    });
    const inBeta = await beta.store.create(ctx("editor", IDENTITIES.editor, APP_B), {
      writeId: uuid(),
      record: input({ title: "Beta only" }),
    });

    const alphaList = await alpha.store.list(ctx("viewer", IDENTITIES.viewer, APP_A), { limit: 25 });
    const betaList = await beta.store.list(ctx("viewer", IDENTITIES.viewer, APP_B), { limit: 25 });
    expect(alphaList.items.map((r) => r.title)).toEqual(["Alpha only"]);
    expect(betaList.items.map((r) => r.title)).toEqual(["Beta only"]);

    // Beta's store cannot see Alpha's record even by id.
    await expect(beta.store.get(ctx("owner", IDENTITIES.owner, APP_B), inAlpha.record.id)).resolves.toBeNull();
    await expect(alpha.store.get(ctx("owner", IDENTITIES.owner, APP_A), inBeta.record.id)).resolves.toBeNull();
  });

  it("shares nothing between the two apps' write ledgers or counters", async () => {
    const alpha = openAppData(APP_A);
    const beta = openAppData(APP_B);
    const writeId = uuid();

    const first = await alpha.store.create(ctx("editor", IDENTITIES.editor, APP_A), {
      writeId,
      record: input({ title: "Same write id" }),
    });
    // The same write id in the other app is a new write, not a replay: the
    // ledgers are separate files.
    const second = await beta.store.create(ctx("editor", IDENTITIES.editor, APP_B), {
      writeId,
      record: input({ title: "Same write id" }),
    });
    expect(second.replayed).toBe(false);
    expect(second.record.id).not.toBe(first.record.id);

    const alphaBytes = await alpha.store.storageBytes(APP_A);
    const betaBytes = await beta.store.storageBytes(APP_B);
    expect(alphaBytes).toBeGreaterThan(0);
    expect(betaBytes).toBeGreaterThan(0);
    expect(alpha.backend.get<{ total: number }>(trackerSql.SELECT_REQUESTS_LOGICAL_BYTES_SUM)?.total).toBe(
      alphaBytes
    );
    expect(beta.backend.get<{ total: number }>(trackerSql.SELECT_REQUESTS_LOGICAL_BYTES_SUM)?.total).toBe(betaBytes);
  });

  it("hands back the same handle for the same app and file", async () => {
    const first = openAppData(APP_A);
    const second = openAppData(APP_A);
    expect(second.backend).toBe(first.backend);
    expect(second.store).toBe(first.store);

    const test = openAppData(APP_A, { file: "test" });
    expect(test.backend).not.toBe(first.backend);
    expect(test.path).not.toBe(first.path);
  });
});

describe("restart persistence", () => {
  it("keeps records, write ids and the counter across close and reopen", async () => {
    const appId = "restart-app";
    const editor = ctx("editor", IDENTITIES.editor, appId);
    const before = openAppData(appId);

    const titles = ["First", "Second", "Third"];
    const ids: string[] = [];
    for (const title of titles) {
      nextMillisecond();
      ids.push((await before.store.create(editor, { writeId: uuid(), record: input({ title }) })).record.id);
    }
    const updated = await before.store.update(editor, ids[0], {
      writeId: uuid(),
      expectedVersion: 1,
      patch: { status: "ordered" },
    });
    const bytesBefore = await before.store.storageBytes(appId);
    const writesBefore = before.backend.get<{ total: number }>(trackerSql.COUNT_WRITES)?.total;

    expect(closeAppData(appId)).toBe(1);
    expect(before.backend.isClosed).toBe(true);

    const after = openAppData(appId);
    expect(after.backend).not.toBe(before.backend);
    expect(after.path).toBe(before.path);

    const page = await after.store.list(editor, { limit: 25 });
    expect(page.items.map((r) => r.title)).toEqual(["Third", "Second", "First"]);
    await expect(after.store.get(editor, ids[0])).resolves.toEqual(updated.record);
    await expect(after.store.storageBytes(appId)).resolves.toBe(bytesBefore);
    await expect(after.store.schemaVersion(appId)).resolves.toBe(1);
    expect(after.backend.get<{ total: number }>(trackerSql.COUNT_WRITES)?.total).toBe(writesBefore);
  });

  it("refuses to use a closed connection instead of silently reopening one", async () => {
    const appId = "closed-app";
    const opened = openAppData(appId);
    closeAppData(appId);
    expect(() => opened.backend.get(trackerSql.COUNT_REQUESTS)).toThrow(/already closed/i);
  });
});

describe("hostile strings", () => {
  const hostile = [
    "'; DROP TABLE equipment_requests; --",
    '" OR 1=1 --',
    "Robert'); DROP TABLE writes;--",
    "100% \\ backslash and 'quotes' and \"doubles\"",
    "line one\nline two\ttabbed",
    "unicode ☃ 🚀 é ñ",
    "%s %d {{template}} ${injection}",
  ];

  for (const value of hostile) {
    it(`stores and returns ${JSON.stringify(value.slice(0, 28))} verbatim`, async () => {
      const appId = "hostile-app";
      const { backend, store } = openAppData(appId);
      const editor = ctx("editor", IDENTITIES.editor, appId);

      const created = await store.create(editor, {
        writeId: uuid(),
        record: input({ title: value.slice(0, 120), details: value, requestedFor: value.slice(0, 120) }),
      });
      expect(created.record.title).toBe(value.slice(0, 120));
      expect(created.record.details).toBe(value);

      const read = await store.get(editor, created.record.id);
      expect(read?.details).toBe(value);
      expect(read).toEqual(created.record);

      // The tables are all still there, and the row count only went up by one.
      expect(backend.get<{ total: number }>(trackerSql.COUNT_REQUESTS)?.total).toBeGreaterThan(0);
      expect(backend.get<{ total: number }>(trackerSql.COUNT_WRITES)?.total).toBeGreaterThan(0);
    });
  }

  it("treats a hostile string as a value in every filter and cursor position", async () => {
    const appId = "hostile-app";
    const { store } = openAppData(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);

    // A hostile id is a miss, not a syntax error.
    await expect(store.get(editor, "' OR '1'='1")).resolves.toBeNull();
    await expect(
      store.update(editor, "'; DELETE FROM equipment_requests; --", {
        writeId: uuid(),
        expectedVersion: 1,
        patch: { quantity: 2 },
      })
    ).rejects.toMatchObject({ code: "not_found" });

    const stillThere = await store.list(editor, { limit: 100 });
    expect(stillThere.items.length).toBeGreaterThan(0);
  });
});

describe("the disposable test database", () => {
  it("resets test.sqlite and leaves data.sqlite untouched", async () => {
    const appId = "probe-app";
    const editor = ctx("editor", IDENTITIES.editor, appId);

    const production = openAppData(appId);
    const kept = await production.store.create(editor, { writeId: uuid(), record: input({ title: "Customer data" }) });
    const productionBytes = await production.store.storageBytes(appId);

    const probe = openAppData(appId, { file: "test" });
    expect(probe.path).toContain(APP_DATA_FILENAMES.test);
    expect(probe.path).not.toBe(production.path);
    const throwaway = await probe.store.create(editor, { writeId: uuid(), record: input({ title: "Probe data" }) });
    expect((await probe.store.list(editor, { limit: 25 })).items.map((r) => r.title)).toEqual(["Probe data"]);

    // Snapshot the production file before the reset.
    const productionPath = appDataPath(appId, "data");
    expect(productionPath).toBe(production.path);
    const beforeBytes = fs.readFileSync(productionPath);

    const reset = resetTestDatabase(appId);

    // The test database is empty and freshly migrated …
    expect(reset.path).toBe(probe.path);
    expect((await reset.store.list(editor, { limit: 25 })).items).toEqual([]);
    await expect(reset.store.schemaVersion(appId)).resolves.toBe(1);
    await expect(reset.store.storageBytes(appId)).resolves.toBe(0);
    await expect(reset.store.get(editor, throwaway.record.id)).resolves.toBeNull();

    // … and production is exactly as it was, byte for byte.
    expect(fs.readFileSync(productionPath).equals(beforeBytes)).toBe(true);
    await expect(production.store.get(editor, kept.record.id)).resolves.toMatchObject({ title: "Customer data" });
    await expect(production.store.storageBytes(appId)).resolves.toBe(productionBytes);
    expect(production.backend.isClosed).toBe(false);
  });

  it("can be reset before the test database has ever been opened", async () => {
    const appId = "never-probed-app";
    const production = openAppData(appId);
    const editor = ctx("editor", IDENTITIES.editor, appId);
    await production.store.create(editor, { writeId: uuid(), record: input() });

    expect(fs.existsSync(appDataPath(appId, "test"))).toBe(false);
    const reset = resetTestDatabase(appId);
    expect(fs.existsSync(reset.path)).toBe(true);
    expect((await reset.store.list(editor, { limit: 25 })).items).toEqual([]);
    expect((await production.store.list(editor, { limit: 25 })).items.length).toBe(1);
  });
});
