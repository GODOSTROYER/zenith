import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { migratePlatformDb } from "@/lib/controlplane/db/migrator";
import { migrationChecksum } from "@/lib/controlplane/db/migrations";
import { migration0054AgentUpdateControls as migration } from "@/lib/controlplane/db/migrations/0054_agent_update_controls";
import { assessPlatformMigration, contractViolations } from "@/lib/controlplane/db/compat";
import { getUpdateControl, putUpdateControl } from "@/lib/controlplane/db/repos/agent-updates";
import { compareInventory, discoverSensitiveColumns, TABLES } from "@/lib/sensitivedata/inventory";

let db: PlatformDbHandle;
const hold = { expectedRevision: 0, hold: true, manifestSha256: null };
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("truncate platform.agent_update_controls, platform.runners, platform.machines cascade");
  await db.query("insert into platform.runners (id, workspace_id, name, public_key) values ($1,$2,$3,$4)", ["run_update", "ws_update", "runner", randomBytes(32).toString("base64url")]);
  await db.query("insert into platform.machines (id, workspace_id, name, transport, target_id) values ($1,$2,$3,$4,$5)", ["run_update", "ws_update", "machine", "zenithd", "fixture"]);
});

describe("agent update repository on canonical migration 54 (PGlite)", () => {
  it("discovers and classifies digit-bearing sensitive column names", () => {
    const discovered = discoverSensitiveColumns(migration.sql, ["platform"]);
    expect(discovered).toEqual([{ table: "platform.agent_update_controls", columns: ["manifest_sha256"] }]);
    expect(compareInventory(discovered, { "platform.agent_update_controls": TABLES["platform.agent_update_controls"] })).toEqual([]);
  });
  it("registers expand-only SQL with its real checksum and reapplies idempotently", async () => {
    // The existing classifier deliberately labels an opaque DO role-grant block
    // as data. Its body only grants/revokes on this newly created table, so N-1
    // remains unaffected; the actual compatibility gate must still accept it.
    expect(assessPlatformMigration(migration, 43)).toMatchObject({ class: "data", findings: ["data: runs a procedure or anonymous block whose effect is opaque"] });
    expect(contractViolations([migration], { baseline: 43 })).toEqual([]);
    expect(await db.query("select version, name, checksum from platform.schema_migrations where version = 54")).toEqual([{ version: 54, name: migration.name, checksum: migrationChecksum(migration) }]);
    await putUpdateControl(db, "ws_update", "runner", "run_update", "actor", hold);
    await db.exec(migration.sql);
    expect((await migratePlatformDb(db)).applied).toEqual([]);
    expect(await getUpdateControl(db, "ws_update", "runner", "run_update")).toMatchObject({ revision: 1, hold: true, requestedBy: "actor" });
  });

  it("isolates kinds and tenants and rejects revoked agents transactionally", async () => {
    await putUpdateControl(db, "ws_update", "runner", "run_update", "actor", hold);
    expect((await getUpdateControl(db, "ws_update", "machine", "run_update")).revision).toBe(0);
    expect((await getUpdateControl(db, "foreign", "runner", "run_update")).revision).toBe(0);
    await expect(putUpdateControl(db, "foreign", "runner", "run_update", "actor", hold)).rejects.toMatchObject({ code: "not_found" });
    await db.query("update platform.runners set status = 'revoked' where workspace_id = $1 and id = $2", ["ws_update", "run_update"]);
    await expect(putUpdateControl(db, "ws_update", "runner", "run_update", "actor", { ...hold, expectedRevision: 1 })).rejects.toMatchObject({ code: "invalid_state" });
    expect((await getUpdateControl(db, "ws_update", "runner", "run_update")).revision).toBe(1);
    expect((await putUpdateControl(db, "ws_update", "machine", "run_update", "actor", hold)).revision).toBe(1);
  });

  it("lets exactly one concurrent first writer commit and refuses stale successors", async () => {
    const results = await Promise.allSettled([putUpdateControl(db, "ws_update", "runner", "run_update", "first", hold), putUpdateControl(db, "ws_update", "runner", "run_update", "second", hold)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("conflict");
    const digest = randomBytes(32).toString("hex");
    expect((await putUpdateControl(db, "ws_update", "runner", "run_update", "actor", { expectedRevision: 1, hold: false, manifestSha256: digest })).revision).toBe(2);
    await expect(putUpdateControl(db, "ws_update", "runner", "run_update", "actor", { expectedRevision: 1, hold: true, manifestSha256: null })).rejects.toMatchObject({ code: "conflict" });
    expect(await getUpdateControl(db, "ws_update", "runner", "run_update")).toMatchObject({ revision: 2, hold: false, manifestSha256: digest });
  });

  it("enforces table constraints even when a writer bypasses repository validation", async () => {
    for (const values of [
      ["invalid-kind", 1, false, null], ["runner", 0, false, null],
      ["runner", 1, false, "invalid-digest"], ["runner", 1, true, randomBytes(32).toString("hex")],
    ]) {
      await expect(db.query("insert into platform.agent_update_controls (workspace_id, agent_id, requested_by, kind, revision, hold, manifest_sha256) values ('ws_update','run_update','actor',$1,$2,$3,$4)", values)).rejects.toMatchObject({ sqlstate: "23514" });
    }
    expect((await getUpdateControl(db, "ws_update", "runner", "run_update")).revision).toBe(0);
  });

  it("enables RLS, denies browser roles and grants only the service role data access", async () => {
    // Disposable in-memory database only; roles do not exist in the base PGlite fixture.
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
    await db.exec(migration.sql);
    expect(await db.query("select relrowsecurity from pg_class where oid = 'platform.agent_update_controls'::regclass")).toEqual([{ relrowsecurity: true }]);
    for (const role of ["anon", "authenticated"]) {
      expect(await db.query("select has_table_privilege($1, 'platform.agent_update_controls', 'select') as read, has_table_privilege($1, 'platform.agent_update_controls', 'insert') as write", [role])).toEqual([{ read: false, write: false }]);
    }
    for (const privilege of ["select", "insert", "update", "delete"]) {
      expect(await db.query("select has_table_privilege('service_role', 'platform.agent_update_controls', $1) as allowed", [privilege])).toEqual([{ allowed: true }]);
    }
  });
});
