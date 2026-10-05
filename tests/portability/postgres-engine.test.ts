/**
 * PROD-LIFE-11: Postgres export, import and independent readback, against REAL
 * Postgres engines (PGlite is Postgres compiled to WebAssembly) and a real
 * directory for tenant storage. Nothing is mocked.
 *
 *   export  -> artifact in storage, read back and verified from storage
 *   import  -> a NEW empty database, restored from the artifact alone
 *   readback-> a different engine instance opened from the target's bytes
 *   refusal -> unsupported objects, non-empty target, rewritten artifact
 *
 * Set ZENITH_TEST_POSTGRES_URL (a superuser-ish URL to an EMPTY scratch server)
 * to also run the same journey over real network Postgres through the
 * production connector (`openPostgres`): see the last describe block.
 */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { verifyArtifact } from "@/lib/portability/artifact";
import { exportPostgres, readbackPostgres } from "@/lib/portability/engines/postgres";
import { runExport, runImport, type ServiceBinding } from "@/lib/portability/service";
import { PortabilityError } from "@/lib/portability/types";
import { directoryArtifactStore, pgliteRunner, reopened, seededPglite, tempDir } from "./support";

const open: PGlite[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => undefined);
});
const track = <T extends PGlite>(db: T): T => {
  open.push(db);
  return db;
};

const SOURCE = { provider: "aws", nativeType: "aws:rds_instance", address: "postgres/db", externalId: "db-1" };
const base = { workspaceId: "ws_1", environmentId: "env_1", operationId: "op_1", now: new Date("2026-10-05T00:00:00Z"), source: SOURCE };

async function exportSeeded() {
  const source = track(await seededPglite());
  const dir = tempDir();
  const store = directoryArtifactStore(dir);
  const outcome = await runExport({ ...base, binding: { kind: "postgres", sql: pgliteRunner(source) }, store });
  return { source, dir, store, outcome };
}

describe("postgres logical export", () => {
  it("writes a manifest last, lists every file with its digest, and verifies the artifact by reading it back from storage", async () => {
    const { dir, store, outcome } = await exportSeeded();
    expect(outcome.kind).toBe("postgres");
    expect(outcome.engine).toBe("postgres-logical-v1");
    expect(outcome.coverage).toMatchObject({ tables: 2, rows: 6, enums: 1, schemas: ["app", "public"] });
    const names = outcome.manifest.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["schema.json", "schema.sql", "RESTORE.md", "tables/0000.ndjson", "tables/0001.ndjson"]));
    // readable without Zenith: plain SQL and plain rows
    expect(fs.readFileSync(path.join(dir, "schema.sql"), "utf8")).toContain('create table "public"."accounts"');
    expect(fs.readFileSync(path.join(dir, "tables/0000.ndjson"), "utf8")).toContain("first");
    expect(fs.readFileSync(path.join(dir, "tables/0001.ndjson"), "utf8")).toContain("ada@example.test");
    const again = await verifyArtifact(store);
    expect(again.manifestDigest).toBe(outcome.manifestDigest);
  });

  it("is idempotent for the same operation and refuses to reuse a location for another", async () => {
    const { source, store, outcome } = await exportSeeded();
    const binding: ServiceBinding = { kind: "postgres", sql: pgliteRunner(source) };
    const retry = await runExport({ ...base, binding, store });
    expect(retry.manifestDigest).toBe(outcome.manifestDigest);
    await expect(runExport({ ...base, operationId: "op_other", binding, store })).rejects.toMatchObject({ code: "artifact_invalid" });
  });

  it("refuses a database holding objects it cannot carry, naming them, and writes nothing", async () => {
    const source = track(new PGlite());
    await source.exec("create table t (id int primary key); create view v as select * from t; create function f() returns int language sql as 'select 1';");
    const dir = tempDir();
    await expect(runExport({ ...base, binding: { kind: "postgres", sql: pgliteRunner(source) }, store: directoryArtifactStore(dir) })).rejects.toMatchObject({
      code: "unsupported_objects",
      message: expect.stringContaining("view public.v"),
    });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses unsupported provider and kind combinations before touching anything", async () => {
    const source = track(new PGlite());
    const dir = tempDir();
    await expect(runExport({ ...base, source: { ...SOURCE, provider: "sandbox" }, binding: { kind: "postgres", sql: pgliteRunner(source) }, store: directoryArtifactStore(dir) })).rejects.toMatchObject({ code: "unsupported" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("postgres restore into a new target, verified by independent readback", () => {
  it("restores the artifact alone into an empty database and a re-opened engine reads back the same logical content", async () => {
    const { source, store, outcome } = await exportSeeded();
    const target = track(new PGlite());
    const reread: PGlite[] = [];
    const result = await runImport({
      recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "postgres", engine: outcome.engine },
      store,
      target: { provider: "aws", kind: "postgres" },
      binding: { kind: "postgres", sql: pgliteRunner(target) },
      openReadback: async () => {
        // A different engine instance opened from the restored bytes: the restore's own session cannot vouch for itself.
        const fresh = track(await reopened(target));
        reread.push(fresh);
        return { binding: { kind: "postgres", sql: pgliteRunner(fresh) }, close: async () => undefined };
      },
    });
    expect(result.status).toBe("verified");
    expect(result.observedContentDigest).toBe(outcome.contentDigest);
    expect(reread).toHaveLength(1);
    expect(result.restored).toMatchObject({ tables: 2, rows: 6 });

    // And the data is really there, exactly: numeric precision, escapes, unicode, bytea, jsonb, arrays, enums, nulls.
    const rows = (await target.query<Record<string, unknown>>("select email, balance::text as balance, mood::text as mood, tags, meta::text as meta, encode(blob, 'hex') as blob, note from public.accounts order by id")).rows;
    expect(rows[0]).toMatchObject({ email: "ada@example.test", balance: "12345678.1234", mood: "happy", tags: ["a", "b c"], blob: "deadbeef", note: 'line one\nline "two" \\ back' });
    expect(JSON.parse(String(rows[0]!.meta))).toEqual({ k: [1, 2, { z: null }], s: "x" });
    expect(rows[1]).toMatchObject({ mood: null, note: "héllo ☃ 日本語", meta: null, blob: null });
    expect(rows[2]).toMatchObject({ email: "o'neil@example.test", meta: '"just a string"', blob: "" });
    // identity, generated column, sequences and constraints came through
    expect((await target.query<{ n: number }>("select count(*)::int as n from app.entries where total_cents = (amount * 100)::bigint")).rows[0]!.n).toBe(3);
    await target.query("insert into app.entries (account_id, amount) values (1, 1)");
    expect((await target.query<{ id: string }>("select max(id)::text as id from app.entries")).rows[0]!.id).toBe("4");
    expect((await target.query<{ v: string }>("select nextval('public.invoice_numbers')::text as v")).rows[0]!.v).toBe("1010");
    await expect(target.query("insert into public.accounts (email) values ('ada@example.test')")).rejects.toThrow();
    await expect(target.query("insert into public.accounts (email) values ('ADA@example.test')")).rejects.toThrow();
    await expect(target.query("insert into app.entries (account_id, amount) values (999, 1)")).rejects.toThrow();
    // the source was never modified
    expect((await source.query<{ n: number }>("select count(*)::int as n from public.accounts")).rows[0]!.n).toBe(3);
  });

  it("reports a mismatch, not success, when the target reads back differently", async () => {
    const { store, outcome } = await exportSeeded();
    const target = track(new PGlite());
    const result = await runImport({
      recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "postgres", engine: outcome.engine },
      store,
      target: { provider: "aws", kind: "postgres" },
      binding: { kind: "postgres", sql: pgliteRunner(target) },
      openReadback: async () => {
        // Something changed the restored data between restore and readback.
        await target.exec("update public.accounts set balance = balance + 1 where id = 1");
        return { binding: { kind: "postgres", sql: pgliteRunner(target) }, close: async () => undefined };
      },
    });
    expect(result.status).toBe("mismatch");
    expect(result.observedContentDigest).not.toBe(result.expectedContentDigest);
  });

  it("never merges into a populated target", async () => {
    const { store, outcome } = await exportSeeded();
    const target = track(new PGlite());
    await target.exec("create table existing (id int)");
    await expect(
      runImport({
        recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "postgres", engine: outcome.engine },
        store, target: { provider: "aws", kind: "postgres" }, binding: { kind: "postgres", sql: pgliteRunner(target) },
        openReadback: async () => { throw new Error("unreachable"); },
      })
    ).rejects.toMatchObject({ code: "target_not_empty" });
    expect((await target.query<{ n: number }>("select count(*)::int as n from pg_tables where schemaname = 'public'")).rows[0]!.n).toBe(1);
  });

  it("refuses an artifact that was changed after Zenith recorded it, and one that no longer matches its own manifest", async () => {
    const { dir, store, outcome } = await exportSeeded();
    const target = track(new PGlite());
    const args = (recordedDigest: string) => ({
      recorded: { manifestDigest: recordedDigest, contentDigest: outcome.contentDigest, kind: "postgres" as const, engine: outcome.engine },
      store, target: { provider: "aws", kind: "postgres" as const }, binding: { kind: "postgres", sql: pgliteRunner(target) } as ServiceBinding,
      openReadback: async () => { throw new Error("unreachable"); },
    });
    // the platform recorded a different manifest than the one in storage
    await expect(runImport(args("0".repeat(64)))).rejects.toMatchObject({ code: "digest_mismatch" });
    // a data file rewritten in the tenant's bucket
    fs.appendFileSync(path.join(dir, "tables/0000.ndjson"), '["x"]\n');
    await expect(runImport(args(outcome.manifestDigest))).rejects.toMatchObject({ code: "digest_mismatch" });
    expect((await target.query<{ n: number }>("select count(*)::int as n from pg_tables where schemaname = 'public'")).rows[0]!.n).toBe(0);
  });

  it("refuses to run DDL the exporter would not have written", async () => {
    const { dir, store, outcome } = await exportSeeded();
    const schemaPath = path.join(dir, "schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as { pre: string[] };
    schema.pre.push("drop schema public cascade");
    const evil = Buffer.from(JSON.stringify(schema));
    // re-seal the manifest so the artifact is self-consistent: only the allowlist stands between it and the target
    const { createHash } = await import("node:crypto");
    fs.writeFileSync(schemaPath, evil);
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { files: { name: string; sha256: string; bytes: number }[] };
    const f = manifest.files.find((x) => x.name === "schema.json")!;
    f.sha256 = createHash("sha256").update(evil).digest("hex");
    f.bytes = evil.length;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const reverified = await verifyArtifact(store);
    const target = track(new PGlite());
    await expect(
      runImport({
        recorded: { manifestDigest: reverified.manifestDigest, contentDigest: outcome.contentDigest, kind: "postgres", engine: outcome.engine },
        store, target: { provider: "aws", kind: "postgres" }, binding: { kind: "postgres", sql: pgliteRunner(target) },
        openReadback: async () => { throw new Error("unreachable"); },
      })
    ).rejects.toMatchObject({ code: "artifact_invalid" });
  });

  it("refuses to restore across kinds and into an older major version", async () => {
    const { dir, store, outcome } = await exportSeeded();
    const target = track(new PGlite());
    const common = { recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "postgres" as const, engine: outcome.engine }, store, openReadback: async () => { throw new Error("unreachable"); } };
    await expect(runImport({ ...common, target: { provider: "aws", kind: "mysql" }, binding: { kind: "postgres", sql: pgliteRunner(target) } })).rejects.toBeInstanceOf(PortabilityError);
    // pretend the source was a newer major than the target
    const runner = pgliteRunner(target);
    const older = { query: async (t: string, p?: readonly unknown[]) => (t === "show server_version" ? [{ server_version: "1.0" }] : runner.query(t, p)) };
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as { engineVersion?: string };
    expect(Number.parseInt(manifest.engineVersion ?? "0", 10)).toBeGreaterThan(1);
    await expect(runImport({ ...common, target: { provider: "aws", kind: "postgres" }, binding: { kind: "postgres", sql: older } })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("independent readback", () => {
  it("computes the same logical digest from any session, whatever order rows were inserted in", async () => {
    const a = track(new PGlite());
    const b = track(new PGlite());
    await a.exec("create table t (id int primary key, v text); insert into t values (1,'a'),(2,'b'),(3,'c');");
    await b.exec("create table t (id int primary key, v text); insert into t values (3,'c'),(1,'a'),(2,'b');");
    expect((await readbackPostgres(pgliteRunner(a))).contentDigest).toBe((await readbackPostgres(pgliteRunner(b))).contentDigest);
    await b.exec("update t set v = 'z' where id = 2");
    expect((await readbackPostgres(pgliteRunner(a))).contentDigest).not.toBe((await readbackPostgres(pgliteRunner(b))).contentDigest);
    // structure is part of the digest, not just rows
    await b.exec("update t set v = 'b' where id = 2; create index t_v on t (v);");
    expect((await readbackPostgres(pgliteRunner(a))).contentDigest).not.toBe((await readbackPostgres(pgliteRunner(b))).contentDigest);
  });

  it("enforces the export limits instead of exporting a truncated database", async () => {
    const source = track(new PGlite());
    await source.exec("create table t (v text); insert into t select repeat('x', 100) from generate_series(1, 200);");
    await expect(exportPostgres(pgliteRunner(source), async () => undefined, { limits: { maxBytes: 1000, maxRows: 10_000, maxObjects: 1, maxObjectBytes: 1 } })).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

const REAL_URL = process.env.ZENITH_TEST_POSTGRES_URL?.trim();
describe.skipIf(!REAL_URL)("real network Postgres through the production connector", () => {
  it("exports and restores between two scratch databases of the same server", async () => {
    const { openPostgres } = await import("@/lib/portability/connect");
    const adminUrl = new URL(REAL_URL as string);
    const admin = await openPostgres(adminUrl.toString(), { allowPrivate: true });
    const suffix = Math.random().toString(36).slice(2, 8);
    const names = [`zenith_pt_src_${suffix}`, `zenith_pt_dst_${suffix}`];
    try {
      for (const n of names) await (admin.binding as { sql: { query(t: string): Promise<unknown> } }).sql.query(`create database ${n}`);
      const urlFor = (db: string): string => { const u = new URL(adminUrl.toString()); u.pathname = `/${db}`; return u.toString(); };
      const src = await openPostgres(urlFor(names[0]!), { allowPrivate: true });
      const sqlSrc = (src.binding as { sql: ReturnType<typeof pgliteRunner> }).sql;
      for (const stmt of SEED_STATEMENTS) await sqlSrc.query(stmt);
      const dir = tempDir();
      const store = directoryArtifactStore(dir);
      const exported = await runExport({ ...base, binding: src.binding, store });
      const dst = await openPostgres(urlFor(names[1]!), { allowPrivate: true });
      const result = await runImport({
        recorded: { manifestDigest: exported.manifestDigest, contentDigest: exported.contentDigest, kind: "postgres", engine: exported.engine },
        store, target: { provider: "aws", kind: "postgres" }, binding: dst.binding,
        openReadback: () => openPostgres(urlFor(names[1]!), { allowPrivate: true }),
      });
      expect(result.status).toBe("verified");
      await src.close();
      await dst.close();
    } finally {
      for (const n of names) await (admin.binding as { sql: { query(t: string): Promise<unknown> } }).sql.query(`drop database if exists ${n}`).catch(() => undefined);
      await admin.close();
    }
  });
});

const SEED_STATEMENTS = [
  "create table accounts (id serial primary key, email text not null unique, balance numeric(12,4) not null default 0, meta jsonb, blob bytea)",
  "insert into accounts (email, balance, meta, blob) values ('a@example.test', 12.3456, '{\"k\":[1]}', '\\xdead'), ('b@example.test', -1, null, null)",
];
