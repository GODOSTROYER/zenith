/** Disposable CI agent schema initialization. Canonical DDL and verifier, no .env or URI diagnostics. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPgAuthorityClient, type Sql, type TransactionSql } from "@/lib/hosted/authority/pg/client";
import { AGENT_CONTROL_MIGRATIONS } from "@/lib/agent-access/control/journal-pg";
import { verifyAgentSchema } from "./verify-schema";

export class AgentLaneInitializationError extends Error {
  constructor() { super("The disposable agent lane could not be initialized."); }
}
const refuse = (): never => { throw new AgentLaneInitializationError(); };

/** Every target scalar is explicit. Query/startup overrides, lists and Unix sockets refuse before opening. */
export function assertAgentLaneUrl(raw: unknown): asserts raw is string {
  if (typeof raw !== "string" || !raw || raw.trim() !== raw || raw.length > 4096 || /[\r\n\u0000]/.test(raw)) return refuse();
  try {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !url.port || !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535
      || url.username !== "postgres" || !url.password || !/^\/[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(url.pathname)
      || url.search || url.hash || raw.includes("?") || raw.includes("#")) return refuse();
  } catch { return refuse(); }
}

type RoleName = "anon" | "authenticated" | "service_role";
interface RoleRow {
  name: RoleName; rolsuper: boolean; rolinherit: boolean; rolcreaterole: boolean; rolcreatedb: boolean;
  rolcanlogin: boolean; rolreplication: boolean; rolbypassrls: boolean; rolconnlimit: number;
  valid_until: string | null; configuration: string[] | null;
}
const roleNames: readonly RoleName[] = ["anon", "authenticated", "service_role"];
const roleStatements: Record<RoleName, string> = {
  anon: "create role anon nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit -1",
  authenticated: "create role authenticated nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit -1",
  service_role: "create role service_role nologin noinherit nosuperuser nocreatedb nocreaterole noreplication bypassrls connection limit -1",
};
function compatibleRole(role: RoleRow): boolean {
  return roleNames.includes(role.name) && role.rolsuper === false && role.rolinherit === false
    && role.rolcreaterole === false && role.rolcreatedb === false && role.rolcanlogin === false
    && role.rolreplication === false && role.rolbypassrls === (role.name === "service_role")
    && role.rolconnlimit === -1 && role.valid_until === null && role.configuration === null;
}
async function readRoles(sql: TransactionSql): Promise<RoleRow[]> {
  return sql<RoleRow[]>`select rolname as name, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
    rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil::text as valid_until, rolconfig as configuration
    from pg_roles where rolname in ('anon','authenticated','service_role') order by rolname`;
}
async function assertNoMembership(sql: TransactionSql): Promise<void> {
  const rows = await sql`select 1 from pg_auth_members m where
    m.roleid in (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))
    or m.member in (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))
    or m.grantor in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')) limit 1`;
  if (rows.length) return refuse();
}
async function admitLaneRoles(client: Sql, raw: string): Promise<void> {
  const database = new URL(raw).pathname.slice(1);
  await client.begin(async sql => {
    // Serialize only this fixed lane-role initialization, never a production authority action.
    await sql`select pg_advisory_xact_lock(hashtext('zenith_ci_agent_schema_initializer'))`;
    const identity = await sql`select current_user::text as username, current_database()::text as database`;
    if (identity.length !== 1 || identity[0].username !== "postgres" || identity[0].database !== database) return refuse();
    const before = await readRoles(sql);
    if (new Set(before.map(role => role.name)).size !== before.length || before.some(role => !compatibleRole(role))) return refuse();
    await assertNoMembership(sql);
    // Existing compatible roles stay untouched; only these three absent fixed names may be created.
    for (const name of roleNames) if (!before.some(role => role.name === name)) await sql.unsafe(roleStatements[name]);
    const after = await readRoles(sql);
    if (after.length !== 3 || new Set(after.map(role => role.name)).size !== 3 || after.some(role => !compatibleRole(role))) return refuse();
    await assertNoMembership(sql);
  });
}

type Migration = (typeof AGENT_CONTROL_MIGRATIONS)[number];
type Output = { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } };
/** Script-local orchestration seam for contract models. The executable entrypoint always uses these real defaults. */
interface InitializerPorts {
  open(raw: string): Sql;
  read(migration: Migration): Promise<string>;
  verify(client: Sql): Promise<void>;
}
const canonicalPorts: InitializerPorts = {
  open: createPgAuthorityClient,
  read: migration => readFile(new URL(`../../supabase/migrations/${migration.file}`, import.meta.url), "utf8"),
  verify: verifyAgentSchema,
};

/** Reads only the explicit lane environment variable; fixed errors never expose URI, SQL or database rows. */
export async function applyAgentSchemaMain(
  environment: { ZENITH_TEST_PLATFORM_PG_URL?: string } = { ZENITH_TEST_PLATFORM_PG_URL: process.env.ZENITH_TEST_PLATFORM_PG_URL },
  ports: InitializerPorts = canonicalPorts,
  output: Output = process,
): Promise<number> {
  let client: Sql | undefined, result = 1;
  try {
    const raw = environment.ZENITH_TEST_PLATFORM_PG_URL;
    assertAgentLaneUrl(raw); // A modeled opener cannot bypass CLI target admission.
    const migrations = await Promise.all(AGENT_CONTROL_MIGRATIONS.map(async migration => {
      const text = await ports.read(migration);
      if (!text || Buffer.byteLength(text) > 1_048_576) return refuse();
      // Migration 0015 owns its canonical transaction. Never nest it inside postgres.js begin or strip its bytes.
      const selfTransactional = migration.file === "0015_agent_oauth_grants.sql";
      if (selfTransactional && (!/^begin;$/m.test(text) || !/\ncommit;\s*$/.test(text))) return refuse();
      return { text, selfTransactional };
    }));
    client = ports.open(raw);
    await admitLaneRoles(client, raw);
    for (const migration of migrations) {
      if (migration.selfTransactional) {
        try { await client.unsafe(migration.text); }
        catch { await client.unsafe("rollback").catch(() => undefined); return refuse(); }
      } else await client.begin(async sql => { await sql.unsafe(migration.text); });
    }
    await ports.verify(client);
    const ledger = await client`select version, name from agent.schema_migrations order by version`;
    if (JSON.stringify(ledger.map(row => ({ version: Number(row.version), name: row.name })))
      !== JSON.stringify(AGENT_CONTROL_MIGRATIONS.map(({ version, name }) => ({ version, name })))) return refuse();
    result = 0;
  } catch { /* Fixed diagnostic below; no private exception or driver output. */ }
  finally {
    if (client) try { await client.end({ timeout: 5 }); } catch { result = 1; }
  }
  if (result === 0) output.stdout.write("Disposable CI agent migrations 1/2/3 and canonical schema verification completed; roles are local stand-ins.\n");
  else output.stderr.write("::error::The disposable agent lane could not be initialized; check its explicit loopback target, role boundary, canonical migrations and verifier.\n");
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void applyAgentSchemaMain().then(code => { process.exitCode = code; });
}
