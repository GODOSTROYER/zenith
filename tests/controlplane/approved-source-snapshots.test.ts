/** Actual PostgreSQL persistence/locks; GitHub HTTP and signing fixtures are modeled, never live installation evidence. */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { withPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { normalizePlan } from "@/lib/tofu/plan";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { openPlatformDb, type PlatformDbHandle, repos } from "@/lib/controlplane/db";
import { createApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { migration0013ApprovedSourceSnapshots } from "@/lib/controlplane/db/migrations/0013_approved_source_snapshots";
import { sourceRecipe, sourceSnapshotDigest, sourceSnapshotSetDigest, type SourceCaptureInput } from "@/lib/execution/source-snapshot";
import { createSourceBundles } from "@/lib/platform/source-bundle";
import { PG_URL, seedApprovedOperation, newWorkspace } from "./_support/harness";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";
import { writeTar } from "../_support/tar";
import { gzipSync } from "node:zlib";
import { keys, api } from "../sources/fixtures";

const owner=vi.hoisted(()=>({db:undefined as PlatformDbHandle|undefined}));
vi.mock("@/lib/controlplane/db/open",async original=>({...await original<typeof import("@/lib/controlplane/db/open")>(),platformDb:async()=>{if(!owner.db)throw new Error("Owned source fixture database is unavailable.");return owner.db;}}));
if(process.env.ZENITH_TEST_APPROVED_SOURCE_REQUIRED==="1" && !PG_URL)throw new Error("Approved source acceptance requires owned PostgreSQL.");

describe.skipIf(!PG_URL)("permanent approved source snapshots [postgres]",()=>{
  let db:PlatformDbHandle,peer:PlatformDbHandle,observer:PlatformDbHandle,material:Awaited<ReturnType<typeof keys>>;
  beforeAll(async()=>{db=await openPlatformDb({kind:"postgres",url:PG_URL!,migrate:true,max:1});await db.exec(migration0013ApprovedSourceSnapshots.sql);
    peer=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});observer=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});owner.db=observer;material=await keys();},60_000);
  afterEach(()=>vi.unstubAllEnvs());
  afterAll(async()=>{owner.db=undefined;await material?.close();await observer?.close();await peer?.close();await db?.close();});
  async function fixture(bound=false,requestedRef="main"){
    const workspaceId=newWorkspace(),environmentId=`env_${workspaceId}`,projectId=`proj_${workspaceId}`;
    const {operation:op}=await seedApprovedOperation(db,workspaceId,{ttlMs:120_000,proposal:{capability:"deployment.deploy",scope:{workspaceId,projectId,environmentId}}});
    const lease=await repos.leases.acquire(db,{workspaceId,scope:`env:${environmentId}`,holder:`worker:${op.id}`,ttlMs:120_000});if(!lease)throw new Error("Source fixture lease missing.");
    await repos.operations.claimForExecution(db,{workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:`workflow:${op.id}`,leaseMs:120_000,lease});
    const pipeline=mkNode("build_pipeline/web","build_pipeline","aws:codebuild_project",{location:"customer_account",source:{repo:"acme/app",ref:requestedRef,dockerfile:"Dockerfile"}},{region:"eu-west-1",specDigest:digest("pipeline")});
    const service=mkNode("container_service/web","container_service","aws:ecs_service",{artifact:{type:"built",pipeline:pipeline.address}},{region:"eu-west-1",specDigest:digest("service")});
    for(const node of [pipeline,service])await repos.resources.upsertDesired(db,{workspaceId,projectId,environmentId,node,status:"planned"});
    if(bound){await db.query("insert into platform.github_source_bindings (workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values ($1,'42',7,99,'acme','app',1,'fixture-admin')",[workspaceId]);vi.stubEnv("ZENITH_GITHUB_APP_ID","42");vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE",material.config.privateKeyFile);}
    const state={commit:"a".repeat(40),body:"FROM scratch\n",id:99,private:bound,delayed:undefined as Promise<void>|undefined};const app=api();
    const fetchImpl=vi.fn<typeof fetch>(async(raw,init)=>{const url=String(raw);
      if(url==="https://api.github.com/repos/acme/app")return Response.json({id:state.id,name:"app",owner:{login:"acme"},private:state.private});
      if(url.startsWith("https://api.github.com/repos/acme/app/commits/"))return new Response(url.endsWith(encodeURIComponent(requestedRef))?state.commit:url.split("/").at(-1)!);
      if(url.startsWith("https://codeload.github.com/acme/app/tar.gz/")){await state.delayed;return new Response(new Uint8Array(gzipSync(writeTar([{path:"root/Dockerfile",bytes:Buffer.from(state.body)},{path:"root/app.txt",bytes:Buffer.from("immutable fixture")}]))));}
      return app(raw,init);
    });
    const input:SourceCaptureInput={workspaceId,operationId:op.id,projectId,environmentId,serviceAddress:service.address,serviceSpecDigest:service.specDigest,pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,
      provider:"aws",region:service.region,repository:"acme/app",requestedRef,dockerfile:"Dockerfile",recipeDigest:sourceRecipe(service,pipeline),archiveFormat:"zip"};
    const port=createSourceBundles({fetchImpl}).port,a=createApprovedSourceSnapshotStore(db),b=createApprovedSourceSnapshotStore(peer),scope={workspaceId,operationId:op.id,projectId,environmentId};
    const captured=await port.capture!(input);return {a,b,scope,lease,op,input,captured,port,state,fetchImpl,pipeline,service,bound};
  }
  it("persists one immutable row across two actual independent handles and reuses it after producer loss",async()=>{
    const f=await fixture();expect(db).not.toBe(peer);const rows=await Promise.all([f.a.retain(f.captured,f.lease),f.b.retain(f.captured,f.lease)]);
    expect(rows.map(sourceSnapshotDigest)).toEqual([sourceSnapshotDigest(f.captured),sourceSnapshotDigest(f.captured)]);expect(await f.b.list(f.scope)).toEqual([f.captured]);await f.b.assertCurrent(f.captured);
  });
  it("rollback before commit retains no partial source row and allows a subsequent capture",async()=>{
    const f=await fixture();await expect(db.tx(async()=>{await f.a.retain(f.captured,f.lease);throw new Error("Isolated precommit crash.");})).rejects.toThrow("precommit");expect(await f.b.list(f.scope)).toEqual([]);await f.b.retain(f.captured,f.lease);
  });
  it("a lost acknowledgement leaves the same permanent row for an independent retry",async()=>{
    const f=await fixture();await f.a.retain(f.captured,f.lease);await expect(Promise.resolve().then(()=>{throw new Error("Injected postcommit acknowledgement loss.");})).rejects.toThrow();expect(await f.b.retain(f.captured,f.lease)).toEqual(f.captured);
  });
  it.each(["main","v1.0.0"])("retained %s bytes remain pinned after branch/tag movement across source-bound plan recording",async ref=>{
    const f=await fixture(false,ref);await f.a.retain(f.captured,f.lease);
    const set=sourceSnapshotSetDigest([f.captured]),plan=normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},{configDigest:digest("config"),lockDigest:digest("lock"),addressMap:{},executableSourceDigest:set});
    await db.query("update platform.operations set plan_digest=$3 where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.op.id,plan.planDigest]);
    await repos.evidence.insert(db,{workspaceId:f.scope.workspaceId,operationId:f.op.id,kind:"tofu_plan",digest:plan.planDigest,summary:planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:digest("graph"),stage:"plan",approvedSources:[f.captured]}).summary,simulated:false});
    f.state.commit="b".repeat(40);await f.port.verify!(f.captured);await f.b.assertReviewed(f.captured);
    expect(f.fetchImpl.mock.calls.filter(([url])=>String(url).startsWith("https://codeload.github.com/")).every(([url])=>String(url).endsWith("a".repeat(40)))).toBe(true);
    const moved=await f.port.capture!(f.input);await expect(f.b.retain(moved,f.lease)).rejects.toThrow();expect(await f.a.list(f.scope)).toEqual([f.captured]);
  });
  it("a different canonical archive for the same commit refuses while preserving the original row",async()=>{
    const f=await fixture();await f.a.retain(f.captured,f.lease);f.state.body="FROM scratch\nLABEL moved=true\n";await expect(f.port.verify!(f.captured)).rejects.toThrow();const moved=await f.port.capture!(f.input);await expect(f.b.retain(moved,f.lease)).rejects.toThrow();expect(await f.a.list(f.scope)).toEqual([f.captured]);
  });
  it.each(["service","pipeline"] as const)("same spec_digest with changed %s JSON cannot establish native recipe authority",async kind=>{
    const f=await fixture();await db.query("update platform.resources set spec=spec || $3::text::jsonb where workspace_id=$1 and address=$2",[f.scope.workspaceId,kind==="service"?f.service.address:f.pipeline.address,JSON.stringify({changedRecipe:true})]);
    await expect(f.a.retain(f.captured,f.lease)).rejects.toThrow();expect(await f.b.list(f.scope)).toEqual([]);
  });
  it.each(["service","pipeline"] as const)("retained %s JSON mutation with unchanged digest refuses current authority",async kind=>{
    const f=await fixture();await f.a.retain(f.captured,f.lease);await db.query("update platform.resources set spec=spec || $3::text::jsonb where workspace_id=$1 and address=$2",[f.scope.workspaceId,kind==="service"?f.service.address:f.pipeline.address,JSON.stringify({changedRecipe:true})]);await expect(f.b.assertCurrent(f.captured)).rejects.toThrow();
  });
  it("authentic capture at a different requested ref cannot borrow the owning recipe digest",async()=>{
    const f=await fixture(),different=await f.port.capture!({...f.input,requestedRef:"a".repeat(40)});
    await expect(f.a.retain(different,f.lease)).rejects.toThrow();expect(await f.b.list(f.scope)).toEqual([]);
  });
  it.each(["workspaceId","operationId","projectId","environmentId"] as const)("foreign %s cannot read or retain another scope",async key=>{
    const f=await fixture();await f.a.retain(f.captured,f.lease);expect(await f.b.list({...f.scope,[key]:`other_${f.scope[key]}`})).toEqual([]);
    await expect(f.b.retain({...f.captured,[key]:`other_${f.captured[key]}`},f.lease)).rejects.toThrow();expect(await f.a.list(f.scope)).toEqual([f.captured]);
  });
  it("raw/as-cast metadata cannot forge actual archive capture provenance",async()=>{
    const f=await fixture();await expect(f.a.retain({...f.captured},f.lease)).rejects.toThrow();expect(await f.a.list(f.scope)).toEqual([]);
  });
  it.each(["operation","execution","fence"] as const)("expired %s authority refuses both first capture and current retained row",async kind=>{
    const f=await fixture();await f.a.retain(f.captured,f.lease);
    if(kind==="fence")await db.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and scope=$2",[f.scope.workspaceId,f.lease.scope]);
    else await db.query(`update platform.operations set ${kind==="operation"?"expires_at":"lease_until"}=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2`,[f.scope.workspaceId,f.op.id]);
    await expect(f.b.retain(f.captured,f.lease)).rejects.toThrow();await expect(f.b.assertCurrent(f.captured)).rejects.toThrow();
  });
  it.each(["revoked","removed","replaced"] as const)("remembered private binding %s never becomes anonymous even when repository is public",async kind=>{
    const f=await fixture(true);await f.a.retain(f.captured,f.lease);f.state.private=false;
    if(kind==="removed")await db.query("delete from platform.github_source_bindings where workspace_id=$1",[f.scope.workspaceId]);
    else await db.query(`update platform.github_source_bindings set version=version+1,${kind==="revoked"?"revoked_at=clock_timestamp()":"repository_id=100"} where workspace_id=$1`,[f.scope.workspaceId]);
    await expect(f.port.verify!(f.captured)).rejects.toThrow();await expect(f.b.assertCurrent(f.captured)).rejects.toThrow();
  });
  it("retains a matching bound identity and refuses missing App configuration after capture",async()=>{
    const f=await fixture(true);await f.a.retain(f.captured,f.lease);await f.port.verify!(f.captured);expect(f.captured.githubBinding).toEqual({appId:"42",installationId:7,repositoryId:99,version:1});
    vi.stubEnv("ZENITH_GITHUB_APP_ID","");vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE","");await expect(f.port.verify!(f.captured)).rejects.toThrow();
  });
  it("repository reuse/replacement at the same canonical slug refuses immutable numeric identity",async()=>{
    const f=await fixture();await f.a.retain(f.captured,f.lease);f.state.id=100;await expect(f.port.verify!(f.captured)).rejects.toThrow();
  });
  it("owning PostgreSQL withPlanReview returns the source-bound normalized plan and safe metadata",async()=>{
    const f=await fixture();await f.a.retain(f.captured,f.lease);const source=sourceSnapshotSetDigest([f.captured]);
    const plan=normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},{configDigest:digest("config"),lockDigest:digest("lock"),addressMap:{},executableSourceDigest:source});
    const evidence=planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:digest("graph"),stage:"plan",approvedSources:[f.captured]});
    await db.query("update platform.operations set plan_digest=$3 where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.op.id,plan.planDigest]);await repos.evidence.insert(db,{workspaceId:f.scope.workspaceId,operationId:f.op.id,kind:"tofu_plan",digest:plan.planDigest,summary:evidence.summary,simulated:false});
    const operation=(await repos.operations.getForSystem(peer,f.op.id))!;const reviewed=await withPlanReview(peer,{...operation,approvalRound:0});
    expect(reviewed.planReview?.view).toMatchObject({executableSourceDigest:source,approvedSources:[{commit:f.captured.commitSha,recipeDigest:f.captured.recipeDigest,archiveDigest:f.captured.archiveDigest}]});await f.b.assertReviewed(f.captured);
  });
  it("owning PostgreSQL legacy source-free view remains byte-compatible when no native snapshots exist",async()=>{
    const f=await fixture(),plan=normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},{configDigest:digest("config"),lockDigest:digest("lock"),addressMap:{}});
    const summary=planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:digest("graph"),stage:"plan"}).summary;
    await db.query("update platform.operations set plan_digest=$3 where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.op.id,plan.planDigest]);await repos.evidence.insert(db,{workspaceId:f.scope.workspaceId,operationId:f.op.id,kind:"tofu_plan",digest:plan.planDigest,summary,simulated:false});
    const op=(await repos.operations.getForSystem(peer,f.op.id))!,review=await withPlanReview(peer,{...op,approvalRound:0});expect(review.planReview?.view).toEqual(summary.view);
    expect(await f.a.list(f.scope)).toEqual([]);
  });
  it.each(["foreign source set and display","changed display","absent native row","foreign project row","wrong native hash","all source fields stripped"])("owning PostgreSQL browser projection refuses %s without returning a source-less approval",async failure=>{
    const f=await fixture();
    if(failure!=="absent native row" && failure!=="foreign project row" && failure!=="wrong native hash")await f.a.retain(f.captured,f.lease);
    if(failure==="foreign project row" || failure==="wrong native hash"){
      const native={...f.captured,...(failure==="foreign project row"?{projectId:"foreign-project"}:{})};
      await db.query("insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)",[f.scope.workspaceId,f.op.id,native.projectId,f.scope.environmentId,native.serviceAddress,JSON.stringify(native),failure==="wrong native hash"?digest("wrong native hash"):sourceSnapshotDigest(native)]);
    }
    const set=sourceSnapshotSetDigest([f.captured]),plan=normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},{configDigest:digest("config"),lockDigest:digest("lock"),addressMap:{},executableSourceDigest:set});
    const summary=planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:digest("graph"),stage:"plan",approvedSources:[f.captured]}).summary;
    if(failure==="foreign source set and display"){
      const foreign={...f.captured,workspaceId:"foreign-workspace",commitSha:"b".repeat(40)};summary.executableSourceDigest=sourceSnapshotSetDigest([foreign]);
      const view=summary.view as {executableSourceDigest:string;approvedSources:{commit:string}[]};view.executableSourceDigest=summary.executableSourceDigest as string;view.approvedSources[0].commit=foreign.commitSha;
    }
    if(failure==="all source fields stripped"){delete summary.executableSourceDigest;const view=summary.view as Record<string,unknown>;delete view.executableSourceDigest;delete view.approvedSources;}
    if(failure==="changed display")(summary.view as {approvedSources:{commit:string}[]}).approvedSources[0].commit="b".repeat(40);
    await db.query("update platform.operations set plan_digest=$3 where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.op.id,plan.planDigest]);await repos.evidence.insert(db,{workspaceId:f.scope.workspaceId,operationId:f.op.id,kind:"tofu_plan",digest:plan.planDigest,summary,simulated:false});
    const op=(await repos.operations.getForSystem(peer,f.op.id))!;
    await expect(withPlanReview(peer,{...op,approvalRound:0})).rejects.toThrow("Approved source review is unavailable");
  });
  it("only exact source-bound nonsimulated plan evidence enables native upload readiness",async()=>{
    const f=await fixture();await f.a.retain(f.captured,f.lease);await expect(f.b.assertReviewed(f.captured)).rejects.toThrow();
    const planDigest=digest("approved source fixture normalized plan"),source=sourceSnapshotSetDigest([f.captured]);
    await db.query("update platform.operations set plan_digest=$3 where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.op.id,planDigest]);
    await repos.evidence.insert(db,{workspaceId:f.scope.workspaceId,operationId:f.op.id,kind:"tofu_plan",digest:planDigest,summary:{stage:"plan",planDigest,executableSourceDigest:source},simulated:false});await f.b.assertReviewed(f.captured);
    await db.query("update platform.evidence set simulated=true where workspace_id=$1 and operation_id=$2",[f.scope.workspaceId,f.op.id]);await expect(f.b.assertReviewed(f.captured)).rejects.toThrow();
  });
  it("rejects new source attachment once an old plan digest is recorded",async()=>{
    const f=await fixture();await db.query("update platform.operations set plan_digest=$3 where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.op.id,digest("legacy plan")]);await expect(f.a.retain(f.captured,f.lease)).rejects.toThrow();
  });
  it("revocation during a delayed archive read refuses capture before native persistence",async()=>{
    const f=await fixture(true);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    const original=f.fetchImpl.getMockImplementation()!;f.fetchImpl.mockImplementation(async(raw,init)=>{if(String(raw).startsWith("https://codeload.github.com/")){entered();await gate;}return original(raw,init);});
    const outcome=f.port.capture!(f.input).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try{await reached;await observer.query("update platform.github_source_bindings set version=version+1,revoked_at=clock_timestamp() where workspace_id=$1",[f.scope.workspaceId]);}
    finally{release();}
    const result=await outcome;expect(result.error).toBeDefined();expect(result.value).toBeUndefined();expect(await f.b.list(f.scope)).toEqual([]);
  });
  it("a proved resource waiter rechecks current operation clock after release, without capturing a stale source row",async()=>{
    const f=await fixture();
    await observer.query("update platform.operations set expires_at=clock_timestamp()+interval '3 seconds' where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.op.id]);
    let claimant=0,blocker=0,ready!:()=>void;const started=new Promise<void>(r=>{ready=r;});let pending!:Promise<{error?:unknown}>;
    await db.tx(async tx=>{
      blocker=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
      await tx.query("select id from platform.resources where workspace_id=$1 and address=$2 for update",[f.scope.workspaceId,f.service.address]);
      pending=peer.tx(async own=>{claimant=(await own.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;ready();await f.b.retain(f.captured,f.lease);}).then(()=>({}),error=>({error}));
      await started;const deadline=Date.now()+8_000;let waited=false;
      while(Date.now()<deadline){await observer.query("select pg_stat_clear_snapshot()");
        const rows=await observer.query<{waiting:boolean;expired:boolean}>(`select exists(select 1 from pg_stat_activity a where a.pid=$1 and a.wait_event_type='Lock'
          and $2=any(pg_blocking_pids(a.pid)) and a.query=$3) as waiting,
          (select expires_at<=clock_timestamp() from platform.operations where workspace_id=$4 and id=$5) as expired`,[claimant,blocker,"select address,kind,provider,region,spec_digest,spec,ownership from platform.resources where workspace_id=$1 and project_id=$2 and environment_id=$3 and address in ($4,$5) order by address for share",f.scope.workspaceId,f.op.id]);
        if(rows[0]?.waiting){waited=true;if(rows[0].expired)break;}await new Promise(r=>setTimeout(r,25));
      }
      expect(waited).toBe(true);expect(new Set([claimant,blocker,(await observer.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid]).size).toBe(3);
      expect((await observer.query<{expired:boolean}>("select expires_at<=clock_timestamp() as expired from platform.operations where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.op.id]))[0].expired).toBe(true);
    });
    expect((await pending).error).toBeDefined();expect(await f.a.list(f.scope)).toEqual([]);
  },15_000);
  it("permanent rows refuse UPDATE, DELETE and TRUNCATE while no-op UPDATE preserves identity",async()=>{
    const f=await fixture();await f.a.retain(f.captured,f.lease);await db.query("update platform.approved_source_snapshots set snapshot=snapshot where workspace_id=$1 and operation_id=$2",[f.scope.workspaceId,f.op.id]);
    for(const statement of ["update platform.approved_source_snapshots set snapshot_digest=$3 where workspace_id=$1 and operation_id=$2","delete from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2"]){await expect(db.query(statement,statement.startsWith("update")?[f.scope.workspaceId,f.op.id,digest("tamper")]:[f.scope.workspaceId,f.op.id])).rejects.toThrow("immutable");}
    await expect(db.exec("truncate platform.approved_source_snapshots")).rejects.toThrow("immutable");expect(await f.b.list(f.scope)).toEqual([f.captured]);
  });
  it("schema rejects missing/nonnumeric/foreign provider-format metadata independently of TypeScript",async()=>{
    const f=await fixture();for(const alter of [(s:Record<string,unknown>)=>{delete s.commitSha;},(s:Record<string,unknown>)=>{s.repositoryId=1.1;},(s:Record<string,unknown>)=>{s.archiveFormat="tar.gz";},(s:Record<string,unknown>)=>{s.githubBinding={appId:"42"};},(s:Record<string,unknown>)=>{s.requestedRef="feature/../main";},(s:Record<string,unknown>)=>{s.region=1;},(s:Record<string,unknown>)=>{s.dockerfile="./Dockerfile";}]){
      const s:Record<string,unknown>={...f.captured};alter(s);await expect(db.query("insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)",[f.scope.workspaceId,f.op.id,f.scope.projectId,f.scope.environmentId,f.service.address,JSON.stringify(s),digest(s)])).rejects.toThrow();}
  });
});
