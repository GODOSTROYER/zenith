/** Actual file IO and in-memory PGlite SQL. No live Postgres/production claim. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb } from "@/lib/controlplane/db/open";
import type { PlatformDbHandle } from "@/lib/controlplane/db/executor";
import { FileSecrets, FileVaultRewrap } from "@/lib/secrets/file-backend";
import { postgresVaultRewrapStore } from "@/lib/secrets/pg-rewrap";
import { readSecretValue, readSecretValueAsync, putSecret, putSecretAsync, unseal, vaultCipherFromEnv } from "@/lib/secrets";
import { createSecretResolver, createConnectionSecretSink } from "@/lib/secrets/resolver";
import { rewrapVault, type VaultRewrapStore } from "@/lib/secrets/rewrap";
import type { SecretRecord } from "@/lib/secrets/backend";
import type { AuditEvent } from "@/lib/domain/types";
import { vaultRewrapMain } from "../../scripts/vault-rewrap";

const VALUE = "synthetic-vault-canary-938217";
const WS = "ws-rotation";
const OTHER = "ws-other";
const NEW = randomBytes(32).toString("hex");
const OLD = randomBytes(32).toString("base64");
const OLDER = randomBytes(32).toString("hex");
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-vault-rotation-"));
  vi.stubEnv("ZENITH_DATA", dir);
  vi.stubEnv("ZENITH_STORE", "file");
  vi.stubEnv("ZENITH_SECRET_KEY", NEW);
  vi.stubEnv("ZENITH_VAULT_PREVIOUS_SECRET_KEYS", JSON.stringify([OLD, OLDER]));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function record(ref: string, key = OLD, workspaceId = WS, value = VALUE): SecretRecord {
  return {
    ref, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
    createdBy: "original-actor", updatedBy: "value-rotator", version: 7, keyVersion: 1,
    ...vaultCipherFromEnv({ ZENITH_SECRET_KEY: key }).seal(workspaceId, ref, value),
  };
}

describe.each(["file", "pglite"] as const)("vault re-wrap on %s", (kind) => {
  let db: PlatformDbHandle | undefined;
  let store: VaultRewrapStore;
  beforeEach(async () => {
    if (kind === "file") { store = FileVaultRewrap; return; }
    db = await openPlatformDb({ kind: "pglite", migrate: false });
    // Use the shipped product schema, not an imitation of platform.secrets.
    const migration = fs.readFileSync("supabase/migrations/0001_system_of_record.sql", "utf8");
    for (const table of ["secrets", "audit_events"]) {
      const ddl = migration.match(new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`))?.[0];
      if (!ddl) throw new Error("Product vault schema was not found.");
      await db.exec(ddl);
    }
    store = postgresVaultRewrapStore(db);
  });
  afterEach(async () => { await db?.close(); db = undefined; });

  async function seed(row: SecretRecord, workspaceId = WS): Promise<void> {
    if (kind === "file") { FileSecrets.put(workspaceId, row); return; }
    await db!.query(
      `INSERT INTO public.secrets (workspace_id, ref, iv, auth_tag, ciphertext, key_version, meta, version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8,$9::timestamptz)
       ON CONFLICT (workspace_id, ref) DO UPDATE SET iv=excluded.iv, auth_tag=excluded.auth_tag, ciphertext=excluded.ciphertext`,
      [workspaceId, row.ref, row.iv, row.authTag, row.ciphertext, row.keyVersion,
        JSON.stringify({ createdAt: row.createdAt, updatedAt: row.updatedAt, createdBy: row.createdBy, updatedBy: row.updatedBy }), row.version, row.updatedAt]);
  }
  async function snapshot(): Promise<string> {
    if (kind === "file") return fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    return JSON.stringify(await db!.query("SELECT * FROM public.secrets WHERE workspace_id = $1 OR workspace_id = $2 ORDER BY workspace_id, ref", [WS, OTHER]));
  }
  async function audits(): Promise<unknown[]> {
    if (kind === "pglite") return db!.query("SELECT * FROM public.audit_events WHERE workspace_id = $1 ORDER BY seq", [WS]);
    const auditPath = path.join(dir, "audit.jsonl");
    return fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  }
  async function mixed(): Promise<void> {
    await seed(record("vault:00", OLD));
    await seed(record("vault:01", OLDER));
    await seed(record("vault:02", NEW));
    await seed(record("vault:00", OLD, OTHER), OTHER);
  }

  it("re-wraps mixed keys in bounded batches, preserves metadata and excludes other tenants", async () => {
    await mixed();
    const before = await store.listBatch(WS, "", 10);
    const foreign = await store.listBatch(OTHER, "", 10);
    const progress: unknown[] = [];
    const counts = await rewrapVault(store, { workspaceId: WS, batchSize: 1, onBatch: (c) => { progress.push(c); } });
    expect(counts).toEqual({ inspected: 3, candidates: 2, rewrapped: 2, unchanged: 1, batches: 3 });
    const after = await store.listBatch(WS, "", 10);
    for (const [i, row] of after.entries()) {
      const { iv: _iv, authTag: _tag, ciphertext: _ct, ...meta } = row;
      const { iv: _oldIv, authTag: _oldTag, ciphertext: _oldCt, ...oldMeta } = before[i];
      expect(meta).toEqual(oldMeta);
      expect(vaultCipherFromEnv({ ZENITH_SECRET_KEY: NEW }).open(WS, row.ref, row).current).toBe(true);
    }
    expect(after[2]).toEqual(before[2]);
    expect(await store.listBatch(OTHER, "", 10)).toEqual(foreign);
    const audit = await audits();
    expect(audit).toHaveLength(2);
    for (const output of [JSON.stringify(progress), JSON.stringify(counts), JSON.stringify(audit), await snapshot()]) {
      expect(output.includes(VALUE)).toBe(false);
      for (const key of [NEW, OLD, OLDER]) expect(output.includes(key)).toBe(false);
    }
    expect(JSON.stringify(progress).includes("vault:")).toBe(false);
    const stable = await snapshot();
    expect(await rewrapVault(store, { workspaceId: WS, batchSize: 2 })).toEqual({ inspected: 3, candidates: 0, rewrapped: 0, unchanged: 3, batches: 2 });
    expect(await snapshot()).toBe(stable);
    expect(await audits()).toEqual(audit);
  });

  it("dry-run authenticates all pages but leaves ciphertext and audit unchanged", async () => {
    await mixed();
    const before = await snapshot();
    expect(await rewrapVault(store, { workspaceId: WS, batchSize: 1, dryRun: true })).toEqual({ inspected: 3, candidates: 2, rewrapped: 0, unchanged: 1, batches: 0 });
    expect(await snapshot()).toBe(before);
    expect(await audits()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "secrets.json.lock"))).toBe(false);
  });

  it("resumes after interruption without rewriting the committed batch", async () => {
    await mixed();
    await expect(rewrapVault(store, { workspaceId: WS, batchSize: 1, onBatch: () => { throw new Error(VALUE); } })).rejects.toThrow(/committed batches can be resumed/);
    const first = (await store.listBatch(WS, "", 1))[0];
    expect(vaultCipherFromEnv({ ZENITH_SECRET_KEY: NEW }).open(WS, first.ref, first).current).toBe(true);
    expect(await rewrapVault(store, { workspaceId: WS, batchSize: 1 })).toEqual({ inspected: 3, candidates: 1, rewrapped: 1, unchanged: 2, batches: 3 });
    expect((await store.listBatch(WS, "", 1))[0]).toEqual(first);
    expect(await audits()).toHaveLength(2);
  });

  it.each([false, true])("wrong key on the last page fails before any writes (dry-run=%s)", async (dryRun) => {
    await seed(record("vault:00"));
    await seed(record("vault:99", randomBytes(32).toString("hex")));
    const before = await snapshot();
    const failure = await rewrapVault(store, { workspaceId: WS, batchSize: 1, dryRun }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure).includes(VALUE)).toBe(false);
    expect(await snapshot()).toBe(before);
    expect(await audits()).toEqual([]);
  });

  it("tampered ciphertext fails closed before the first batch", async () => {
    await seed(record("vault:00"));
    await seed({ ...record("vault:99"), authTag: randomBytes(16).toString("base64") });
    const before = await snapshot();
    await expect(rewrapVault(store, { workspaceId: WS, batchSize: 1 })).rejects.toThrow(/Vault re-wrap stopped/);
    expect(await snapshot()).toBe(before);
    expect(await audits()).toEqual([]);
  });

  it.each(["workspace", "reference"])("authenticates the %s even with previous keys", async (label) => {
    const copied = record("vault:00", OLD, label === "workspace" ? OTHER : WS);
    await seed(label === "reference" ? { ...copied, ref: "vault:01" } : copied);
    const before = await snapshot();
    await expect(rewrapVault(store, { workspaceId: WS })).rejects.toThrow(/Vault re-wrap stopped/);
    expect(await snapshot()).toBe(before);
  });

  it("rereads a concurrently updated record instead of overwriting its new value", async () => {
    await seed(record("vault:00"));
    const latest = record("vault:00", NEW, WS, "synthetic-newer-value");
    const apply = store.applyBatch.bind(store);
    const raced: VaultRewrapStore = { ...store, async applyBatch(...args) { await seed(latest); return apply(...args); } };
    expect((await rewrapVault(raced, { workspaceId: WS })).rewrapped).toBe(0);
    expect((await store.listBatch(WS, "", 1))[0].ciphertext).toBe(latest.ciphertext);
  });

  it("rolls back the whole batch when transformation fails after preflight", async () => {
    await seed(record("vault:00"));
    await seed(record("vault:01"));
    const before = await snapshot();
    const apply = store.applyBatch.bind(store);
    const faulty: VaultRewrapStore = { ...store, applyBatch: (ws, cursor, limit, transform, audit) => apply(ws, cursor, limit,
      (row) => { if (row.ref === "vault:01") throw new Error(VALUE); return transform(row); }, audit) };
    await expect(rewrapVault(faulty, { workspaceId: WS })).rejects.toThrow(/Vault re-wrap stopped/);
    expect(await snapshot()).toBe(before);
    expect(await audits()).toEqual([]);
  });

  it("empty workspace is a no-op with zero rows", async () => {
    expect(await rewrapVault(store, { workspaceId: WS })).toEqual({ inspected: 0, candidates: 0, rewrapped: 0, unchanged: 0, batches: 0 });
    expect(await audits()).toEqual([]);
  });

  if (kind === "pglite") {
    it("audit failure rolls back every ciphertext update in its SQL transaction", async () => {
      await seed(record("vault:00"));
      await seed(record("vault:01"));
      const before = await snapshot();
      await db!.exec("ALTER TABLE public.audit_events ADD CONSTRAINT reject_audit CHECK (false)");
      await expect(rewrapVault(store, { workspaceId: WS })).rejects.toThrow(/Vault re-wrap stopped/);
      expect(await snapshot()).toBe(before);
      expect(await audits()).toEqual([]);
      await db!.exec("ALTER TABLE public.audit_events DROP CONSTRAINT reject_audit");
      expect((await rewrapVault(store, { workspaceId: WS })).rewrapped).toBe(2);
    });
    it("refuses an unsupported key scheme without changing rows", async () => {
      await seed({ ...record("vault:00"), keyVersion: 99 });
      const before = await snapshot();
      await expect(rewrapVault(store, { workspaceId: WS })).rejects.toThrow(/Vault re-wrap stopped/);
      expect(await snapshot()).toBe(before);
    });
    it("refuses a silently skipped SQL update instead of claiming success", async () => {
      await seed(record("vault:00"));
      const before = await snapshot();
      await db!.exec(`CREATE FUNCTION public.skip_rewrap_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
        CREATE TRIGGER skip_rewrap BEFORE UPDATE ON public.secrets FOR EACH ROW EXECUTE FUNCTION public.skip_rewrap_update();`);
      await expect(rewrapVault(store, { workspaceId: WS })).rejects.toThrow(/Vault re-wrap stopped/);
      expect(await snapshot()).toBe(before);
      expect(await audits()).toEqual([]);
    });
    it("does not skip an invalid empty reference at the start of SQL keyset paging", async () => {
      await seed(record(""));
      const before = await snapshot();
      await expect(rewrapVault(store, { workspaceId: WS })).rejects.toThrow(/Vault re-wrap stopped/);
      expect(await snapshot()).toBe(before);
    });
  }
});

describe("vault previous-key read compatibility", () => {
  it("supports sync, async and activity reads while all new writes use only the current key", async () => {
    const ref = "vault:proj1/svc1/KEY";
    FileSecrets.put(WS, record(ref));
    expect(readSecretValue(WS, ref) === VALUE).toBe(true);
    expect((await readSecretValueAsync(WS, ref)) === VALUE).toBe(true);
    const scope = { workspaceId: WS, projectId: "proj1", environmentId: "env1", resourceAddresses: ["postgres/db"] };
    expect((await createSecretResolver(scope)(ref)) === VALUE).toBe(true);
    const uri = "vault:generated/env1/postgres/db/connection-uri";
    FileSecrets.put(WS, record(uri));
    await createConnectionSecretSink(scope).put(uri, VALUE);
    putSecret(WS, "vault:SYNC", VALUE, "operator");
    await putSecretAsync(WS, "vault:ASYNC", VALUE, "operator");
    await createSecretResolver(scope)("vault:generated/env1/postgres/db/password");
    for (const row of FileSecrets.list(WS).filter((row) => row.ref !== ref && row.ref !== uri)) {
      expect(vaultCipherFromEnv({ ZENITH_SECRET_KEY: NEW }).open(WS, row.ref, row).current).toBe(true);
      expect(() => vaultCipherFromEnv({ ZENITH_SECRET_KEY: OLD }).open(WS, row.ref, row)).toThrow(/cannot be opened/);
    }
    expect(() => unseal(WS, ref, FileSecrets.get(WS, ref)!)).toThrow(/cannot be opened/);
  });

  it("accepts duplicate keys in either encoding without rewrapping current rows", async () => {
    vi.stubEnv("ZENITH_VAULT_PREVIOUS_SECRET_KEYS", JSON.stringify([NEW, Buffer.from(NEW, "hex").toString("base64"), OLD, OLD]));
    FileSecrets.put(WS, record("vault:00", NEW));
    expect((await rewrapVault(FileVaultRewrap, { workspaceId: WS })).rewrapped).toBe(0);
  });

  it.each(["broken-json-canary", "null", "{}", '"string"', "[null]", "[42]", '["bad-key-canary"]', '["' + OLD + '!invalid"]', ""])("refuses malformed previous-key configuration case %# without echoing it", (raw) => {
    const failure = (() => { try { vaultCipherFromEnv({ ZENITH_SECRET_KEY: NEW, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: raw }); } catch (error) { return error; } })();
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("ZENITH_VAULT_PREVIOUS_SECRET_KEYS");
    for (const canary of ["broken-json-canary", "bad-key-canary", OLD, NEW]) expect(String(failure).includes(canary)).toBe(false);
  });

  it("refuses previous keys without a valid current write key", () => {
    expect(() => vaultCipherFromEnv({ ZENITH_VAULT_PREVIOUS_SECRET_KEYS: JSON.stringify([OLD]) })).toThrow(/ZENITH_SECRET_KEY/);
    expect(() => vaultCipherFromEnv({ ZENITH_SECRET_KEY: "malformed-current-canary", ZENITH_VAULT_PREVIOUS_SECRET_KEYS: JSON.stringify([OLD]) })).toThrow(/ZENITH_SECRET_KEY/);
  });
});

describe("file audit recovery and CLI safety", () => {
  it("runs the actual CLI entry point in a separate Node process", async () => {
    FileSecrets.put(WS, record("vault:00"));
    const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "ZENITH_DATA", "ZENITH_STORE", "ZENITH_SECRET_KEY", "ZENITH_VAULT_PREVIOUS_SECRET_KEYS"]) {
      if (process.env[key] !== undefined) childEnv[key] = process.env[key];
    }
    const run = promisify(execFile);
    const result = await run(process.execPath, ["--import", "tsx", "scripts/vault-rewrap.ts", "--workspace", WS, "--dry-run"], {
      cwd: process.cwd(), env: childEnv, encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ inspected: 1, candidates: 1, rewrapped: 0 });
    for (const canary of [VALUE, NEW, OLD, OLDER]) expect(result.stdout.includes(canary)).toBe(false);
  });
  it("recovers a committed audit outbox after audit append failure", async () => {
    FileSecrets.put(WS, record("vault:00"));
    const open = fs.openSync;
    const spy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (String(args[0]).endsWith("audit.jsonl")) throw new Error(VALUE);
      return open(...args);
    });
    await expect(rewrapVault(FileVaultRewrap, { workspaceId: WS })).rejects.toThrow(/Vault re-wrap stopped/);
    spy.mockRestore();
    const file = path.join(dir, "secrets.json");
    const pending = JSON.parse(fs.readFileSync(file, "utf8")).pendingRewrapAudit as AuditEvent[];
    expect(pending).toHaveLength(1);
    const committed = FileSecrets.get(WS, "vault:00");
    const auditPath = path.join(dir, "audit.jsonl");
    fs.writeFileSync(auditPath, '{"interrupted":"fragment"');
    expect((await rewrapVault(FileVaultRewrap, { workspaceId: WS })).rewrapped).toBe(0);
    expect(FileSecrets.get(WS, "vault:00")).toEqual(committed);
    const auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    expect(auditLines[0]).toBe('{"interrupted":"fragment"');
    const events = auditLines.slice(1).map((line) => JSON.parse(line));
    expect(events.map((event) => event.id)).toEqual(pending.map((event) => event.id));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).pendingRewrapAudit).toBeUndefined();
  });

  it("refuses a busy file writer without modifying ciphertext", async () => {
    FileSecrets.put(WS, record("vault:00"));
    const file = path.join(dir, "secrets.json");
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(`${file}.lock`, "operator-owned-lock");
    await expect(rewrapVault(FileVaultRewrap, { workspaceId: WS })).rejects.toThrow(/Vault re-wrap stopped/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe("operator-owned-lock");
  });

  it.each(['{"version":99,"workspaces":{}}', '{"version":1,"workspaces":null}', '{"version":1,"workspaces":[]}', '{"version":1,"workspaces":{"ws-rotation":[]}}', 'corrupt-json-canary'])("refuses malformed file data case %#", async (data) => {
    const file = path.join(dir, "secrets.json");
    fs.writeFileSync(file, data);
    await expect(rewrapVault(FileVaultRewrap, { workspaceId: WS })).rejects.toThrow(/Vault re-wrap stopped/);
    expect(fs.readFileSync(file, "utf8")).toBe(data);
  });

  it("CLI emits numeric counts only and dry-run does not mutate the file", async () => {
    FileSecrets.put(WS, record("vault:00"));
    const file = path.join(dir, "secrets.json");
    const before = fs.readFileSync(file, "utf8");
    const lines: string[] = [];
    const errors: string[] = [];
    expect(await vaultRewrapMain(["--workspace", WS, "--batch-size", "1", "--dry-run"], (line) => { lines.push(line); }, (line) => { errors.push(line); })).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(lines[0])).toMatchObject({ candidates: 1, rewrapped: 0 });
    expect(await vaultRewrapMain(["--workspace", WS], (line) => { lines.push(line); }, (line) => { errors.push(line); })).toBe(0);
    expect(errors).toEqual([]);
    for (const line of lines) {
      expect(Object.values(JSON.parse(line)).every((value) => typeof value === "number")).toBe(true);
      expect(line.includes(VALUE)).toBe(false);
    }
  });

  it.each([[], ["--workspace"], ["--workspace", WS, "--batch-size", "0"], ["--workspace", WS, "--batch-size", "1001"], ["--workspace", WS, "--batch-size", "1.5"], ["--workspace", WS, "--dry-run", "--dry-run"], ["--workspace", "external-string-canary;DROP"], ["--key", "secret-argument-canary"]].map((args) => ({ args })))("CLI rejects invalid arguments case %# without echoing them", async ({ args }) => {
    const errors: string[] = [];
    expect(await vaultRewrapMain(args, () => { throw new Error("Unexpected output."); }, (line) => { errors.push(line); })).toBe(2);
    expect(errors.join().includes("external-string-canary")).toBe(false);
    expect(errors.join().includes("secret-argument-canary")).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("CLI sanitizes failed configuration and does not open the platform database for a product rotation", async () => {
    vi.stubEnv("ZENITH_STORE", "postgres");
    vi.stubEnv("SUPABASE_DB_URL", undefined);
    vi.stubEnv("ZENITH_PLATFORM_DB_URL", "postgres://user:synthetic-password-canary@127.0.0.1:1/platform");
    const errors: string[] = [];
    expect(await vaultRewrapMain(["--workspace", WS], () => undefined, (line) => { errors.push(line); })).toBe(1);
    expect(errors.join().includes("synthetic-password-canary")).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

/** Real product-table lane; never contacts a database unless explicitly armed. */
describe.skipIf(!process.env.ZENITH_TEST_PLATFORM_PG_URL)("real Postgres vault re-wrap", () => {
  it("commits product rows and audit together, then resumes idempotently", async () => {
    const db = await openPlatformDb({ kind: "postgres", url: process.env.ZENITH_TEST_PLATFORM_PG_URL, migrate: false, max: 1 });
    const workspaceId = `vault-rewrap-${randomBytes(10).toString("hex")}`;
    try {
      const row = record("vault:CONTRACT", OLD, workspaceId);
      await db.query(
        `INSERT INTO public.secrets (workspace_id, ref, iv, auth_tag, ciphertext, key_version, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [workspaceId, row.ref, row.iv, row.authTag, row.ciphertext, row.keyVersion, row.version]);
      const store = postgresVaultRewrapStore(db);
      expect((await rewrapVault(store, { workspaceId, batchSize: 1 })).rewrapped).toBe(1);
      const committed = (await store.listBatch(workspaceId, "", 1))[0];
      expect(vaultCipherFromEnv({ ZENITH_SECRET_KEY: NEW }).open(workspaceId, committed.ref, committed).current).toBe(true);
      expect((await rewrapVault(store, { workspaceId })).rewrapped).toBe(0);
      expect(await store.listBatch(workspaceId, "", 1)).toEqual([committed]);
      const events = await db.query("SELECT * FROM public.audit_events WHERE workspace_id = $1 AND action_id = $2", [workspaceId, "system.rewrapVault"]);
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events).includes(VALUE)).toBe(false);
    } finally {
      await db.query("DELETE FROM public.audit_events WHERE workspace_id = $1", [workspaceId]);
      await db.query("DELETE FROM public.secrets WHERE workspace_id = $1", [workspaceId]);
      await db.close();
    }
  });
});
