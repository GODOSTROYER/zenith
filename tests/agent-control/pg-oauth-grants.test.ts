/** Owning PostgreSQL journal persistence; OAuth identity inputs model the already-verified protocol only. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgAgentJournal, AGENT_CONTROL_MIGRATIONS, OAUTH_GRANT_CONSTRAINTS, type AnySql } from "@/lib/agent-access/control/journal-pg";
import { ControlError, type Grant } from "@/lib/agent-access/control/journal";
import { bindGrant, type VerifiedOAuth } from "@/lib/agent-access/control/oauth";
import { createPgAuthorityClient, closePgAuthorityClient, type Sql } from "@/lib/hosted/authority/pg/client";
import { verifyAgentSchema, verifyAgentSchemaMain, AgentGrantSchemaError } from "../../scripts/agent/verify-schema";

const enabled = process.env.ZENITH_CONTRACT_POSTGRES === "1" && Boolean(process.env.SUPABASE_DB_URL?.trim());
if (process.env.ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED === "1" && !enabled)
  throw new Error("Native OAuth grant acceptance requires ZENITH_CONTRACT_POSTGRES=1 and an explicitly owned SUPABASE_DB_URL.");
const migration = readFileSync(new URL("../../supabase/migrations/0015_agent_oauth_grants.sql", import.meta.url), "utf8");
const prefix = `oauth_${randomUUID().replaceAll("-", "")}`;
const id = (kind: string) => `${prefix}_${kind}_${randomUUID().replaceAll("-", "")}`;
let alpha: Sql, beta: Sql, a: PgAgentJournal, b: PgAgentJournal;
const live = () => new Date(Date.now() + 3_600_000).toISOString();
function grant(over: Partial<Grant> = {}): Grant {
  return { integrationId: `integration_${randomUUID()}`, subject: id("member"), clientId: id("client"),
    workspaceId: id("workspace"), projectIds: [id("project")], environmentIds: [id("environment")], appIds: [],
    scopes: ["read", "plan", "write"], oauthIssuer: "https://issuer.example.test", expiresAt: live(), revoked: false, ...over };
}
// bindGrant's token input is an explicit protocol model; no signature/provider key or browser consent is fabricated.
const identity = (g: Grant, over: Partial<VerifiedOAuth> = {}): VerifiedOAuth => ({ subject: g.subject, clientId: g.clientId,
  scopes: ["read", "plan", "write", "logs"], issuer: g.oauthIssuer!, expiresAt: live(), ...over });
const retained = (g: Grant) => b.getGrant(g.subject, g.clientId, g.workspaceId);
const rowCount = async (g: Grant) => Number((await alpha`select count(*)::integer as n from agent.agent_oauth_grants
  where subject = ${g.subject} and client_id = ${g.clientId} and workspace_id = ${g.workspaceId}`)[0].n);
async function asRole<T>(sql: Sql, role: "service_role" | "anon" | "authenticated", body: (tx: AnySql) => Promise<T>): Promise<T> {
  return await sql.begin(async tx => {
    if (role === "service_role") await tx`set local role service_role`;
    else if (role === "anon") await tx`set local role anon`;
    else await tx`set local role authenticated`;
    return body(tx);
  }) as T;
}
/** Owned schema-fault fixture only; never alter the configured shared agent schema or server roles. */
async function scratch<T>(withOAuth: boolean, body: (client: Sql, url: string) => Promise<T>): Promise<T> {
  const name = `zo_${randomUUID().replaceAll("-", "")}`, target = new URL(process.env.SUPABASE_DB_URL!);
  target.pathname = `/${name}`;
  let client: Sql | undefined, created = false;
  try {
    await alpha.unsafe(`create database "${name}"`); created = true;
    client = createPgAuthorityClient(target.toString());
    for (const entry of AGENT_CONTROL_MIGRATIONS.filter(entry => withOAuth || entry.scope === "journal"))
      await client.unsafe(readFileSync(new URL(`../../supabase/migrations/${entry.file}`, import.meta.url), "utf8"));
    return await body(client, target.toString());
  } finally {
    await client?.end({ timeout: 5 });
    if (created) await alpha.unsafe(`drop database "${name}"`);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  alpha = createPgAuthorityClient(process.env.SUPABASE_DB_URL!);
  beta = createPgAuthorityClient(process.env.SUPABASE_DB_URL!);
  const [first, second] = await Promise.all([alpha`select pg_backend_pid() as pid, version() as version`, beta`select pg_backend_pid() as pid`]);
  expect(String(first[0].version)).toMatch(/^PostgreSQL /); expect(first[0].pid).not.toBe(second[0].pid);
  await verifyAgentSchema(alpha); a = new PgAgentJournal({ client: alpha }); b = new PgAgentJournal({ client: beta });
});
afterAll(async () => {
  if (!alpha) return;
  try { await alpha`delete from agent.agent_oauth_grants where subject like ${`${prefix}%`}`; }
  finally { await Promise.all([alpha.end({ timeout: 5 }), beta?.end({ timeout: 5 }), closePgAuthorityClient()]); }
});

describe.skipIf(!enabled)("OAuth resource grant journal [postgres]", () => {
  it("verifies the canonical agent migration registry and native OAuth table boundary", async () => {
    await verifyAgentSchema(beta);
    const rows = await beta`select version, name from agent.schema_migrations order by version`;
    expect(rows.map(row => ({ version: Number(row.version), name: row.name })))
      .toEqual(AGENT_CONTROL_MIGRATIONS.map(({ version, name }) => ({ version, name })));
  });
  it("persists only the owning non-secret Grant tuple across independent clients", async () => {
    const g = grant(); await a.setGrant(g); expect(await retained(g)).toEqual(g);
    const columns = await beta`select column_name from information_schema.columns
      where table_schema='agent' and table_name='agent_oauth_grants' order by ordinal_position`;
    expect(columns.map(row => row.column_name)).not.toContain("document");
    expect(await rowCount(g)).toBe(1);
  });
  it("the default PostgreSQL journal reads the same retained native grant", async () => {
    const g = grant(); await a.setGrant(g);
    expect(await new PgAgentJournal().getGrant(g.subject, g.clientId, g.workspaceId)).toEqual(g);
  });
  it("subject client and workspace lookups never cross their exact stored tuple", async () => {
    const own = grant(), foreign = grant({ clientId: own.clientId }); await a.setGrant(own); await b.setGrant(foreign);
    expect(await b.getGrant(own.subject, own.clientId, foreign.workspaceId)).toBeUndefined();
    expect(await b.getGrant(foreign.subject, own.clientId, own.workspaceId)).toBeUndefined();
    expect(await b.getGrant(own.subject, foreign.clientId + "other", own.workspaceId)).toBeUndefined();
    expect(await b.grants(own.subject, own.workspaceId)).toEqual([own]);
    expect(await b.grants(own.subject, foreign.workspaceId)).toEqual([]);
  });
  it("the same human and client can retain distinct grants in two workspaces", async () => {
    const first = grant(), second = grant({ subject: first.subject, clientId: first.clientId });
    await a.setGrant(first); await b.setGrant(second);
    expect(await retained(first)).toEqual(first); expect(await retained(second)).toEqual(second);
  });
  it("the same client can retain distinct grants for two humans in one workspace", async () => {
    const first = grant(), second = grant({ workspaceId: first.workspaceId, clientId: first.clientId });
    await a.setGrant(first); await b.setGrant(second);
    expect(await b.grants(first.subject, first.workspaceId)).toEqual([first]);
    expect(await b.grants(second.subject, first.workspaceId)).toEqual([second]);
  });
  it("retains revoked and expired records for browser withdrawal and renewal", async () => {
    const g = grant({ revoked: true, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await a.setGrant(g); expect(await retained(g)).toEqual(g); expect(await b.grants(g.subject, g.workspaceId)).toEqual([g]);
    expect(() => bindGrant(identity(g), g)).toThrow(ControlError);
  });
  it("fresh persisted scope attenuates the already-verified OAuth identity", async () => {
    const g = grant({ scopes: ["read", "logs"], appIds: [id("app")] }); await a.setGrant(g);
    const bound = bindGrant(identity(g, { scopes: ["read", "plan"] }), (await retained(g))!);
    expect(bound.scopes).toEqual(["read"]); expect(bound.projectIds).toEqual(g.projectIds);
    expect(bound.environmentIds).toEqual(g.environmentIds); expect(bound.appIds).toEqual(g.appIds);
    expect(Date.parse(bound.expiresAt)).toBeLessThanOrEqual(Date.parse(g.expiresAt));
  });
  it.each(["issuer", "subject", "client", "expiry"] as const)("persisted grant cannot authorize a mismatched OAuth %s", async field => {
    const g = grant(); await a.setGrant(g);
    const changed = identity(g, field === "issuer" ? { issuer: "https://other.example.test" }
      : field === "subject" ? { subject: id("other") } : field === "client" ? { clientId: id("other") }
        : { expiresAt: new Date(Date.now() - 1000).toISOString() });
    // Token expiry is already verified upstream; here the expiry control is the persisted resource grant.
    if (field === "expiry") await a.setGrant({ ...g, expiresAt: changed.expiresAt });
    expect(() => bindGrant(changed, undefined)).toThrow(ControlError);
    const current = await retained(g); expect(() => bindGrant(changed, current)).toThrow(ControlError);
  });
  it("revocation committed by another client refuses the next OAuth binding", async () => {
    const g = grant(); await a.setGrant(g); expect(bindGrant(identity(g), (await retained(g))!).subject).toBe(g.subject);
    await b.setGrant({ ...g, revoked: true });
    const revoked = await retained(g); expect(() => bindGrant(identity(g), revoked)).toThrow(ControlError);
    expect((await a.getGrant(g.subject, g.clientId, g.workspaceId))?.revoked).toBe(true);
  });
  it("renewal and scope replacement preserve the original integration identity", async () => {
    const g = grant({ revoked: true }); await a.setGrant(g);
    const next = { ...g, revoked: false, scopes: ["read"], projectIds: [id("new_project")], environmentIds: [], expiresAt: live() };
    await b.setGrant(next); expect(await retained(g)).toEqual(next);
  });
  it("a competing integration identity cannot replace the retained scoped binding", async () => {
    const g = grant(); await a.setGrant(g);
    await expect(b.setGrant({ ...g, integrationId: `integration_${randomUUID()}` })).rejects.toMatchObject({ code: "grant_conflict", status: 409 });
    expect(await retained(g)).toEqual(g); expect(await rowCount(g)).toBe(1);
  });
  it("an integration identity cannot move to a foreign native tuple", async () => {
    const g = grant(); await a.setGrant(g);
    const foreign = grant({ integrationId: g.integrationId });
    await expect(b.setGrant(foreign)).rejects.toMatchObject({ code: "grant_conflict", status: 409 });
    expect(await retained(g)).toEqual(g); expect(await retained(foreign)).toBeUndefined();
  });
  it("racing first consent retains exactly one immutable native binding", async () => {
    const first = grant(), second = { ...first, integrationId: `integration_${randomUUID()}` };
    const results = await Promise.allSettled([a.setGrant(first), b.setGrant(second)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter(result => result.status === "rejected"); expect(failures).toHaveLength(1);
    expect(failures[0].status === "rejected" && failures[0].reason).toMatchObject({ code: "grant_conflict" });
    expect([first, second]).toContainEqual(await retained(first)); expect(await rowCount(first)).toBe(1);
  });
  it("racing same-identity replacements commit complete scopes without mixing fields", async () => {
    const g = grant(); await a.setGrant(g);
    const first = { ...g, projectIds: [id("first")], environmentIds: [], scopes: ["read"], revoked: true };
    const second = { ...g, projectIds: [id("second")], environmentIds: [id("second_env")], scopes: ["read", "plan"], revoked: false };
    await Promise.all([a.setGrant(first), b.setGrant(second)]);
    expect([first, second]).toContainEqual(await retained(g)); expect(await rowCount(g)).toBe(1);
  });
  it.each(["integration_id", "subject", "client_id", "workspace_id"] as const)("native SQL cannot replace immutable %s", async field => {
    const g = grant(); await a.setGrant(g);
    await expect(asRole(alpha, "service_role", async tx => {
      await tx.unsafe(`update agent.agent_oauth_grants set ${field}=$1 where integration_id=$2`, [id("replacement"), g.integrationId]);
    })).rejects.toMatchObject({ code: "23514" });
    expect(await retained(g)).toEqual(g);
  });
  it("service role can insert read and replace a grant without DELETE or TRUNCATE", async () => {
    const g = grant(); await asRole(alpha, "service_role", async tx => {
      await tx`insert into agent.agent_oauth_grants (integration_id,subject,client_id,workspace_id,oauth_issuer,expires_at,project_ids,scopes)
        values (${g.integrationId},${g.subject},${g.clientId},${g.workspaceId},${g.oauthIssuer!},${g.expiresAt},${tx.json(g.projectIds)},${tx.json(g.scopes)})`;
      await tx`update agent.agent_oauth_grants set revoked=true where subject=${g.subject} and client_id=${g.clientId} and workspace_id=${g.workspaceId}`;
      expect((await tx`select integration_id from agent.agent_oauth_grants where subject=${g.subject} and workspace_id=${g.workspaceId}`)[0].integration_id).toBe(g.integrationId);
    });
    for (const command of ["delete from agent.agent_oauth_grants where integration_id=$1", "truncate agent.agent_oauth_grants"]) {
      await expect(asRole(alpha, "service_role", async tx => {
        await tx.unsafe(command, command.startsWith("delete") ? [g.integrationId] : []);
      })).rejects.toMatchObject({ code: "42501" });
    }
    expect((await retained(g))?.revoked).toBe(true);
  });
  it.each(["anon", "authenticated"] as const)("%s cannot read or mutate OAuth grants", async role => {
    const g = grant(); await a.setGrant(g);
    await expect(asRole(alpha, role, async tx => { await tx`select integration_id from agent.agent_oauth_grants`; }))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asRole(alpha, role, async tx => { await tx`update agent.agent_oauth_grants set revoked=true where integration_id=${g.integrationId}`; }))
      .rejects.toMatchObject({ code: "42501" });
    expect(await retained(g)).toEqual(g);
  });
  it("RLS still hides grant rows if clients receive accidental SELECT in a disposable transaction", async () => {
    await scratch(true, async sql => {
      const j = new PgAgentJournal({ client: sql }), g = grant(); await j.setGrant(g);
      await sql.begin(async tx => {
        await tx`grant usage on schema agent to anon, authenticated`;
        await tx`grant select on agent.agent_oauth_grants to anon, authenticated`;
        await tx`set local role anon`; expect(await tx`select integration_id from agent.agent_oauth_grants`).toEqual([]);
        await tx`reset role`; await tx`set local role authenticated`; expect(await tx`select integration_id from agent.agent_oauth_grants`).toEqual([]);
      });
    });
  });
  it("missing OAuth migration refuses grants while prior non-OAuth journal work remains valid", async () => {
    await scratch(false, async sql => {
      const j = new PgAgentJournal({ client: sql }), g = grant(); await j.ready();
      await expect(j.getGrant(g.subject, g.clientId, g.workspaceId)).rejects.toMatchObject({ code: "journal_schema", status: 503 });
      const op = await j.prepare({ ...g, scopes: ["read", "plan"] }, { action: "manifest.import", input: {},
        target: { workspaceId: g.workspaceId, projectId: g.projectIds[0] }, fingerprint: "native-state", plan: {}, requestKey: "oauth_compatibility" });
      expect(op.phase).toBe("prepared");
      expect((await sql`select id from agent.agent_operations where workspace_id=${g.workspaceId} and id=${op.id}`)[0].id).toBe(op.id);
    });
  });
  it("wrong migration name refuses grant reads and emits only fixed verifier diagnostics", async () => {
    await scratch(true, async (sql, url) => {
      await sql`update agent.schema_migrations set name='untrusted-ledger-marker' where version=3`;
      const g = grant(), j = new PgAgentJournal({ client: sql });
      await expect(j.getGrant(g.subject, g.clientId, g.workspaceId)).rejects.toMatchObject({ code: "journal_schema" });
      const stdout: string[] = [], stderr: string[] = [];
      expect(await verifyAgentSchemaMain({ SUPABASE_DB_URL: url }, createPgAuthorityClient,
        { stdout: { write: text => stdout.push(text) }, stderr: { write: text => stderr.push(text) } })).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(["::error::The canonical agent OAuth grant schema could not be verified; check lane connectivity, migrations and privileges.\n"]);
    });
  });
  it("safe migration reapplication retains grant identity scope and ledger timestamp", async () => {
    await scratch(true, async sql => {
      const j = new PgAgentJournal({ client: sql }), g = grant(); await j.setGrant(g);
      const ledger = await sql`select version,name,applied_at from agent.schema_migrations order by version`;
      await sql.unsafe(migration); await sql.unsafe(migration);
      expect(await new PgAgentJournal({ client: sql }).getGrant(g.subject, g.clientId, g.workspaceId)).toEqual(g);
      expect(await sql`select version,name,applied_at from agent.schema_migrations order by version`).toEqual(ledger);
      await verifyAgentSchema(sql);
    });
  });
  it("migration refuses an incompatible partial grant table without recording success", async () => {
    await scratch(false, async sql => {
      await sql`create table agent.agent_oauth_grants (token text)`;
      try { await expect(sql.unsafe(migration)).rejects.toMatchObject({ code: "23514" }); }
      finally { await sql`rollback`; }
      expect(await sql`select version from agent.schema_migrations where version=3`).toEqual([]);
      expect((await sql`select column_name from information_schema.columns where table_schema='agent' and table_name='agent_oauth_grants'`)
        .map(row => row.column_name)).toEqual(["token"]);
    });
  });
  it.each(["check", "binding"] as const)("same-named weakened %s constraint cannot certify canonical grant schema", async fault => {
    await scratch(true, async sql => {
      if (fault === "check") {
        await sql`alter table agent.agent_oauth_grants drop constraint agent_oauth_grants_projects`;
        await sql`alter table agent.agent_oauth_grants add constraint agent_oauth_grants_projects check (true)`;
      } else {
        await sql`alter table agent.agent_oauth_grants drop constraint agent_oauth_grants_binding`;
        await sql`alter table agent.agent_oauth_grants add constraint agent_oauth_grants_binding unique (subject, client_id)`;
      }
      await expect(verifyAgentSchema(sql)).rejects.toBeInstanceOf(AgentGrantSchemaError);
      await sql`delete from agent.schema_migrations where version=3`;
      try { await expect(sql.unsafe(migration)).rejects.toMatchObject({ code: "23514" }); }
      finally { await sql`rollback`; }
      expect(await sql`select version from agent.schema_migrations where version=3`).toEqual([]);
      const definition = (await sql`select pg_get_constraintdef(oid,false) as definition from pg_constraint
        where conrelid='agent.agent_oauth_grants'::regclass and conname=${fault === "check" ? "agent_oauth_grants_projects" : "agent_oauth_grants_binding"}`)[0].definition;
      expect(definition).toBe(fault === "check" ? "CHECK (true)" : "UNIQUE (subject, client_id)");
    });
  });
  it("native schema verifier refuses restored DELETE privilege", async () => {
    await scratch(true, async sql => {
      await sql`grant delete on agent.agent_oauth_grants to service_role`;
      await expect(verifyAgentSchema(sql)).rejects.toBeInstanceOf(AgentGrantSchemaError);
    });
  });
  it.each(["accessToken", "refreshToken", "secret"] as const)("rejects unknown %s data before grant persistence", async field => {
    const g = grant(), input = { ...g, [field]: "must-never-persist" };
    await expect(a.setGrant(input)).rejects.toMatchObject({ code: "grant_invalid", status: 400 });
    expect(await rowCount(g)).toBe(0);
  });
  it.each(["projects", "duplicate", "scope", "issuer", "expiry"] as const)("rejects malformed grant %s without storing a row", async field => {
    const g = grant(), invalid = field === "projects" ? { ...g, projectIds: [] }
      : field === "duplicate" ? { ...g, projectIds: [g.projectIds[0], g.projectIds[0]] }
        : field === "scope" ? { ...g, scopes: ["write"] } : field === "issuer" ? { ...g, oauthIssuer: "http://untrusted.example.test" }
          : { ...g, expiresAt: "2099-02-31T00:00:00.000Z" };
    await expect(a.setGrant(invalid)).rejects.toMatchObject({ code: "grant_invalid" }); expect(await rowCount(g)).toBe(0);
  });
  it("concurrent new client grants cannot exceed the existing browser owner quota", async () => {
    const first = grant();
    for (let number = 0; number < 49; number++) await a.setGrant({ ...first,
      integrationId: `integration_${randomUUID()}`, clientId: `client_${number}` });
    const left = { ...first, integrationId: `integration_${randomUUID()}`, clientId: "client_left" };
    const right = { ...first, integrationId: `integration_${randomUUID()}`, clientId: "client_right" };
    const results = await Promise.allSettled([a.setGrant(left), b.setGrant(right)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter(result => result.status === "rejected"); expect(failures).toHaveLength(1);
    expect(failures[0].status === "rejected" && failures[0].reason).toMatchObject({ code: "grant_quota", status: 429 });
    expect(await b.grants(first.subject, first.workspaceId)).toHaveLength(50);
    expect(await rowCount(left) + await rowCount(right)).toBe(1);
  });
  it("full retained quota permits same-identity renewal and revocation without pruning", async () => {
    const first = grant({ revoked: true, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await a.setGrant(first);
    for (let number = 1; number < 50; number++) await a.setGrant({ ...first,
      integrationId: `integration_${randomUUID()}`, clientId: `client_${number}` });
    const extra = { ...first, integrationId: `integration_${randomUUID()}`, clientId: "client_extra" };
    await expect(b.setGrant(extra)).rejects.toMatchObject({ code: "grant_quota" });
    const renewed = { ...first, revoked: false, expiresAt: live(), scopes: ["read"] };
    await b.setGrant(renewed); expect(await retained(first)).toEqual(renewed);
    await a.setGrant({ ...renewed, revoked: true }); expect((await retained(first))?.revoked).toBe(true);
    expect(await b.grants(first.subject, first.workspaceId)).toHaveLength(50); expect(await rowCount(extra)).toBe(0);
  });
  it("owner quota does not consume a different workspace or subject allowance", async () => {
    const first = grant();
    for (let number = 0; number < 50; number++) await a.setGrant({ ...first,
      integrationId: `integration_${randomUUID()}`, clientId: `client_${number}` });
    const workspace = grant({ subject: first.subject }), subject = grant({ workspaceId: first.workspaceId });
    await b.setGrant(workspace); await b.setGrant(subject);
    expect(await retained(workspace)).toEqual(workspace); expect(await retained(subject)).toEqual(subject);
    expect(await b.grants(first.subject, first.workspaceId)).toHaveLength(50);
  });
  it("scoped listing refuses overflow rather than hiding another current grant", async () => {
    // A positively owned administrator fault fixture exceeds the normal creation
    // quota; journal writers above cannot create this state or silently prune it.
    const first = grant();
    for (let number = 0; number <= 100; number++) {
      const g = { ...first, integrationId: `integration_${randomUUID()}`, clientId: `client_${number}` };
      await alpha`insert into agent.agent_oauth_grants
        (integration_id,subject,client_id,workspace_id,oauth_issuer,expires_at,revoked,project_ids,environment_ids,app_ids,scopes)
        values (${g.integrationId},${g.subject},${g.clientId},${g.workspaceId},${g.oauthIssuer!},${g.expiresAt},${g.revoked ?? false},
          ${alpha.json(g.projectIds)},${alpha.json(g.environmentIds!)},${alpha.json(g.appIds!)},${alpha.json(g.scopes)})`;
    }
    await expect(b.grants(first.subject, first.workspaceId)).rejects.toMatchObject({ code: "grant_unavailable", status: 503 });
    expect(Number((await beta`select count(*)::integer as n from agent.agent_oauth_grants
      where subject=${first.subject} and workspace_id=${first.workspaceId}`)[0].n)).toBe(101);
  });
  it("a closed native client yields a fixed grant refusal without database details", async () => {
    const closed = createPgAuthorityClient(process.env.SUPABASE_DB_URL!), j = new PgAgentJournal({ client: closed });
    await j.ready(); await closed.end({ timeout: 5 }); const g = grant();
    await expect(j.getGrant(g.subject, g.clientId, g.workspaceId)).rejects.toMatchObject({ code: "grant_unavailable",
      message: "The OAuth resource grant could not be confirmed.", status: 503 });
  });
  it("browser duration and derived digest metadata never become stored grant authority", async () => {
    const g = grant(), input = { ...g, days: 1, grantDigest: "a".repeat(64) }; await a.setGrant(input);
    expect(await retained(g)).toEqual(g);
  });

  // Faults run only in the positively created scratch database; canonical migration bytes repair schema, not past data.
  it.each(["delete-only", "after-update", "statement", "column-restricted", "conditional", "arguments", "disabled", "additional"] as const)(
    "canonical verifier refuses identity trigger %s even with the original function", async fault => {
      await scratch(true, async sql => {
        if (fault === "disabled") await sql`alter table agent.agent_oauth_grants disable trigger agent_oauth_grants_identity`;
        else if (fault === "additional") await sql`create trigger extra_identity_guard before update on agent.agent_oauth_grants
          for each row execute function agent.guard_oauth_grant_identity()`;
        else {
          await sql`drop trigger agent_oauth_grants_identity on agent.agent_oauth_grants`;
          if (fault === "delete-only") await sql`create trigger agent_oauth_grants_identity before delete on agent.agent_oauth_grants
            for each row execute function agent.guard_oauth_grant_identity()`;
          else if (fault === "after-update") await sql`create trigger agent_oauth_grants_identity after update on agent.agent_oauth_grants
            for each row execute function agent.guard_oauth_grant_identity()`;
          else if (fault === "statement") await sql`create trigger agent_oauth_grants_identity before update on agent.agent_oauth_grants
            for each statement execute function agent.guard_oauth_grant_identity()`;
          else if (fault === "column-restricted") await sql`create trigger agent_oauth_grants_identity before update of revoked on agent.agent_oauth_grants
            for each row execute function agent.guard_oauth_grant_identity()`;
          else if (fault === "conditional") await sql`create trigger agent_oauth_grants_identity before update on agent.agent_oauth_grants
            for each row when (false) execute function agent.guard_oauth_grant_identity()`;
          else await sql`create trigger agent_oauth_grants_identity before update on agent.agent_oauth_grants
            for each row execute function agent.guard_oauth_grant_identity('unexpected')`;
        }
        const rows = await sql`select tgname, tgfoid=to_regprocedure('agent.guard_oauth_grant_identity()') as original_function
          from pg_trigger where tgrelid='agent.agent_oauth_grants'::regclass and not tgisinternal`;
        expect(rows.some(row => row.tgname === 'agent_oauth_grants_identity' && row.original_function === true)).toBe(true);
        await expect(verifyAgentSchema(sql)).rejects.toBeInstanceOf(AgentGrantSchemaError);
        if (fault === "delete-only") {
          // Demonstrate the originally reported false certification: service_role can change identity through UPDATE.
          const g = grant(), replacement = id("replacement"); await new PgAgentJournal({ client: sql }).setGrant(g);
          await asRole(sql, "service_role", tx => tx`update agent.agent_oauth_grants set integration_id=${replacement}
            where subject=${g.subject} and client_id=${g.clientId} and workspace_id=${g.workspaceId}`);
          expect((await sql`select integration_id from agent.agent_oauth_grants
            where subject=${g.subject} and client_id=${g.clientId} and workspace_id=${g.workspaceId}`)[0].integration_id).toBe(replacement);
        }
        if (fault === "additional") await sql`drop trigger extra_identity_guard on agent.agent_oauth_grants`;
        await sql.unsafe(migration); await verifyAgentSchema(sql);
      });
    });

  async function functionFault(name: "identity" | "ids", fault: "body" | "security" | "path" | "volatility" | "strictness" | "parallel" | "client") {
    await scratch(true, async sql => {
      // Both signatures are fixed fixture literals, never supplied by an operation, client or command argument.
      const signature = name === "identity" ? "agent.guard_oauth_grant_identity()" : "agent.oauth_grant_ids_valid(jsonb, integer, integer)";
      if (fault === "body") {
        if (name === "identity") await sql`create or replace function agent.guard_oauth_grant_identity()
          returns trigger language plpgsql set search_path=pg_catalog as $$begin return new; end;$$`;
        else await sql`create or replace function agent.oauth_grant_ids_valid(value jsonb, minimum integer, maximum integer)
          returns boolean language sql immutable strict set search_path=pg_catalog as $$select true$$`;
      } else if (fault === "security") await sql.unsafe(`alter function ${signature} security definer`);
      else if (fault === "path") await sql.unsafe(`alter function ${signature} set search_path=public,pg_catalog`);
      else if (fault === "volatility") await sql.unsafe(`alter function ${signature} ${name === "identity" ? "stable" : "volatile"}`);
      else if (fault === "strictness") await sql.unsafe(`alter function ${signature} ${name === "identity" ? "strict" : "called on null input"}`);
      else if (fault === "parallel") await sql.unsafe(`alter function ${signature} parallel safe`);
      else await sql.unsafe(`grant execute on function ${signature} to anon`);
      if (fault === "body" && name === "ids") {
        expect((await sql`select agent.oauth_grant_ids_valid('[]'::jsonb,1,100) as accepted`)[0].accepted).toBe(true);
      }
      await expect(verifyAgentSchema(sql)).rejects.toBeInstanceOf(AgentGrantSchemaError);
      await sql.unsafe(migration); await verifyAgentSchema(sql);
      if (fault === "body" && name === "ids") {
        expect((await sql`select agent.oauth_grant_ids_valid('[]'::jsonb,1,100) as accepted`)[0].accepted).toBe(false);
      }
    });
  }
  it.each(["identity", "ids"] as const)("canonical verifier refuses changed %s function body", name => functionFault(name, "body"));
  it.each(["identity", "ids"] as const)("canonical verifier refuses %s function security definer", name => functionFault(name, "security"));
  it.each(["identity", "ids"] as const)("canonical verifier refuses changed %s function search path", name => functionFault(name, "path"));
  it.each(["identity", "ids"] as const)("canonical verifier refuses changed %s function volatility", name => functionFault(name, "volatility"));
  it.each(["identity", "ids"] as const)("canonical verifier refuses changed %s function strictness", name => functionFault(name, "strictness"));
  it.each(["identity", "ids"] as const)("canonical verifier refuses changed %s function parallel contract", name => functionFault(name, "parallel"));
  it.each(["identity", "ids"] as const)("canonical verifier refuses %s function client execution privilege", name => functionFault(name, "client"));

  // Revision 3 catalog controls use only the existing positively owned scratch database.
  it("cold native catalog preserves canonical CHECK and primary unique inheritance flags", async () => {
    await scratch(true, async sql => {
      await verifyAgentSchema(sql);
      const catalog = await sql`select conname as name, contype::text as type, conkey::text as columns,
        pg_get_constraintdef(oid,false) as definition, connoinherit as no_inherit
        from pg_constraint where conrelid='agent.agent_oauth_grants'::regclass order by conname`;
      expect(catalog.map(row => ({ name: row.name, type: row.type, columns: row.columns,
        definition: row.definition, noInherit: row.no_inherit })))
        .toEqual(OAUTH_GRANT_CONSTRAINTS.map(constraint => ({ ...constraint,
          noInherit: constraint.type === "p" || constraint.type === "u" })));
      expect(catalog.find(row => row.name === "agent_oauth_grants_issuer")?.definition)
        .toBe("CHECK ((((length(oauth_issuer) >= 1) AND (length(oauth_issuer) <= 2048)) AND (oauth_issuer ~* '^https://'::text)))");
      await sql.unsafe(migration);
      await verifyAgentSchema(sql);
    });
  });
  it("canonical verifier and migration refuse a same-named NO INHERIT CHECK constraint", async () => {
    await scratch(true, async sql => {
      await sql`alter table agent.agent_oauth_grants drop constraint agent_oauth_grants_projects`;
      await sql`alter table agent.agent_oauth_grants add constraint agent_oauth_grants_projects
        check (agent.oauth_grant_ids_valid(project_ids,1,100)) no inherit`;
      const changed = await sql`select connoinherit as no_inherit, pg_get_constraintdef(oid,false) as definition
        from pg_constraint where conrelid='agent.agent_oauth_grants'::regclass and conname='agent_oauth_grants_projects'`;
      expect(changed).toHaveLength(1);
      expect(changed[0].no_inherit).toBe(true);
      expect(changed[0].definition).toBe("CHECK (agent.oauth_grant_ids_valid(project_ids, 1, 100)) NO INHERIT");
      await expect(verifyAgentSchema(sql)).rejects.toBeInstanceOf(AgentGrantSchemaError);
      await sql`delete from agent.schema_migrations where version=3`;
      try { await expect(sql.unsafe(migration)).rejects.toMatchObject({ code: "23514" }); }
      finally { await sql`rollback`; }
      expect(await sql`select version from agent.schema_migrations where version=3`).toEqual([]);
      expect((await sql`select connoinherit as no_inherit from pg_constraint
        where conrelid='agent.agent_oauth_grants'::regclass and conname='agent_oauth_grants_projects'`)[0].no_inherit).toBe(true);
    });
  });
});
