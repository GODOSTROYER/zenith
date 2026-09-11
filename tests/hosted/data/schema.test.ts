/**
 * Migrations, durability pragmas and the database's own CHECK constraints —
 * the second line of defence behind the zod contract.
 */
import { afterAll, describe, expect, it } from "vitest";
import { TRACKER_SCHEMA_VERSION } from "@/lib/hosted/contracts";
import { isolatedDataDir, removeDir } from "../_fixtures";
import { APP_A } from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-data-schema-");

const {
  LATEST_TRACKER_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  TRACKER_MIGRATIONS,
  applyTrackerMigrations,
  closeAllAppData,
  openAppData,
  readSchemaVersion,
  sqliteBackendOf,
  trackerSql,
} = await import("@/lib/hosted/data");

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

/** The 19 bound values `INSERT_REQUEST_WITHIN_QUOTA` takes, with a huge quota headroom. */
function insertParams(overrides: Partial<Record<string, string | number | null>> = {}) {
  const row: Record<string, string | number | null> = {
    id: `row-${Math.random().toString(36).slice(2)}`,
    title: "Laptop",
    details: "",
    category: "laptop",
    quantity: 1,
    priority: "normal",
    status: "requested",
    requested_for: "",
    needed_by: null,
    version: 1,
    created_by: "sub-1",
    created_by_email: "a@example.test",
    created_at: "2026-09-07T00:00:00.000Z",
    updated_by: "sub-1",
    updated_by_email: "a@example.test",
    updated_at: "2026-09-07T00:00:00.000Z",
    logical_bytes: 100,
    ...overrides,
  };
  return [
    row.id,
    row.title,
    row.details,
    row.category,
    row.quantity,
    row.priority,
    row.status,
    row.requested_for,
    row.needed_by,
    row.version,
    row.created_by,
    row.created_by_email,
    row.created_at,
    row.updated_by,
    row.updated_by_email,
    row.updated_at,
    row.logical_bytes,
    0,
    Number.MAX_SAFE_INTEGER,
  ] as (string | number | null)[];
}

describe("tracker migrations", () => {
  it("reports schema version 1 and matches the frozen contract version", async () => {
    const { backend, store } = openSqlite(APP_A);
    expect(readSchemaVersion(backend)).toBe(1);
    expect(LATEST_TRACKER_SCHEMA_VERSION).toBe(TRACKER_SCHEMA_VERSION);
    expect(Math.max(...TRACKER_MIGRATIONS.map((m) => m.version))).toBe(LATEST_TRACKER_SCHEMA_VERSION);
    await expect(store.schemaVersion(APP_A)).resolves.toBe(1);
  });

  it("is idempotent: re-applying changes neither the version nor the data", async () => {
    const { backend } = openSqlite(APP_A);
    backend.run(trackerSql.INSERT_REQUEST_WITHIN_QUOTA, insertParams({ id: "keep-me" }));
    const before = backend.get<{ total: number }>(trackerSql.COUNT_REQUESTS)?.total;

    expect(applyTrackerMigrations(backend)).toBe(1);
    expect(applyTrackerMigrations(backend)).toBe(1);

    expect(backend.get<{ total: number }>(trackerSql.COUNT_REQUESTS)?.total).toBe(before);
    expect(backend.get<{ logical_bytes: number }>(trackerSql.SELECT_STORAGE_BYTES)?.logical_bytes).toBe(0);
    expect(backend.get<{ value: string }>(trackerSql.SELECT_META, [SCHEMA_VERSION_KEY])?.value).toBe("1");
  });

  it("opens with the hosted durability pragmas", async () => {
    const { backend } = openSqlite(APP_A);
    const pragmas = backend.pragmas();
    expect(pragmas.journalMode).toBe("wal");
    expect(pragmas.synchronous).toBe(2); // FULL
    expect(pragmas.foreignKeys).toBe(1);
    expect(pragmas.busyTimeoutMs).toBe(5000);
  });
});

describe("CHECK constraints (second line of defence behind zod)", () => {
  const cases: { name: string; overrides: Partial<Record<string, string | number | null>> }[] = [
    { name: "an unknown category", overrides: { category: "spaceship" } },
    { name: "an unknown priority", overrides: { priority: "urgent" } },
    { name: "an unknown status", overrides: { status: "pending" } },
    { name: "a title over 120 characters", overrides: { title: "x".repeat(121) } },
    { name: "an empty title", overrides: { title: "" } },
    { name: "details over 2000 characters", overrides: { details: "y".repeat(2001) } },
    { name: "requestedFor over 120 characters", overrides: { requested_for: "z".repeat(121) } },
    { name: "quantity below 1", overrides: { quantity: 0 } },
    { name: "quantity above 99", overrides: { quantity: 100 } },
    { name: "version below 1", overrides: { version: 0 } },
    { name: "a needed_by that is not a calendar date", overrides: { needed_by: "next tuesday" } },
    { name: "negative logical bytes", overrides: { logical_bytes: -1 } },
  ];

  for (const { name, overrides } of cases) {
    it(`rejects ${name} at the database, even when validation is bypassed`, async () => {
      const { backend } = openSqlite(APP_A);
      expect(() => backend.run(trackerSql.INSERT_REQUEST_WITHIN_QUOTA, insertParams(overrides))).toThrow(
        /CHECK constraint failed/i
      );
    });
  }

  it("accepts a null needed_by and every valid enum value", async () => {
    const { backend } = openSqlite(APP_A);
    for (const category of ["laptop", "monitor", "peripheral", "software", "furniture", "other"]) {
      const result = backend.run(
        trackerSql.INSERT_REQUEST_WITHIN_QUOTA,
        insertParams({ id: `cat-${category}`, category, needed_by: null })
      );
      expect(result.changes).toBe(1);
    }
    for (const status of ["requested", "approved", "ordered", "delivered", "declined"]) {
      expect(
        backend.run(trackerSql.INSERT_REQUEST_WITHIN_QUOTA, insertParams({ id: `st-${status}`, status })).changes
      ).toBe(1);
    }
    for (const priority of ["low", "normal", "high"]) {
      expect(
        backend.run(trackerSql.INSERT_REQUEST_WITHIN_QUOTA, insertParams({ id: `pr-${priority}`, priority })).changes
      ).toBe(1);
    }
  });

  it("refuses a second storage row, so the counter cannot fork", async () => {
    const { backend } = openSqlite(APP_A);
    expect(() => backend.run("INSERT INTO storage (id, logical_bytes) VALUES (2, 0)")).toThrow(
      /CHECK constraint failed/i
    );
  });
});
