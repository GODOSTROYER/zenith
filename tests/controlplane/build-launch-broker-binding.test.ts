/** Real PostgreSQL launch receipts and SDK mocks; product membership/scope reads are modeled, not live PostgREST/TLS. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BatchGetBuildsCommand, BatchGetProjectsCommand, CodeBuildClient, StartBuildCommand, type Build, type Project } from "@aws-sdk/client-codebuild";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { immutableSourceSnapshot, sourceRecipe, sourceSnapshotDigest, sourceSnapshotSetDigest } from "@/lib/execution/source-snapshot";
import { migration0013ApprovedSourceSnapshots } from "@/lib/controlplane/db/migrations/0013_approved_source_snapshots";
import { digest } from "@/lib/controlplane/digest";
import * as repos from "@/lib/controlplane/db/repos";
import { openPlatformDb } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { createIsolatedBuildLauncherForTests, startBuild } from "@/lib/providers/aws/drivers/compute/codebuild-builds";
import { createBroker, setPlatformBrokerForTests, resetPlatformBrokerForTests } from "@/lib/capabilities/platform";
import { PlatformBrokerStore } from "@/lib/capabilities/platform-store";
import { MemoryBrokerStore } from "@/lib/capabilities/memory-store";
import type { WorkspaceRoleOrNone } from "@/lib/capabilities/ports";
import { registerEnvironment } from "@/lib/reconcile/platform";
import { LANES, PG_URL, openLane } from "./_support/harness";
import { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, user, sessionFor, type Harness } from "../capabilities/support";
import { makePlan, change } from "../execution/fakes/fixtures";
import { buildPlanFacts } from "@/lib/capabilities/evaluate";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { fakeSession, mkDriverContext, mkNode } from "../providers/aws/drivers/compute/fixtures";

const model = vi.hoisted(() => ({
  active: undefined as Harness | undefined,
  currentMembers: new Map<string, WorkspaceRoleOrNone>(),
  scopeTx: undefined as Sql | undefined,
  memberRead: undefined as undefined | ((workspaceId: string, humanId: string, signal: AbortSignal) => Promise<{data: unknown; error: unknown}>),
  memberCalls: [] as { workspaceId: string; humanId: string; signal: AbortSignal }[],
  policyInputs: [] as { autonomyLevel?: number; twoPerson: boolean; regions?: string[] }[],
}));
// Only product ports and bundle loading are modeled. The evaluator, broker,
// PlatformBrokerStore, claim transaction, approvals, CAS and receipts are real.
vi.mock("@/lib/capabilities/product-adapters", async original => ({
  ...await original<typeof import("@/lib/capabilities/product-adapters")>(),
  productRoleResolver: () => { if (!model.active) throw new Error("Fixture roles unavailable."); return model.active.deps.roles; },
}));
vi.mock("@/lib/platform/scopes", async original => ({
  ...await original<typeof import("@/lib/platform/scopes")>(),
  platformScopeResolver: (tx: Sql) => { model.scopeTx = tx; if (!model.active) throw new Error("Fixture scopes unavailable."); return model.active.deps.scopes; },
}));
vi.mock("@/lib/policy", async original => ({
  ...await original<typeof import("@/lib/policy")>(),
  loadPolicyEngine: () => { if (!model.active) throw new Error("Fixture policy unavailable."); return model.active.deps.policy(); },
}));
vi.mock("@/lib/execution/product-port", async original => ({
  ...await original<typeof import("@/lib/execution/product-port")>(),
  workerStoreScope: async <T>(body: () => Promise<T>): Promise<T> => body(),
}));
vi.mock("@/lib/db/store", async original => ({
  ...await original<typeof import("@/lib/db/store")>(), isPostgres: () => true,
}));
vi.mock("@/lib/db/postgres-store", async original => ({
  ...await original<typeof import("@/lib/db/postgres-store")>(),
  pgClient: () => ({ from: (table: string) => {
    if (table !== "members") throw new Error("Unexpected modeled table.");
    const filters = new Map<string, string>(); let signal!: AbortSignal;
    const query = {
      select: (columns: string) => { expect(columns).toBe("id,workspace_id,role"); return query; },
      eq: (column: string, value: string) => { filters.set(column, value); return query; },
      abortSignal: (value: AbortSignal) => { signal = value; return query; },
      maybeSingle: async () => {
        const workspaceId = filters.get("workspace_id")!, humanId = filters.get("id")!;
        if (!workspaceId || !humanId || !signal) throw new Error("Unscoped modeled read.");
        model.memberCalls.push({workspaceId,humanId,signal});
        if (model.memberRead) return model.memberRead(workspaceId,humanId,signal);
        const role = model.currentMembers.get(`${workspaceId}|${humanId}`);
        return { data: !role || role === "none" ? null : {id:humanId,workspace_id:workspaceId,role}, error:null };
      },
    }; return query;
  } }),
}));

closeSharedPgliteAfterAll();

describe.skipIf(!PG_URL)("CodeBuild transaction-bound broker [postgres]", () => {
  let world: Awaited<ReturnType<typeof openLane>>;
  let observer: Awaited<ReturnType<typeof openPlatformDb>>;
  const cb = mockClient(CodeBuildClient), s3 = mockClient(S3Client);
  beforeAll(async () => { world = await openLane(LANES.find(l => l.name === "postgres")!); await world.db.exec(migration0013ApprovedSourceSnapshots.sql); observer=await openPlatformDb({kind:"postgres",url:PG_URL,max:1,migrate:false}); }, 60_000);
  afterAll(async () => { cb.restore(); s3.restore(); await observer?.close(); await world?.close(); });
  beforeEach(() => { cb.reset(); s3.reset(); model.active = undefined; model.currentMembers.clear(); model.memberRead = undefined; model.memberCalls = []; model.policyInputs = []; model.scopeTx = undefined; resetPlatformBrokerForTests(); });
  afterEach(() => { resetPlatformBrokerForTests(); vi.restoreAllMocks(); });
  async function fixture(boundSource=false) {
    const h=await makeHarness({kind:"postgres",engine:scriptedEngine("build-policy",input => {
      model.policyInputs.push({autonomyLevel:input.environment?.autonomyLevel,twoPerson:input.workspacePolicy.twoPersonProduction,regions:input.workspacePolicy.approvedRegions});
      if (input.workspacePolicy.approvedRegions && !input.workspacePolicy.approvedRegions.includes(input.environment?.region ?? ""))
        return { outcome: "deny", reasons: [{ code: "region_denied", message: "Region denied." }] };
      return requireApproval(input.workspacePolicy.twoPersonProduction ? 2 : 1,"admin",true);
    })});
    model.active = h; model.currentMembers = new Map(h.world.members);
    const workspaceId=h.ids.wsA, environmentId=h.ids.envAProd, accountId="123456789012", region="eu-west-1";
    h.deps.clock={now:()=>new Date()};
    h.world.environments.get(environmentId)!.region=region;
    const {operation:op}=await h.broker.propose({capability:"deployment.deploy",scope:{workspaceId,projectId:h.ids.projA,environmentId},input:{}},user("alice"));
    const decide=(planDigest?:string)=>h.broker.approve({workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,planDigest,approver:user("erin"),session:sessionFor("erin")});
    await decide();
    await h.broker.beginExecution({workspaceId,operationId:op.id,holder:`workflow:${op.id}`,audience:"worker"});
    const ports=createOperationsPort(world.db), worker=createExecutionBroker(world.db,async()=>h.broker);
    const projectName = "zenith-build-web", projectArn = `arn:aws:codebuild:${region}:${accountId}:project/${projectName}`;
    const pipeline = mkNode("build_pipeline/web", "build_pipeline", "aws:codebuild_project", { source: { repo: "https://github.com/acme/web", ref: "revision" } }, { region, specDigest: digest("pipeline"), externalRef: projectArn });
    const service = mkNode("container_service/web", "container_service", "aws:ecs_service", { artifact: { type: "built", pipeline: pipeline.address } }, { region, specDigest: digest("service") });
    for (const node of [pipeline, service]) await repos.resources.upsertDesired(world.db, { workspaceId, projectId:h.ids.projA, environmentId, node, status: "active" });
    const sourceDigest=digest("source");
    const sourceSnapshot=immutableSourceSnapshot({format:"zenith.approved-source.v1",workspaceId,operationId:op.id,projectId:h.ids.projA,environmentId,
      serviceAddress:service.address,serviceSpecDigest:service.specDigest,pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,provider:"aws",region,
      owner:"acme",repo:"web",repositoryId:99,requestedRef:"revision",commitSha:"a".repeat(40),githubBinding:boundSource?{appId:"42",installationId:7,repositoryId:99,version:1}:null,
      dockerfile:"Dockerfile",dockerfileDigest:digest("modeled Dockerfile bytes"),recipeDigest:sourceRecipe(service,pipeline),archiveFormat:"zip",archiveDigest:sourceDigest,archiveBytes:100});
    // Modeled snapshot/archive provenance; real owning PostgreSQL/CAS/approval and SDK protocol below.
    if(boundSource)await world.db.query("insert into platform.github_source_bindings(workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values ($1,'42',7,99,'acme','web',1,'fixture-admin')",[workspaceId]);
    await world.db.query("insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)",
      [workspaceId,op.id,h.ids.projA,environmentId,service.address,JSON.stringify(sourceSnapshot),sourceSnapshotDigest(sourceSnapshot)]);
    const plan=makePlan({changes:[change({address:"aws_codebuild_project.web",type:"aws_codebuild_project",action:"create"})]});
    plan.executableSourceDigest=sourceSnapshotSetDigest([sourceSnapshot]);
    plan.planDigest=digest({configDigest:plan.configDigest,lockDigest:plan.lockDigest,tofuVersion:plan.tofuVersion,resourceChanges:plan.resourceChanges,outputChanges:plan.outputChanges,executableSourceDigest:plan.executableSourceDigest});
    const facts=buildPlanFacts(plan)!;
    await repos.evidence.insert(world.db,{workspaceId,operationId:op.id,kind:"tofu_plan",digest:plan.planDigest,summary:planEvidence({plan,facts,cost:{},graphDigest:digest("graph"),stage:"plan",approvedSources:[sourceSnapshot]}).summary,simulated:false});
    await ports.setPlanDigest({workspaceId,operationId:op.id,planDigest:plan.planDigest});
    const policy=await worker.reevaluate(op.id,facts);
    await ports.setPolicyDecision({workspaceId,operationId:op.id,decisionId:policy.decisionId});
    await ports.transition({workspaceId,operationId:op.id,to:"awaiting_approval"});
    await decide(plan.planDigest);
    const lease=await repos.leases.acquire(world.db,{workspaceId,scope:`env:${environmentId}`,holder:`worker:${op.id}`,ttlMs:60_000});
    if(!lease) throw new Error("Fixture lease not acquired.");
    await repos.operations.claimForExecution(world.db,{workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:`workflow:${op.id}`,leaseMs:60_000,lease,expectedPolicyVersion:"build-policy"});
    await worker.issueGrant(op.id,"worker",lease);
    const startBuild=createIsolatedBuildLauncherForTests(h.broker);
    // This is only the build adapter's authority fixture, not plan/apply acceptance.
    await world.db.query("insert into platform.plan_artifact_uses(workspace_id,operation_id,phase) values ($1,$2,'succeeded')", [workspaceId, op.id]);
    const connection = await repos.connections.create(world.db, { workspaceId, createdBy: "fixture-admin", config: { provider: "aws", mode: "oidc_web_identity", accountId, region, observeRoleArn: `arn:aws:iam::${accountId}:role/observe`, deployRoleArn: `arn:aws:iam::${accountId}:role/deploy` } });
    await repos.connections.recordVerification(world.db, { workspaceId, id: connection.id, ok: true });
    await registerEnvironment(world.db, { environment: { workspaceId, environmentId, provider: "aws", region, class: "development", connection: { id: connection.id, status: "verified" } } });
    const sourceBucket = "zenith-build-source", sourceS3Key = `zenith/${environmentId}/web/${sourceDigest}.zip`;
    const input = { sourceS3Key, sourceDigest, externalId: projectArn, service };
    const ctx = mkDriverContext({ workspaceId, environmentId, region, session: fakeSession({ accountId, region }), now: () => new Date(),
      tags: { "zenith:workspace": workspaceId, "zenith:environment": environmentId, "zenith:managed": "true" },
      operationId: op.id, fence: { scope: lease.scope, token: lease.fenceToken } });
    const tags = Object.entries({ ...ctx.tags, "zenith:resource": pipeline.address }).map(([key, value]) => ({ key, value }));
    const repositoryUri=`${accountId}.dkr.ecr.${region}.amazonaws.com/zenith-web`;
    const project: Project = { name: projectName, arn: projectArn, tags, source: { type: "S3", location: `${sourceBucket}/zenith/${environmentId}/bootstrap.zip`, buildspec: "version: 0.2" }, artifacts: { type: "NO_ARTIFACTS" }, serviceRole: `arn:aws:iam::${accountId}:role/build`, timeoutInMinutes: 30, queuedTimeoutInMinutes: 60, environment: { type: "LINUX_CONTAINER", image: "aws/codebuild/standard:7.0", computeType: "BUILD_GENERAL1_MEDIUM", privilegedMode:true,imagePullCredentialsType:"CODEBUILD", environmentVariables: [{ name: "ZENITH_DOCKERFILE", value: "Dockerfile", type: "PLAINTEXT" }, {name:"ZENITH_REPO_URL",value:repositoryUri,type:"PLAINTEXT"}] } };
    cb.on(BatchGetProjectsCommand).resolves({ projects: [project] });
    s3.on(HeadObjectCommand).resolves({ ContentLength: 100, ChecksumSHA256: Buffer.from(sourceDigest, "hex").toString("base64") });
    const buildId = `${projectName}:11111111-2222-3333-4444-555555555555`;
    const build: Build = { id: buildId, arn: `arn:aws:codebuild:${region}:${accountId}:build/${buildId}`, projectName, buildStatus: "IN_PROGRESS", buildComplete: false, source: { ...project.source!, location: `${sourceBucket}/${sourceS3Key}` }, serviceRole: project.serviceRole, timeoutInMinutes: project.timeoutInMinutes, queuedTimeoutInMinutes: project.queuedTimeoutInMinutes, environment: { ...project.environment!, environmentVariables: [...project.environment!.environmentVariables!, { name: "ZENITH_SOURCE_DIGEST", value: sourceDigest, type: "PLAINTEXT" }] } };
    cb.on(StartBuildCommand).resolves({ build, $metadata: { requestId: "accepted-request" } });
    cb.on(BatchGetBuildsCommand).resolves({ builds: [build], $metadata: { requestId: "read-request" } });
    return { ctx, input, pipeline, service, project, build, op, repositoryUri, h, startBuild, worker, sourceSnapshot };
  }

  async function inventory(f: Awaited<ReturnType<typeof fixture>>) {
    return world.db.query<{phase:string;build_id:string}>("select phase,build_id from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.ctx.workspaceId,f.op.id]);
  }
  async function live(f: Awaited<ReturnType<typeof fixture>>, sql: Sql = world.db) {
    const [row] = await sql.query<{operation:boolean;fence:boolean;approvals:number}>(`select
      o.status='running' and o.expires_at>clock_timestamp() and o.lease_until>clock_timestamp() as operation,
      l.expires_at>clock_timestamp() and l.released_at is null as fence,
      (select count(*)::integer from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
        and a.approval_round=o.approval_round and a.decision='approve' and a.consumed_at is not null and a.expires_at>clock_timestamp()) as approvals
      from platform.operations o join platform.leases l on l.scope=o.lease_scope where o.workspace_id=$1 and o.id=$2`,[f.ctx.workspaceId,f.op.id]);
    expect(row).toEqual({operation:true,fence:true,approvals:1});
  }
  async function waitForResourceBlock(claimantPid: number, blockerPid: number) {
    expect(claimantPid).toBeGreaterThan(0); expect(claimantPid).not.toBe(blockerPid);
    const deadline=Date.now()+3_000;
    while(Date.now()<deadline) {
      const row=await observer.tx(async fresh=>{
        await fresh.query("select pg_stat_clear_snapshot()");
        const [state]=await fresh.query<{blocked:boolean;observer_pid:number}>(`select pg_backend_pid() as observer_pid,
          exists (select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'
            and query like '%select address,spec_digest,spec from platform.resources%'
            and $2=any(pg_blocking_pids(pid))) as blocked`,[claimantPid,blockerPid]);
        return state;
      });
      expect(row.observer_pid).not.toBe(claimantPid); expect(row.observer_pid).not.toBe(blockerPid);
      if(row.blocked) return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error("Expected exact PostgreSQL resource lock waiter was not observed.");
  }

  it.each(["production", "isolated"] as const)("launches with valid owning approvals on a single-connection pool through %s composition", async mode => {
    const f=await fixture();
    const single=await openPlatformDb({kind:"postgres",url:PG_URL,max:1,migrate:false});
    try {
      const outside=new PlatformBrokerStore(single);
      const outsidePolicy=vi.spyOn(outside,"getWorkspacePolicy");
      const outsideApprovals=vi.spyOn(outside,"listApprovals");
      const outsideBroker=createBroker({...f.h.deps,store:outside});
      setPlatformBrokerForTests(outsideBroker);
      const launch=mode==="production" ? startBuild : createIsolatedBuildLauncherForTests(outsideBroker);
      await live(f);
      const result=await launch(f.ctx,f.pipeline,f.input,single);
      expect(result.buildId).toBe(f.build.id);
      expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
      expect(await inventory(f)).toEqual([{phase:"accepted",build_id:f.build.id!}]);
      // The outer pool has only one connection: any nested use would deadlock.
      expect(outsidePolicy).not.toHaveBeenCalled(); expect(outsideApprovals).not.toHaveBeenCalled();
      if(mode==="production") {
        expect(model.scopeTx).toBeDefined(); expect(model.scopeTx).not.toBe(single);
        expect(model.memberCalls.map(call=>call.humanId)).toContain("erin");
      }
      expect(await single.query("select 1 as available")).toEqual([{available:1}]);
    } finally { await single.close(); }
  },20_000);

  it("ignores a permissive global memory policy and authentic approval IDs when owning PostgreSQL policy denies", async () => {
    const f=await fixture(), memory=new MemoryBrokerStore(f.h.deps.clock);
    // Actual owning approval IDs are copied through this wrong-store adapter:
    // a denial cannot be explained away by an empty/missing approval fixture.
    vi.spyOn(memory,"listApprovals").mockImplementation((ws,op)=>f.h.store.listApprovals(ws,op));
    const memoryPolicy=vi.spyOn(memory,"getWorkspacePolicy");
    const wrongBroker=createBroker({...f.h.deps,store:memory});
    setPlatformBrokerForTests(wrongBroker);
    await repos.settings.putWorkspacePolicy(world.db,{workspaceId:f.ctx.workspaceId,updatedBy:"fixture-admin",params:{approvedRegions:["us-west-2"]}});
    await live(f);
    // Positive counterexample: the authentic evaluator over the wrong memory
    // policy accepts the real consumed approvals; owning SQL must still deny.
    expect(await createExecutionBroker(world.db2,async()=>wrongBroker).approvalStatus(f.op.id)).toMatchObject({approved:true,rejected:false});
    expect(memoryPolicy).toHaveBeenCalled(); memoryPolicy.mockClear();
    await expect(startBuild(f.ctx,f.pipeline,f.input,world.db2)).rejects.toMatchObject({code:"build_launch_unconfirmed"});
    expect(memoryPolicy).not.toHaveBeenCalled();
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0); expect(await inventory(f)).toHaveLength(0);
  });

  it("rebinds the captured isolated broker store instead of admitting its memory policy", async () => {
    const f=await fixture(), memory=new MemoryBrokerStore(f.h.deps.clock);
    const memoryApprovals=vi.spyOn(memory,"listApprovals").mockImplementation((ws,op)=>f.h.store.listApprovals(ws,op));
    const launch=createIsolatedBuildLauncherForTests(createBroker({...f.h.deps,store:memory}));
    await repos.settings.putWorkspacePolicy(world.db,{workspaceId:f.ctx.workspaceId,updatedBy:"fixture-admin",params:{approvedRegions:["us-west-2"]}});
    await expect(launch(f.ctx,f.pipeline,f.input,world.db2)).rejects.toMatchObject({code:"build_launch_unconfirmed"});
    expect(memoryApprovals).not.toHaveBeenCalled(); expect(await inventory(f)).toHaveLength(0);
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
  });

  it.each(["unchanged authority", "current approver demotion", "current requester removal", "raised policy count", "current policy deny"] as const)("uses %s after an observed PostgreSQL resource lock wait", async change => {
    const f=await fixture(); let outcome!:Promise<{error?:unknown;buildId?:string}>;
    let claimantPid=0, backendReady!:()=>void;
    const ready=new Promise<void>(resolve=>{backendReady=resolve;});
    const claimant:Sql & {kind:"postgres"}={kind:"postgres",query:world.db2.query.bind(world.db2),
      tx:async body=>world.db2.tx(async tx=>{
        const [{pid}]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        claimantPid=pid;backendReady();return body(tx);
      })};
    await world.db.tx(async blocker=>{
      await blocker.query("select id from platform.resources where workspace_id=$1 and environment_id=$2 and address=$3 for update",[f.ctx.workspaceId,f.ctx.environmentId,f.service.address]);
      const [{pid}]=await blocker.query<{pid:number}>("select pg_backend_pid() as pid");
      outcome=startBuild(f.ctx,f.pipeline,f.input,claimant).then(result=>({buildId:result.buildId}),error=>({error}));
      await Promise.race([ready,outcome.then(()=>{throw new Error("Launch ended before entering its claim transaction.");})]);
      await waitForResourceBlock(claimantPid,pid);
      if(change==="current approver demotion") model.currentMembers.set(`${f.ctx.workspaceId}|erin`,"viewer");
      if(change==="current requester removal") model.currentMembers.delete(`${f.ctx.workspaceId}|alice`);
      if(change==="raised policy count") await repos.settings.putWorkspacePolicy(blocker,{workspaceId:f.ctx.workspaceId,updatedBy:"fixture-admin",params:{twoPersonProduction:true}});
      if(change==="current policy deny") await repos.settings.putWorkspacePolicy(blocker,{workspaceId:f.ctx.workspaceId,updatedBy:"fixture-admin",params:{approvedRegions:["us-west-2"]}});
      // The old bulk member snapshot still says admin; only the fresh read sees
      // the demotion/removal. Policy and receipt queries use actual PostgreSQL.
      expect(f.h.world.members.get(`${f.ctx.workspaceId}|erin`)).toBe("admin");
      await live(f,blocker); expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
    });
    const result=await outcome;
    if(change==="unchanged authority") {
      expect(result).toEqual({buildId:f.build.id}); expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
      expect(await inventory(f)).toEqual([{phase:"accepted",build_id:f.build.id!}]);
    } else {
      expect(result.error).toMatchObject({code:"build_launch_unconfirmed"});
      expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0); expect(await inventory(f)).toHaveLength(0);
    }
  });

  async function delayApprover() {
    let enter!:()=>void, finish!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;}), delayed=new Promise<void>(resolve=>{finish=resolve;});
    model.memberRead=async (workspaceId,humanId)=>{
      if(humanId==="erin") {enter();await delayed;}
      const role=model.currentMembers.get(`${workspaceId}|${humanId}`);
      return {data:role?{id:humanId,workspace_id:workspaceId,role}:null,error:null};
    };
    return {entered,finish};
  }
  async function mutateSource(f:Awaited<ReturnType<typeof fixture>>,change:string) {
    if(change==="binding revoked")await observer.query("update platform.github_source_bindings set revoked_at=clock_timestamp(),version=version+1 where workspace_id=$1",[f.ctx.workspaceId]);
    if(change==="binding removed")await observer.query("delete from platform.github_source_bindings where workspace_id=$1",[f.ctx.workspaceId]);
    if(change==="binding replaced")await observer.query("update platform.github_source_bindings set installation_id=8,version=version+1 where workspace_id=$1",[f.ctx.workspaceId]);
    if(change==="public absence replaced")await observer.query("insert into platform.github_source_bindings(workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values ($1,'42',7,99,'acme','web',1,'fixture-admin')",[f.ctx.workspaceId]);
  }
  it.each(["unchanged binding","binding revoked","binding removed","binding replaced","public absence replaced"] as const)("final native source CAS fences %s during delayed current approver lookup",async change=>{
    const f=await fixture(change!=="public absence replaced"),wait=await delayApprover();
    const outcome=startBuild(f.ctx,f.pipeline,f.input,world.db2).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try{await wait.entered;await mutateSource(f,change);await live(f);expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);}
    finally{wait.finish();}
    const result=await outcome;
    if(change==="unchanged binding"){expect(result.value?.buildId).toBe(f.build.id);expect(await inventory(f)).toEqual([{phase:"accepted",build_id:f.build.id!}]);expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);}
    else{expect(result.error).toMatchObject({code:"build_launch_unconfirmed"});expect(await inventory(f)).toEqual([]);expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);}
  });
  it.each(["unchanged binding","binding revoked","binding removed","public absence replaced"] as const)("retained-launch recovery fences %s during delayed approver lookup without another SDK attempt",async change=>{
    const f=await fixture(change!=="public absence replaced");expect((await startBuild(f.ctx,f.pipeline,f.input,world.db2)).buildId).toBe(f.build.id);
    const before=await world.db.query("select * from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.ctx.workspaceId,f.op.id]);
    const wait=await delayApprover(),outcome=startBuild(f.ctx,f.pipeline,f.input,world.db2).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try{await wait.entered;await mutateSource(f,change);await live(f);}finally{wait.finish();}
    const result=await outcome;expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
    expect(await world.db.query("select * from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.ctx.workspaceId,f.op.id])).toEqual(before);
    if(change==="unchanged binding")expect(result.value?.buildId).toBe(f.build.id);else expect(result.error).toMatchObject({code:"build_launch_unconfirmed"});
  });
  it.each(["unchanged binding","binding revoked"] as const)("rechecks %s after an exact three-connection retained launch lock wait",async change=>{
    const f=await fixture(true);expect((await startBuild(f.ctx,f.pipeline,f.input,world.db2)).buildId).toBe(f.build.id);
    const before=await world.db.query("select * from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.ctx.workspaceId,f.op.id]);
    let claimantPid=0,ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});let outcome!:Promise<{value?:{buildId:string};error?:unknown}>;
    const claimant:Sql & {kind:"postgres"}={kind:"postgres",query:world.db2.query.bind(world.db2),tx:body=>world.db2.tx(async tx=>{claimantPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;ready();return body(tx);})};
    await world.db.tx(async blocker=>{
      await blocker.query("select operation_id from platform.build_launches where workspace_id=$1 and operation_id=$2 for update",[f.ctx.workspaceId,f.op.id]);
      const blockerPid=(await blocker.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
      outcome=startBuild(f.ctx,f.pipeline,f.input,claimant).then(value=>({value}),error=>({error}));
      await Promise.race([started,outcome.then(()=>{throw new Error("Launch ended before the expected claim transaction.");})]);
      const deadline=Date.now()+3_000;let blocked=false;
      while(Date.now()<deadline){const state=await observer.tx(async fresh=>{await fresh.query("select pg_stat_clear_snapshot()");return (await fresh.query<{pid:number;blocked:boolean}>(`select pg_backend_pid() as pid,exists(select 1 from pg_stat_activity a where a.pid=$1 and a.wait_event_type='Lock'
        and a.query=$3 and $2=any(pg_blocking_pids(a.pid))) as blocked`,[claimantPid,blockerPid,"select operation_id from platform.build_launches\n      where workspace_id=$1 and operation_id=$2 and service_address=$3 for update"]))[0];});
        expect(new Set([state.pid,claimantPid,blockerPid]).size).toBe(3);if(state.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
      expect(blocked).toBe(true);await mutateSource(f,change);await live(f,blocker);expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
    });
    const result=await outcome;expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
    expect(await world.db.query("select * from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.ctx.workspaceId,f.op.id])).toEqual(before);
    if(change==="unchanged binding")expect(result.value?.buildId).toBe(f.build.id);else expect(result.error).toMatchObject({code:"build_launch_unconfirmed"});
  });
  it.each(["service","pipeline"] as const)("same stored digest with changed %s recipe JSON refuses before native launch and SDK mutation",async kind=>{
    const f=await fixture();await world.db.query("update platform.resources set spec=spec || $3::text::jsonb where workspace_id=$1 and address=$2",[f.ctx.workspaceId,kind==="service"?f.service.address:f.pipeline.address,JSON.stringify({recipeChanged:true})]);
    await live(f);await expect(startBuild(f.ctx,f.pipeline,f.input,world.db2)).rejects.toMatchObject({code:"build_launch_unconfirmed"});expect(await inventory(f)).toEqual([]);expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
  });
  it.each(["missing row","foreign project row","wrong approved set","simulated approval evidence"] as const)("native source CAS refuses %s without a new launch",async failure=>{
    const f=await fixture();
    let input=f.input;
    const boundaryCase=failure==="missing row"||failure==="foreign project row";
    const retained=async()=>world.db.query("select snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 order by service_address",[f.ctx.workspaceId,f.op.id]);
    const original=boundaryCase?await retained():undefined;
    if(failure==="missing row") {
      // The original approved set remains intact. Only this requested service
      // lacks a retained row; this does not model deletion of immutable rows.
      const unreviewed={...f.service,address:"container_service/unreviewed"};
      await repos.resources.upsertDesired(world.db,{workspaceId:f.ctx.workspaceId,projectId:f.h.ids.projA,environmentId:f.ctx.environmentId,node:unreviewed,status:"active"});
      input={...f.input,service:unreviewed,sourceS3Key:`zenith/${f.ctx.environmentId}/unreviewed/${f.input.sourceDigest}.zip`};
    }
    if(failure==="foreign project row") {
      // Valid review and consumed approval came first. The retained original
      // project row is now foreign to the current operation's SQL authority.
      await world.db.query("update platform.operations set project_id=$3 where workspace_id=$1 and id=$2",[f.ctx.workspaceId,f.op.id,f.h.ids.projB]);
    }
    if(failure==="wrong approved set")await world.db.query("update platform.evidence set summary=jsonb_set(summary,'{executableSourceDigest}',to_jsonb($3::text)) where workspace_id=$1 and operation_id=$2",[f.ctx.workspaceId,f.op.id,digest("wrong source set")]);
    if(failure==="simulated approval evidence")await world.db.query("update platform.evidence set simulated=true where workspace_id=$1 and operation_id=$2",[f.ctx.workspaceId,f.op.id]);
    const sourceSelect="select snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 and project_id=$3 and environment_id=$4 order by service_address for share";
    const sourceReads:{params:readonly unknown[];rows:unknown[]}[]=[];
    // Transparent observation: every query, including this source read, runs
    // on the actual owning PostgreSQL transaction before its result is recorded.
    const observe=(sql:Sql):Sql=>({
      query:async<T=Record<string,unknown>>(text:string,params?:readonly unknown[])=>{
        const rows=await sql.query<T>(text,params);
        if(text===sourceSelect)sourceReads.push({params:[...(params??[])],rows:structuredClone(rows)});
        return rows;
      },
      tx:body=>sql.tx(tx=>body(observe(tx))),
    });
    expect(world.db2.kind).toBe("postgres");
    const claimant=boundaryCase?{...observe(world.db2),kind:world.db2.kind}:world.db2;
    await live(f);await expect(startBuild(f.ctx,f.pipeline,input,claimant)).rejects.toMatchObject({code:"build_launch_unconfirmed"});expect(await inventory(f)).toEqual([]);expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
    if(boundaryCase) {
      expect(original).toEqual([{snapshot:f.sourceSnapshot,snapshot_digest:sourceSnapshotDigest(f.sourceSnapshot)}]);
      expect(sourceReads).toEqual([{params:[f.ctx.workspaceId,f.op.id,failure==="foreign project row"?f.h.ids.projB:f.h.ids.projA,f.ctx.environmentId],rows:failure==="foreign project row"?[]:original!}]);
      expect(await retained()).toEqual(original);
    }
  });
  async function mutateSettings(f:Awaited<ReturnType<typeof fixture>>, change:string) {
    if(change==="two-person policy") await repos.settings.putWorkspacePolicy(world.db,{workspaceId:f.ctx.workspaceId,updatedBy:"fixture-admin",params:{twoPersonProduction:true}});
    if(change==="denying policy") await repos.settings.putWorkspacePolicy(world.db,{workspaceId:f.ctx.workspaceId,updatedBy:"fixture-admin",params:{approvedRegions:["us-west-2"]}});
    if(change==="lower autonomy") await repos.settings.putEnvironmentSettings(world.db,{workspaceId:f.ctx.workspaceId,environmentId:f.ctx.environmentId,updatedBy:"fixture-admin",autonomyLevel:1});
    if(change==="same-value policy version" || change==="new default policy row") await repos.settings.putWorkspacePolicy(world.db,{workspaceId:f.ctx.workspaceId,updatedBy:"fixture-admin",params:{}});
    if(change==="same-value environment version" || change==="new default environment row") await repos.settings.putEnvironmentSettings(world.db,{workspaceId:f.ctx.workspaceId,environmentId:f.ctx.environmentId,updatedBy:"fixture-admin",autonomyLevel:change==="new default environment row"?1:3});
    if(change==="same-version policy params") await world.db.query("update platform.workspace_policy set params=$2::text::jsonb where workspace_id=$1",[f.ctx.workspaceId,JSON.stringify({twoPersonProduction:true})]);
    if(change==="same-version autonomy") await world.db.query("update platform.environment_settings set autonomy_level=1 where workspace_id=$1 and environment_id=$2",[f.ctx.workspaceId,f.ctx.environmentId]);
    if(change==="same-version environment params") await world.db.query("update platform.environment_settings set policy_params=$3::text::jsonb where workspace_id=$1 and environment_id=$2",[f.ctx.workspaceId,f.ctx.environmentId,JSON.stringify({maxReplicas:1})]);
    if(change==="new foreign environment row") await repos.settings.putEnvironmentSettings(world.db,{workspaceId:f.h.ids.wsB,environmentId:f.ctx.environmentId,updatedBy:"fixture-admin",autonomyLevel:3});
    if(change==="deleted policy row") await world.db.query("delete from platform.workspace_policy where workspace_id=$1",[f.ctx.workspaceId]);
    if(change==="deleted environment row") await world.db.query("delete from platform.environment_settings where workspace_id=$1 and environment_id=$2",[f.ctx.workspaceId,f.ctx.environmentId]);
  }

  it.each(["unchanged settings", "two-person policy", "denying policy", "lower autonomy", "same-value policy version", "same-value environment version", "same-version policy params", "same-version autonomy", "same-version environment params", "deleted policy row", "deleted environment row"] as const)("fences insertion when %s is observed during a delayed approver read", async change => {
    const f=await fixture();
    await repos.settings.putWorkspacePolicy(world.db,{workspaceId:f.ctx.workspaceId,updatedBy:"fixture-admin",params:{}});
    await repos.settings.putEnvironmentSettings(world.db,{workspaceId:f.ctx.workspaceId,environmentId:f.ctx.environmentId,updatedBy:"fixture-admin",autonomyLevel:3});
    const wait=await delayApprover(), before=model.policyInputs.length;
    const outcome:Promise<{error?:unknown;buildId?:string}>=startBuild(f.ctx,f.pipeline,f.input,world.db2).then(result=>({buildId:result.buildId}),error=>({error}));
    await wait.entered;
    expect(model.policyInputs.length).toBe(before+1);
    expect(model.policyInputs.at(-1)).toEqual({autonomyLevel:3,twoPerson:false,regions:undefined});
    // This independent statement commits while the real claim holds its locks;
    // the policy was already evaluated, but the approver read has not returned.
    await mutateSettings(f,change);await live(f);expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
    wait.finish();const result=await outcome;
    expect(model.policyInputs.length).toBe(before+1); // no refresh/reevaluate/retry
    if(change==="unchanged settings") {
      expect(result).toEqual({buildId:f.build.id});expect(await inventory(f)).toEqual([{phase:"accepted",build_id:f.build.id!}]);
      expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
    } else {
      expect(result.error).toMatchObject({code:"build_launch_unconfirmed"});expect(await inventory(f)).toHaveLength(0);
      expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
    }
  });

  it.each(["unchanged defaults", "new default policy row", "new default environment row", "new foreign environment row"] as const)("fences explicit absent settings when %s occurs during approver lookup", async change => {
    const f=await fixture();
    expect(await repos.settings.getWorkspacePolicy(world.db,f.ctx.workspaceId)).toMatchObject({version:0,isDefault:true});
    expect(await repos.settings.getEnvironmentSettings(world.db,f.ctx.workspaceId,f.ctx.environmentId)).toMatchObject({version:0,isDefault:true});
    const wait=await delayApprover();
    const outcome:Promise<{error?:unknown;buildId?:string}>=startBuild(f.ctx,f.pipeline,f.input,world.db2).then(result=>({buildId:result.buildId}),error=>({error}));
    await wait.entered;await mutateSettings(f,change);await live(f);wait.finish();const result=await outcome;
    if(change==="unchanged defaults") {
      expect(result).toEqual({buildId:f.build.id});expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
    } else {
      expect(result.error).toMatchObject({code:"build_launch_unconfirmed"});expect(await inventory(f)).toHaveLength(0);
      expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
    }
  });

  it.each(["unchanged recovery", "two-person policy", "denying policy", "lower autonomy", "same-value policy version", "same-value environment version", "same-version policy params", "same-version autonomy", "same-version environment params", "deleted policy row", "deleted environment row", "new default policy row", "new default environment row", "new foreign environment row"] as const)("fences retained-launch recovery under %s without a second SDK attempt", async change => {
    const f=await fixture();
    if(!change.startsWith("new ")) {
      await repos.settings.putWorkspacePolicy(world.db,{workspaceId:f.ctx.workspaceId,updatedBy:"fixture-admin",params:{}});
      await repos.settings.putEnvironmentSettings(world.db,{workspaceId:f.ctx.workspaceId,environmentId:f.ctx.environmentId,updatedBy:"fixture-admin",autonomyLevel:3});
    }
    expect((await startBuild(f.ctx,f.pipeline,f.input,world.db2)).buildId).toBe(f.build.id);
    const wait=await delayApprover(), before=model.policyInputs.length;
    const outcome:Promise<{error?:unknown;buildId?:string}>=startBuild(f.ctx,f.pipeline,f.input,world.db2).then(result=>({buildId:result.buildId}),error=>({error}));
    await wait.entered;expect(model.policyInputs.length).toBe(before+1);
    await mutateSettings(f,change);await live(f);wait.finish();const result=await outcome;
    expect(model.policyInputs.length).toBe(before+1);
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
    expect(await inventory(f)).toEqual([{phase:"accepted",build_id:f.build.id!}]);
    if(change==="unchanged recovery")expect(result).toEqual({buildId:f.build.id});
    else expect(result.error).toMatchObject({code:"build_launch_unconfirmed"});
  });

  it("cannot continue a claim from a late membership success after the bounded read is aborted", async () => {
    const f=await fixture(), controller=new AbortController();
    let enter!:()=>void, finish!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;}), delayed=new Promise<void>(resolve=>{finish=resolve;});
    vi.spyOn(AbortSignal,"timeout").mockReturnValue(controller.signal);
    model.memberRead=async (workspaceId,humanId)=>{
      enter(); await delayed;
      return {data:{id:humanId,workspace_id:workspaceId,role:"admin"},error:null};
    };
    const attempt=startBuild(f.ctx,f.pipeline,f.input,world.db2);
    const refusal=expect(attempt).rejects.toMatchObject({code:"build_launch_unconfirmed"});
    await entered; controller.abort(); await refusal;
    finish(); await Promise.resolve();
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0); expect(await inventory(f)).toHaveLength(0);
    expect(await world.db2.query("select 1 as available")).toEqual([{available:1}]);
  });

  it("captures isolated evaluator ports once while always rebinding its store", async () => {
    const f=await fixture(), launch=createIsolatedBuildLauncherForTests(f.h.broker);
    f.h.deps.store=new MemoryBrokerStore(f.h.deps.clock);
    f.h.deps.roles={resolve:async()=>({role:"none"})};
    f.h.deps.policy=async()=>scriptedEngine("replacement-deny",()=>({outcome:"deny",reasons:[{code:"denied",message:"Denied."}]}));
    const result=await launch(f.ctx,f.pipeline,f.input,world.db2);
    expect(result.buildId).toBe(f.build.id); expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
    expect(await inventory(f)).toEqual([{phase:"accepted",build_id:f.build.id!}]);
  });

  it.each(["foreign membership", "malformed membership", "inaccessible membership"] as const)("refuses %s with live owning approval before any launch", async failure => {
    const f=await fixture();
    model.memberRead=async (workspaceId,humanId)=>({
      data:failure==="foreign membership"?{id:humanId,workspace_id:"foreign",role:"admin"}:
        {id:humanId,workspace_id:workspaceId,role:failure==="malformed membership"?"owner":"admin"},
      error:failure==="inaccessible membership"?new Error("Private store failure."):null,
    });
    await live(f);
    await expect(startBuild(f.ctx,f.pipeline,f.input,world.db2)).rejects.toMatchObject({code:"build_launch_unconfirmed"});
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0); expect(await inventory(f)).toHaveLength(0);
  });

  it("refuses expired consumed approval even with current product admin and live operation/fence", async () => {
    const f=await fixture();
    await f.h.expireApprovals(f.op.id);
    await expect(startBuild(f.ctx,f.pipeline,f.input,world.db2)).rejects.toMatchObject({code:"build_launch_unconfirmed"});
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0); expect(await inventory(f)).toHaveLength(0);
  });
});


// Admission ordering models only: no SQL, provider read or SDK transport runs.
describe("CodeBuild isolated admission [contract model]", () => {
  it.each(["production", "development"] as const)("%s refuses factory creation before broker dependency access", async mode => {
    const h=await makeHarness({kind:"memory"});
    const dependencies=vi.fn(()=>h.deps);
    Object.defineProperty(h.broker,"deps",{get:dependencies});
    try {
      vi.stubEnv("NODE_ENV",mode);
      expect(()=>createIsolatedBuildLauncherForTests(h.broker)).toThrow(repos.buildLaunches.BuildLaunchError);
      expect(dependencies).not.toHaveBeenCalled();
    } finally {vi.unstubAllEnvs();}
  });

  it.each(["production", "development"] as const)("%s refuses a captured launcher before context, provider or SQL access", async mode => {
    const h=await makeHarness({kind:"memory"});
    const dependencies=vi.fn(()=>h.deps),contextRead=vi.fn(),sqlRead=vi.fn();
    Object.defineProperty(h.broker,"deps",{get:dependencies});
    const ctx=new Proxy({} as Parameters<typeof startBuild>[0],{get(){contextRead();throw new Error("Unexpected context/provider access.");}});
    const sql=new Proxy({} as Sql,{get(){sqlRead();throw new Error("Unexpected SQL access.");}});
    try {
      vi.stubEnv("NODE_ENV","test");
      const launch=createIsolatedBuildLauncherForTests(h.broker);
      expect(dependencies).toHaveBeenCalledTimes(1);
      expect(repos.bindRepos(sql).buildLaunches).not.toHaveProperty("assertIsolatedBuildTestAdmission");
      vi.stubEnv("NODE_ENV",mode);
      expect(()=>launch(ctx,{} as Parameters<typeof startBuild>[1],{} as Parameters<typeof startBuild>[2],sql)).toThrow(repos.buildLaunches.BuildLaunchError);
      expect(contextRead).not.toHaveBeenCalled();expect(sqlRead).not.toHaveBeenCalled();
      expect(dependencies).toHaveBeenCalledTimes(1);
    } finally {vi.unstubAllEnvs();}
  });
});
