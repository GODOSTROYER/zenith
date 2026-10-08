import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle, repos } from "@/lib/controlplane/db";
import { PLATFORM_MIGRATIONS, migrationChecksum } from "@/lib/controlplane/db/migrations";
import { migratePlatformDb } from "@/lib/controlplane/db/migrator";
import { assessPlatformMigration, contractViolations, assertPendingMigrationsCompatible } from "@/lib/controlplane/db/compat";
import { migration0058KubernetesSourceProvider as migration } from "@/lib/controlplane/db/migrations/0058_kubernetes_source_provider";
import { immutableSourceSnapshot, sourceSnapshotDigest } from "@/lib/execution/source-snapshot";

const source = (provider: "aws" | "gcp" | "azure" | "zenith" | "kubernetes", operationId: string) => immutableSourceSnapshot({
  format: "zenith.approved-source.v1", workspaceId: "ws-j6-schema", operationId, projectId: "project-j6", environmentId: "env-j6",
  serviceAddress: "container_service/web", pipelineAddress: "build_pipeline/web", serviceSpecDigest: "1".repeat(64), pipelineSpecDigest: "2".repeat(64),
  provider, region: "local", owner: "example", repo: "web", repositoryId: 1, requestedRef: "main", commitSha: "a".repeat(40), githubBinding: null,
  dockerfile: "Dockerfile", dockerfileDigest: "b".repeat(64), recipeDigest: "c".repeat(64), archiveFormat: provider === "aws" ? "zip" : "tar.gz",
  archiveDigest: "d".repeat(64), archiveBytes: 100,
});
const constraint = async (db: PlatformDbHandle) => (await db.query<{ definition: string }>("select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='platform.approved_source_snapshots'::regclass and contype='c' and pg_get_constraintdef(oid) like '%tar.gz%'"))[0].definition;
const pg = process.env.ZENITH_TEST_PLATFORM_PG_URL;
if (process.env.ZENITH_TEST_J6_SOURCE_PG === "1" && !pg) throw new Error("J6 source custody verification requires ZENITH_TEST_PLATFORM_PG_URL.");
describe.each([
  { kind: "pglite" as const, enabled: true },
  { kind: "postgres" as const, enabled: process.env.ZENITH_TEST_J6_SOURCE_PG === "1" },
])("J6 schema custody [$kind]", ({ kind, enabled }) => {
  describe.skipIf(!enabled)("native source provider join", () => {
    let db: PlatformDbHandle;
    let before: string;
    beforeAll(async () => {
      db = await openPlatformDb(kind === "pglite" ? { kind, migrate: false } : { kind, url: pg!, max: 1 });
      if (kind === "pglite") await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter(m => m.version < migration.version));
      before = await constraint(db);
      // Exact migration under test. PG is an owned verifier database with explicit migration admission.
      if (kind === "pglite") await db.exec(migration.sql);
    }, 60_000);
    afterAll(async () => { await db?.close(); });
    it("widens only the provider list and remains idempotent", async () => {
      const after = await constraint(db);
      expect(after).toContain("'kubernetes'::text");
      if (kind === "pglite") expect(after.replace(", 'kubernetes'::text", "")).toBe(before);
      await db.exec(migration.sql);
      expect(await constraint(db)).toBe(after);
    });
    it.each(["aws", "gcp", "azure", "zenith", "kubernetes"] as const)("retains %s records while enforcing immutable rows", async provider => {
      const operation = await repos.operations.create(db, { workspaceId: "ws-j6-schema", principal: { kind: "user", id: "j6-reviewer", name: "J6" },
        proposal: { summary: "J6 source custody", details: ["Disposable schema contract"], risk: "low", capability: "deployment.deploy", scope: { workspaceId: "ws-j6-schema", projectId: "project-j6", environmentId: "env-j6" }, input: {} } });
      const snapshot = source(provider, operation.operation.id);
      await db.query("insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values($1,$2,$3,$4,$5,$6::text::jsonb,$7)",
        [snapshot.workspaceId, snapshot.operationId, snapshot.projectId, snapshot.environmentId, snapshot.serviceAddress, JSON.stringify(snapshot), sourceSnapshotDigest(snapshot)]);
      await expect(db.query("update platform.approved_source_snapshots set snapshot_digest=$3 where workspace_id=$1 and operation_id=$2",
        [snapshot.workspaceId, snapshot.operationId, "e".repeat(64)])).rejects.toThrow(/immutable/);
      await expect(db.query("delete from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [snapshot.workspaceId, snapshot.operationId])).rejects.toThrow(/immutable/);
      const rows = await db.query<{ snapshot: unknown }>("select snapshot from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [snapshot.workspaceId, snapshot.operationId]);
      expect(rows).toEqual([{ snapshot }]);
    });
    it("preserves malformed snapshot and archive-format refusal", async () => {
      const operation = await repos.operations.create(db, { workspaceId: "ws-j6-schema", principal: { kind: "user", id: "j6-reviewer", name: "J6" },
        proposal: { summary: "J6 source custody", details: ["Disposable schema contract"], risk: "low", capability: "deployment.deploy", scope: { workspaceId: "ws-j6-schema", projectId: "project-j6", environmentId: "env-j6" }, input: {} } });
      const snapshot = source("kubernetes", operation.operation.id);
      await expect(db.query("insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values($1,$2,$3,$4,$5,$6::text::jsonb,$7)",
        [snapshot.workspaceId, snapshot.operationId, snapshot.projectId, snapshot.environmentId, snapshot.serviceAddress, JSON.stringify({ ...snapshot, archiveFormat: "zip" }), sourceSnapshotDigest(snapshot)])).rejects.toThrow();
      expect((await db.query("select snapshot from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [snapshot.workspaceId, snapshot.operationId]))).toHaveLength(0);
    });
  });
});
describe("J6 migration compatibility admission", () => {
  it("registers the exact widening but still requires explicit operator admission", () => {
    expect(assessPlatformMigration(migration, 52).class).toBe("contract");
    expect(contractViolations([migration], { baseline: 52 })).toEqual([]);
    expect(() => assertPendingMigrationsCompatible([migration], { baseline: 52, allowed: new Set() })).toThrow();
    expect(() => assertPendingMigrationsCompatible([migration], { baseline: 52, allowed: new Set([migration.version]) })).not.toThrow();
    expect(contractViolations([{ ...migration, sql: migration.sql + "\n" }], { baseline: 52 })).toMatchObject([{ reason: "sql_changed_since_approval" }]);
    expect(migrationChecksum(migration)).toBe("afef954e9417c33a3a0dadc254253ab523c9dbc425af27da5120927e8064df9a");
  });
});
