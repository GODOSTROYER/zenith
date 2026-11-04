/** Actual PostgreSQL/evaluator/CAS. Product REST transport, directory and policy bundle loading are explicit fixture ports, not live acceptance. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as settings from "@/lib/controlplane/db/repos/settings";
import * as intents from "@/lib/controlplane/db/repos/workflow-start-intents";
import { migration0012WorkflowStartIntents } from "@/lib/controlplane/db/migrations/0012_workflow_start_intents";
import { createBroker, resetPlatformBrokerForTests, setPlatformBrokerForTests } from "@/lib/capabilities/platform";
import { PlatformBrokerStore } from "@/lib/capabilities/platform-store";
import { MemoryBrokerStore } from "@/lib/capabilities/memory-store";
import { createExecutionBroker } from "@/lib/platform/broker";
import type { Sql } from "@/lib/controlplane/types";
import { approveAs, closeSharedPgliteAfterAll, makeHarness, PG_URL, proposeOk, requestFor,
  requireApproval, scriptedEngine, user, type Harness } from "../capabilities/support";

const model=vi.hoisted(()=>({
  active:undefined as Harness|undefined,memberDb:undefined as Sql|undefined,scopeTx:undefined as Sql|undefined,
  beforeMember:undefined as undefined|((workspaceId:string,humanId:string,signal:AbortSignal)=>Promise<void>),
  memberCalls:[] as {workspaceId:string;humanId:string;signal:AbortSignal}[],
  evaluations:[] as {autonomy:number|undefined;twoPerson:boolean;regions:string[]|undefined}[],
}));
vi.mock("@/lib/capabilities/product-adapters",async original=>({
  ...await original<typeof import("@/lib/capabilities/product-adapters")>(),
  productRoleResolver:()=>{if(!model.active)throw new Error("Fixture roles unavailable.");return model.active.deps.roles;},
  productScopeResolver:()=>{if(!model.active)throw new Error("Fixture directory unavailable.");return model.active.deps.scopes;},
}));
vi.mock("@/lib/platform/scopes",async original=>{
  const actual=await original<typeof import("@/lib/platform/scopes")>();
  return {...actual,platformScopeResolver:(tx:Sql)=>{model.scopeTx=tx;return actual.platformScopeResolver(tx);}};
});
vi.mock("@/lib/policy",async original=>({
  ...await original<typeof import("@/lib/policy")>(),
  loadPolicyEngine:()=>{if(!model.active)throw new Error("Fixture policy unavailable.");return model.active.deps.policy();},
}));
vi.mock("@/lib/execution/product-port",async original=>({
  ...await original<typeof import("@/lib/execution/product-port")>(),
  workerStoreScope:async <T>(body:()=>Promise<T>):Promise<T>=>body(),
}));
vi.mock("@/lib/db/store",async original=>({...await original<typeof import("@/lib/db/store")>(),isPostgres:()=>true}));
vi.mock("@/lib/db/postgres-store",async original=>({
  ...await original<typeof import("@/lib/db/postgres-store")>(),
  pgClient:()=>({from:(table:string)=>{
    if(table!=="members")throw new Error("Unexpected fixture member table.");
    const filters=new Map<string,string>();let signal!:AbortSignal;
    const query={
      select:(columns:string)=>{expect(columns).toBe("id,workspace_id,role");return query;},
      eq:(column:string,value:string)=>{filters.set(column,value);return query;},
      abortSignal:(value:AbortSignal)=>{signal=value;return query;},
      maybeSingle:async()=>{
        const workspaceId=filters.get("workspace_id")!,humanId=filters.get("id")!;
        if(!workspaceId || !humanId || !signal || !model.memberDb)throw new Error("Unscoped fixture member read.");
        model.memberCalls.push({workspaceId,humanId,signal});
        await model.beforeMember?.(workspaceId,humanId,signal);
        if(signal.aborted)return {data:null,error:new Error("Fixture member read cancelled.")};
        // A separate actual SQL fixture relation supplies current membership.
        // This adapter models REST only; it does not masquerade as a live product table.
        const rows=await model.memberDb.query("select id,workspace_id,role from public.zenith_workflow_start_test_members where workspace_id=$1 and id=$2",[workspaceId,humanId]);
        return {data:rows[0]??null,error:null};
      },
    };return query;
  }}),
}));

if(process.env.ZENITH_TEST_WORKFLOW_START_REQUIRED==="1" && !PG_URL)throw new Error("Workflow start authority acceptance requires owned PostgreSQL.");
closeSharedPgliteAfterAll();
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
type Phase="prepare"|"claim";
type Outcome={value?:intents.WorkflowStartIntent|{intent:intents.WorkflowStartIntent;dispatch:boolean};error?:unknown};

describe.skipIf(!PG_URL)("workflow start final authority [postgres]",()=>{
  let db:PlatformDbHandle,worker:PlatformDbHandle,observer:PlatformDbHandle;
  beforeAll(async()=>{
    db=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1,migrate:true});
    await db.exec(migration0012WorkflowStartIntents.sql);
    worker=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1,migrate:false});
    observer=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1,migrate:false});
    await db.exec("create table if not exists public.zenith_workflow_start_test_members(workspace_id text not null,id text not null,role text not null,primary key(workspace_id,id))");
    model.memberDb=observer;
  },60_000);
  afterAll(async()=>{await observer?.close();await worker?.close();await db?.close();});
  beforeEach(()=>{model.active=undefined;model.beforeMember=undefined;model.memberCalls=[];model.evaluations=[];model.scopeTx=undefined;resetPlatformBrokerForTests();});
  afterEach(()=>{resetPlatformBrokerForTests();vi.restoreAllMocks();});
  async function fixture(){
    const h=await makeHarness({kind:"postgres",engine:scriptedEngine("workflow-current-policy",input=>{
      model.evaluations.push({autonomy:input.environment?.autonomyLevel,twoPerson:input.workspacePolicy.twoPersonProduction,regions:input.workspacePolicy.approvedRegions});
      if(input.workspacePolicy.approvedRegions && !input.workspacePolicy.approvedRegions.includes(input.environment?.region??""))
        return {outcome:"deny",reasons:[{code:"region_denied",message:"Region denied."}]};
      return requireApproval(input.workspacePolicy.twoPersonProduction?2:1,"admin");
    })});
    model.active=h;h.deps.clock={now:()=>new Date()};
    const op=await proposeOk(h,requestFor(h,"service.restart","prod"),user("bob"));await approveAs(h,op.operation,"erin");
    const fence=await h.acquireLease(h.ids.envAProd);
    await h.broker.beginExecution({workspaceId:h.ids.wsA,operationId:op.id,holder:`workflow:${op.id}`,audience:"worker",leaseMs:60_000,lease:fence});
    for(const [key,role] of h.world.members){const [workspaceId,humanId]=key.split("|");
      await observer.query("insert into public.zenith_workflow_start_test_members(workspace_id,id,role) values ($1,$2,$3)",[workspaceId,humanId,role]);}
    await observer.query("update platform.operations set expires_at=clock_timestamp()+interval '60 seconds',lease_until=clock_timestamp()+interval '60 seconds' where workspace_id=$1 and id=$2",[h.ids.wsA,op.id]);
    await observer.query("update platform.approvals set expires_at=clock_timestamp()+interval '60 seconds' where workspace_id=$1 and operation_id=$2",[h.ids.wsA,op.id]);
    const request:intents.StartRequest={kind:"dayTwo",arguments:{workspaceId:h.ids.wsA,operationId:op.id,environmentId:h.ids.envAProd,capability:"service.restart"},
      namespace:"default",endpointDigest:digest("owned authority frontend"),taskQueue:"owned-authority-contract"};
    return {h,op,fence,request};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  const inventory=(f:Fixture)=>intents.get(observer,f.h.ids.wsA,f.op.id);
  const runPhase=(f:Fixture,phase:Phase,sql:PlatformDbHandle=worker)=>phase==="prepare"?intents.prepare(sql,f.request):intents.claim(sql,f.request);
  async function live(f:Fixture){
    const [row]=await observer.query<{operation:boolean;fence:boolean;approvals:number}>(`select
      o.status='running' and o.expires_at>clock_timestamp() and o.lease_until>clock_timestamp() as operation,
      l.expires_at>clock_timestamp() and l.released_at is null as fence,
      (select count(*)::integer from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
        and a.decision='approve' and a.consumed_at is not null and a.expires_at>clock_timestamp()) as approvals
      from platform.operations o join platform.leases l on l.scope=o.lease_scope where o.workspace_id=$1 and o.id=$2`,[f.h.ids.wsA,f.op.id]);
    expect(row).toEqual({operation:true,fence:true,approvals:1});
  }
  for(const mode of ["production","isolated"] as const)it(`uses the owning single-connection transaction through ${mode} composition`,async()=>{
    const f=await fixture(),outside=new PlatformBrokerStore(worker);
    const outsidePolicy=vi.spyOn(outside,"getWorkspacePolicy"),outsideApprovals=vi.spyOn(outside,"listApprovals");
    const broker=createBroker({...f.h.deps,store:outside});setPlatformBrokerForTests(broker);
    const store=mode==="production"?intents:intents.createIsolatedStartIntentStoreForTests(broker);
    await store.prepare(worker,f.request);const first=await store.claim(worker,f.request);
    expect(first.dispatch).toBe(true);expect(first.intent.phase).toBe("attempted");
    expect(outsidePolicy).not.toHaveBeenCalled();expect(outsideApprovals).not.toHaveBeenCalled();
    if(mode==="production"){expect(model.scopeTx).toBeDefined();expect(model.scopeTx).not.toBe(worker);expect(model.memberCalls.map(call=>call.humanId)).toContain("erin");}
    expect(await worker.query("select 1 as available")).toEqual([{available:1}]);
  },20_000);

  for(const phase of ["prepare","claim"] as const)it(`ignores a permissive global memory broker at ${phase} with authentic owning consumed approvals`,async()=>{
    const f=await fixture();if(phase==="claim")await intents.prepare(worker,f.request);
    const memory=new MemoryBrokerStore(f.h.deps.clock);
    vi.spyOn(memory,"listApprovals").mockImplementation((ws,op)=>f.h.store.listApprovals(ws,op));
    const wrong=createBroker({...f.h.deps,store:memory});setPlatformBrokerForTests(wrong);
    await settings.putWorkspacePolicy(observer,{workspaceId:f.h.ids.wsA,updatedBy:"fixture-admin",params:{approvedRegions:["us-west-2"]}});
    expect(await createExecutionBroker(worker,async()=>wrong).approvalStatus(f.op.id)).toMatchObject({approved:true,rejected:false});
    await live(f);await expect(runPhase(f,phase)).rejects.toMatchObject({code:"workflow_start_intent"});
    expect((await inventory(f))?.phase??null).toBe(phase==="prepare"?null:"prepared");
  });
  for(const phase of ["prepare","claim"] as const)it(`refuses explicit process memory mode before ${phase} reads the durable store`,async()=>{
    const f=await fixture();if(phase==="claim")await intents.prepare(worker,f.request);
    const queries=vi.spyOn(worker,"query"),previous=process.env.ZENITH_PLATFORM_BROKER_MEMORY;
    try{vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY","1");
      await expect(Promise.resolve().then(async()=>await runPhase(f,phase))).rejects.toMatchObject({code:"workflow_start_intent"});expect(queries).not.toHaveBeenCalled();
    }finally{vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY",previous);}
    expect((await inventory(f))?.phase??null).toBe(phase==="prepare"?null:"prepared");
  });
  it("captures isolated ports once and discards the broker's mutable/alternative store",async()=>{
    const f=await fixture(),store=intents.createIsolatedStartIntentStoreForTests(f.h.broker);
    f.h.deps.store=new MemoryBrokerStore(f.h.deps.clock);f.h.deps.roles={resolve:async()=>({role:"none"})};
    f.h.deps.policy=async()=>scriptedEngine("replacement-deny",()=>({outcome:"deny",reasons:[]}));
    await store.prepare(worker,f.request);expect((await store.claim(worker,f.request)).dispatch).toBe(true);
  });
  for(const phase of ["prepare","claim"] as const)for(const human of ["bob","erin"] as const)it(`refuses freshly removed ${human==="bob"?"requester":"approver"} at ${phase} despite the old bulk snapshot`,async()=>{
    const f=await fixture();if(phase==="claim")await intents.prepare(worker,f.request);
    await observer.query("delete from public.zenith_workflow_start_test_members where workspace_id=$1 and id=$2",[f.h.ids.wsA,human]);
    expect(f.h.world.members.has(`${f.h.ids.wsA}|${human}`)).toBe(true);await live(f);
    await expect(runPhase(f,phase)).rejects.toThrow();expect((await inventory(f))?.phase??null).toBe(phase==="prepare"?null:"prepared");
  });

  async function seedSettings(f:Fixture){
    await settings.putWorkspacePolicy(observer,{workspaceId:f.h.ids.wsA,updatedBy:"fixture-admin",params:{}});
    await settings.putEnvironmentSettings(observer,{workspaceId:f.h.ids.wsA,environmentId:f.h.ids.envAProd,updatedBy:"fixture-admin",autonomyLevel:3});
  }
  async function changeSettings(f:Fixture,change:string){
    if(change==="two-person policy")await settings.putWorkspacePolicy(observer,{workspaceId:f.h.ids.wsA,updatedBy:"fixture-admin",params:{twoPersonProduction:true}});
    if(change==="denying policy")await settings.putWorkspacePolicy(observer,{workspaceId:f.h.ids.wsA,updatedBy:"fixture-admin",params:{approvedRegions:["us-west-2"]}});
    if(change==="policy version" || change==="insert default policy")await settings.putWorkspacePolicy(observer,{workspaceId:f.h.ids.wsA,updatedBy:"fixture-admin",params:{}});
    if(change==="policy JSON same version")await observer.query("update platform.workspace_policy set params=$2::text::jsonb where workspace_id=$1",[f.h.ids.wsA,JSON.stringify({twoPersonProduction:true})]);
    if(change==="deleted policy")await observer.query("delete from platform.workspace_policy where workspace_id=$1",[f.h.ids.wsA]);
    if(change==="replaced policy same version")await observer.tx(async tx=>{
      await tx.query("delete from platform.workspace_policy where workspace_id=$1",[f.h.ids.wsA]);
      await settings.putWorkspacePolicy(tx,{workspaceId:f.h.ids.wsA,updatedBy:"fixture-admin",params:{twoPersonProduction:true}});
    });
    if(change==="autonomy")await settings.putEnvironmentSettings(observer,{workspaceId:f.h.ids.wsA,environmentId:f.h.ids.envAProd,updatedBy:"fixture-admin",autonomyLevel:1});
    if(change==="environment version" || change==="insert default environment")await settings.putEnvironmentSettings(observer,{workspaceId:f.h.ids.wsA,environmentId:f.h.ids.envAProd,updatedBy:"fixture-admin",autonomyLevel:change==="environment version"?3:1});
    if(change==="autonomy same version")await observer.query("update platform.environment_settings set autonomy_level=1 where workspace_id=$1 and environment_id=$2",[f.h.ids.wsA,f.h.ids.envAProd]);
    if(change==="environment JSON same version")await observer.query("update platform.environment_settings set policy_params=$3::text::jsonb where workspace_id=$1 and environment_id=$2",[f.h.ids.wsA,f.h.ids.envAProd,JSON.stringify({maxReplicas:1})]);
    if(change==="deleted environment")await observer.query("delete from platform.environment_settings where workspace_id=$1 and environment_id=$2",[f.h.ids.wsA,f.h.ids.envAProd]);
    if(change==="insert foreign environment")await settings.putEnvironmentSettings(observer,{workspaceId:f.h.ids.wsB,environmentId:f.h.ids.envAProd,updatedBy:"fixture-admin",autonomyLevel:3});
  }
  const changes=["unchanged settings","two-person policy","denying policy","policy version","policy JSON same version","deleted policy","replaced policy same version", "autonomy","environment version","autonomy same version","environment JSON same version","deleted environment", "unchanged defaults","insert default policy","insert default environment","insert foreign environment"] as const;
  for(const phase of ["prepare","claim"] as const)it.each(changes)(`${phase} fences %s committed during a delayed consumed-approver read`,async change=>{
    const f=await fixture(),absent=change==="unchanged defaults" || change.startsWith("insert ");
    if(!absent)await seedSettings(f);if(phase==="claim")await intents.prepare(worker,f.request);
    const entered=barrier(),resume=barrier();model.beforeMember=async (_ws,human)=>{if(human==="erin"){entered.release();await resume.promise;}};
    const before=model.evaluations.length;
    const outcome:Promise<Outcome>=runPhase(f,phase).then(value=>({value}),error=>({error}));
    let observationFailure:unknown;
    try{
      await Promise.race([entered.promise,outcome.then(()=>{throw new Error("Final authority completed before the delayed approver read.");})]);
      expect(model.evaluations).toHaveLength(before+1);expect(model.evaluations.at(-1)?.twoPerson).toBe(false);
      expect((await inventory(f))?.phase??null).toBe(phase==="prepare"?null:"prepared");
      await changeSettings(f,change);await live(f);
    }catch(error){observationFailure=error;}finally{resume.release();}
    const completed=await outcome;if(observationFailure)throw observationFailure;
    expect(model.evaluations).toHaveLength(before+1); // no changed-state refresh/re-evaluation/retry
    if(change.startsWith("unchanged"))expect(completed).toHaveProperty(phase==="prepare"?"value.phase":"value.dispatch",phase==="prepare"?"prepared":true);
    else {expect(completed).toHaveProperty("error");expect((await inventory(f))?.phase??null).toBe(phase==="prepare"?null:"prepared");}
    expect(await worker.query("select 1 as available")).toEqual([{available:1}]);
  });

  for(const phase of ["prepare","claim"] as const)it(`refuses an already foreign globally keyed environment before ${phase}`,async()=>{
    const f=await fixture();if(phase==="claim")await intents.prepare(worker,f.request);
    await settings.putEnvironmentSettings(observer,{workspaceId:f.h.ids.wsB,environmentId:f.h.ids.envAProd,updatedBy:"fixture-admin",autonomyLevel:3});
    await expect(runPhase(f,phase)).rejects.toMatchObject({code:"workflow_start_intent"});
    expect((await inventory(f))?.phase??null).toBe(phase==="prepare"?null:"prepared");
  });

  for(const phase of ["prepare","claim"] as const)for(const change of ["unchanged","removed requester","demoted approver"] as const)it(`${phase} resolves ${change} after an exact observed operation-row lock waiter`,async()=>{
    const f=await fixture();if(phase==="claim")await intents.prepare(worker,f.request);
    const ready=barrier(),locked=barrier(),unlock=barrier();let claimantPid=0,blockerPid=0;
    const claimant:PlatformDbHandle={kind:worker.kind,identity:worker.identity,query:worker.query.bind(worker),exec:worker.exec.bind(worker),close:async()=>{},
      tx:async body=>worker.tx(async tx=>{claimantPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;ready.release();return body(tx);})};
    const blocking=db.tx(async tx=>{blockerPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
      await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for update",[f.h.ids.wsA,f.op.id]);locked.release();await unlock.promise;});
    await Promise.race([locked.promise,blocking.then(()=>{throw new Error("Owned blocker did not acquire the operation row.");})]);
    const outcome:Promise<Outcome>=runPhase(f,phase,claimant).then(value=>({value}),error=>({error}));let observationFailure:unknown;
    try{
      await Promise.race([ready.promise,outcome.then(()=>{throw new Error("Authority ended before its exact PostgreSQL backend was observed.");})]);
      expect(claimantPid).toBeGreaterThan(0);expect(claimantPid).not.toBe(blockerPid);
      const deadline=Date.now()+5_000;let blocked=false;
      while(Date.now()<deadline){
        const state=await observer.tx(async fresh=>{await fresh.query("select pg_stat_clear_snapshot()");
          return (await fresh.query<{observer_pid:number;blocked:boolean}>(`select pg_backend_pid() as observer_pid,
            exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock' and query=$3
              and $2::integer=any(pg_blocking_pids(pid))) as blocked`,[claimantPid,blockerPid,
              "select * from platform.operations where workspace_id=$1 and id=$2 for update"]))[0];});
        expect(state.observer_pid).not.toBe(claimantPid);expect(state.observer_pid).not.toBe(blockerPid);
        if(state.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);expect((await inventory(f))?.phase??null).toBe(phase==="prepare"?null:"prepared");
      if(change==="removed requester")await observer.query("delete from public.zenith_workflow_start_test_members where workspace_id=$1 and id='bob'",[f.h.ids.wsA]);
      if(change==="demoted approver")await observer.query("update public.zenith_workflow_start_test_members set role='viewer' where workspace_id=$1 and id='erin'",[f.h.ids.wsA]);
      expect(f.h.world.members.get(`${f.h.ids.wsA}|erin`)).toBe("admin");await live(f);
    }catch(error){observationFailure=error;}finally{unlock.release();await blocking;}
    const completed=await outcome;if(observationFailure)throw observationFailure;
    if(change==="unchanged")expect(completed).toHaveProperty(phase==="prepare"?"value.phase":"value.dispatch",phase==="prepare"?"prepared":true);
    else {expect(completed).toHaveProperty("error");expect((await inventory(f))?.phase??null).toBe(phase==="prepare"?null:"prepared");}
  });
  for(const phase of ["prepare","claim"] as const)it(`${phase} authority abort rolls back and a late member answer cannot commit`,async()=>{
    const f=await fixture();if(phase==="claim")await intents.prepare(worker,f.request);
    const controller=new AbortController(),entered=barrier(),resume=barrier();
    vi.spyOn(AbortSignal,"timeout").mockReturnValue(controller.signal);
    model.beforeMember=async (_ws,human)=>{if(human==="erin"){entered.release();await resume.promise;}};
    const outcome:Promise<Outcome>=runPhase(f,phase).then(value=>({value}),error=>({error}));
    try{await Promise.race([entered.promise,outcome.then(()=>{throw new Error("Authority ended before the delayed member read.");})]);controller.abort();
      expect(await outcome).toHaveProperty("error");expect((await inventory(f))?.phase??null).toBe(phase==="prepare"?null:"prepared");
      expect(await worker.query("select 1 as available")).toEqual([{available:1}]);
    }finally{controller.abort();resume.release();await outcome;}
  });
});
