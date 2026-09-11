/**
 * SQLite vs Postgres parity for the three whole-database operations that used
 * to be SQLite-only: the integrity probe, the record count and the bulk import.
 *
 * These are what `hosted/health`, `hosted/backup/reopen` and `hosted/export`
 * call, and until `app-ops.ts` existed each of them reached through
 * `OpenAppData.backend` for a `PRAGMA` or a synchronous transaction — which is
 * why postgres mode could only refuse. What is pinned here is that both
 * implementations answer the *same shape* for the same situation, and that
 * where they genuinely differ they say so rather than pretending:
 * `IntegrityVerdict.kind` is `quick_check` on one and `logical` on the other,
 * because SQLite can be asked to walk its own file and Postgres cannot be asked
 * anything of the sort about rows inside a cluster it owns.
 *
 * The SQLite side is real: a real file, real statements, real transaction. The
 * Postgres side is the transport double from `pg-backend.test.ts` — whether
 * Postgres agrees is `pg-contract.live.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HostedError, type EquipmentRequest } from "@/lib/hosted/contracts";
import { IDENTITIES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { input } from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-data-parity-");

const {
  PgDataBackend,
  PgTrackerStore,
  closeAllAppData,
  logicalBytes,
  openAppData,
  postgresOps,
  resetTestDatabase,
} = await import("@/lib/hosted/data");

const SUPABASE_URL = "https://project.supabase.test";
const PG_APP = "parity-pg-app";

/* --------------------------------- harness -------------------------------- */

interface Call {
  method: string;
  url: string;
  key: string;
  body: unknown;
}

/** The same PostgREST double `pg-backend.test.ts` uses: replies are queued per request. */
function pgHarness(appId = PG_APP, storageBytes = 100_000) {
  const calls: Call[] = [];
  const replies = new Map<string, { body: unknown; status?: number; count?: number }[]>();

  const fetchDouble: typeof globalThis.fetch = async (target, init) => {
    const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname.replace(/^\/rest\/v1\//, "");
    const raw = init?.body;
    calls.push({
      method,
      url,
      key: path,
      body: typeof raw === "string" && raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
    });
    const next = replies.get(`${method} ${path}`)?.shift() ?? { body: [] };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (next.count !== undefined) headers["content-range"] = `0-0/${next.count}`;
    return new Response(JSON.stringify(next.body ?? []), { status: next.status ?? 200, headers });
  };

  const backend = new PgDataBackend({ appId, fetch: fetchDouble });
  const store = new PgTrackerStore({ backend, appId, limits: { storageBytes } });
  return {
    backend,
    store,
    ops: postgresOps(backend, store),
    calls,
    queue(key: string, body: unknown, status?: number, count?: number) {
      const list = replies.get(key) ?? [];
      list.push({ body, status, count });
      replies.set(key, list);
    },
    of(key: string): Call[] {
      return calls.filter((call) => call.key === key);
    },
  };
}

/** A stored record with the server-assigned fields an import carries. */
function record(n: number): EquipmentRequest {
  const at = `2026-09-07T10:00:0${n}.000Z`;
  return {
    id: `parity-record-${n}`,
    ...input({ title: `Imported ${n}` }),
    version: 1,
    createdBy: IDENTITIES.editor.subject,
    createdByEmail: IDENTITIES.editor.email,
    createdAt: at,
    updatedBy: IDENTITIES.editor.subject,
    updatedByEmail: IDENTITIES.editor.email,
    updatedAt: at,
  };
}

const quotaRefusal = (imported: number): HostedError =>
  new HostedError("quota_exceeded", `Importing would not fit (${imported} imported).`, {
    fix: "Raise the destination app's storage limit and import again.",
    details: { imported },
  });

let appCounter = 0;
const freshApp = (): string => `parity-app-${(appCounter += 1)}`;

const realEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  store: process.env.ZENITH_HOSTED_STORE,
};

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-not-a-real-one";
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (realEnv.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = realEnv.url;
  if (realEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = realEnv.key;
  if (realEnv.store === undefined) delete process.env.ZENITH_HOSTED_STORE;
  else process.env.ZENITH_HOSTED_STORE = realEnv.store;
  closeAllAppData();
  removeDir(DATA_DIR);
});

/* ------------------------------- integrity -------------------------------- */

describe("the integrity probe health and reopen ask for", () => {
  it("passes on both stores, and each says which question it actually asked", async () => {
    const appId = freshApp();
    const sqlite = openAppData(appId);
    const ctx = {
      appId,
      subject: IDENTITIES.editor.subject,
      email: IDENTITIES.editor.email,
      role: "editor" as const,
      releaseId: "rel-parity",
    };
    const created = await sqlite.store.create(ctx, { writeId: uuid(), record: input() });
    const bytes = logicalBytes(created.record);

    const sqliteVerdict = await sqlite.ops.integrity();
    expect(sqliteVerdict.ok).toBe(true);
    expect(sqliteVerdict.kind).toBe("quick_check");
    expect(sqliteVerdict.detail).toMatch(/quick_check/);

    // The Postgres check is the logical one: the rows read back and the counter
    // agrees with them.
    const pg = pgHarness();
    pg.queue("GET app_records", [{ record_id: created.record.id, logical_bytes: bytes }]);
    pg.queue("GET app_storage", [{ logical_bytes: bytes }]);

    const pgVerdict = await pg.ops.integrity();
    expect(pgVerdict.ok).toBe(true);
    expect(pgVerdict.kind).toBe("logical");
    expect(pgVerdict.detail).toMatch(/Logical check/);

    // Same shape, so one caller can report either without branching.
    expect(Object.keys(pgVerdict).sort()).toEqual(Object.keys(sqliteVerdict).sort());
  });

  it("fails on Postgres when the counter every quota decision is made against has drifted", async () => {
    const pg = pgHarness();
    pg.queue("GET app_records", [
      { record_id: "a", logical_bytes: 120 },
      { record_id: "b", logical_bytes: 80 },
    ]);
    pg.queue("GET app_storage", [{ logical_bytes: 150 }]);

    const verdict = await pg.ops.integrity();
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("200 logical bytes");
    expect(verdict.detail).toContain("150");
  });

  it("counts this app's records the same way on both stores", async () => {
    const appId = freshApp();
    const sqlite = openAppData(appId);
    const ctx = {
      appId,
      subject: IDENTITIES.editor.subject,
      email: IDENTITIES.editor.email,
      role: "editor" as const,
      releaseId: "rel-parity",
    };
    await sqlite.store.create(ctx, { writeId: uuid(), record: input() });
    await sqlite.store.create(ctx, { writeId: uuid(), record: input({ title: "Second" }) });
    await expect(sqlite.ops.countRecords()).resolves.toBe(2);

    const pg = pgHarness();
    pg.queue("HEAD app_records", [], 200, 2);
    await expect(pg.ops.countRecords()).resolves.toBe(2);
  });
});

/* -------------------------------- importing ------------------------------- */

describe("the bulk import an export bundle is read back through", () => {
  it("imports the same records and skips the same ids on both stores", async () => {
    const records = [record(1), record(2)];

    const sqlite = openAppData(freshApp());
    await expect(sqlite.ops.importRecords(records, { quotaRefusal })).resolves.toEqual({
      imported: 2,
      skipped: [],
    });
    // Re-importing the same bundle skips rather than merging or duplicating.
    const again = await sqlite.ops.importRecords(records, { quotaRefusal });
    expect(again.imported).toBe(0);
    expect(again.skipped.map((skip) => skip.id)).toEqual(["parity-record-1", "parity-record-2"]);
    await expect(sqlite.ops.countRecords()).resolves.toBe(2);

    const pg = pgHarness();
    pg.queue("GET app_storage", [{ logical_bytes: 0 }]); // the headroom check
    for (const _ of records) {
      pg.queue("GET app_records", []); // not already stored
      pg.queue("POST rpc/app_record_insert_within_quota", 1); // admitted
    }
    await expect(pg.ops.importRecords(records, { quotaRefusal })).resolves.toEqual({
      imported: 2,
      skipped: [],
    });
    // The counter moved inside the admission function, not after it.
    expect(pg.of("rpc/app_storage_add")).toHaveLength(0);

    const second = pgHarness();
    second.queue("GET app_storage", [{ logical_bytes: 0 }]);
    for (const one of records) {
      second.queue("GET app_records", [
        {
          record_id: one.id,
          subject: one.createdBy,
          version: 1,
          logical_bytes: logicalBytes(one),
          body: one,
          created_at: one.createdAt,
          updated_at: one.updatedAt,
        },
      ]);
    }
    const pgAgain = await second.ops.importRecords(records, { quotaRefusal });
    expect(pgAgain.imported).toBe(0);
    expect(pgAgain.skipped.map((skip) => skip.id)).toEqual(["parity-record-1", "parity-record-2"]);
    expect(second.of("rpc/app_record_insert_within_quota")).toHaveLength(0);
  });

  it("refuses past the storage ceiling with the caller's own error, and writes nothing", async () => {
    const records = [record(1), record(2)];

    const sqlite = openAppData(freshApp(), { storageBytes: 1 });
    await expect(sqlite.ops.importRecords(records, { quotaRefusal })).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    // The whole import was one transaction, so the refusal rolled it back.
    await expect(sqlite.ops.countRecords()).resolves.toBe(0);

    const pg = pgHarness(PG_APP, 1);
    pg.queue("GET app_storage", [{ logical_bytes: 0 }]);
    await expect(pg.ops.importRecords(records, { quotaRefusal })).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    // Checked before anything was written: there is no transaction to roll back
    // on PostgREST, so the bundle's total is compared against the headroom up
    // front and no insert is ever attempted.
    expect(pg.of("rpc/app_record_insert_within_quota")).toHaveLength(0);
    expect(pg.calls.filter((call) => call.method !== "GET" && call.method !== "HEAD")).toHaveLength(0);
  });
});

/* ------------------------------ the probe reset --------------------------- */

describe("throwing away the disposable probe database", () => {
  it("hands back an empty one on SQLite, without touching production", async () => {
    const appId = freshApp();
    const production = openAppData(appId);
    const ctx = {
      appId,
      subject: IDENTITIES.editor.subject,
      email: IDENTITIES.editor.email,
      role: "editor" as const,
      releaseId: "rel-parity",
    };
    const kept = await production.store.create(ctx, { writeId: uuid(), record: input() });

    const probe = openAppData(appId, { file: "test" });
    await probe.store.create(ctx, { writeId: uuid(), record: input({ title: "Throwaway" }) });

    const reset = await resetTestDatabase(appId);
    expect((await reset.store.list(ctx, { limit: 25 })).items).toEqual([]);
    await expect(production.store.get(ctx, kept.record.id)).resolves.toMatchObject({ id: kept.record.id });
  });

  it("empties the `<appId>::test` namespace on Postgres, and nothing outside it", async () => {
    const deletes: string[] = [];
    vi.stubGlobal("fetch", (async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
      deletes.push(`${(init?.method ?? "GET").toUpperCase()} ${decodeURIComponent(url)}`);
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch);
    process.env.ZENITH_HOSTED_STORE = "postgres";

    try {
      const reset = await resetTestDatabase("parity-probe-app");
      expect(reset.store.appId).toBe("parity-probe-app");
    } finally {
      process.env.ZENITH_HOSTED_STORE = realEnv.store ?? "sqlite";
      vi.unstubAllGlobals();
      closeAllAppData();
    }

    expect(deletes).toHaveLength(3);
    for (const call of deletes) {
      expect(call.startsWith("DELETE ")).toBe(true);
      expect(call).toContain("app_id=eq.parity-probe-app::test");
    }
    expect(deletes.some((call) => call.includes("app_records"))).toBe(true);
    expect(deletes.some((call) => call.includes("app_writes"))).toBe(true);
    expect(deletes.some((call) => call.includes("app_storage"))).toBe(true);
  });
});
