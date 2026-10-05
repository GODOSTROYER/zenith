/** Actual service-role SQL custody. Human approval inputs are fixture models;
 * canonical approval/storage SQL, role ACLs and independent backends are real.
 * No browser authentication, provider execution or current-role admission claim.
 */
import { describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { renderSupabaseMigration } from "@/lib/controlplane/db/migrations/emit";
import * as repos from "@/lib/controlplane/db/repos";
import type { Sql } from "@/lib/controlplane/types";
import { transferRequest } from "@/lib/ownership/registry";
import { PG_URL, approve, newWorkspace, proposalFor, seedAwaitingApproval, uid, user, withScratchDatabase } from "./_support/harness";

const transfer = transferRequest({ address: "container_service/web", resourceType: "aws:ecs_service", path: "replicas", from: "autoscaler", to: "native-op" });

async function withNative<T>(fn: (db: PlatformDbHandle, independent: PlatformDbHandle) => Promise<T>): Promise<T> {
  return withScratchDatabase(async url => {
    const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2 });
    let independent: PlatformDbHandle | undefined;
    try {
      // Canonical agent bootstrap creates this cluster role first. No test
      // changes its attributes, membership or the protected table ACLs.
      expect(await db.query("select rolbypassrls as bypass from pg_roles where rolname='service_role'")).toEqual([{ bypass: true }]);
      await db.exec(renderSupabaseMigration());
      independent = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2 });
      return await fn(db, independent);
    } finally {
      if (independent) await independent.close();
      await db.close();
    }
  });
}

const asService = <T>(db: PlatformDbHandle, fn: (tx: Sql) => Promise<T>): Promise<T> => db.tx(async tx => {
  await tx.query("set local role service_role");
  expect(await tx.query("select current_user as name")).toEqual([{ name: "service_role" }]);
  return fn(tx);
});

async function pending(db: PlatformDbHandle, count = 1) {
  const workspaceId = newWorkspace(), environmentId = uid("env");
  const proposal = { ...proposalFor(workspaceId, { capability: "service.scale", scope: { workspaceId, projectId: uid("project"), environmentId } }), broker: { ownershipTransfers: [transfer] } };
  return seedAwaitingApproval(db, { workspaceId, count, proposal });
}

const rowsFor = (db: PlatformDbHandle, workspaceId: string, operationId: string) => db.query(
  "select * from platform.ownership_transfers where workspace_id=$1 and operation_id=$2 order by id", [workspaceId, operationId]
);

describe.skipIf(!PG_URL)("ownership transfer immutable service-role custody [postgres]", () => {
  it("records and replays an exact human-approved transfer without immutable-column UPDATE privileges", async () => {
    await withNative(async (db, independent) => {
      const acl = await db.query(`select has_table_privilege('service_role','platform.ownership_transfers','SELECT,INSERT') as read_insert,
        has_column_privilege('service_role','platform.ownership_transfers','transfer_digest','UPDATE') as digest_update,
        has_column_privilege('service_role','platform.ownership_transfers','revoked_at','UPDATE') as revoke_update,
        has_table_privilege('service_role','platform.ownership_transfers','DELETE') as delete_rows`);
      expect(acl).toEqual([{ read_insert: true, digest_update: false, revoke_update: true, delete_rows: false }]);
      const seeded = await pending(db);
      const decision = await asService(db, tx => approve(tx, seeded, user()));
      const original = await rowsFor(db, seeded.workspaceId, seeded.operation.id);
      expect(original).toHaveLength(1);
      const input = { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, approvalId: decision.approval.id };
      const expected = await repos.ownershipTransfers.listActive(db, seeded.workspaceId, seeded.operation.environmentId!);
      expect(await asService(independent, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, input))).toEqual(expected);
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(original);
      expect(await asService(db, tx => tx.query("select has_column_privilege(current_user,'platform.ownership_transfers','transfer_digest','UPDATE') as allowed"))).toEqual([{ allowed: false }]);
    });
  }, 60_000);

  it("two independent service-role replay transactions preserve the original immutable receipt", async () => {
    await withNative(async (db, independent) => {
      const seeded = await pending(db);
      const decision = await asService(db, tx => approve(tx, seeded, user()));
      const original = await rowsFor(db, seeded.workspaceId, seeded.operation.id);
      const input = { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, approvalId: decision.approval.id };
      const [first, second] = await Promise.all([asService(db, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, input)), asService(independent, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, input))]);
      expect(first).toHaveLength(1); expect(second).toEqual(first);
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(original);
    });
  }, 60_000);

  it("foreign, differently approved and revoked replays cannot rewrite or revive the stored transfer", async () => {
    await withNative(async (db, independent) => {
      const seeded = await pending(db, 2);
      const first = await asService(db, tx => approve(tx, seeded, user()));
      expect(first.operation.status).toBe("awaiting_approval");
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual([]);
      const second = await asService(independent, tx => approve(tx, seeded, user()));
      expect(second.operation.status).toBe("approved");
      const original = await rowsFor(db, seeded.workspaceId, seeded.operation.id);
      const input = { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, approvalId: second.approval.id };
      await expect(asService(db, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, { ...input, workspaceId: newWorkspace() }))).rejects.toMatchObject({ code: "operation_not_found" });
      await expect(asService(db, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, { ...input, approvalId: first.approval.id }))).rejects.toMatchObject({ code: "conflict" });
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(original);
      expect(await asService(db, tx => repos.ownershipTransfers.revoke(tx, { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, transferDigest: transfer.digest, revokedBy: uid("human") }))).toBe(true);
      const revoked = await rowsFor(db, seeded.workspaceId, seeded.operation.id);
      await expect(asService(independent, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, input))).rejects.toMatchObject({ code: "conflict" });
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(revoked);
      expect(await repos.ownershipTransfers.listActive(db, seeded.workspaceId, seeded.operation.environmentId!)).toEqual([]);
      await expect(asService(db, tx => tx.query("delete from platform.ownership_transfers where workspace_id=$1", [seeded.workspaceId]))).rejects.toMatchObject({ sqlstate: "42501" });
      await expect(asService(db, tx => tx.query("update platform.ownership_transfers set transfer_digest=$2 where workspace_id=$1", [seeded.workspaceId, "c".repeat(64)]))).rejects.toMatchObject({ sqlstate: "42501" });
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(revoked);
    });
  }, 60_000);
});
