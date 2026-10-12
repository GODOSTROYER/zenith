import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  openPlatformDb: vi.fn(),
  assertMaintenancePreconditions: vi.fn(),
}));
vi.mock("@/lib/controlplane/db", () => ({ openPlatformDb: diagnosticMocks.openPlatformDb, repos: {} }));
vi.mock("../../scripts/acceptance/maintenance/preconditions", () => ({
  localUrl: vi.fn(), CORE_JOBS: [],
  assertMaintenancePreconditions: diagnosticMocks.assertMaintenancePreconditions,
  seededEpoch: vi.fn(),
}));

import { defaultMaintenanceAcceptance } from "../../scripts/acceptance/maintenance/default";
import { isDirectInvocation, maintenanceDiagnosticCode, runMaintenanceCli, writeMaintenanceDiagnostic } from "../../scripts/acceptance/maintenance/run";

const roots: string[] = [];
function ownedEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), "zenith-j4-diagnostic-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const stack = path.join(root, "stack");
  mkdirSync(stack, { mode: 0o700 });
  return {
    NODE_ENV: "test",
    ZENITH_LOCAL_TARGETS: "1",
    ZENITH_LOCAL_JOINED_DRIVERS: "1",
    ZENITH_ACCEPTANCE_DEFAULT_STACK: "1",
    ZENITH_TEST_MAINTENANCE: "1",
    ZENITH_LOCAL_ROOT: root,
    ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR: stack,
    ZENITH_LOCAL_STACK_DIRECTORY: stack,
    ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE: path.join(root, "maintenance-diagnostic.private.json"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("J4 maintenance CLI failure diagnostics", () => {
  it("recognizes only the canonical maintenance CLI module as the direct entry", () => {
    const moduleUrl = new URL("../../scripts/acceptance/maintenance/run.ts", import.meta.url);
    const actualEntry = fileURLToPath(moduleUrl);
    const otherRoot = mkdtempSync(path.join(os.tmpdir(), "zenith-j4-run-entry-"));
    roots.push(otherRoot);
    const otherRun = path.join(otherRoot, "run.ts");
    writeFileSync(otherRun, "", { mode: 0o600 });
    expect(isDirectInvocation(actualEntry, moduleUrl)).toBe(true);
    expect(isDirectInvocation(otherRun, moduleUrl)).toBe(false);
    expect(isDirectInvocation(undefined, moduleUrl)).toBe(false);
  });

  it("maps known gate and precondition assertions to fixed codes", () => {
    expect(maintenanceDiagnosticCode(new Error("Not run: needs the Mac default stack and ZENITH_TEST_MAINTENANCE=1.")))
      .toBe("maintenance_gate_not_enabled");
    expect(maintenanceDiagnosticCode(new Error("Requires a fresh dedicated maintenance database.")))
      .toBe("maintenance_database_not_fresh");
    expect(maintenanceDiagnosticCode(new Error("Migration-seeded cleanup epoch is missing or invalid; refuse without changing it.")))
      .toBe("cleanup_epoch_invalid");
  });

  it("writes only fixed fields and an allowlisted SQLSTATE in an owned private J4 root", () => {
    const env = ownedEnvironment();
    const error = Object.assign(new Error("private provider error including secret=do-not-write"), { code: "23505" });
    expect(writeMaintenanceDiagnostic(error, env)).toBe(true);
    const file = env.ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE!;
    const receipt = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(receipt).sort()).toEqual(["code", "sqlState", "type"]);
    expect(receipt).toEqual({ code: "postgres_sqlstate", sqlState: "23505", type: "error" });
    expect(readFileSync(file, "utf8")).not.toContain("do-not-write");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses path escape, symlink targets, and non-J4 gate environments", () => {
    const env = ownedEnvironment();
    const root = env.ZENITH_LOCAL_ROOT!;
    const target = env.ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE!;
    env.ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE = `${root}/../escape.json`;
    expect(writeMaintenanceDiagnostic(new Error("known"), env)).toBe(false);

    env.ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE = target;
    const outside = path.join(root, "outside.json");
    symlinkSync(outside, target);
    expect(writeMaintenanceDiagnostic(new Error("known"), env)).toBe(false);
    expect(() => lstatSync(outside)).toThrow();

    rmSync(target);
    env.ZENITH_TEST_MAINTENANCE = "0";
    expect(writeMaintenanceDiagnostic(new Error("known"), env)).toBe(false);
    expect(() => lstatSync(target)).toThrow();
  });

  it("does not follow a symlinked root or overwrite an existing receipt", () => {
    const env = ownedEnvironment();
    const root = env.ZENITH_LOCAL_ROOT!;
    const target = env.ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE!;
    const existing = "retain-existing-diagnostic\n";
    writeFileSync(target, existing, { mode: 0o600, flag: "wx" });
    expect(writeMaintenanceDiagnostic(new Error("known"), env)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(existing);

    const link = `${root}-link`;
    symlinkSync(root, link);
    roots.push(link);
    env.ZENITH_LOCAL_ROOT = link;
    env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR = `${link}/stack`;
    env.ZENITH_LOCAL_STACK_DIRECTORY = `${link}/stack`;
    env.ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE = `${link}/other.json`;
    expect(writeMaintenanceDiagnostic(new Error("known"), env)).toBe(false);
    expect(() => lstatSync(`${root}/other.json`)).toThrow();
  });

  it("keeps the original nonzero failure behavior and does not leak unknown errors", async () => {
    const env = ownedEnvironment();
    const output = { stdout: "", stderr: "" };
    const status = await runMaintenanceCli(
      async () => { throw new Error("postgres://user:secret@localhost/db?password=never-print"); },
      env,
      { stdout: value => { output.stdout += value; }, stderr: value => { output.stderr += value; } },
    );
    expect(status).toBe(1);
    expect(output.stderr).toBe("J4 maintenance acceptance failed; retain the owned local database/namespace for inspection. code=acceptance_failed_unclassified\n");
    expect(output.stderr).not.toContain("secret");
  });

  it("preserves the original precondition cause when cleanup also fails, with only a bounded sanitized cause receipt", async () => {
    const env = ownedEnvironment();
    const secret = "postgres://user:synthetic-password@127.0.0.1/db";
    const primary = Object.assign(new Error(secret), { code: "23505" });
    const closeDb = vi.fn().mockResolvedValue(undefined);
    diagnosticMocks.openPlatformDb.mockReset().mockResolvedValue({ close: closeDb });
    diagnosticMocks.assertMaintenancePreconditions.mockReset().mockRejectedValue(primary);
    vi.stubEnv("ZENITH_TEST_MAINTENANCE", "1");
    vi.stubEnv("ZENITH_PLATFORM_DB_URL", "postgres://user:synthetic-password@127.0.0.1/db");
    vi.stubEnv("ZENITH_J4_API_ORIGIN", "http://127.0.0.1:1");
    const output = { stdout: "", stderr: "" };
    let captured: unknown;
    const status = await runMaintenanceCli(async () => {
      try { return await defaultMaintenanceAcceptance(); }
      catch (error) { captured = error; throw error; }
    }, env, {
      stdout: value => { output.stdout += value; },
      stderr: value => { output.stderr += value; },
    });

    expect(status).toBe(1);
    expect(diagnosticMocks.openPlatformDb).toHaveBeenCalledOnce();
    expect(diagnosticMocks.assertMaintenancePreconditions).toHaveBeenCalledOnce();
    expect(closeDb).toHaveBeenCalledOnce();
    expect(captured).toBeInstanceOf(AggregateError);
    expect((captured as AggregateError).cause).toBe(primary);
    expect((captured as AggregateError).errors).toHaveLength(1);
    expect(output.stderr).toContain("code=cleanup_unconfirmed");

    const receiptText = readFileSync(env.ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE!, "utf8");
    expect(receiptText).not.toContain(secret);
    expect(JSON.parse(receiptText)).toEqual({
      code: "cleanup_unconfirmed",
      type: "aggregate",
      cause: { code: "postgres_sqlstate", type: "error", sqlState: "23505" },
    });
  });

  it("writes no failure receipt for success", async () => {
    const env = ownedEnvironment();
    const output = { stdout: "", stderr: "" };
    const status = await runMaintenanceCli(
      async () => ({ naturalTimers: true }),
      env,
      { stdout: value => { output.stdout += value; }, stderr: value => { output.stderr += value; } },
    );
    expect(status).toBe(0);
    expect(output.stdout).toBe('{"naturalTimers":true}\n');
    expect(output.stderr).toBe("");
    expect(() => lstatSync(env.ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE!)).toThrow();
  });

  it("returns a fixed generic code for arbitrary assertion text and non-error values", () => {
    expect(maintenanceDiagnosticCode({ name: "AssertionError", message: "arbitrary provider response" }))
      .toBe("acceptance_assertion_failed");
    expect(maintenanceDiagnosticCode("not an error object"))
      .toBe("acceptance_failed_unclassified");
  });
});
