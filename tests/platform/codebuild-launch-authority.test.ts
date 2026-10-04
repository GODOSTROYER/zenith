/** Actual PostgreSQL claims plus SDK contract readback; no live AWS acceptance. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BatchGetBuildsCommand, BatchGetProjectsCommand, CodeBuildClient, StartBuildCommand, type Build, type Project } from "@aws-sdk/client-codebuild";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { immutableSourceSnapshot, sourceRecipe, sourceSnapshotDigest, sourceSnapshotSetDigest } from "@/lib/execution/source-snapshot";
import { migration0013ApprovedSourceSnapshots } from "@/lib/controlplane/db/migrations/0013_approved_source_snapshots";
import { digest } from "@/lib/controlplane/digest";
import type { Sql } from "@/lib/controlplane/types";
import * as repos from "@/lib/controlplane/db/repos";
import { createIsolatedBuildLauncherForTests, waitForBuild } from "@/lib/providers/aws/drivers/compute/codebuild-builds";
import { createAwsBuildPort } from "@/lib/platform/release";
import { registerEnvironment } from "@/lib/reconcile/platform";
import { LANES, PG_URL, openLane } from "../controlplane/_support/harness";
import { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, user, sessionFor } from "../capabilities/support";
import { makePlan, change } from "../execution/fakes/fixtures";
import { buildPlanFacts } from "@/lib/capabilities/evaluate";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { fakeSession, mkDriverContext, mkNode } from "../providers/aws/drivers/compute/fixtures";

closeSharedPgliteAfterAll();

describe.skipIf(!PG_URL)("CodeBuild launch authority [postgres]", () => {
  let world: Awaited<ReturnType<typeof openLane>>;
  let observer: Awaited<ReturnType<(typeof LANES)[number]["open"]>>;
  const cb = mockClient(CodeBuildClient), s3 = mockClient(S3Client), ecr = mockClient(ECRClient);
  beforeAll(async () => {
    const lane=LANES.find(l=>l.name==="postgres")!;
    world=await openLane(lane);
    await world.db.exec(migration0013ApprovedSourceSnapshots.sql);
    observer=await lane.open();
  }, 60_000);
  afterAll(async () => { cb.restore(); s3.restore(); ecr.restore(); await observer?.close(); await world?.close(); });
  beforeEach(() => { cb.reset(); s3.reset(); ecr.reset(); });

  async function fixture(boundSource=false,omitSource=false) {
    const h=await makeHarness({kind:"postgres",engine:scriptedEngine("build-policy",()=>requireApproval(1,"admin",true))});
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
    if(!omitSource)await world.db.query("insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)",
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
    const ctx = mkDriverContext({ workspaceId, environmentId, region, session:fakeSession({accountId,region}), now:()=>new Date(),
      tags:{"zenith:workspace":workspaceId,"zenith:environment":environmentId,"zenith:managed":"true"},
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

  async function terminalTimestamp(workspaceId:string,operationId:string):Promise<Date> {
    const hostFinishedAt=new Date();
    const [clock]=await observer.query<{accepted:boolean;database_now:string;host_after_created:boolean;host_not_future:boolean;host_delta_ms:number;database_after_created:boolean}>(`select phase='accepted' as accepted,clock_timestamp()::text as database_now,
      $3::timestamptz>=created_at as host_after_created,$3::timestamptz<=clock_timestamp() as host_not_future,
      (extract(epoch from ($3::timestamptz-clock_timestamp()))*1000)::double precision as host_delta_ms,
      clock_timestamp()>=created_at as database_after_created
      from platform.build_launches where workspace_id=$1 and operation_id=$2`,[workspaceId,operationId,hostFinishedAt.toISOString()]);
    expect(clock,`terminal timestamp predicate diagnostics: ${JSON.stringify(clock)}`).toMatchObject({accepted:true,database_after_created:true});
    expect(Number.isFinite(clock.host_delta_ms)).toBe(true);
    console.info("CodeBuild terminal clock diagnostics",clock);
    // Mocked provider times follow the authoritative database clock, after
    // acknowledgement; production rejects out-of-window values unchanged.
    await observer.query("select pg_sleep(0.002)");
    const [provider]=await observer.query<{finished_at:string;within_receipt_window:boolean}>(`select date_trunc('milliseconds',clock_timestamp())::text as finished_at,
      date_trunc('milliseconds',clock_timestamp())>=created_at as within_receipt_window
      from platform.build_launches where workspace_id=$1 and operation_id=$2 and phase='accepted'`,[workspaceId,operationId]);
    expect(provider.within_receipt_window).toBe(true);
    return new Date(provider.finished_at);
  }

  it("keeps the isolated actual-broker launcher unavailable in production",async()=>{
    const f=await fixture(), prior=process.env.NODE_ENV;
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(()=>createIsolatedBuildLauncherForTests(f.h.broker)).toThrow();
      expect(()=>f.startBuild(f.ctx,f.pipeline,f.input,world.db)).toThrow();
    } finally {vi.stubEnv("NODE_ENV", prior);}
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
  });

  it.each(["expired approval","revoked approver role","new approval count","current policy deny","missing plan evidence","moved approval round"] as const)("refuses %s through canonical current authority with a live operation and fence",async change=>{
    const f=await fixture();
    if(change==="expired approval") await f.h.expireApprovals(f.op.id);
    if(change==="revoked approver role") f.h.world.members.set(`${f.ctx.workspaceId}|erin`,"viewer");
    if(change==="new approval count") f.h.setEngine(scriptedEngine("stricter-build-policy",()=>requireApproval(2,"admin",true)));
    if(change==="current policy deny") f.h.setEngine(scriptedEngine("deny-build-policy",()=>({outcome:"deny",reasons:[{code:"build_denied",message:"Build denied."}]})));
    if(change==="missing plan evidence") await world.db.query("delete from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='tofu_plan'",[f.ctx.workspaceId,f.op.id]);
    if(change==="moved approval round") await world.db.query("update platform.operations set approval_round=approval_round+1 where workspace_id=$1 and id=$2",[f.ctx.workspaceId,f.op.id]);
    const [live]=await world.db.query<{operation:boolean;fence:boolean}>(`select o.status='running' and o.expires_at>clock_timestamp() and o.lease_until>clock_timestamp() as operation,
      l.expires_at>clock_timestamp() and l.released_at is null as fence from platform.operations o join platform.leases l on l.scope=o.lease_scope
      where o.workspace_id=$1 and o.id=$2`,[f.ctx.workspaceId,f.op.id]);
    expect(live).toEqual({operation:true,fence:true});
    await expect(f.startBuild(f.ctx,f.pipeline,f.input,world.db2)).rejects.toMatchObject({code:"build_launch_unconfirmed"});
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
    expect(await world.db.query("select operation_id from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.ctx.workspaceId,f.op.id])).toHaveLength(0);
  });

  it.each(["unchanged authority","revoked approver role","new approval count","current policy deny"] as const)("reevaluates %s after an observed PostgreSQL resource lock wait before any launch",async change=>{
    const f=await fixture();
    let outcome!:Promise<{error?:unknown;buildId?:string}>;
    let claimantPid=0;
    let backendReady!:()=>void;
    const ready=new Promise<void>(resolve=>{backendReady=resolve;});
    // This wrapper observes the real claim transaction's backend. All queries,
    // locks and broker evaluation still run on the independent PostgreSQL handle.
    const claimant:Sql & {kind:"postgres"}={kind:"postgres",query:world.db2.query.bind(world.db2),
      tx:async fn=>world.db2.tx(async tx=>{
        const [{pid}]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        claimantPid=pid;backendReady();return fn(tx);
      })};
    try { await world.db.tx(async blocker=>{
      await blocker.query("select id from platform.resources where workspace_id=$1 and environment_id=$2 and address=$3 for update",[f.ctx.workspaceId,f.ctx.environmentId,f.service.address]);
      const [{pid}]=await blocker.query<{pid:number}>("select pg_backend_pid() as pid");
      // A normal independent handle owns the launch transaction. No provider
      // request is nested inside this blocker's database transaction.
      outcome=f.startBuild(f.ctx,f.pipeline,f.input,claimant).then(result=>({buildId:result.buildId}),error=>({error}));
      await Promise.race([ready,outcome.then(()=>{throw new Error("Build finished before entering its PostgreSQL claim transaction.");})]);
      expect(claimantPid).toBeGreaterThan(0);
      expect(claimantPid).not.toBe(pid);
      let blocked=false;
      const deadline=Date.now()+3000;
      while(Date.now()<deadline) {
        const state=await observer.tx(async fresh=>{
          await fresh.query("select pg_stat_clear_snapshot()");
          const [state]=await fresh.query<{blocked:boolean;observer_pid:number}>(`select pg_backend_pid() as observer_pid,
            exists (select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'
              and query like '%select address,spec_digest,spec from platform.resources%'
              and $2=any(pg_blocking_pids(pid))) as blocked`,[claimantPid,pid]);
          return state;
        });
        expect(state.observer_pid).not.toBe(claimantPid);
        expect(state.observer_pid).not.toBe(pid);
        if(state?.blocked) {blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      // Mutation happens only after the DB proves this launch is waiting.
      if(change==="revoked approver role") f.h.world.members.set(`${f.ctx.workspaceId}|erin`,"viewer");
      if(change==="new approval count") f.h.setEngine(scriptedEngine("stricter-wait-policy",()=>requireApproval(2,"admin",true)));
      if(change==="current policy deny") f.h.setEngine(scriptedEngine("deny-wait-policy",()=>({outcome:"deny",reasons:[{code:"build_denied",message:"Build denied."}]})));
      const [live]=await blocker.query<{operation:boolean;fence:boolean;approvals:number}>(`select
        o.status='running' and o.expires_at>clock_timestamp() and o.lease_until>clock_timestamp() as operation,
        l.expires_at>clock_timestamp() and l.released_at is null as fence,
        (select count(*)::integer from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
          and a.approval_round=o.approval_round and a.decision='approve' and a.consumed_at is not null and a.expires_at>clock_timestamp()) as approvals
        from platform.operations o join platform.leases l on l.scope=o.lease_scope where o.workspace_id=$1 and o.id=$2`,[f.ctx.workspaceId,f.op.id]);
      expect(live).toEqual({operation:true,fence:true,approvals:1});
      expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
      // Commit releases the exact resource lock after current authority changed.
    }); } finally { if(outcome) await outcome; }
    const result=await outcome;
    const retained=await world.db.query<{phase:string;build_id:string}>("select phase,build_id from platform.build_launches where workspace_id=$1 and operation_id=$2",[f.ctx.workspaceId,f.op.id]);
    if(change==="unchanged authority") {
      expect(result).toEqual({buildId:f.build.id});
      expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
      expect(retained).toEqual([{phase:"accepted",build_id:f.build.id}]);
    } else {
      expect(result.error).toMatchObject({code:"build_launch_unconfirmed"});
      expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
      expect(retained).toHaveLength(0);
    }
  },15000);

  it("commits one claim across competing workers and sends the bound ZIP once", async () => {
    const f = await fixture();
    let sdkAttempts: number | undefined;
    cb.on(StartBuildCommand).callsFake(async (_input, getClient) => {
      sdkAttempts = await getClient().config.maxAttempts();
      return { build: f.build, $metadata: { requestId: "accepted-request" } };
    });
    // The losing worker may arrive before acknowledgement; then it must refuse,
    // not wait and acquire a second right to dispatch.
    const attempts = await Promise.allSettled([f.startBuild(f.ctx, f.pipeline, f.input, world.db), f.startBuild(f.ctx, f.pipeline, f.input, world.db2)]);
    expect(attempts.some(r => r.status === "fulfilled")).toBe(true);
    const handle = await f.startBuild(f.ctx, f.pipeline, f.input, world.db2);
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
    expect(sdkAttempts).toBe(1);
    expect(cb.commandCalls(StartBuildCommand)[0].args[0].input).toMatchObject({ sourceLocationOverride: `zenith-build-source/${f.input.sourceS3Key}`, environmentVariablesOverride: [{ name: "ZENITH_SOURCE_DIGEST", value: f.input.sourceDigest, type: "PLAINTEXT" }], autoRetryLimitOverride: 0 });
    const retained = await repos.buildLaunches.get(world.db2, f.ctx.workspaceId, f.op.id, handle.buildId);
    expect(retained).toMatchObject({ phase: "accepted", request_ids: ["accepted-request"], binding: { serviceAddress: f.service.address, sourceKey: f.input.sourceS3Key } });
  });

  it("keeps an accepted-but-lost response permanently unconfirmed, including after token expiry", async () => {
    const f = await fixture();
    cb.on(StartBuildCommand).rejects(new Error("response lost"));
    await expect(f.startBuild(f.ctx, f.pipeline, f.input, world.db)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    cb.on(StartBuildCommand).resolves({ build: f.build, $metadata: { requestId: "second-response" } });
    await expect(f.startBuild(f.ctx, f.pipeline, f.input, world.db2)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    await world.db.query("update platform.operations set expires_at=clock_timestamp()-interval '6 minutes' where workspace_id=$1 and id=$2", [f.ctx.workspaceId, f.op.id]);
    await expect(f.startBuild(f.ctx, f.pipeline, f.input, world.db2)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
    const [row] = await world.db.query<{ phase: string; build_id: string | null }>("select phase,build_id from platform.build_launches where workspace_id=$1 and operation_id=$2", [f.ctx.workspaceId, f.op.id]);
    expect(row).toEqual({ phase: "dispatched", build_id: null });
  });

  it("rejects altered input/settings and missing ownership or stored checksum before another dispatch", async () => {
    const f = await fixture();
    await f.startBuild(f.ctx, f.pipeline, f.input, world.db);
    cb.on(BatchGetProjectsCommand).resolves({ projects: [{ ...f.project, environment: { ...f.project.environment!, image: "changed-image" } }] });
    await expect(f.startBuild(f.ctx, f.pipeline, f.input, world.db2)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    cb.on(BatchGetProjectsCommand).resolves({ projects: [{ ...f.project, tags: [] }] });
    await expect(f.startBuild(f.ctx, f.pipeline, f.input, world.db2)).rejects.toThrow();
    cb.on(BatchGetProjectsCommand).resolves({ projects: [f.project] });
    s3.on(HeadObjectCommand).resolves({ ContentLength: 100, ChecksumSHA256: "wrong" });
    await expect(f.startBuild(f.ctx, f.pipeline, f.input, world.db2)).rejects.toThrow();
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
  });

  it("retains a provider-complete failure receipt independently of cancelled UI status", async () => {
    const f = await fixture(); const handle = await f.startBuild(f.ctx, f.pipeline, f.input, world.db);
    await repos.operations.transition(world.db2, { workspaceId: f.ctx.workspaceId, id: f.op.id, from: ["running"], to: "cancelled" });
    const endTime=await terminalTimestamp(f.ctx.workspaceId,f.op.id);
    cb.on(BatchGetBuildsCommand).resolves({ builds: [{ ...f.build, buildStatus: "FAILED", buildComplete: true, endTime }], $metadata: { requestId: "terminal-read" } });
    expect(await waitForBuild(f.ctx, handle.buildId, {}, world.db2)).toMatchObject({ status: "FAILED" });
    expect(await repos.buildLaunches.get(world.db, f.ctx.workspaceId, f.op.id, handle.buildId)).toMatchObject({ phase: "terminal", terminal_status: "FAILED" });
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
  });

  it.each(["omitted","empty","default-flags"] as const)("returns verified executed output with %s NO_ARTIFACTS readback through canonical authority", async artifactShape => {
    const f=await fixture(); const handle=await f.startBuild(f.ctx,f.pipeline,f.input,world.db);
    const imageDigest=`sha256:${"a".repeat(64)}`;
    const artifacts=artifactShape==="omitted"?undefined:artifactShape==="empty"?{}:{encryptionDisabled:false,overrideArtifactName:false,bucketOwnerAccess:"NONE" as const};
    const endTime=await terminalTimestamp(f.ctx.workspaceId,f.op.id);
    cb.on(BatchGetBuildsCommand).resolves({builds:[{...f.build,buildStatus:"SUCCEEDED",buildComplete:true,endTime,artifacts,autoRetryConfig:{autoRetryLimit:0,autoRetryNumber:0},exportedEnvironmentVariables:[{name:"ZENITH_IMAGE_DIGEST",value:imageDigest}]}],$metadata:{requestId:"successful-terminal-read"}});
    ecr.on(DescribeRepositoriesCommand).resolves({repositories:[{repositoryName:"zenith-web",repositoryUri:f.repositoryUri}]});
    const before=cb.commandCalls(BatchGetProjectsCommand).length;
    expect(await createAwsBuildPort(world.db2).waitForBuild(f.ctx,handle,{timeoutMs:1000})).toEqual({status:"succeeded",digest:imageDigest,imageUri:`${f.repositoryUri}@${imageDigest}`});
    expect(cb.commandCalls(BatchGetProjectsCommand).length-before).toBe(1);
    expect(await repos.buildLaunches.get(world.db,f.ctx.workspaceId,f.op.id,handle.buildId)).toMatchObject({phase:"terminal",terminal_status:"SUCCEEDED",terminal_request_id:"successful-terminal-read"});
  });

  it("refuses terminal status without completion, a foreign build, and a polling deadline as clean failure", async () => {
    const f = await fixture(); const handle = await f.startBuild(f.ctx, f.pipeline, f.input, world.db);
    cb.on(BatchGetBuildsCommand).resolves({ builds: [{ ...f.build, buildStatus: "FAILED", buildComplete: false }] });
    await expect(waitForBuild(f.ctx, handle.buildId, {}, world.db2)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    cb.on(BatchGetBuildsCommand).resolves({ builds: [{ ...f.build, arn: f.build.arn!.replace("123456789012", "999999999999") }] });
    await expect(waitForBuild(f.ctx, handle.buildId, {}, world.db2)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    cb.on(BatchGetBuildsCommand).resolves({ builds: [f.build] });
    await expect(createAwsBuildPort(world.db).waitForBuild(f.ctx, handle, { timeoutMs: -1 })).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    expect(await repos.buildLaunches.get(world.db, f.ctx.workspaceId, f.op.id, handle.buildId)).toMatchObject({ phase: "accepted", terminal_status: null });
  });

  it.each(["image", "environment", "repository", "role", "encryption", "vpc", "source", "artifacts", "secondaryArtifacts", "missingEnvironment", "duplicateEnvironment", "duplicateDigest", "digestType", "retryLimit", "retryAncestor"] as const)("refuses a changed executed %s even after the project was restored", async change => {
    const f = await fixture(); const handle = await f.startBuild(f.ctx, f.pipeline, f.input, world.db);
    const actual: Build = structuredClone(f.build);
    if (change === "image") actual.environment!.image = "different-image";
    if (change === "environment") actual.environment!.environmentVariables![0].value = "different-mode";
    if (change === "repository") actual.environment!.environmentVariables![1].value = f.repositoryUri.replace("zenith-web","foreign-output");
    if (change === "role") actual.serviceRole = f.build.serviceRole!.replace("role/build", "role/other");
    if (change === "encryption") actual.encryptionKey = "alias/other-key";
    if (change === "vpc") actual.vpcConfig = { vpcId: "vpc-other", subnets: ["subnet-other"], securityGroupIds: ["sg-other"] };
    if (change === "source") actual.source!.buildspec = "version: 0.1";
    if (change === "artifacts") actual.artifacts = { location: "arn:aws:s3:::foreign-output/artifact.zip" };
    if (change === "secondaryArtifacts") actual.secondaryArtifacts = [{ artifactIdentifier: "foreign", location: "arn:aws:s3:::foreign-output/secondary.zip" }];
    if (change === "missingEnvironment") actual.environment!.environmentVariables = undefined;
    if (change === "duplicateEnvironment") actual.environment!.environmentVariables!.push({ ...actual.environment!.environmentVariables![0] });
    if (change === "duplicateDigest") actual.environment!.environmentVariables!.push({ ...actual.environment!.environmentVariables!.find(v=>v.name==="ZENITH_SOURCE_DIGEST")! });
    if (change === "digestType") actual.environment!.environmentVariables!.find(v=>v.name==="ZENITH_SOURCE_DIGEST")!.type="PARAMETER_STORE";
    if (change === "retryLimit") actual.autoRetryConfig={autoRetryLimit:1};
    if (change === "retryAncestor") actual.autoRetryConfig={previousAutoRetry:"foreign-retry-id"};
    // The current Project exactly matches preflight again. Only Build exposes
    // the settings that actually ran during the intervening change.
    cb.on(BatchGetProjectsCommand).resolves({ projects: [f.project] });
    cb.on(BatchGetBuildsCommand).resolves({ builds: [actual], $metadata: { requestId: "restored-project-read" } });
    await expect(waitForBuild(f.ctx, handle.buildId, {}, world.db2)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    expect(await repos.buildLaunches.get(world.db, f.ctx.workspaceId, f.op.id, handle.buildId)).toMatchObject({ phase: "accepted", terminal_status: null });
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(1);
  });
});
