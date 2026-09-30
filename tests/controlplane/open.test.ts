/**
 * Opening the store: environment resolution (one function), the process-wide
 * handle, persistent PGlite, and fail-closed behaviour against an un-migrated
 * Postgres.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlStoreError, PlatformDbError, openPlatformDb, platformDb, platformDbConfigFromEnv, resetPlatformDbForTests } from "@/lib/controlplane/db";
import { PG_URL, uid, withScratchDatabase } from "./_support/harness";

const ENV_KEYS = ["ZENITH_PLATFORM_DB", "ZENITH_PLATFORM_DB_URL", "ZENITH_PLATFORM_DB_MAX", "SUPABASE_DB_URL", "ZENITH_DATA"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(async () => {
  await resetPlatformDbForTests();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zenith-platform-db-"));
}

function removeQuietly(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 100;
      while (Date.now() < until) {
        /* Windows holds file handles briefly after a close */
      }
    }
  }
}

describe("platformDbConfigFromEnv (the one place the environment is read)", () => {
  it("defaults to PGlite under <ZENITH_DATA>/platform-pg when no URL is configured", () => {
    expect(platformDbConfigFromEnv({ ZENITH_DATA: "/srv/zenith" })).toEqual({ kind: "pglite", dataDir: path.join("/srv/zenith", "platform-pg"), source: "default" });
    expect(platformDbConfigFromEnv({}).dataDir).toBe(path.join(process.cwd(), ".data", "platform-pg"));
  });

  it("defaults to Postgres when ZENITH_PLATFORM_DB_URL or SUPABASE_DB_URL is set, preferring the platform variable", () => {
    expect(platformDbConfigFromEnv({ SUPABASE_DB_URL: "postgres://a/b" })).toMatchObject({ kind: "postgres", url: "postgres://a/b", source: "url" });
    expect(platformDbConfigFromEnv({ SUPABASE_DB_URL: "postgres://a/b", ZENITH_PLATFORM_DB_URL: "postgres://c/d" }).url).toBe("postgres://c/d");
    expect(platformDbConfigFromEnv({ ZENITH_PLATFORM_DB_URL: "  " })).toMatchObject({ kind: "pglite" });
  });

  it("an explicit ZENITH_PLATFORM_DB wins over the URL default", () => {
    expect(platformDbConfigFromEnv({ ZENITH_PLATFORM_DB: "pglite", ZENITH_PLATFORM_DB_URL: "postgres://a/b", ZENITH_DATA: "/d" })).toMatchObject({ kind: "pglite", source: "explicit" });
    expect(platformDbConfigFromEnv({ ZENITH_PLATFORM_DB: "POSTGRES", ZENITH_PLATFORM_DB_URL: "postgres://a/b" })).toMatchObject({ kind: "postgres", source: "explicit" });
  });

  it("refuses Postgres without a URL, an unknown kind, and a bad pool size — each with an actionable message", () => {
    expect(() => platformDbConfigFromEnv({ ZENITH_PLATFORM_DB: "postgres" })).toThrowError(/ZENITH_PLATFORM_DB_URL/);
    expect(() => platformDbConfigFromEnv({ ZENITH_PLATFORM_DB: "sqlite" })).toThrowError(/"pglite" or "postgres"/);
    expect(() => platformDbConfigFromEnv({ ZENITH_PLATFORM_DB_URL: "postgres://a/b", ZENITH_PLATFORM_DB_MAX: "0" })).toThrowError(/1 to 100/);
    expect(() => platformDbConfigFromEnv({ ZENITH_PLATFORM_DB_URL: "postgres://a/b", ZENITH_PLATFORM_DB_MAX: "many" })).toThrowError(ControlStoreError);
    expect(platformDbConfigFromEnv({ ZENITH_PLATFORM_DB_URL: "postgres://a/b", ZENITH_PLATFORM_DB_MAX: "7" }).max).toBe(7);
  });

  it("refuses a URL that is not a postgres connection string, without echoing it", () => {
    for (const bad of ["not a url at all hunter2", "mysql://u:hunter2@h/db", "http://u:hunter2@h/", "hunter2"]) {
      const err = (() => {
        try {
          platformDbConfigFromEnv({ ZENITH_PLATFORM_DB_URL: bad });
        } catch (e) {
          return e as Error;
        }
        return undefined;
      })();
      expect(err, bad).toBeInstanceOf(ControlStoreError);
      expect(err?.message).toMatch(/not a valid postgres/);
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("hunter2");
    }
  });

  it("never echoes the connection string in an error", () => {
    const url = "postgres://user:hunter2@host/db";
    try {
      platformDbConfigFromEnv({ ZENITH_PLATFORM_DB_URL: url, ZENITH_PLATFORM_DB_MAX: "nope" });
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("hunter2");
    }
  });
});

describe("platformDb()", () => {
  it("opens PGlite from the environment, migrates it, caches the handle, and reset closes it", async () => {
    const data = tempDir();
    try {
      clearEnv();
      process.env.ZENITH_DATA = data;
      const a = await platformDb();
      const b = await platformDb();
      expect(b).toBe(a);
      expect(a.kind).toBe("pglite");
      expect(a.identity).toBe(`pglite://${path.join(data, "platform-pg")}`);
      expect((await a.query<{ n: number }>("select count(*)::int as n from platform.schema_migrations"))[0].n).toBe(1);
      await resetPlatformDbForTests();
      const c = await platformDb();
      expect(c).not.toBe(a);
      await resetPlatformDbForTests();
    } finally {
      await resetPlatformDbForTests();
      removeQuietly(data);
    }
  }, 60_000);

  it("a persistent PGlite directory keeps its data (and its ledger) across close and reopen", async () => {
    const data = tempDir();
    try {
      clearEnv();
      process.env.ZENITH_DATA = data;
      const id = uid("persist");
      const first = await platformDb();
      await first.query("insert into platform.workspace_policy (workspace_id, params, updated_by) values ($1, '{}'::jsonb, 'test')", [id]);
      await resetPlatformDbForTests();
      const second = await platformDb();
      const rows = await second.query<{ workspace_id: string }>("select workspace_id from platform.workspace_policy where workspace_id = $1", [id]);
      expect(rows).toHaveLength(1);
      expect((await second.query<{ n: number }>("select count(*)::int as n from platform.schema_migrations"))[0].n).toBe(1); // not re-applied
    } finally {
      await resetPlatformDbForTests();
      removeQuietly(data);
    }
  }, 90_000);

  it("concurrent first calls share one opening", async () => {
    const data = tempDir();
    try {
      clearEnv();
      process.env.ZENITH_DATA = data;
      const [a, b, c] = await Promise.all([platformDb(), platformDb(), platformDb()]);
      expect(a).toBe(b);
      expect(b).toBe(c);
    } finally {
      await resetPlatformDbForTests();
      removeQuietly(data);
    }
  }, 60_000);

  it("a configuration error rejects and is not cached", async () => {
    clearEnv();
    process.env.ZENITH_PLATFORM_DB = "postgres"; // no URL
    await expect(platformDb()).rejects.toMatchObject({ code: "invalid_input" });
    const data = tempDir();
    try {
      delete process.env.ZENITH_PLATFORM_DB;
      process.env.ZENITH_DATA = data;
      expect((await platformDb()).kind).toBe("pglite"); // fixed configuration works on the next call
    } finally {
      await resetPlatformDbForTests();
      removeQuietly(data);
    }
  }, 60_000);

  it("resetPlatformDbForTests is safe when nothing is open", async () => {
    await resetPlatformDbForTests();
    await resetPlatformDbForTests();
  });
});

describe("openPlatformDb", () => {
  it("requires a URL for Postgres, and refuses a malformed one without echoing it", async () => {
    await expect(openPlatformDb({ kind: "postgres" })).rejects.toMatchObject({ code: "invalid_input" });
    const err = await openPlatformDb({ kind: "postgres", url: "definitely not a url hunter2" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlStoreError);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("hunter2");
  });

  it("an unreachable or unauthorised database fails with a typed error that never carries the password", async () => {
    const err = await openPlatformDb({ kind: "postgres", url: "postgres://user:hunter2@127.0.0.1:1/db", migrate: true, max: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformDbError);
    expect((err as PlatformDbError).message).toMatch(/ECONNREFUSED|connect/i);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("hunter2");
  }, 30_000);

  it("reports an unusable PGlite directory instead of hanging", async () => {
    // a "directory" that is actually a file cannot be opened; the failure is reported
    const dir = tempDir();
    const file = path.join(dir, "not-a-directory");
    fs.writeFileSync(file, "x");
    try {
      await expect(openPlatformDb({ kind: "pglite", dataDir: file })).rejects.toBeDefined();
    } finally {
      removeQuietly(dir);
    }
  }, 60_000);
});

describe.skipIf(!PG_URL)("platformDb() against PostgreSQL", () => {
  it("opens a migrated database using ZENITH_PLATFORM_DB_URL, with the schema check passing", async () => {
    clearEnv();
    process.env.ZENITH_PLATFORM_DB_URL = PG_URL;
    process.env.ZENITH_PLATFORM_DB_MAX = "2";
    await (await openPlatformDb({ kind: "postgres", url: PG_URL as string, migrate: true, max: 1 })).close(); // make sure it is migrated
    const db = await platformDb();
    expect(db.kind).toBe("postgres");
    expect(db.identity).not.toContain("@");
    expect((await db.query<{ ok: number }>("select 1 as ok"))[0].ok).toBe(1);
  }, 60_000);

  it("fails CLOSED against an un-migrated database with the command to run, and does not cache the failure", async () => {
    await withScratchDatabase(async (url) => {
      clearEnv();
      process.env.ZENITH_PLATFORM_DB_URL = url;
      const err = await platformDb().catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "schema_behind" });
      expect((err as Error).message).toContain("scripts/platform/migrate.ts");
      // migrate it out of band; the very next call succeeds (the failure was not cached)
      await (await openPlatformDb({ kind: "postgres", url, migrate: true, max: 1 })).close();
      const db = await platformDb();
      expect((await db.query<{ n: number }>("select count(*)::int as n from platform.schema_migrations"))[0].n).toBe(1);
      await resetPlatformDbForTests();
    });
  }, 60_000);
});
