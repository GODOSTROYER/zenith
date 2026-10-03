/** SQL custody contracts, on two independent PostgreSQL handles when configured. Synthetic sealed payloads here are NOT engine provenance proof. */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { stableJson } from "@/lib/tofu/stable";
import { createHash } from "node:crypto";
import { executionHolder } from "@/lib/execution/platform";
import { approvalRoundOf } from "@/lib/controlplane/db/repos/operation-review";
import { planArtifactCipherFromEnv } from "@/lib/platform/plan-artifacts";
import * as artifacts from "@/lib/controlplane/db/repos/plan-artifacts";
import * as repos from "@/lib/controlplane/db/repos";
import type { PlanArtifactManifest } from "@/lib/tofu/engine";
import { LANES, openLane, seedApprovedOperation, seedAwaitingApproval, newWorkspace, uid } from "./_support/harness";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const wait = (ms:number) => new Promise<void>(resolve => setTimeout(resolve,ms));
function barrier() { let release!:()=>void; const promise=new Promise<void>(resolve => {release=resolve;}); return {promise,release}; }

describe.each(LANES)("plan artifacts [$name]", lane => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async()=>{ctx=await openLane(lane);},60000);
  afterAll(async()=>{await ctx.close();});
  async function fixture(ttlMs?:number,sourceReview=false,approvalCount?:number) {
    const workspaceIdSeed=newWorkspace(),environmentId=uid("env");
    const seeded = approvalCount ? await seedAwaitingApproval(ctx.db,{workspaceId:workspaceIdSeed,count:approvalCount,minRole:"admin"}) : await seedApprovedOperation(ctx.db,workspaceIdSeed,sourceReview?{proposal:{capability:"infrastructure.plan",scope:{workspaceId:workspaceIdSeed,projectId:"proj_1",environmentId},input:{environmentId,teardownReview:true}}}:{});
    const {workspaceId}=seeded;
    if(approvalCount) {
      const decision=(await repos.policyDecisions.get(ctx.db,workspaceId,seeded.operation.policyDecisionId!))!;
      for(let i=0;i<approvalCount;i++) await repos.approvals.record(ctx.db,{workspaceId,operationId:seeded.operation.id,proposalDigest:seeded.operation.proposalDigest,
        approver:{kind:"user",id:`canonical-admin-${i}`,name:"Canonical admin fixture"},approverRole:"admin",decision:"approve",policyVersion:decision.policyVersion});
    }
    if (ttlMs) await ctx.db.query("update platform.operations set expires_at=clock_timestamp()+($3::bigint * interval '1 millisecond') where workspace_id=$1 and id=$2",[workspaceId,seeded.operation.id,ttlMs]);
    const op=(await repos.operations.get(ctx.db,workspaceId,seeded.operation.id))!;
    await repos.operations.claimForExecution(ctx.db,{workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:executionHolder(op.id),leaseMs:60000});
    const lease=await repos.leases.acquire(ctx.db,{scope:`env:${op.environmentId}`,holder:`worker:fixture:${op.id}`,workspaceId,ttlMs:60000});
    if (!lease) throw new Error("fixture lease missing");
    const key=randomBytes(32).toString("hex");
    const cipher=planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:key});
    const payload="synthetic-private-plan-payload";
    const manifest:PlanArtifactManifest={workspaceId,operationId:op.id,projectId:op.projectId!,environmentId:op.environmentId!,proposalDigest:op.proposalDigest,inputDigest:op.inputDigest,
      expiresAt:op.expiresAt,sourceDigest:digest("source"),graphDigest:digest("graph"),format:"zenith.plan-artifact.v1",purpose:sourceReview?"destroy":"deploy",configDigest:digest("config"),lockDigest:digest("lock"),
      backendDigest:digest("backend"),addressMapDigest:digest("addresses"),planDigest:digest("plan"),rawSha256:hash(payload),bytes:Buffer.byteLength(payload),
      executable:{version:"fixture",platform:"fixture",sha256:digest("binary"),archiveSha256:null}};
    const seal=(m=manifest,text=payload)=>cipher.seal(workspaceId,`zenith.tofu.plan-artifact.v1:${hash(stableJson(m))}`,Buffer.from(text).toString("base64"));
    const input:artifacts.PublishArtifact={manifest,sealed:seal(),lease,evidence:{id:`evd_${randomUUID()}`,workspaceId,operationId:op.id,kind:"tofu_plan",digest:manifest.planDigest,summary:{planDigest:manifest.planDigest},simulated:false}};
    const access:artifacts.ArtifactAccess={custody:manifest,planDigest:manifest.planDigest,lease};
    return {op,manifest,input,access,key,payload,seal};
  }
  it("commits ciphertext, immutable plan binding and sanitized evidence together; content UPDATE/DELETE is refused",async()=>{
    const f=await fixture(); await artifacts.publish(ctx.db,f.input);
    expect((await repos.operations.get(ctx.db,f.op.workspaceId,f.op.id))?.planDigest).toBe(f.manifest.planDigest);
    const row=await artifacts.read(ctx.db,f.access);
    expect(JSON.stringify(row)).not.toContain(f.payload);
    expect(await repos.evidence.list(ctx.db,f.op.workspaceId,{operationId:f.op.id})).toHaveLength(1);
    await expect(ctx.db.query("update platform.plan_artifacts set ciphertext='changed' where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).rejects.toThrow();
    await expect(ctx.db.query("delete from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).rejects.toThrow();
    expect((await artifacts.read(ctx.db,f.access)).ciphertext).toBe(row.ciphertext);
  });
  it("concurrent equivalent publishers preserve the first original; changed binding conflicts",async()=>{
    const f=await fixture(); const row=await artifacts.publish(ctx.db,f.input);
    const alternate={...f.manifest,rawSha256:hash("alternate"),bytes:9};
    const second={...f.input,manifest:alternate,sealed:f.seal(alternate,"alternate")};
    const results=await Promise.all([artifacts.publish(ctx.db,f.input),artifacts.publish(ctx.db2,second)]);
    expect(results.map(r=>r.ciphertext)).toEqual([row.ciphertext,row.ciphertext]);
    await expect(artifacts.publish(ctx.db2,{...second,manifest:{...alternate,sourceDigest:digest("other")}})).rejects.toThrow("new review");
  });
  it("publication rollback leaves neither artifact, evidence nor plan binding",async()=>{
    const f=await fixture();
    await expect(ctx.db.tx(async tx=>{await artifacts.publish(tx,f.input);throw new Error("deliberate precommit crash");})).rejects.toThrow("precommit");
    expect(await ctx.db.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toHaveLength(0);
    expect(await repos.evidence.list(ctx.db,f.op.workspaceId,{operationId:f.op.id})).toHaveLength(0);
    expect((await repos.operations.get(ctx.db,f.op.workspaceId,f.op.id))?.planDigest).toBeUndefined();
  });
  it("rejects foreign tenant/operation/project/environment/source and expired or foreign execution holders",async()=>{
    const f=await fixture(); await artifacts.publish(ctx.db,f.input);
    for (const key of ["workspaceId","operationId","projectId","environmentId","sourceDigest"] as const) {
      await expect(artifacts.read(ctx.db2,{...f.access,custody:{...f.access.custody,[key]:`other-${key}`}})).rejects.toThrow();
    }
    await expect(artifacts.read(ctx.db2,{...f.access,lease:{...f.access.lease,holder:"foreign"}})).rejects.toThrow();
    await ctx.db.query("update platform.operations set lease_holder='foreign' where workspace_id=$1 and id=$2",[f.op.workspaceId,f.op.id]);
    await expect(artifacts.read(ctx.db2,f.access)).rejects.toThrow();
    await ctx.db.query("update platform.operations set lease_holder=$3,lease_until=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2",[f.op.workspaceId,f.op.id,executionHolder(f.op.id)]);
    await expect(artifacts.read(ctx.db2,f.access)).rejects.toThrow();
  });
  it("binds only an entirely unbound live claim, is idempotent, and refuses partial, changed or stale fences",async()=>{
    const f=await fixture(); await artifacts.publish(ctx.db,f.input);
    expect((await repos.operations.get(ctx.db,f.op.workspaceId,f.op.id))?.fenceToken).toBe(f.access.lease.fenceToken);
    await artifacts.read(ctx.db,f.access); await artifacts.read(ctx.db2,f.access);
    expect((await repos.operations.get(ctx.db,f.op.workspaceId,f.op.id))?.fenceToken).toBe(f.access.lease.fenceToken);
    await ctx.db.query("update platform.operations set fence_token=null where workspace_id=$1 and id=$2",[f.op.workspaceId,f.op.id]);
    await expect(artifacts.read(ctx.db2,f.access)).rejects.toThrow();
    await ctx.db.query("update platform.operations set fence_token=$3 where workspace_id=$1 and id=$2",[f.op.workspaceId,f.op.id,f.access.lease.fenceToken+1]);
    await expect(artifacts.read(ctx.db2,f.access)).rejects.toThrow();
    // The operation still records its original fence when a replacement worker acquires the environment.
    await ctx.db.query("update platform.operations set fence_token=$3 where workspace_id=$1 and id=$2",[f.op.workspaceId,f.op.id,f.access.lease.fenceToken]);
    await repos.leases.release(ctx.db,f.access.lease);
    const replacement=await repos.leases.acquire(ctx.db2,{scope:f.access.lease.scope,holder:`worker:replacement:${f.op.id}`,workspaceId:f.op.workspaceId,ttlMs:60000});
    if (!replacement) throw new Error("Replacement test lease was not acquired.");
    expect(replacement.fenceToken).not.toBe(f.access.lease.fenceToken);
    await expect(artifacts.read(ctx.db2,{...f.access,lease:replacement})).rejects.toThrow();
  });
  it("claims and dispatches once across independent handles; uncertainty never reopens dispatch",async()=>{
    const f=await fixture(); await artifacts.publish(ctx.db,f.input);
    const attempts=await Promise.allSettled([artifacts.claim(ctx.db,f.access,"one"),artifacts.claim(ctx.db2,f.access,"two")]);
    expect(attempts.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const attempt=attempts[0].status==="fulfilled"?"one":"two";
    await artifacts.dispatch(ctx.db,f.access,attempt);
    await artifacts.finish(ctx.db,f.access,attempt,false);
    await expect(artifacts.claim(ctx.db2,f.access,"retry")).rejects.toThrow();
    expect(await ctx.db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"uncertain"}]);
  });
  it("expiry after callback completion cannot produce a successful completion receipt or delete ciphertext",async()=>{
    const f=await fixture(1000); await artifacts.publish(ctx.db,f.input);
    await artifacts.claim(ctx.db,f.access,"expiry"); await artifacts.dispatch(ctx.db,f.access,"expiry");
    await wait(Math.max(0,Date.parse(f.op.expiresAt)-Date.now()+30));
    await artifacts.expire(ctx.db2);
    await expect(artifacts.finish(ctx.db,f.access,"expiry",true)).rejects.toThrow();
    expect(await ctx.db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"uncertain"}]);
    expect(await ctx.db.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toHaveLength(1);
  });
  if (lane.independent) {
    it("publisher and reader barriers serialize visible commit, then losing fence cannot dispatch",async()=>{
      const f=await fixture(); const entered=barrier(), release=barrier();
      const writing=ctx.db.tx(async tx=>{await artifacts.publish(tx,f.input);entered.release();await release.promise;});
      await entered.promise;
      let readDone=false; const reading=artifacts.read(ctx.db2,f.access).then(row=>{readDone=true;return row;});
      await wait(30); expect(readDone).toBe(false); release.release(); await writing; await reading;
      await artifacts.claim(ctx.db,f.access,"fence"); await repos.leases.release(ctx.db2,f.access.lease);
      await repos.leases.acquire(ctx.db2,{scope:f.access.lease.scope,holder:`worker:new:${f.op.id}`,workspaceId:f.op.workspaceId,ttlMs:60000});
      await expect(artifacts.dispatch(ctx.db,f.access,"fence")).rejects.toThrow();
    });
  }
  it.each([0,2])("a serialized canonical proof with %i required humans permits exactly one live durable dispatch",async(requiredApprovalCount)=>{
    const f=await fixture(undefined,false,requiredApprovalCount || undefined);
    await artifacts.publish(ctx.db,f.input);await artifacts.claim(ctx.db,f.access,"positive-proof");
    const approvals=await repos.approvals.listForOperation(ctx.db,f.op.workspaceId,f.op.id);
    expect(approvals).toHaveLength(requiredApprovalCount);
    for(const approval of approvals)expect(approval.consumedAt).toBeDefined();
    const op=await repos.operations.get(ctx.db,f.op.workspaceId,f.op.id);
    if(!op)throw new Error("Canonical proof fixture operation is unavailable.");
    const proof={approvalIds:approvals.map(a=>a.id),requiredApprovalCount,approvalRound:approvalRoundOf(op),proposalDigest:op.proposalDigest,planDigest:f.manifest.planDigest};
    await artifacts.dispatch(ctx.db,f.access,"positive-proof",proof);
    expect(await ctx.db2.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"dispatched"}]);
    await expect(artifacts.dispatch(ctx.db2,f.access,"positive-proof",proof)).rejects.toThrow();
    await artifacts.finish(ctx.db,f.access,"positive-proof",true);
    expect(await ctx.db2.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"succeeded"}]);
  });
  it("the exact canonical approval set/count fails at the CAS clock when one approver expires despite another live human",async()=>{
    const f=await fixture(undefined,false,2);await artifacts.publish(ctx.db,f.input);await artifacts.claim(ctx.db,f.access,"approval-clock");
    // Simulate a stale linked policy requiring one; the canonical proof requires two.
    const stale=await repos.policyDecisions.insert(ctx.db,{workspaceId:f.op.workspaceId,operationId:f.op.id,policyVersion:digest("stale-one"),inputDigest:digest("policy-input"),outcome:"require_approval",reasons:[],approval:{count:1,minRole:"admin",separationOfDuties:false}});
    await ctx.db.query("update platform.operations set policy_decision_id=$3 where workspace_id=$1 and id=$2",[f.op.workspaceId,f.op.id,stale.id]);
    const approvals=await repos.approvals.listForOperation(ctx.db,f.op.workspaceId,f.op.id);
    const proof={approvalIds:approvals.map(a=>a.id),requiredApprovalCount:2,approvalRound:0,proposalDigest:f.op.proposalDigest,planDigest:f.manifest.planDigest};
    await ctx.db2.query("update platform.approvals set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2",[f.op.workspaceId,approvals[0].id]);
    await expect(artifacts.dispatch(ctx.db,f.access,"approval-clock",proof)).rejects.toThrow();
    expect(await ctx.db2.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"claimed"}]);
    expect(await ctx.db2.query("select id from platform.approvals where workspace_id=$1 and operation_id=$2 and expires_at > clock_timestamp()",[f.op.workspaceId,f.op.id])).toHaveLength(1);
    await artifacts.finish(ctx.db,f.access,"approval-clock",false);
  });
  if (lane.independent) {
    it("a committed dispatch CAS with lost response remains uncertain and refuses another claim",async()=>{
      const f=await fixture();await artifacts.publish(ctx.db,f.input);await artifacts.claim(ctx.db,f.access,"lost-dispatch");
      const committed:import("@/lib/controlplane/types").Sql={query:(sql,params)=>ctx.db.query(sql,params),tx:async fn=>{await ctx.db.tx(fn);throw new Error("lost committed dispatch response");}};
      await expect(artifacts.dispatch(committed,f.access,"lost-dispatch")).rejects.toThrow("lost committed dispatch");
      expect(await ctx.db2.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"dispatched"}]);
      await artifacts.finish(ctx.db,f.access,"lost-dispatch",false);await expect(artifacts.claim(ctx.db2,f.access,"retry-dispatch")).rejects.toThrow();
      expect(await ctx.db2.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"uncertain"}]);
    });
  }
  if (lane.independent) {
    it("source association locks both operations and loses safely to a partially decided browser round",async()=>{
      const f=await fixture(undefined,true);await artifacts.publish(ctx.db,f.input);
      const proposal={capability:"infrastructure.destroy",scope:{workspaceId:f.op.workspaceId,projectId:f.op.projectId,environmentId:f.op.environmentId},input:{environmentId:f.op.environmentId},planDigest:f.manifest.planDigest,
        broker:{v:1,destroyPlan:{operationId:f.op.id,evidenceId:f.input.evidence.id}}};
      const destination=await seedAwaitingApproval(ctx.db,{workspaceId:f.op.workspaceId,count:2,minRole:"admin",proposal});
      const entered=barrier(),release=barrier();
      const decision=ctx.db2.tx(async tx=>{
        await repos.approvals.record(tx,{workspaceId:f.op.workspaceId,operationId:destination.operation.id,proposalDigest:destination.operation.proposalDigest,planDigest:f.manifest.planDigest,
          approver:{kind:"user",id:"independent-browser-admin",name:"Independent browser fixture"},approverRole:"admin",decision:"approve",policyVersion:destination.decision.policyVersion});
        entered.release();await release.promise;
      });
      await entered.promise;let done=false;
      const associating=artifacts.associate(ctx.db,{workspaceId:f.op.workspaceId,sourceOperationId:f.op.id,destinationOperationId:destination.operation.id,sourceEvidenceId:f.input.evidence.id!,planDigest:f.manifest.planDigest,lease:f.access.lease}).then(()=>{done=true;},error=>{done=true;throw error;});
      const refused=expect(associating).rejects.toThrow();
      await wait(30);expect(done).toBe(false);release.release();await decision;await refused;
      expect((await repos.operations.get(ctx.db,f.op.workspaceId,destination.operation.id))?.status).toBe("awaiting_approval");
      expect(await repos.approvals.listForOperation(ctx.db,f.op.workspaceId,destination.operation.id)).toHaveLength(1);
      expect(await ctx.db.query("select operation_id from platform.plan_artifact_associations where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,destination.operation.id])).toHaveLength(0);
      expect(await ctx.db.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toHaveLength(1);
    });
  }
  it("source association refuses unclaimed publication and foreign immutable destination references",async()=>{
    const f=await fixture(undefined,true);await artifacts.publish(ctx.db,f.input);
    const proposal={capability:"infrastructure.destroy",scope:{workspaceId:f.op.workspaceId,projectId:f.op.projectId,environmentId:f.op.environmentId},input:{environmentId:f.op.environmentId},planDigest:f.manifest.planDigest,
      broker:{v:1,destroyPlan:{operationId:f.op.id,evidenceId:"foreign-evidence"}}};
    const destination=await seedAwaitingApproval(ctx.db,{workspaceId:f.op.workspaceId,proposal});
    await expect(artifacts.associate(ctx.db,{workspaceId:f.op.workspaceId,sourceOperationId:f.op.id,destinationOperationId:destination.operation.id,sourceEvidenceId:f.input.evidence.id!,planDigest:f.manifest.planDigest,lease:f.access.lease})).rejects.toThrow();
    const fresh=await fixture();await ctx.db.query("update platform.operations set lease_until=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2",[fresh.op.workspaceId,fresh.op.id]);
    await expect(artifacts.publish(ctx.db,fresh.input)).rejects.toThrow();
    expect(await ctx.db.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[fresh.op.workspaceId,fresh.op.id])).toHaveLength(0);
  });
  if (lane.independent) {
    it("lost durable completion response refuses replay even when the commit succeeded",async()=>{
      const f=await fixture();await artifacts.publish(ctx.db,f.input);
      await artifacts.claim(ctx.db,f.access,"lost");await artifacts.dispatch(ctx.db,f.access,"lost");
      const committed:import("@/lib/controlplane/types").Sql={
        query:(sql,params)=>ctx.db.query(sql,params),
        tx:async fn=>{await ctx.db.tx(fn);throw new Error("simulated lost committed completion response");},
      };
      await expect(artifacts.finish(committed,f.access,"lost",true)).rejects.toThrow("lost committed completion");
      expect(await ctx.db2.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"succeeded"}]);
      await expect(artifacts.claim(ctx.db2,f.access,"replay")).rejects.toThrow();
    });
  }
});
