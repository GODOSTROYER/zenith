/** Script orchestration/target models; genuine CLI linkage refusal. Native migration/ACL verification remains root-owned. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";
import { describe, expect, it, vi } from "vitest";
import type { Sql } from "@/lib/hosted/authority/pg/client";
import { AGENT_CONTROL_MIGRATIONS } from "@/lib/agent-access/control/journal-pg";
import { assertAgentLaneUrl, applyAgentSchemaMain } from "../../scripts/agent/apply-schema";

const ROOT = process.cwd();
const laneUrl = "postgresql://postgres:private-ci-canary@127.0.0.1:5432/zenith_platform_ci";
// Only the fixed SQLite import warning is suppressed in these disposable children.
// Every other warning still uses Node's original emitter and remains observable.
const sqliteWarning = "SQLite is an experimental feature and might change at any time";
const warningFilterSource = `const original = process.emitWarning;
process.emitWarning = function (warning, type, ...rest) {
  if (warning === ${JSON.stringify(sqliteWarning)} && type === "ExperimentalWarning") return;
  return original.call(this, warning, type, ...rest);
};`;
const warningFilterImport = `data:text/javascript,${encodeURIComponent(warningFilterSource)}`;
const migrations = () => AGENT_CONTROL_MIGRATIONS.map(migration => ({ ...migration,
  text: readFileSync(resolve(ROOT, "supabase/migrations", migration.file), "utf8") }));
const role = (name: string) => ({ name, rolsuper: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false,
  rolcanlogin: false, rolreplication: false, rolbypassrls: name === "service_role", rolconnlimit: -1, valid_until: null, configuration: null });
function model(initial: Record<string, unknown>[] = [role("anon"), role("authenticated"), role("service_role")]) {
  let roles = initial;
  const events: string[] = [], delivered: string[] = [];
  const stdout = vi.fn(), stderr = vi.fn();
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray): Promise<Record<string, unknown>[]> => {
    const query = parts.join("?");
    if (query.includes("current_user")) return [{ username: "postgres", database: "zenith_platform_ci" }];
    // Membership reads contain role subqueries; match their outer query first.
    if (query.includes("from pg_auth_members")) return [];
    if (query.includes("from pg_roles where rolname")) return roles;
    if (query.includes("from agent.schema_migrations")) return AGENT_CONTROL_MIGRATIONS.map(({ version, name }) => ({ version, name }));
    if (query.includes("pg_advisory_xact_lock")) return [];
    throw new Error("Unrecognized modeled initializer query.");
  }), {
    begin: vi.fn(async (body: (tx: unknown) => Promise<unknown>): Promise<unknown> => { events.push("begin"); const result = await body(sql); events.push("commit"); return result; }),
    unsafe: vi.fn(async (statement: string) => {
      if (statement.startsWith("create role ")) { const name = statement.split(" ")[2]; roles = [...roles, role(name)]; events.push(`role:${name}`); }
      else { delivered.push(statement); events.push("ddl"); }
      return [];
    }),
    end: vi.fn(async () => { events.push("close"); }),
  });
  // Explicit SQL protocol model for a script-local seam; no private native/default factory registration.
  const client = sql as unknown as Sql;
  const open = vi.fn(() => { events.push("open"); return client; });
  const read = vi.fn(async (entry: (typeof AGENT_CONTROL_MIGRATIONS)[number]) => {
    events.push(`read:${entry.version}`); return migrations().find(value => value.file === entry.file)!.text;
  });
  const verify = vi.fn(async (value: Sql) => { expect(value).toBe(client); events.push("verify"); });
  return { sql, client, open, read, verify, events, delivered, output: { stdout: { write: stdout }, stderr: { write: stderr } }, stdout, stderr };
}

describe("canonical disposable agent CI initializer [script protocol models]", () => {
  it.each(["127.0.0.1", "localhost", "[::1]"])("admits one explicit loopback target %s", host => {
    expect(() => assertAgentLaneUrl(`postgresql://postgres:private-ci-canary@${host}:5432/zenith_platform_ci`)).not.toThrow();
  });
  it.each(["missing", "hosted", "host list", "host query", "encoded socket", "user override", "database override", "startup override", "alternate user", "missing user", "missing database", "encoded database", "missing port", "missing password", "fragment"])("refuses %s before any opener or role/migration IO", async fault => {
    const urls: Record<string, string | undefined> = {
      missing: undefined, hosted: laneUrl.replace("127.0.0.1", "db.example.supabase.co"),
      "host list": laneUrl.replace("127.0.0.1", "127.0.0.1,db.example.com"),
      "host query": `${laneUrl}?host=db.example.com`, "encoded socket": laneUrl.replace("127.0.0.1", "%2Ftmp"),
      "user override": `${laneUrl}?user=foreign`, "database override": `${laneUrl}?database=foreign`,
      "startup override": `${laneUrl}?options=-c%20user%3Dforeign`, "alternate user": laneUrl.replace("postgres:", "foreign:"),
      "missing user": laneUrl.replace("postgres:private-ci-canary@", ""), "missing database": laneUrl.replace("/zenith_platform_ci", "/"),
      "encoded database": laneUrl.replace("zenith_platform_ci", "zenith%2Fforeign"), "missing port": laneUrl.replace(":5432", ""),
      "missing password": laneUrl.replace(":private-ci-canary", ""), fragment: `${laneUrl}#private-ci-canary`,
    };
    const f = model();
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: urls[fault] }, f, f.output)).toBe(1);
    expect(f.open).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.sql.unsafe).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled(); expect(f.stdout).not.toHaveBeenCalled();
    expect(f.stderr).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("::error::The disposable agent lane could not be initialized;"));
    expect(f.stderr.mock.calls.flat().join(" ")).not.toContain("private-ci-canary");
  });
  it("the executable refuses a hosted target through actual locked module linkage without URI diagnostics", () => {
    const run = spawnSync(process.execPath, ["--import", warningFilterImport, "--import", "tsx", "scripts/agent/apply-schema.ts"], { cwd: ROOT,
      env: { ...process.env, ZENITH_TEST_PLATFORM_PG_URL: laneUrl.replace("127.0.0.1", "db.example.supabase.co") },
      encoding: "utf8", timeout: 10_000 });
    expect(run.error).toBeUndefined(); expect(run.signal).toBeNull(); expect(run.status).toBe(1); expect(run.stdout).toBe("");
    expect(run.stderr).toBe("::error::The disposable agent lane could not be initialized; check its explicit loopback target, role boundary, canonical migrations and verifier.\n");
    expect(run.stderr).not.toContain("private-ci-canary");
  });
  it.each(["different ExperimentalWarning text", "SQLite text with ordinary Warning type"])("the child filter preserves %s beside the exact executable refusal", fault => {
    const message = fault === "different ExperimentalWarning text" ? "Distinct initializer warning control" : sqliteWarning;
    const type = fault === "different ExperimentalWarning text" ? "ExperimentalWarning" : "Warning";
    const emitImport = `data:text/javascript,${encodeURIComponent(`${warningFilterSource}\nprocess.emitWarning(${JSON.stringify(message)}, ${JSON.stringify(type)});`)}`;
    const run = spawnSync(process.execPath, ["--import", emitImport, "--import", "tsx", "scripts/agent/apply-schema.ts"], { cwd: ROOT,
      env: { ...process.env, ZENITH_TEST_PLATFORM_PG_URL: laneUrl.replace("127.0.0.1", "db.example.supabase.co") },
      encoding: "utf8", timeout: 10_000 });
    expect(run.error).toBeUndefined(); expect(run.signal).toBeNull(); expect(run.status).toBe(1); expect(run.stdout).toBe("");
    // The only variable output is Node's child PID. All warning and refusal text remains exact.
    const warningBlock = new RegExp(`\\(node:\\d+\\) ${type}: ${message}\\n\\(Use \u0060node --trace-warnings \\.\\.\\.\u0060 to show where the warning was created\\)\\n`, "g");
    expect(run.stderr.match(warningBlock)).toHaveLength(1);
    expect(run.stderr.replace(warningBlock, "")).toBe("::error::The disposable agent lane could not be initialized; check its explicit loopback target, role boundary, canonical migrations and verifier.\n");
    expect(run.stderr).not.toContain("private-ci-canary");
  });
  it("delivers every unchanged canonical registry file before the real-verifier slot and exact ledger admission", async () => {
    const f = model();
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(0);
    expect(f.delivered).toEqual(migrations().map(value => value.text));
    expect(f.read.mock.calls.map(([entry]) => [entry.version, entry.name, entry.file])).toEqual(AGENT_CONTROL_MIGRATIONS.map(({ version, name, file }) => [version, name, file]));
    expect(f.events.indexOf("open")).toBeGreaterThan(f.events.indexOf("read:3"));
    expect(f.events.slice(-3)).toEqual(["ddl", "verify", "close"]);
    // Roles plus 0006/0007 use driver transactions; unchanged 0015 owns BEGIN/COMMIT itself.
    expect(f.sql.begin).toHaveBeenCalledTimes(3); expect(f.verify).toHaveBeenCalledExactlyOnceWith(f.client);
    expect(f.sql.unsafe.mock.calls.some(([text]) => text.startsWith("create role "))).toBe(false);
    expect(f.stdout).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("roles are local stand-ins")); expect(f.stderr).not.toHaveBeenCalled();
  });
  it("creates only absent fixed stand-in roles and never alters compatible existing roles", async () => {
    const f = model([role("authenticated")]);
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(0);
    expect(f.events.filter(value => value.startsWith("role:"))).toEqual(["role:anon", "role:service_role"]);
    expect(f.sql.unsafe.mock.calls.filter(([text]) => text.startsWith("create role ")).map(([text]) => text)).toEqual([
      "create role anon nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit -1",
      "create role service_role nologin noinherit nosuperuser nocreatedb nocreaterole noreplication bypassrls connection limit -1",
    ]);
    expect(f.sql.unsafe.mock.calls.some(([text]) => /alter role|drop role/i.test(text))).toBe(false);
  });
  it.each(["superuser", "inherit", "create role", "create database", "login", "replication", "client bypass", "service no bypass", "connection limit", "expiry", "configuration"])("incompatible existing role %s refuses before any creation or canonical DDL", async fault => {
    const mutations: Record<string, object> = { superuser: { rolsuper: true }, inherit: { rolinherit: true }, "create role": { rolcreaterole: true },
      "create database": { rolcreatedb: true }, login: { rolcanlogin: true }, replication: { rolreplication: true }, "client bypass": { rolbypassrls: true },
      "service no bypass": { rolbypassrls: false }, "connection limit": { rolconnlimit: 8 }, expiry: { valid_until: "2027-01-01" }, configuration: { configuration: ["private-setting-canary"] } };
    const name = fault === "service no bypass" ? "service_role" : "anon", f = model([{ ...role(name), ...mutations[fault] }]);
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(1);
    expect(f.sql.unsafe).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled(); expect(f.sql.end).toHaveBeenCalledOnce();
    expect(f.stdout).not.toHaveBeenCalled(); expect(f.stderr.mock.calls.flat().join(" ")).not.toContain("private-setting-canary");
  });
  it("existing role membership refuses before creating absent roles", async () => {
    const f = model([role("anon")]), original = f.sql.getMockImplementation()!;
    f.sql.mockImplementation(async parts => parts.join("?").includes("from pg_auth_members") ? [{ present: true }] : original(parts));
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(1);
    expect(f.sql.unsafe).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  });
  it.each(["user", "database"])("native readback of a foreign %s refuses before role writes", async fault => {
    const f = model([]), original = f.sql.getMockImplementation()!;
    f.sql.mockImplementation(async parts => parts.join("?").includes("current_user")
      ? [{ username: fault === "user" ? "foreign" : "postgres", database: fault === "database" ? "foreign" : "zenith_platform_ci" }] : original(parts));
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(1);
    expect(f.sql.unsafe).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  });
  it("a missing canonical file refuses before opening or writing roles", async () => {
    const f = model(); f.read.mockRejectedValue(new Error("private-file-canary"));
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(1);
    expect(f.open).not.toHaveBeenCalled(); expect(f.stdout).not.toHaveBeenCalled(); expect(f.stderr.mock.calls.flat().join(" ")).not.toContain("private-file-canary");
  });
  it("canonical migration failure rolls back its native transaction and excludes verification and positive output", async () => {
    const f = model(), original = f.sql.unsafe.getMockImplementation()!, oauth = migrations()[2].text;
    f.sql.unsafe.mockImplementation(async text => { if (text === oauth) throw new Error("private-sql-canary"); return original(text); });
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(1);
    expect(f.sql.unsafe).toHaveBeenLastCalledWith("rollback"); expect(f.verify).not.toHaveBeenCalled(); expect(f.sql.end).toHaveBeenCalledOnce();
    expect(f.stdout).not.toHaveBeenCalled(); expect(f.stderr.mock.calls.flat().join(" ")).not.toContain("private-sql-canary");
  });
  it("canonical verifier refusal keeps the lane failed and closes the owned client", async () => {
    const f = model(); f.verify.mockRejectedValue(new Error("private-verifier-canary"));
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(1);
    expect(f.sql.end).toHaveBeenCalledOnce(); expect(f.stdout).not.toHaveBeenCalled(); expect(f.stderr.mock.calls.flat().join(" ")).not.toContain("private-verifier-canary");
  });
  it("a forged or extra ledger identity refuses after verification instead of promoting modeled success", async () => {
    for (const ledger of [[{ version: 3, name: "foreign" }], [...AGENT_CONTROL_MIGRATIONS.map(({ version, name }) => ({ version, name })), { version: 4, name: "foreign" }]]) {
      const f = model(), original = f.sql.getMockImplementation()!;
      f.sql.mockImplementation(async parts => parts.join("?").includes("from agent.schema_migrations") ? ledger : original(parts));
      expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(1);
      expect(f.verify).toHaveBeenCalledOnce(); expect(f.stdout).not.toHaveBeenCalled();
    }
  });
  it("owned client close failure cannot return positive initialization", async () => {
    const f = model(); f.sql.end.mockRejectedValue(new Error("private-close-canary"));
    expect(await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: laneUrl }, f, f.output)).toBe(1);
    expect(f.stdout).not.toHaveBeenCalled(); expect(f.stderr.mock.calls.flat().join(" ")).not.toContain("private-close-canary");
  });
  it("the real canonical verifier and unchanged registry are the executable defaults, with no .env or argv target", () => {
    const source = readFileSync(resolve(ROOT, "scripts/agent/apply-schema.ts"), "utf8");
    expect(source).toContain('verify: verifyAgentSchema'); expect(source).toContain('open: createPgAuthorityClient');
    expect(source).toContain('AGENT_CONTROL_MIGRATIONS.map'); expect(source).toContain('supabase/migrations/${migration.file}');
    expect(source).not.toContain('dotenv'); expect(source).not.toContain('process.argv[2]');
  });
  it("the mandatory platform job initializes canonical agent authority before its unchanged run and always validation", () => {
    const workflow = load(readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { if?: unknown; steps: { run?: string; if?: string; "continue-on-error"?: unknown }[] }> };
    const job = workflow.jobs["platform-postgres"]; expect(job).toBeDefined(); expect(job.if).toBeUndefined();
    const initializer = job.steps.filter(step => step.run === "node node_modules/tsx/dist/cli.mjs scripts/agent/apply-schema.ts");
    expect(initializer).toHaveLength(1); expect(initializer[0].if).toBeUndefined(); expect(initializer[0]["continue-on-error"]).toBeUndefined();
    expect(job.steps.indexOf(initializer[0])).toBeLessThan(job.steps.findIndex(step => step.run === "node scripts/ci/run-gate.mjs platform-postgres --run"));
    expect(job.steps.some(step => step.run === "bash scripts/ci/apply-platform-migrations.sh")).toBe(true);
    expect(job.steps.some(step => step.run === "bash scripts/ci/apply-supabase-migrations.sh")).toBe(false);
    expect(job.steps.find(step => step.run === "node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/platform-lane.json --require-execution")?.if).toBe("always()");
  });
});
