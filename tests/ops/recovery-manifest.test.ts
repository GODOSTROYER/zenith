/**
 * PROD-OPS-04: the backup manifest, the integrity checks, the restore gates that fire BEFORE any database is
 * touched, the connection hygiene of the tool runner and the RPO/RTO arithmetic. No database, no external tool:
 * these are the contract-level checks. The real pg_dump / pg_restore / Temporal rehearsal is
 * tests/ops/recovery-rehearsal.test.ts.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_MANIFEST_FORMAT, COMPONENT_IDS, MANIFEST_FILE, describeFile, parseManifest, sealManifest, verifyBackupDirectory,
  type BackupManifest, type ComponentId, type ManifestComponent,
} from "@/lib/ops/recovery/manifest";
import { RecoveryToolError, mustRun, pgArgs, scrub, toolsFromEnv, type CommandRunner } from "@/lib/ops/recovery/process";
import { deliverReport, measureRecovery, registerRecoveryMeasurementSink, targetsFromEnv } from "@/lib/ops/recovery/report";
import { runRestore, type RestoreOptions } from "@/lib/ops/recovery/restore";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "zenith-recovery-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const component = (id: ComponentId, over: Partial<ManifestComponent> = {}): ManifestComponent =>
  ({ id, title: id, status: "covered", method: "none", note: "in the platform dump", files: [], facts: {}, ...over });

async function writeBackup(over: { components?: (files: Awaited<ReturnType<typeof describeFile>>[]) => ManifestComponent[]; keys?: BackupManifest["keys"] } = {}): Promise<BackupManifest> {
  await writeFile(path.join(dir, "database.dump"), Buffer.from("PGDMP-not-really-but-bytes-are-bytes"));
  const dump = await describeFile(dir, "database.dump");
  const components = over.components?.([dump]) ?? COMPONENT_IDS.map((id) => id === "platform"
    ? component("platform", { status: "captured", method: "pg_dump", note: "", files: [dump], facts: { schemas: "platform", "rows.operations": 3 } })
    : id === "customer_state" ? component(id, { status: "referenced", note: "customer's bucket" })
    : component(id, id === "keys" ? { status: "captured", method: "key_registry", note: "" } : {}));
  const manifest = sealManifest({
    format: BACKUP_MANIFEST_FORMAT, backupId: "bk-1", startedAt: "2026-10-07T10:00:00.000Z", finishedAt: "2026-10-07T10:00:05.000Z",
    platform: { schemaVersion: 41, recoveryEpoch: 0, serverVersion: "16.4", snapshotAt: "2026-10-07T10:00:01.000Z" },
    keys: over.keys ?? [], components,
  });
  await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe("manifest integrity", () => {
  it("a complete backup verifies, and the digest covers everything but itself", async () => {
    const manifest = await writeBackup();
    const result = await verifyBackupDirectory(dir);
    expect(result).toMatchObject({ ok: true, filesChecked: 1 });
    expect(result.manifest?.digest).toBe(manifest.digest);
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an edited file, a missing file, a resized file and an edited manifest are each refused", async () => {
    await writeBackup();
    await writeFile(path.join(dir, "database.dump"), Buffer.from("PGDMP-not-really-but-bytes-are-BYTES"));
    expect((await verifyBackupDirectory(dir)).problems.map((p) => p.code)).toEqual(["file_digest"]);
    await writeFile(path.join(dir, "database.dump"), Buffer.from("short"));
    expect((await verifyBackupDirectory(dir)).problems.map((p) => p.code)).toEqual(["file_size"]);
    await rm(path.join(dir, "database.dump"));
    expect((await verifyBackupDirectory(dir)).problems.map((p) => p.code)).toEqual(["file_missing"]);

    await writeBackup();
    const text = await readFile(path.join(dir, MANIFEST_FILE), "utf8");
    await writeFile(path.join(dir, MANIFEST_FILE), text.replace('"schemaVersion": 41', '"schemaVersion": 40'));
    expect((await verifyBackupDirectory(dir)).problems.map((p) => p.code)).toContain("manifest_digest");
  });

  it("refuses an unreadable manifest, a foreign format and a path that escapes the backup", async () => {
    expect((await verifyBackupDirectory(dir)).problems[0]?.code).toBe("manifest_unreadable");
    await writeFile(path.join(dir, MANIFEST_FILE), "{ not json");
    expect((await verifyBackupDirectory(dir)).problems[0]?.code).toBe("manifest_unreadable");
    expect(parseManifest(JSON.stringify({ format: "other" })).problems[0]?.code).toBe("manifest_format");
    const escaping = sealManifest({
      format: BACKUP_MANIFEST_FORMAT, backupId: "bk-2", startedAt: "2026-10-07T10:00:00.000Z", finishedAt: "2026-10-07T10:00:05.000Z",
      platform: { schemaVersion: 41, recoveryEpoch: 0, serverVersion: "16.4", snapshotAt: "2026-10-07T10:00:01.000Z" }, keys: [],
      components: [component("platform", { status: "captured", method: "pg_dump", note: "", files: [{ path: "../outside.dump", bytes: 1, sha256: "a".repeat(64) }] })],
    });
    await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(escaping));
    const result = await verifyBackupDirectory(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain("file_name");
  });

  it("a captured file component with no files is refused as incomplete", () => {
    const m = sealManifest({
      format: BACKUP_MANIFEST_FORMAT, backupId: "bk-3", startedAt: "2026-10-07T10:00:00.000Z", finishedAt: "2026-10-07T10:00:05.000Z",
      platform: { schemaVersion: 41, recoveryEpoch: 0, serverVersion: "16.4", snapshotAt: "2026-10-07T10:00:01.000Z" }, keys: [],
      components: [component("platform", { status: "captured", method: "pg_dump", note: "", files: [] })],
    });
    expect(parseManifest(JSON.stringify(m)).problems.map((p) => p.code)).toContain("component_incomplete");
  });
});

describe("restore gates (all fire before any database is opened)", () => {
  const neverOpen = (): Promise<never> => { throw new Error("the target database must not be opened"); };
  const noRun: CommandRunner = async () => { throw new Error("no tool must run"); };
  const base = (over: Partial<RestoreOptions> = {}): RestoreOptions => ({
    backupDir: dir, targetUrl: "postgres://u:secret-pw@127.0.0.1:5432/target", runId: "restore-gates-1", actor: "operator:a", reason: "gate test",
    confirmCustomerState: true, keysAvailable: [], reportFile: path.join(dir, "out", "report.json"), ...over,
  });
  const run = (over?: Partial<RestoreOptions>) => runRestore({ run: noRun, tools: toolsFromEnv({}), openTarget: neverOpen }, base(over));

  it("refuses a damaged backup at verify and still writes a report", async () => {
    await writeBackup();
    await writeFile(path.join(dir, "database.dump"), Buffer.from("tampered tampered tampered tampered!"));
    const report = await run();
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ id: "verify", status: "refused" });
    expect(JSON.parse(await readFile(path.join(dir, "out", "report.json"), "utf8"))).toMatchObject({ ok: false, runId: "restore-gates-1" });
  });

  it("refuses without the customer-state confirmation, with the reason", async () => {
    await writeBackup();
    const report = await run({ confirmCustomerState: false });
    expect(report.steps.at(-1)).toMatchObject({ id: "gates", status: "refused" });
    expect(report.steps.at(-1)?.detail).toMatch(/customer/i);
  });

  it("refuses a skipped component unless the operator accepts that gap by name", async () => {
    await writeBackup({ components: (files) => COMPONENT_IDS.map((id) => id === "platform"
      ? component("platform", { status: "captured", method: "pg_dump", note: "", files, facts: { schemas: "platform" } })
      : id === "temporal" ? component(id, { status: "skipped", note: "unreachable" })
      : id === "customer_state" ? component(id, { status: "referenced" })
      : component(id, id === "keys" ? { status: "captured", method: "key_registry", note: "" } : {})) });
    const refused = await run();
    expect(refused.steps.at(-1)).toMatchObject({ id: "gates", status: "refused" });
    expect(refused.steps.at(-1)?.detail).toContain("--accept-skipped temporal");
    // accepted by name: the next gate (keys) is reached instead
    const accepted = await run({ acceptSkipped: ["temporal"], productDataDir: undefined });
    expect(accepted.steps.map((s) => s.id)).toContain("gates");
    expect(accepted.steps.find((s) => s.id === "gates")?.status).toBe("ok");
  });

  it("refuses a manifest that omits a component", async () => {
    await writeBackup({ components: (files) => [component("platform", { status: "captured", method: "pg_dump", note: "", files })] });
    const report = await run();
    expect(report.steps.at(-1)).toMatchObject({ id: "gates", status: "refused" });
    expect(report.steps.at(-1)?.detail).toMatch(/no entry for/);
  });

  it("refuses to restore when this host lacks a key id the backup needs, naming ids only", async () => {
    await writeBackup({ keys: [{ purpose: "enc:vault", keyId: "k-needed", role: "current" }, { purpose: "signing:control", keyId: "k-sign", role: "verify_only" }] });
    const report = await run({ keysAvailable: [{ purpose: "enc:vault", keyId: "k-needed", role: "current" }] });
    expect(report.steps.at(-1)).toMatchObject({ id: "keys", status: "refused" });
    const detail = report.steps.at(-1)!.detail;
    expect(detail).toContain("signing:control:k-sign");
    expect(detail).not.toContain("k-needed");
    expect(detail).not.toContain("secret-pw");
    expect(report.epoch).toBeNull();
  });

  it("a restore report records the measurement and never a connection string", async () => {
    await writeBackup();
    const report = await run({ confirmCustomerState: false, incidentAt: "2026-10-07T10:30:00.000Z" });
    const text = await readFile(path.join(dir, "out", "report.json"), "utf8");
    expect(text).not.toContain("secret-pw");
    expect(text).not.toContain("postgres://");
    expect(report.measurement).toMatchObject({ rpoSeconds: 1799, incidentAt: "2026-10-07T10:30:00.000Z" });
  });
});

describe("tool hygiene", () => {
  it("never puts a password on a command line", () => {
    const conn = pgArgs("postgres://user:p%40ss@db.example.com:6543/zenith?sslmode=require");
    expect(conn.args.join(" ")).not.toContain("p%40ss");
    expect(conn.args.join(" ")).not.toContain("p@ss");
    expect(conn.env).toMatchObject({ PGPASSWORD: "p@ss", PGSSLMODE: "require" });
    expect(conn.label).toBe("db.example.com:6543/zenith");
    expect(conn.args).toEqual(["--host", "db.example.com", "--port", "6543", "--username", "user", "--dbname", "zenith"]);
  });

  it("refuses a non-postgres or database-less URL without echoing it", () => {
    for (const bad of ["mysql://u:pw@h/db", "postgres://u:pw@h", "not a url"]) {
      try { pgArgs(bad); throw new Error("accepted"); } catch (e) {
        expect(e).toBeInstanceOf(RecoveryToolError);
        expect((e as Error).message).not.toContain("pw@");
      }
    }
  });

  it("scrubs connection strings and passwords from tool output", () => {
    const out = scrub('connection to postgres://u:hunter2@h:5432/db failed\npassword authentication failed for user "u"');
    expect(out).not.toContain("hunter2");
    expect(out).toContain("postgres://[redacted]");
  });

  it("reports a missing tool as unavailable and a failing tool with a scrubbed tail", async () => {
    const missing: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "" });
    await expect(mustRun(missing, "pg_dump", "/x/pg_dump", [])).rejects.toMatchObject({ code: "tool_unavailable" });
    const failing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "could not connect to postgres://u:pw@h/db" });
    const error = await mustRun(failing, "pg_dump", "pg_dump", []).catch((e: Error) => e);
    expect(error).toMatchObject({ code: "tool_failed" });
    expect((error as Error).message).not.toContain("pw@");
  });

  it("only accepts absolute tool overrides", () => {
    expect(() => toolsFromEnv({ ZENITH_PG_DUMP_BIN: "pg_dump" })).toThrow(/absolute/);
    expect(toolsFromEnv({}).pgRestore).toBe("pg_restore");
  });
});

describe("RPO / RTO measurement", () => {
  const times = { backupSnapshotAt: "2026-10-07T10:00:00.000Z", backupFinishedAt: "2026-10-07T10:00:09.000Z", restoreStartedAt: "2026-10-07T12:00:00.000Z", restoreFinishedAt: "2026-10-07T12:07:30.000Z" };

  it("measures the loss window and recovery time from recorded instants", () => {
    const m = measureRecovery({ ...times, incidentAt: "2026-10-07T11:30:00.000Z" });
    expect(m).toMatchObject({ rpoSeconds: 5400, rtoSeconds: 2250, restoreDurationSeconds: 450, backupAgeAtRestoreStartSeconds: 7200, verdict: "no_targets" });
  });

  it("without a loss time it gives the honest upper bound and says so", () => {
    const m = measureRecovery(times);
    expect(m.rpoSeconds).toBeNull();
    expect(m.rtoSeconds).toBeNull();
    expect(m.backupAgeAtRestoreStartSeconds).toBe(7200);
    expect(m.caveats.join(" ")).toMatch(/upper bound/);
  });

  it("compares against provisional targets only when they are configured", () => {
    expect(targetsFromEnv({})).toEqual({ rpoSeconds: null, rtoSeconds: null, status: "unset" });
    const targets = targetsFromEnv({ ZENITH_RPO_TARGET_SECONDS: "3600", ZENITH_RTO_TARGET_SECONDS: "900" });
    expect(targets.status).toBe("provisional");
    expect(measureRecovery({ ...times, incidentAt: "2026-10-07T11:30:00.000Z", targets }).verdict).toBe("exceeds_targets");
    expect(measureRecovery({ ...times, incidentAt: "2026-10-07T10:20:00.000Z", restoreStartedAt: "2026-10-07T10:21:00.000Z", restoreFinishedAt: "2026-10-07T10:25:00.000Z", targets }).verdict).toBe("within_targets");
  });

  it("delivers to the file and to a registered sink, and a failing sink does not hide the report", async () => {
    const received: unknown[] = [];
    const off = [
      registerRecoveryMeasurementSink({ name: "ops01-hook", record: async (r) => { received.push(r); } }),
      registerRecoveryMeasurementSink({ name: "broken-hook", record: async () => { throw new Error("down"); } }),
    ];
    try {
      const file = path.join(dir, "nested", "report.json");
      const result = await deliverReport({ ok: true }, file);
      expect(result.delivered).toContain("ops01-hook");
      expect(result.failed).toEqual(["broken-hook"]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ok: true });
      expect(received).toEqual([{ ok: true }]);
    } finally { for (const f of off) f(); }
    await mkdir(dir, { recursive: true });
  });
});
