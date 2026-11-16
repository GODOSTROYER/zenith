/** Platform-ledger integration, including the original manually installed schema. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertPlatformSchemaCurrent, migratePlatformDb, migrationChecksum,
  openPlatformDb, platformSchemaStatus, PLATFORM_MIGRATIONS, PLATFORM_SCHEMA_VERSION,
  type PlatformDbHandle,
} from "@/lib/controlplane/db";
import { renderSupabaseMigration } from "@/lib/controlplane/db/migrations/emit";
import { migration0006GithubSources } from "@/lib/controlplane/db/migrations/0006_github_sources";
import { GITHUB_SOURCE_SCHEMA_SQL, installGithubSourceSchema } from "@/lib/sources/github/schema";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { binding } from "./fixtures";
import { captureGithubWebhookFence } from "@/lib/sources/github/webhook-store";

// Independent snapshot of the installer shipped before migration 6. Do not derive
// this upgrade fixture from current feature code or the migration under test.
const LEGACY_SCHEMA_SQL = `
create table if not exists platform.github_source_bindings (
  workspace_id text primary key,
  app_id text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  owner text not null,
  repo text not null,
  version integer not null check (version > 0),
  bound_by text not null,
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists platform.github_install_intents (
  workspace_id text not null,
  state_digest text not null check (state_digest ~ '^[a-f0-9]{64}$'),
  actor_id text not null,
  browser_digest text not null check (browser_digest ~ '^[a-f0-9]{64}$'),
  owner text not null,
  repo text not null,
  expected_version integer not null check (expected_version >= 0),
  installation_id bigint,
  phase text not null check (phase in ('install', 'oauth')),
  expires_at timestamptz not null,
  primary key (workspace_id, state_digest)
);
`;
const PREVIOUS = PLATFORM_MIGRATIONS.filter((migration) => migration.version < 6);
const ALL = PLATFORM_MIGRATIONS.map(migration => migration.version);
const PENDING = ALL.filter(version => version >= 6);
const CHECKSUM = "0e256ace8f784b996b2e6687dc42bb4705f91c4579b4ecb1da38987d9f68d78d";

async function fresh(run: (db: PlatformDbHandle) => Promise<void>): Promise<void> {
  const db = await openPlatformDb({ kind: "pglite", migrate: false });
  try { await run(db); } finally { await db.close(); }
}

// Seed the exact legacy column contract without calling newer feature code.
async function seedLegacyBinding(db: PlatformDbHandle): Promise<void> {
  await db.query(`insert into platform.github_source_bindings
    (workspace_id, app_id, installation_id, repository_id, owner, repo, version, bound_by)
    values ($1,$2,$3,$4,$5,$6,$7,'human')`, [binding.workspaceId,binding.appId,binding.installationId,binding.repositoryId,binding.owner,binding.repo,binding.version]);
}
async function seedLegacyIntent(db: PlatformDbHandle) {
  const state = "a".repeat(43), browserProof = "b".repeat(43);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  await db.query(`insert into platform.github_install_intents
    (workspace_id,state_digest,actor_id,browser_digest,owner,repo,expected_version,installation_id,phase,expires_at)
    values ($1,$2,'human',$3,$4,$5,1,7,'oauth',clock_timestamp()+interval '10 minutes')`, [binding.workspaceId,hash(state),hash(browserProof),binding.owner,binding.repo]);
  return { workspaceId: binding.workspaceId, actorId: "human", state, browserProof };
}
const legacyBindings = (db: PlatformDbHandle) => db.query("select workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by,updated_at from platform.github_source_bindings order by workspace_id");
const legacyIntents = (db: PlatformDbHandle) => db.query("select workspace_id,state_digest,actor_id,browser_digest,owner,repo,expected_version,installation_id,phase,expires_at from platform.github_install_intents order by workspace_id,state_digest");

async function assertSourceColumns(db: PlatformDbHandle): Promise<void> {
  const columns = await db.query<{ table_name: string; column_name: string }>(
    "select table_name, column_name from information_schema.columns where table_schema = 'platform' and table_name in ('github_source_bindings', 'github_install_intents') order by table_name, ordinal_position"
  );
  expect(columns.filter((column) => column.table_name === "github_source_bindings").map((column) => column.column_name)).toEqual([
    "workspace_id", "app_id", "installation_id", "repository_id", "owner", "repo", "version", "bound_by", "updated_at", "revoked_at", "revoked_by", "revoked_reason",
  ]);
  expect(columns.filter((column) => column.table_name === "github_install_intents").map((column) => column.column_name)).toEqual([
    "workspace_id", "state_digest", "actor_id", "browser_digest", "owner", "repo", "expected_version", "installation_id", "phase", "expires_at", "app_id", "installation_generation",
  ]);
}

describe("GitHub source platform migration 6 [PGlite]", () => {
  it("pins the append-only version and checksum, with compatibility SQL owned by the migration", () => {
    expect(PLATFORM_SCHEMA_VERSION).toBe(PLATFORM_MIGRATIONS.at(-1)!.version);
    expect(PLATFORM_MIGRATIONS.find((migration) => migration.version === 6)).toBe(migration0006GithubSources);
    expect(ALL).toEqual(Array.from({ length: ALL.length }, (_, index) => index + 1));
    expect(migration0006GithubSources).toMatchObject({ version: 6, name: "github_sources" });
    expect(migrationChecksum(migration0006GithubSources)).toBe(CHECKSUM);
    expect(GITHUB_SOURCE_SCHEMA_SQL).toBe(migration0006GithubSources.sql);
    expect(GITHUB_SOURCE_SCHEMA_SQL).toBe(LEGACY_SCHEMA_SQL);
  });

  it("normal fresh migration provides both source tables and usable workspace bindings", async () => {
    await fresh(async (db) => {
      expect((await migratePlatformDb(db)).applied).toEqual(ALL);
      await assertSourceColumns(db);
      const store = createGithubSourceStore(db);
      const fence = await captureGithubWebhookFence(db, binding.appId, binding.installationId);
      await store.bind({ ...binding, actorId: "human", expectedVersion: 0, installationGeneration: fence.generation });
      expect(await store.getBinding("ws-a")).toEqual(binding);
      expect(await store.getBinding("ws-b")).toBeUndefined();
      const input = { workspaceId: "ws-a", actorId: "human", ...await store.begin("ws-a", "human", binding) };
      await store.authorize(input, 7, binding.appId);
      expect(await store.consume(input)).toMatchObject({ installationId: 7, expectedVersion: 1 });
      await expect(store.consume(input)).rejects.toThrow("refused");
      expect(await migratePlatformDb(db)).toEqual({ applied: [], alreadyApplied: ALL });
      await assertPlatformSchemaCurrent(db);
    });
  }, 60_000);

  it.each(["platform migrator", "emitted SQL"])("adopts manually installed tables without losing rows via %s", async (mode) => {
    await fresh(async (db) => {
      await migratePlatformDb(db, PREVIOUS);
      await db.exec(LEGACY_SCHEMA_SQL);
      await seedLegacyBinding(db);
      const input = await seedLegacyIntent(db);
      const before = await legacyBindings(db);
      const intents = await legacyIntents(db);
      const oldLedger = await db.query("select * from platform.schema_migrations order by version");
      expect((await platformSchemaStatus(db)).pending.map((migration) => migration.version)).toEqual(PENDING);
      await expect(assertPlatformSchemaCurrent(db)).rejects.toMatchObject({ code: "schema_behind" });
      if (mode === "platform migrator") {
        expect(await migratePlatformDb(db)).toEqual({ applied: PENDING, alreadyApplied: [1, 2, 3, 4, 5] });
      } else {
        await db.exec(renderSupabaseMigration());
        await db.exec(renderSupabaseMigration());
      }
      await installGithubSourceSchema(db); // older explicit helper remains safe after adoption
      await assertSourceColumns(db);
      expect(await legacyBindings(db)).toEqual(before);
      expect(await db.query("select revoked_at,revoked_by from platform.github_source_bindings where workspace_id=$1", ["ws-a"])).toEqual([{revoked_at:null,revoked_by:null}]);
      expect(await db.query("select * from platform.github_binding_events")).toEqual([]);
      expect(await legacyIntents(db)).toEqual(intents);
      expect(await db.query("select app_id,installation_generation from platform.github_install_intents")).toEqual([{app_id:null,installation_generation:null}]);
      expect(await db.query("select * from platform.schema_migrations where version < 6 order by version")).toEqual(oldLedger);
      expect(await db.query("select version, name, checksum from platform.schema_migrations where version = 6")).toEqual([
        { version: 6, name: "github_sources", checksum: CHECKSUM },
      ]);
      const store = createGithubSourceStore(db);
      expect(await store.getBinding("ws-a")).toEqual(binding);
      expect(await store.getBinding("ws-b")).toBeUndefined();
      await expect(store.consume(input)).rejects.toThrow("refused");
      await assertPlatformSchemaCurrent(db);
      expect((await migratePlatformDb(db)).applied).toEqual([]);
      if (mode === "emitted SQL") {
        expect(await db.query("select tablename from pg_tables where schemaname = 'platform' and tablename like 'github_%' and not rowsecurity")).toEqual([]);
      }
    });
  }, 60_000);

  it("the legacy operator command upgrades a behind ledger and preserves manual bindings", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zenith-github-migration-"));
    let db: PlatformDbHandle | undefined;
    try {
      const dataDir = path.join(dataRoot, "platform-pg");
      db = await openPlatformDb({ kind: "pglite", dataDir, migrate: false });
      await migratePlatformDb(db, PREVIOUS);
      await db.exec(LEGACY_SCHEMA_SQL);
      await seedLegacyBinding(db);
      await db.close(); db = undefined;
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/lib/sources/github/migrate.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, ZENITH_PLATFORM_DB: "pglite", ZENITH_DATA: dataRoot, ZENITH_PLATFORM_DB_URL: "", SUPABASE_DB_URL: "" },
        timeout: 30_000,
      });
      expect(result.stdout).toContain("Platform migrations applied, including GitHub source schema.");
      expect(result.stderr).toBe("");
      db = await openPlatformDb({ kind: "pglite", dataDir, migrate: false });
      await assertPlatformSchemaCurrent(db);
      expect(await createGithubSourceStore(db).getBinding("ws-a")).toEqual(binding);
      expect((await migratePlatformDb(db)).applied).toEqual([]);
    } finally {
      await db?.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps intent uniqueness within each workspace and enforces proof, phase and version constraints", async () => {
    await fresh(async (db) => {
      await migratePlatformDb(db);
      const insert = (workspace: string, state = "a".repeat(64), browser = "b".repeat(64), phase = "install", version = 0) => db.query(
        `insert into platform.github_install_intents (workspace_id, state_digest, actor_id, browser_digest, owner, repo, expected_version, phase, expires_at)
         values ($1, $2, 'human', $3, 'acme', 'app', $4, $5, clock_timestamp() + interval '10 minutes')`,
        [workspace, state, browser, version, phase]
      );
      await insert("ws-a"); await insert("ws-b");
      await expect(insert("ws-a")).rejects.toMatchObject({ sqlstate: "23505" });
      await expect(insert("ws-c", "invalid")).rejects.toMatchObject({ sqlstate: "23514" });
      await expect(insert("ws-c", "c".repeat(64), "invalid")).rejects.toMatchObject({ sqlstate: "23514" });
      await expect(insert("ws-c", "c".repeat(64), "d".repeat(64), "skip-oauth")).rejects.toMatchObject({ sqlstate: "23514" });
      await expect(insert("ws-c", "c".repeat(64), "d".repeat(64), "install", -1)).rejects.toMatchObject({ sqlstate: "23514" });
      for (const column of ["installation_id", "repository_id", "version"]) {
        const values = { installation_id: 7, repository_id: 99, version: 1, [column]: 0 };
        await expect(db.query(`insert into platform.github_source_bindings (workspace_id, app_id, installation_id, repository_id, owner, repo, version, bound_by)
          values ('ws-c', '42', $1, $2, 'acme', 'app', $3, 'human')`, [values.installation_id, values.repository_id, values.version])).rejects.toMatchObject({ sqlstate: "23514" });
      }
    });
  }, 60_000);
});
