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

/** Finite expiry has no public writer today. These original SQL receipts
 * explicitly model the reviewed approval tuple to exercise native admission,
 * while the genuine browser/default broker positive lives in capabilities. */
async function admission(db: PlatformDbHandle, expiresMs: number | null = null, to: "native-op" | "iac" = "native-op") {
  const receipt=transferRequest({address:transfer.address,resourceType:transfer.resourceType,path:transfer.path,from:transfer.from,to});
  const workspaceId = newWorkspace(), environmentId = uid("env"), projectId = uid("project"), resourceId = uid("resource");
  await db.query(`insert into platform.resources
    (id,workspace_id,environment_id,address,kind,provider,native_type,ownership,spec_digest,spec)
    values($1,$2,$3,'container_service/web','container_service','aws','aws:ecs_service','managed',$4,$5::text::jsonb)`,
    [resourceId,workspaceId,environmentId,"a".repeat(64),JSON.stringify({replicas:2,autoscaling:{min:2,max:8}})]);
  const seeded = await seedAwaitingApproval(db, { workspaceId, proposal: {
    capability: "service.scale", scope: { workspaceId, projectId, environmentId, resourceId },
  } });
  const decision = await asService(db, tx => approve(tx, seeded, user()));
  const transferId = uid("own");
  await asService(db, tx => tx.query(`insert into platform.ownership_transfers
    (id,workspace_id,project_id,environment_id,address,resource_type,field_path,from_owner,to_owner,transfer_digest,operation_id,approval_id,proposal_digest,approved_at,expires_at)
    select $1,o.workspace_id,o.project_id,o.environment_id,$2,$3,$4,$5,$6,$7,o.id,a.id,o.proposal_digest,a.created_at,
      case when $11::bigint is null then null else clock_timestamp()+($11::bigint*interval '1 millisecond') end
    from platform.operations o join platform.approvals a on a.workspace_id=o.workspace_id and a.operation_id=o.id
    where o.workspace_id=$8 and o.id=$9 and a.id=$10 and a.decision='approve' and a.approver->>'kind'='user' and a.proposal_digest=o.proposal_digest`,
    [transferId,receipt.address,receipt.resourceType,receipt.path,receipt.from,receipt.to,receipt.digest,workspaceId,seeded.operation.id,decision.approval.id,expiresMs]));
  const lease = await repos.leases.acquire(db,{workspaceId,scope:`env:${environmentId}`,holder:"worker:ownership-native",ttlMs:60_000});
  expect(lease).not.toBeNull();
  const claim = { workspaceId, id: seeded.operation.id, expectedDigest: seeded.operation.proposalDigest, holder: "worker:ownership-native", lease: lease! };
  const now = Date.now();
  const grant = { jti: uid("jti"), workspaceId, operationId: seeded.operation.id, capability:"service.scale",audience:"worker",issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString() };
  return { workspaceId, operationId:seeded.operation.id, transferId, claim, grant };
}

async function stateOf(db: PlatformDbHandle, input: { workspaceId: string; operationId: string }) {
  const [state] = await db.query<{ status: string; grants: number; consumed: number }>(`select o.status,
    (select count(*)::integer from platform.capability_grants g where g.workspace_id=o.workspace_id and g.operation_id=o.id) as grants,
    (select count(*)::integer from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id and a.consumed_at is not null) as consumed
    from platform.operations o where o.workspace_id=$1 and o.id=$2`,[input.workspaceId,input.operationId]);
  return state;
}

const signal = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

async function waitForNativeLock(db: PlatformDbHandle, waiter: number, blocker: number) {
  const end = Date.now()+10_000;
  while (Date.now()<end) {
    const rows = await db.query(`select pid from pg_stat_activity where pid=$1 and wait_event_type='Lock'
      and $2::integer=any(pg_blocking_pids(pid))`,[waiter,blocker]);
    if (rows.length===1) return;
    await new Promise(done => setTimeout(done,10));
  }
  throw new Error("The owning native row wait was not observed.");
}

async function waitForExpiry(db: PlatformDbHandle, input: { workspaceId: string; transferId: string }) {
  const end = Date.now()+10_000;
  while (Date.now()<end) {
    const [clock] = await db.query<{ expired: boolean }>("select expires_at<=clock_timestamp() as expired from platform.ownership_transfers where workspace_id=$1 and id=$2",[input.workspaceId,input.transferId]);
    if (clock?.expired) return;
    await new Promise(done => setTimeout(done,10));
  }
  throw new Error("The finite native transfer expiry was not observed.");
}

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
  it("rechecks a revoked enabling transfer after the owning operation lock wait without consuming approval", async () => {
    await withNative(async (db,independent) => {
      const owned=await admission(db), ready=signal<number>(), release=signal<void>(), started=signal<number>();
      const blocker=asService(independent,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for update",[owned.workspaceId,owned.operationId]);
        ready.resolve(backend!.pid); await release.promise;
      }).then(()=>undefined,error=>{ready.reject(error);return error;});
      const blockerPid=await ready.promise;
      const attempt=asService(db,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid"); started.resolve(backend!.pid);
        return repos.operations.claimForExecution(tx,owned.claim);
      }).then(value=>({value}),error=>({error}));
      try {
        await waitForNativeLock(db,await started.promise,blockerPid);
        expect(await repos.ownershipTransfers.revoke(db,{workspaceId:owned.workspaceId,operationId:owned.operationId,transferDigest:transfer.digest,revokedBy:uid("human")})).toBe(true);
      } finally { release.resolve(); expect(await blocker).toBeUndefined(); }
      expect(await attempt).toMatchObject({error:{code:"conflict",details:{reason:"field_ownership_conflict"}}});
      expect(await stateOf(db,owned)).toEqual({status:"approved",grants:0,consumed:0});
    });
  },60_000);

  it("rechecks a transfer whose one-way revocation committed during the native transfer row wait", async () => {
    await withNative(async (db,independent) => {
      const owned=await admission(db), ready=signal<number>(), release=signal<void>(), started=signal<number>();
      const blocker=asService(independent,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        expect(await repos.ownershipTransfers.revoke(tx,{workspaceId:owned.workspaceId,operationId:owned.operationId,transferDigest:transfer.digest,revokedBy:uid("human")})).toBe(true);
        ready.resolve(backend!.pid); await release.promise;
      }).then(()=>undefined,error=>{ready.reject(error);return error;});
      const blockerPid=await ready.promise;
      const attempt=asService(db,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid"); started.resolve(backend!.pid);
        return repos.operations.claimForExecution(tx,owned.claim);
      }).then(value=>({value}),error=>({error}));
      try { await waitForNativeLock(db,await started.promise,blockerPid); }
      finally { release.resolve(); expect(await blocker).toBeUndefined(); }
      expect(await attempt).toMatchObject({error:{code:"conflict",details:{reason:"field_ownership_conflict"}}});
      expect(await stateOf(db,owned)).toEqual({status:"approved",grants:0,consumed:0});
    });
  },60_000);

  it("rolls back approval consumption when the selected transfer expires during the real approval row wait", async () => {
    await withNative(async (db,independent) => {
      const owned=await admission(db,3_000), ready=signal<number>(), release=signal<void>(), started=signal<number>();
      const blocker=asService(independent,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        await tx.query("select id from platform.approvals where workspace_id=$1 and operation_id=$2 for update",[owned.workspaceId,owned.operationId]);
        ready.resolve(backend!.pid); await release.promise;
      }).then(()=>undefined,error=>{ready.reject(error);return error;});
      const blockerPid=await ready.promise;
      const attempt=asService(db,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid"); started.resolve(backend!.pid);
        return repos.operations.claimForExecution(tx,owned.claim);
      }).then(value=>({value}),error=>({error}));
      try { await waitForNativeLock(db,await started.promise,blockerPid); await waitForExpiry(independent,owned); }
      finally { release.resolve(); expect(await blocker).toBeUndefined(); }
      expect(await attempt).toMatchObject({error:{code:"conflict",details:{reason:"field_ownership_conflict"}}});
      expect(await stateOf(db,owned)).toEqual({status:"approved",grants:0,consumed:0});
    });
  },60_000);

  it("refuses final mutation grant insertion after transfer expiry behind the actual cleanup coordinator", async () => {
    await withNative(async (db,independent) => {
      // Both direct permission and the existing IaC warning can depend on a
      // live transfer from autoscaler; neither survives its native expiry.
      for (const to of ["native-op","iac"] as const) {
      const owned=await admission(db,3_000,to);
      await asService(db,tx=>repos.operations.claimForExecution(tx,owned.claim));
      await db.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing",[owned.workspaceId]);
      const ready=signal<number>(),release=signal<void>(),started=signal<number>();
      const blocker=asService(independent,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[owned.workspaceId]);
        ready.resolve(backend!.pid);await release.promise;
      }).then(()=>undefined,error=>{ready.reject(error);return error;});
      const blockerPid=await ready.promise;
      const attempt=asService(db,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");started.resolve(backend!.pid);
        return repos.grants.insert(tx,owned.grant);
      }).then(value=>({value}),error=>({error}));
      try { await waitForNativeLock(db,await started.promise,blockerPid); await waitForExpiry(independent,owned); }
      finally { release.resolve();expect(await blocker).toBeUndefined(); }
      expect(await attempt).toMatchObject({error:{code:"conflict",details:{reason:"field_ownership_conflict"}}});
      expect(await stateOf(db,owned)).toEqual({status:"running",grants:0,consumed:1});
      expect(await repos.grants.get(db,owned.workspaceId,owned.grant.jti)).toBeNull();
      }
    });
  },60_000);

});
