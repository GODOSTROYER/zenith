/** Actual PostgreSQL authority acceptance. Synthetic completed-plan use is a fixture, not provider/apply provenance. */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import * as launches from "@/lib/controlplane/db/repos/build-launches";
import * as repos from "@/lib/controlplane/db/repos";
import { registerEnvironment } from "@/lib/reconcile/platform";
import { LANES, PG_URL, openLane, newWorkspace } from "./_support/harness";
import { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, user, sessionFor } from "../capabilities/support";
import { makePlan, change } from "../execution/fakes/fixtures";
import { buildPlanFacts } from "@/lib/capabilities/evaluate";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";

closeSharedPgliteAfterAll();

describe.skipIf(!PG_URL)("build launch authority [postgres]",()=>{
  let world: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async()=>{world=await openLane(LANES.find(l=>l.name==="postgres")!);},60000);
  afterAll(async()=>{await world?.close();});
  async function fixture() {
    const h=await makeHarness({kind:"postgres",engine:scriptedEngine("build-policy",()=>requireApproval(1,"admin",true))});
    const workspaceId=h.ids.wsA, environmentId=h.ids.envAProd, region="eu-west-1", accountId="123456789012";
    h.deps.clock={now:()=>new Date()};
    h.world.environments.get(environmentId)!.region=region;
    const {operation:op}=await h.broker.propose({capability:"deployment.deploy",scope:{workspaceId,projectId:h.ids.projA,environmentId},input:{}},user("alice"));
    const decide=(planDigest?:string)=>h.broker.approve({workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,planDigest,approver:user("erin"),session:sessionFor("erin")});
    await decide();
    await h.broker.beginExecution({workspaceId,operationId:op.id,holder:`workflow:${op.id}`,audience:"worker"});
    const ports=createOperationsPort(world.db), worker=createExecutionBroker(world.db,async()=>h.broker);
    const plan=makePlan({changes:[change({address:"aws_codebuild_project.web",type:"aws_codebuild_project",action:"create"})]});
    const facts=buildPlanFacts(plan)!;
    await repos.evidence.insert(world.db,{workspaceId,operationId:op.id,kind:"tofu_plan",digest:plan.planDigest,summary:planEvidence({plan,facts,cost:{},graphDigest:digest("graph"),stage:"plan"}).summary,simulated:false});
    await ports.setPlanDigest({workspaceId,operationId:op.id,planDigest:plan.planDigest});
    const policy=await worker.reevaluate(op.id,facts);
    await ports.setPolicyDecision({workspaceId,operationId:op.id,decisionId:policy.decisionId});
    await ports.transition({workspaceId,operationId:op.id,to:"awaiting_approval"});
    await decide(plan.planDigest);
    const lease=await repos.leases.acquire(world.db,{workspaceId,scope:`env:${environmentId}`,holder:`worker:${op.id}`,ttlMs:60000});
    if(!lease) throw new Error("Fixture lease not acquired.");
    await repos.operations.claimForExecution(world.db,{workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:`workflow:${op.id}`,leaseMs:60000,lease,expectedPolicyVersion:"build-policy"});
    const status=await worker.approvalStatus(op.id);
    if(!status.approved || !status.dispatchApproval) throw new Error("Fixture has no current dispatch approval.");
    const claim=launches.createIsolatedBuildClaimerForTests(h.broker);
    await world.db.query("insert into platform.plan_artifact_uses (workspace_id,operation_id,phase) values ($1,$2,'succeeded')",[workspaceId,op.id]);
    const pipeline=mkNode("build_pipeline/web","build_pipeline","aws:codebuild_project",{source:{repo:"https://github.com/acme/web",ref:"revision"}},{specDigest:digest("pipeline")});
    const service=mkNode("container_service/web","container_service","aws:ecs_service",{artifact:{type:"built",pipeline:pipeline.address}},{specDigest:digest("service")});
    for(const node of [pipeline,service]) await repos.resources.upsertDesired(world.db,{workspaceId,environmentId,node,status:"active"});
    const connection=await repos.connections.create(world.db,{workspaceId,createdBy:"fixture-admin",config:{provider:"aws",mode:"oidc_web_identity",accountId,region,observeRoleArn:`arn:aws:iam::${accountId}:role/observe`,deployRoleArn:`arn:aws:iam::${accountId}:role/deploy`}});
    await repos.connections.recordVerification(world.db,{workspaceId,id:connection.id,ok:true});
    await registerEnvironment(world.db,{environment:{workspaceId,environmentId,provider:"aws",region,class:"development",connection:{id:connection.id,status:"verified"}}});
    const sourceDigest=digest("source");
    const binding:launches.BuildLaunchBinding={workspaceId,operationId:op.id,environmentId,serviceAddress:service.address,serviceSpecDigest:service.specDigest,pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,accountId,region,projectName:"zenith-build-web",projectArn:`arn:aws:codebuild:${region}:${accountId}:project/zenith-build-web`,sourceBucket:"zenith-source-fixture",sourceKey:`zenith/${environmentId}/web/${sourceDigest}.zip`,sourceDigest,settingsDigest:digest("settings"),executedSettingsDigest:digest("executed-settings")};
    return {claim,h,worker,binding,fence:{scope:lease.scope,token:lease.fenceToken},op,connection,buildId:"zenith-build-web:11111111-2222-3333-4444-555555555555"};
  }
  it("commits one permanent predispatch claim across independent workers",async()=>{
    const f=await fixture();
    const results=await Promise.all([f.claim(world.db,f.binding,f.fence),f.claim(world.db2,f.binding,f.fence)]);
    expect(results.filter(r=>r.claimed)).toHaveLength(1);
    expect(new Set(results.map(r=>r.launch.attempt_id)).size).toBe(1);
    expect(results.every(r=>r.launch.phase==="dispatched" && r.launch.build_id===null)).toBe(true);
  });
  it("a committed claim without a provider receipt never becomes dispatchable again",async()=>{
    const f=await fixture(); const first=await f.claim(world.db,f.binding,f.fence);
    expect(first.claimed).toBe(true);
    const later=await f.claim(world.db2,f.binding,f.fence);
    expect(later.claimed).toBe(false); expect(later.launch.build_id).toBeNull();
    for(const key of ["sourceDigest","settingsDigest","executedSettingsDigest","accountId","serviceSpecDigest"] as const) {
      const changed={...f.binding,[key]:key==="accountId"?"999999999999":digest(`changed-${key}`)};
      await expect(f.claim(world.db2,changed,f.fence)).rejects.toThrow();
    }
  });
  it("a rollback before commit leaves no external launch intent and can be claimed",async()=>{
    const f=await fixture();
    await expect(world.db.tx(async tx=>{await f.claim(tx,f.binding,f.fence);throw new Error("precommit fixture crash");})).rejects.toThrow("precommit");
    expect((await f.claim(world.db2,f.binding,f.fence)).claimed).toBe(true);
  });
  it.each(["fence","execution-lease","operation","consumed-approval"] as const)("rechecks %s expiry after an observed resource lock wait before committing dispatch",async kind=>{
    const f=await fixture();
    let backendReady!:()=>void;
    const ready=new Promise<void>(resolve=>{backendReady=resolve;});
    let pid=0;
    let outcome!:Promise<{error?:unknown;claimed?:boolean}>;
    await world.db.tx(async blocker=>{
      await blocker.query("select id from platform.resources where workspace_id=$1 and environment_id=$2 and address=$3 for update",[f.binding.workspaceId,f.binding.environmentId,f.binding.serviceAddress]);
      const table=kind==="fence"?"leases":kind==="consumed-approval"?"approvals":"operations", column=kind==="execution-lease"?"lease_until":"expires_at";
      const target=kind==="fence"?f.fence.scope:kind==="consumed-approval"?(await f.worker.approvalStatus(f.op.id)).dispatchApproval!.approvalIds[0]:f.op.id;
      const [expires]=await world.db.query<{expiry:string}>(`update platform.${table} set ${column}=clock_timestamp()+interval '2 seconds'
        where ${kind==="fence"?"scope=$1":"id=$1"} returning ${column}::text as expiry`,[target]);
      outcome=world.db2.tx(async claimant=>{
        [ { pid } ]=await claimant.query<{pid:number}>("select pg_backend_pid() as pid");
        backendReady();
        return f.claim(claimant,f.binding,f.fence);
      }).then(result=>({claimed:result.claimed}),error=>({error}));
      await ready;
      let blocked=false;
      for(let attempt=0;attempt<100;attempt++) {
        const [state]=await world.db.query<{blocked:boolean}>("select wait_event_type='Lock' and query like '%select address,spec_digest,spec from platform.resources%' as blocked from pg_stat_activity where pid=$1",[pid]);
        if(state?.blocked) {blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      expect(blocked).toBe(true);
      await world.db.query("select pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp())))+0.05)",[expires.expiry]);
      // COMMIT releases the real PostgreSQL resource lock after authority expiry.
    });
    expect((await outcome).error).toBeDefined();
    const rows=await world.db.query("select operation_id from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.binding.workspaceId,f.op.id]);
    expect(rows).toHaveLength(0);
  });
  it("refuses expired consumed approvals at the CAS while operation and fence remain live",async()=>{
    const f=await fixture();
    await f.h.expireApprovals(f.op.id);
    const [live]=await world.db.query<{operation:boolean;fence:boolean}>(`select o.status='running' and o.expires_at>clock_timestamp() and o.lease_until>clock_timestamp() as operation,
      l.expires_at>clock_timestamp() and l.released_at is null as fence from platform.operations o join platform.leases l on l.scope=o.lease_scope
      where o.workspace_id=$1 and o.id=$2`,[f.binding.workspaceId,f.op.id]);
    expect(live).toEqual({operation:true,fence:true});
    await expect(f.claim(world.db2,f.binding,f.fence)).rejects.toThrow();
    expect(await world.db.query("select operation_id from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.binding.workspaceId,f.op.id])).toHaveLength(0);
  });
  it("keeps the isolated actual-broker claimer unavailable in production and outside bound SQL repositories",async()=>{
    const f=await fixture(), prior=process.env.NODE_ENV;
    expect(repos.bindRepos(world.db).buildLaunches).not.toHaveProperty("createIsolatedBuildClaimerForTests");
    try {
      process.env.NODE_ENV="production";
      expect(()=>launches.createIsolatedBuildClaimerForTests(f.h.broker)).toThrow();
      expect(()=>f.claim(world.db,f.binding,f.fence)).toThrow();
    } finally {process.env.NODE_ENV=prior;}
    expect(await world.db.query("select operation_id from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.binding.workspaceId,f.op.id])).toHaveLength(0);
  });
  it("records a late accepted receipt after cancellation without reopening the writer",async()=>{
    const f=await fixture(); const first=await f.claim(world.db,f.binding,f.fence);
    await repos.operations.transition(world.db2,{workspaceId:f.binding.workspaceId,id:f.op.id,from:["running"],to:"cancelled"});
    const accepted=await launches.acknowledge(world.db,first.launch,f.buildId,["provider-launch-request"]);
    expect(accepted.phase).toBe("accepted");
    expect((await launches.get(world.db2,f.binding.workspaceId,f.op.id,f.buildId))?.attempt_id).toBe(first.launch.attempt_id);
    await expect(f.claim(world.db2,f.binding,f.fence)).rejects.toThrow();
    expect(await launches.get(world.db2,newWorkspace(),f.op.id,f.buildId)).toBeNull();
  });
  it("rejects stale fences, foreign tenants, absent original-use authority and revoked account bindings",async()=>{
    const f=await fixture();
    await expect(f.claim(world.db2,f.binding,{...f.fence,token:f.fence.token+1})).rejects.toThrow();
    await expect(f.claim(world.db2,{...f.binding,workspaceId:newWorkspace()},f.fence)).rejects.toThrow();
    await world.db.query("update platform.plan_artifact_uses set phase='uncertain' where workspace_id=$1 and operation_id=$2",[f.binding.workspaceId,f.op.id]);
    await expect(f.claim(world.db2,f.binding,f.fence)).rejects.toThrow();
    await world.db.query("update platform.plan_artifact_uses set phase='succeeded' where workspace_id=$1 and operation_id=$2",[f.binding.workspaceId,f.op.id]);
    await repos.connections.revoke(world.db,f.binding.workspaceId,f.connection.id);
    await expect(f.claim(world.db2,f.binding,f.fence)).rejects.toThrow();
  });
  it("retains an immutable terminal receipt independently of operation projections and provider-token expiry",async()=>{
    const f=await fixture(); const first=await f.claim(world.db,f.binding,f.fence);
    const accepted=await launches.acknowledge(world.db2,first.launch,f.buildId,["accepted-request"]);
    const finishedAt=new Date();
    const terminal=await launches.observeTerminal(world.db,accepted,{status:"STOPPED",finishedAt,requestId:"terminal-read-request"});
    expect(terminal).toMatchObject({phase:"terminal",terminal_status:"STOPPED"});
    await world.db.query("update platform.operations set expires_at=clock_timestamp()-interval '6 minutes' where workspace_id=$1 and id=$2",[f.binding.workspaceId,f.op.id]);
    expect((await launches.get(world.db2,f.binding.workspaceId,f.op.id,f.buildId))?.phase).toBe("terminal");
    await expect(f.claim(world.db2,f.binding,f.fence)).rejects.toThrow();
    await expect(world.db.query("delete from platform.build_launches where workspace_id=$1",[f.binding.workspaceId])).rejects.toThrow();
    await expect(world.db.query("update platform.build_launches set phase='dispatched' where workspace_id=$1",[f.binding.workspaceId])).rejects.toThrow();
  });
  it("refuses receipt substitution and preserves the first acknowledgement",async()=>{
    const f=await fixture(); const first=await f.claim(world.db,f.binding,f.fence);
    const saved=await launches.acknowledge(world.db,first.launch,f.buildId,["accepted-request"]);
    expect((await launches.acknowledge(world.db2,first.launch,f.buildId,["accepted-request"])).build_id).toBe(saved.build_id);
    await expect(launches.acknowledge(world.db2,first.launch,f.buildId,["different-request"])).rejects.toThrow();
    await expect(launches.acknowledge(world.db2,first.launch,f.buildId.replace("zenith-build-web:","foreign:"),["accepted-request"])).rejects.toThrow();
  });
});
