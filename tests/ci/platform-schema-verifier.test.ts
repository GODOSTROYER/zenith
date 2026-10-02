/** PGlite SQL contracts are unit evidence; the CI lane also runs on real PG16. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformSchemaError } from "@/lib/controlplane/db/errors";
import type { PlatformDbHandle } from "@/lib/controlplane/db/executor";
import { openPlatformDb } from "@/lib/controlplane/db/open";
import { assertPlatformSchemaCurrent, platformSchemaStatus } from "@/lib/controlplane/db/migrator";
import { BOOTSTRAP_SQL } from "@/lib/controlplane/db/migrations/bootstrap";
import { PLATFORM_MIGRATIONS, migrationChecksum } from "@/lib/controlplane/db/migrations/index";
import { EMITTED_RELATIVE_PATH } from "@/lib/controlplane/db/migrations/emit";
import { verifyPlatformSchema, verifySchemaMain } from "../../scripts/platform/verify-schema";
import mutations from "./platform-schema-verifier-fixtures/ledger-mutations.json";

const FIRST = PLATFORM_MIGRATIONS[0].version;
const LATEST = Math.max(...PLATFORM_MIGRATIONS.map((migration) => migration.version));
const FUTURE = LATEST + 1;
const PASSWORD = "fixture-credential-never-log";
const URL = `postgresql://postgres:${PASSWORD}@127.0.0.1:5432/ci`;
const PAYLOAD = "select 'fixture-private-sql-payload'";
const EMITTED_SQL = fs.readFileSync(EMITTED_RELATIVE_PATH, "utf8");
type LedgerRow = { version: number; name: string; checksum: string; applied_at: string };
const ledgerSql = "select version, name, checksum, applied_at from platform.schema_migrations order by version";

function capture() {
  let out = "";
  return {
    output: { stdout: { write: (text: string) => { out += text; } }, stderr: { write: (text: string) => { out += text; } } },
    read: () => out,
  };
}

describe("platform schema verifier [pglite]", () => {
  let db: PlatformDbHandle;
  let emittedLedger: LedgerRow[];
  beforeAll(async () => {
    db = await openPlatformDb({ kind: "pglite", migrate: false });
    await db.exec(EMITTED_SQL);
    emittedLedger = await db.query<LedgerRow>(ledgerSql);
  });
  beforeEach(async () => {
    await db.exec(BOOTSTRAP_SQL);
    await db.query("delete from platform.schema_migrations");
    for (const row of emittedLedger) {
      await db.query("insert into platform.schema_migrations(version, name, checksum, applied_at) values ($1, $2, $3, $4)", [
        row.version, row.name, row.checksum, row.applied_at,
      ]);
    }
  });
  afterAll(async () => { await db?.close(); });

  it("verifies every canonical version, name and actual checksum after a fresh emitted install", async () => {
    expect(emittedLedger.map(({ version, name, checksum }) => ({ version, name, checksum }))).toEqual(
      PLATFORM_MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name, checksum: migrationChecksum(migration) }))
    );
    await expect(assertPlatformSchemaCurrent(db)).resolves.toBeUndefined();
    await expect(verifyPlatformSchema(db)).resolves.toMatchObject({ current: true, ahead: [] });
  });

  it("reapplies emitted SQL without changing the ledger or its original timestamps", async () => {
    const before = await db.query<LedgerRow>(ledgerSql);
    await db.exec(EMITTED_SQL);
    await expect(verifyPlatformSchema(db)).resolves.toMatchObject({ current: true });
    expect(await db.query<LedgerRow>(ledgerSql)).toEqual(before);
  });

  it("verifies by reads only without repairing a damaged ledger", async () => {
    await db.query("delete from platform.schema_migrations where version = $1", [LATEST]);
    const before = await db.query<LedgerRow>(ledgerSql);
    const query = vi.spyOn(db, "query");
    const exec = vi.spyOn(db, "exec");
    const tx = vi.spyOn(db, "tx");
    try {
      await expect(verifyPlatformSchema(db)).rejects.toMatchObject({ code: "schema_behind" });
      expect(query.mock.calls.every(([text]) => /^select\b/i.test(text))).toBe(true);
      expect(exec).not.toHaveBeenCalled();
      expect(tx).not.toHaveBeenCalled();
    } finally {
      query.mockRestore(); exec.mockRestore(); tx.mockRestore();
    }
    expect(await db.query<LedgerRow>(ledgerSql)).toEqual(before);
  });

  async function addFuture() {
    await db.query("insert into platform.schema_migrations(version, name, checksum) values ($1, $2, $3)", [
      FUTURE, `newer-build-${PASSWORD}`, "b".repeat(64),
    ]);
  }

  it.each(mutations)("fails closed for $label", async ({ action, error }) => {
    switch (action) {
      case "drop-ledger": await db.exec("drop table platform.schema_migrations"); break;
      case "empty-ledger": await db.query("delete from platform.schema_migrations"); break;
      case "delete-latest": await db.query("delete from platform.schema_migrations where version = $1", [LATEST]); break;
      case "move-version": await db.query("update platform.schema_migrations set version = $1 where version = $2", [FUTURE, FIRST]); break;
      case "change-checksum": await db.query("update platform.schema_migrations set checksum = $1 where version = $2", ["a".repeat(64), FIRST]); break;
      case "change-name": await db.query("update platform.schema_migrations set name = $1 where version = $2", [`${PASSWORD} ${PAYLOAD}`, FIRST]); break;
      case "future-with-gap":
        await addFuture();
        await db.query("delete from platform.schema_migrations where version = $1", [LATEST]);
        break;
      case "future-with-tamper":
        await addFuture();
        await db.query("update platform.schema_migrations set checksum = $1 where version = $2", ["a".repeat(64), FIRST]);
        break;
      default: throw new Error("Unknown test fixture action");
    }
    if (action === "change-name") {
      // The runtime checks SQL checksums; CI also enforces manifest name integrity.
      await expect(assertPlatformSchemaCurrent(db)).resolves.toBeUndefined();
    } else {
      await expect(assertPlatformSchemaCurrent(db)).rejects.toMatchObject({ code: error });
    }
    await expect(verifyPlatformSchema(db)).rejects.toMatchObject({ code: error });
    const close = vi.fn(async () => {});
    const result = capture();
    expect(await verifySchemaMain({ SUPABASE_DB_URL: URL }, async () => ({ ...db, close }), result.output)).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(result.read()).toContain(error);
    for (const secret of [URL, PASSWORD, PAYLOAD]) expect(result.read()).not.toContain(secret);
  });

  it("accepts additive future versions, and states that their integrity is not verified", async () => {
    await addFuture();
    await expect(assertPlatformSchemaCurrent(db)).resolves.toBeUndefined();
    expect((await platformSchemaStatus(db)).ahead).toEqual([FUTURE]);
    await expect(verifyPlatformSchema(db)).resolves.toMatchObject({ current: true, ahead: [FUTURE] });
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({ ...db, close }));
    const result = capture();
    expect(await verifySchemaMain({ SUPABASE_DB_URL: URL }, open, result.output)).toBe(0);
    expect(open).toHaveBeenCalledWith({ kind: "postgres", url: URL, max: 1, migrate: false });
    expect(close).toHaveBeenCalledOnce();
    expect(result.read()).toContain("compatible with this build; their names/checksums were not verified");
    for (const secret of [URL, PASSWORD, PAYLOAD]) expect(result.read()).not.toContain(secret);
  });
});

describe("platform schema verifier safe failures", () => {
  it.each([undefined, "", "  "])("refuses a missing explicit lane URL (%s) without opening a database", async (url) => {
    const open = vi.fn();
    const result = capture();
    expect(await verifySchemaMain({ SUPABASE_DB_URL: url }, open, result.output)).toBe(1);
    expect(open).not.toHaveBeenCalled();
    expect(result.read()).toContain("SUPABASE_DB_URL is not set");
  });

  it.each([`not-a-url-${PASSWORD}`, `https://user:${PASSWORD}@example.test/private`])(
    "refuses an invalid lane URL without printing its value", async (url) => {
      const result = capture();
      expect(await verifySchemaMain({ SUPABASE_DB_URL: url }, openPlatformDb, result.output)).toBe(1);
      expect(result.read()).toContain("could not be verified");
      expect(result.read()).not.toContain(url);
      expect(result.read()).not.toContain(PASSWORD);
    }
  );

  it.each([
    new Error(`connect failed ${URL} ${PAYLOAD}`),
    new PlatformSchemaError("schema_tampered", `${URL} ${PAYLOAD}`),
  ])("never echoes raw connection, SQL or schema error messages", async (error) => {
    const result = capture();
    expect(await verifySchemaMain({ SUPABASE_DB_URL: URL }, async () => { throw error; }, result.output)).toBe(1);
    for (const secret of [URL, PASSWORD, PAYLOAD]) expect(result.read()).not.toContain(secret);
  });

  it("does not load .env.local or fall back to the application's database environment", () => {
    const child = spawnSync(path.resolve("node_modules/.bin/tsx"), [path.resolve("scripts/platform/verify-schema.ts")], {
      encoding: "utf8",
      env: { ...process.env, SUPABASE_DB_URL: "", ZENITH_PLATFORM_DB_URL: URL, ZENITH_PLATFORM_DB: "pglite" },
    });
    const out = child.stdout + child.stderr;
    expect(child.status).toBe(1);
    expect(out).toContain("SUPABASE_DB_URL is not set");
    expect(out).not.toContain(URL);
    expect(out).not.toContain(PASSWORD);
  });
});

describe.skipIf(process.platform === "win32")("Supabase apply verifier prerequisites and safe failures", () => {
  const script = path.resolve("scripts/ci/apply-supabase-migrations.sh");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-schema-verifier-"));
  const marker = path.join(scratch, "ddl-attempted");
  beforeAll(() => {
    fs.mkdirSync(path.join(scratch, "bin"));
    // The initial connectivity probe succeeds. The first mutation fails with a
    // credential/payload-bearing libpq error, as a real psql error may do.
    fs.writeFileSync(path.join(scratch, "bin/psql"), `#!/usr/bin/env bash
for argument in "$@"; do
  if [ "$argument" = "select 1" ]; then exit 0; fi
done
touch "$FAKE_DDL_MARKER"
echo "$SUPABASE_DB_URL $FAKE_SQL_PAYLOAD" >&2
exit 1
`, { mode: 0o755 });
  });
  beforeEach(() => {
    fs.rmSync(marker, { force: true });
    fs.rmSync(path.join(scratch, "scripts"), { recursive: true, force: true });
    fs.rmSync(path.join(scratch, "node_modules"), { recursive: true, force: true });
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  function run() {
    const child = spawnSync("bash", [script], {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(scratch, "bin")}${path.delimiter}${process.env.PATH}`, SUPABASE_DB_URL: URL,
        FAKE_DDL_MARKER: marker, FAKE_SQL_PAYLOAD: PAYLOAD },
    });
    return { status: child.status, out: child.stdout + child.stderr };
  }

  it("fails before DDL when the verifier/runtime prerequisites are missing", () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("Run npm ci --ignore-scripts");
    expect(fs.existsSync(marker)).toBe(false);
    for (const secret of [URL, PASSWORD, PAYLOAD]) expect(result.out).not.toContain(secret);
  });

  it("suppresses credential/SQL-bearing psql errors while retaining a trusted failure phase", () => {
    fs.mkdirSync(path.join(scratch, "scripts/platform"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "scripts/platform/verify-schema.ts"), "// prerequisite fixture\n");
    fs.mkdirSync(path.join(scratch, "node_modules/.bin"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "node_modules/.bin/tsx"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const result = run();
    expect(result.status).toBe(1);
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.out).toContain("psql_failed (role_stand_ins)");
    for (const secret of [URL, PASSWORD, PAYLOAD]) expect(result.out).not.toContain(secret);
  });
});
