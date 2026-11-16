/**
 * `scripts/ci/apply-platform-migrations.sh` runs the platform migrator against
 * the lane database. What is worth pinning is the part that can do damage: it
 * must refuse to run against anything but a loopback database, must say what is
 * missing rather than proceed, and must never print the connection URL (it
 * carries a password). The success path needs the real migrator and a real
 * database, which is the `platform-postgres` job's own business.
 *
 * Skipped on Windows, where `bash` is ambiguous between Git Bash and WSL; the
 * script runs only on the Linux CI runner.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/ci/apply-platform-migrations.sh");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-apply-platform-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Run from an empty directory, so scripts/platform/migrate.ts is never found. */
function run(url: string | undefined): { status: number | null; out: string } {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.ZENITH_TEST_PLATFORM_PG_URL;
  if (url !== undefined) env.ZENITH_TEST_PLATFORM_PG_URL = url;
  const child = spawnSync("bash", [SCRIPT], { cwd: scratch, env, encoding: "utf8" });
  return { status: child.status, out: `${child.stdout}\n${child.stderr}` };
}

describe.skipIf(process.platform === "win32")("apply-platform-migrations.sh", () => {
  it("fails when no lane database URL is set", () => {
    const { status, out } = run(undefined);
    expect(status).toBe(1);
    expect(out).toContain("ZENITH_TEST_PLATFORM_PG_URL is not set");
  });

  it.each([
    ["a hosted Supabase host", "postgresql://postgres:s3cret-pw@db.abcdefgh.supabase.co:5432/postgres"],
    ["a pooler host", "postgresql://postgres.abc:s3cret-pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres"],
    ["a private address that is not loopback", "postgresql://postgres:s3cret-pw@10.0.0.5:5432/zenith"],
    ["a lookalike of localhost", "postgresql://postgres:s3cret-pw@localhost.evil.example:5432/zenith"],
    ["a host hidden in the credential section", "postgresql://127.0.0.1:x@db.example.com:5432/zenith"],
    ["an IPv6 address that is not loopback", "postgresql://postgres:s3cret-pw@[2001:db8::1]:5432/zenith"],
  ])("refuses %s, and never prints the password", (_label, url) => {
    const { status, out } = run(url);
    expect(status).toBe(1);
    expect(out).toContain("Refusing to migrate");
    expect(out).not.toContain("s3cret-pw");
  });

  it.each([
    ["a second host after the loopback one", "postgresql://postgres:s3cret-pw@127.0.0.1:5432,db.example.com:5432/zenith"],
    ["a host override in the query string", "postgresql://postgres:s3cret-pw@127.0.0.1:5432/zenith?host=db.example.com"],
    ["any query string", "postgresql://postgres:s3cret-pw@127.0.0.1:5432/zenith?sslmode=disable"],
  ])("refuses %s, which libpq would honour over the loopback address", (_label, url) => {
    const { status, out } = run(url);
    expect(status).toBe(1);
    expect(out).toContain("Refusing to migrate");
    expect(out).not.toContain("s3cret-pw");
  });

  it.each([
    ["127.0.0.1", "postgresql://postgres:s3cret-pw@127.0.0.1:5432/zenith"],
    ["localhost", "postgresql://postgres:s3cret-pw@localhost:5432/zenith"],
    ["localhost without a port", "postgresql://postgres:s3cret-pw@localhost/zenith"],
    ["IPv6 loopback", "postgresql://postgres:s3cret-pw@[::1]:5432/zenith"],
  ])("accepts %s as a target, then stops at the missing migrator without printing the password", (_label, url) => {
    const { status, out } = run(url);
    expect(status).toBe(1);
    expect(out).not.toContain("Refusing to migrate");
    expect(out).toContain("scripts/platform/migrate.ts does not exist");
    expect(out).not.toContain("s3cret-pw");
  });
});
