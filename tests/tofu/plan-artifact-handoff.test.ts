/** Required combined lane: real PostgreSQL, independent producer process, pinned OpenTofu builtin resources, no cloud calls. */
import { spawn, execFile } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, readdir, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { approvalRoundOf } from "@/lib/controlplane/db/repos/operation-review";
import { PlanArtifactError } from "@/lib/controlplane/db/repos/plan-artifacts";
import type { BrokerPort } from "@/lib/execution/ports";
import { digest } from "@/lib/controlplane/digest";
import { executionHolder } from "@/lib/execution/platform";
import { createApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { PLATFORM_SCHEMA_VERSION } from "@/lib/controlplane/db/migrations";
import { createOwningSourceBundles } from "@/lib/platform/source-bundle";
import { sourceRecipe, sourceSnapshotSetDigest, type ApprovedSourceSnapshot, type SourceCaptureInput } from "@/lib/execution/source-snapshot";
import { createPlanEngineAuthority, createPlanArtifactCodec, planWorkspace, applyVerifiedPlan, type PlanCustodyInput, type ApprovedPlan } from "@/lib/tofu/engine";
import { createExecutionBroker } from "@/lib/platform/broker";
import { checkDestroyApproval } from "@/lib/execution/destroy";
import { createRuntime } from "@/lib/execution/runtime";
import { createPlatformPorts } from "@/lib/execution/platform";
import { createWorld } from "../execution/fakes/world";
import { TofuRunner, type TofuRunContext } from "@/lib/tofu/runner";
import { TofuPlanProvenanceError, type TofuWorkspace } from "@/lib/tofu/types";
import { planArtifactCipherFromEnv, createPlanArtifactRuntime, createIsolatedPlanArtifactRuntimeForTests } from "@/lib/platform/plan-artifacts";
import { builtinWorkspace, dataFragment, tofuOnPath } from "./_helpers";
import { createBroker } from "@/lib/capabilities/platform";
import { PlatformBrokerStore } from "@/lib/capabilities/platform-store";
import { makeHarness, scriptedEngine, requireApproval, allowDecision, sessionFor, user } from "../capabilities/support";
import { PG_URL, seedApprovedOperation, withScratchDatabase } from "../controlplane/_support/harness";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";
import { writeTar } from "../_support/tar";
import { keys, api } from "../sources/fixtures";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const runFile=promisify(execFile);
async function matchingPostgresTools(db:Awaited<ReturnType<typeof openPlatformDb>>) {
  const dump=process.env.ZENITH_TEST_PG_DUMP_BIN??"pg_dump";
  const restore=process.env.ZENITH_TEST_PG_RESTORE_BIN??"pg_restore";
  const fail=():never=>{throw new Error("Private PostgreSQL restore requires matching dump/restore client versions and server major.");};
  if((process.env.ZENITH_TEST_PG_DUMP_BIN!==undefined && !path.isAbsolute(dump))
    ||(process.env.ZENITH_TEST_PG_RESTORE_BIN!==undefined && !path.isAbsolute(restore)))fail();
  const env:NodeJS.ProcessEnv={NODE_ENV:"test",PATH:process.env.PATH,HOME:os.tmpdir()};
  const version=async(file:string,command:"pg_dump"|"pg_restore")=>{
    let output:string;
    try {output=(await runFile(file,["--version"],{env,maxBuffer:4096})).stdout.trim();}catch{return fail();}
    const match=output.match(/^(pg_dump|pg_restore) \(PostgreSQL\) (\d+\.\d+(?:\.\d+)?)(?: [^\r\n]+)?$/);
    if(!match || match[1]!==command) return fail();
    return match[2];
  };
  const dumpVersion=await version(dump,"pg_dump"),restoreVersion=await version(restore,"pg_restore");
  const server=(await db.query<{version:string}>("select current_setting('server_version_num') as version"))[0]?.version;
  if(!server || !/^\d+$/.test(server) || !Number.isSafeInteger(Number(server)) || dumpVersion!==restoreVersion
    ||Number(dumpVersion.split(".")[0])!==Math.floor(Number(server)/10000))fail();
  return {dump,restore};
}
async function privatePostgresTool(file:string,args:string[],url:string) {
  const parsed=new URL(url);
  const env:NodeJS.ProcessEnv={NODE_ENV:"test",PATH:process.env.PATH,HOME:os.tmpdir(),PGHOST:parsed.hostname,PGPORT:parsed.port||"5432",PGUSER:decodeURIComponent(parsed.username),PGPASSWORD:decodeURIComponent(parsed.password),PGDATABASE:decodeURIComponent(parsed.pathname.slice(1))};
  try {await runFile(file,args,{env,maxBuffer:65536});}catch{throw new Error("Private PostgreSQL backup/restore command failed.");}
}
class InspectRunner extends TofuRunner {
  activeDirectory="";
  override async open(ws:TofuWorkspace,ctx:TofuRunContext={}) { const run=await super.open(ws,ctx);this.activeDirectory=run.workDir;return run; }
}
const childSource = `
import { openPlatformDb } from './src/lib/controlplane/db/index.ts';
import { planEvidence } from './src/lib/execution/plan-evidence.ts';
import { extractPlanFacts } from './src/lib/policy/plan-facts.ts';
import { createPlanArtifactRuntime } from './src/lib/platform/plan-artifacts.ts';
let raw=''; for await (const part of process.stdin) raw+=part; const c=JSON.parse(raw);
let db; try {
 db=await openPlatformDb({kind:'postgres',url:c.url,max:1});
 // The child process itself has a private allowlisted environment; capture its intended tool settings explicitly.
 const runtime=createPlanArtifactRuntime(db,{...process.env,ZENITH_PLAN_ARTIFACT_KEY:c.key,ZENITH_WORKER_PLAN_DIR:c.workRoot,ZENITH_TOFU_PLUGIN_CACHE:c.cache});
 const produced=await runtime.tofu.planWorkspace(c.ws,undefined,{custody:c.custody,lock:false,destroy:c.destroy,normalize:{fingerprintKey:c.fingerprint,...(c.executableSourceDigest?{executableSourceDigest:c.executableSourceDigest}:{})}});
 const port=runtime.planArtifacts;
 await port.publish({produced:produced.produced,lease:c.lease,evidence:{id:c.evidenceId,workspaceId:c.custody.workspaceId,operationId:c.custody.operationId,
  kind:'tofu_plan',digest:produced.plan.planDigest,summary:{...planEvidence({plan:produced.plan,facts:extractPlanFacts(produced.plan),cost:{},graphDigest:c.custody.graphDigest,stage:'plan',...(c.approvedSources?{approvedSources:c.approvedSources}:{})}).summary,destroy:!!c.destroy,destroyAddresses:produced.plan.resourceChanges.map(r=>r.address),statefulDeletes:[]},simulated:false}});
 process.stdout.write(JSON.stringify({planDigest:produced.plan.planDigest}));
} catch { process.exitCode=1; } finally { await db?.close(); }
`;
async function producer(config:unknown):Promise<{planDigest:string}> {
  const env:NodeJS.ProcessEnv={NODE_ENV:"test"};
  for (const name of ["PATH","HOME","TMPDIR","ZENITH_TOFU_BIN","ZENITH_TOFU_PLUGIN_CACHE"]) {const value=process.env[name];if(value)env[name]=value;}
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",childSource],{cwd:process.cwd(),env,stdio:["pipe","pipe","pipe"]});
    let output=""; let overflow=false;
    child.stdout.on("data",part=>{output+=part;if(output.length>4096){overflow=true;child.kill();}});
    // No child diagnostic values are emitted into assertion output.
    child.stderr.resume(); child.on("error",()=>reject(new Error("Independent producer could not start.")));
    child.on("exit",code=>{if(code!==0||overflow)return reject(new Error("Independent producer refused publication."));try{resolve(JSON.parse(output));}catch{reject(new Error("Independent producer reply was invalid."));}});
    child.stdin.end(JSON.stringify(config));
  });
}

// Missing prerequisites remain visible skips locally; committed mandatory gate declarations must reject them in CI.
if (process.env.ZENITH_TEST_PLAN_SOURCE_AUTHORITY_REQUIRED === "1" && (!PG_URL || !tofuOnPath() || process.env.ZENITH_TEST_TOFU_NETWORK !== "1" || PLATFORM_SCHEMA_VERSION < 13))
  throw new Error("Original plan source acceptance requires actual PostgreSQL, canonical schema13 and pinned OpenTofu network admission.");
describe.skipIf(!PG_URL || !tofuOnPath() || process.env.ZENITH_TEST_TOFU_NETWORK !== "1")("authenticated original cross-worker handoff [postgres]",()=>{
  async function fixture<T>(fn:(f:Awaited<ReturnType<typeof setup>>)=>Promise<T>) {
    return withScratchDatabase(async url=>{const f=await setup(url);try{return await fn(f);}finally{await f.closeSourceFixture();await f.a.close();await f.b.close();await rm(f.temp,{recursive:true,force:true});}});
  }
  async function setup(url:string) {
    const a=await openPlatformDb({kind:"postgres",url,migrate:true,max:3}); const b=await openPlatformDb({kind:"postgres",url,max:3});
    const temp=await mkdtemp(path.join(os.tmpdir(),"zenith-real-handoff-"));
    const state=path.join(temp,"customer-state.tfstate"), cache=path.join(temp,"cache");
    const runner=new InspectRunner({workRoot:temp,pluginCacheDir:cache,limits:{timeoutMs:120000}});
    const key=randomBytes(32).toString("hex"), fingerprint=randomBytes(32).toString("hex");
    let sourceMaterial: Awaited<ReturnType<typeof keys>> | undefined;
    // This SQL/tool fixture isolates product scope/policy; the full review scenario installs the scoped canonical broker below.
    const fixtureBroker=(db:typeof b):Pick<BrokerPort,"approvalStatus">=>({approvalStatus:async id=>{
      const op=(await repos.operations.getForSystem(db,id))!;
      return {approved:!op.approvalRequired,rejected:false,dispatchApproval:{approvalIds:[],requiredApprovalCount:0,approvalRound:approvalRoundOf(op),proposalDigest:op.proposalDigest,planDigest:op.planDigest}};
    }});
    let dispatchBroker=fixtureBroker(b);
    const custodyRuntime=createIsolatedPlanArtifactRuntimeForTests(b,{...process.env,ZENITH_PLAN_ARTIFACT_KEY:key,ZENITH_WORKER_PLAN_DIR:temp,ZENITH_TOFU_PLUGIN_CACHE:cache},{approvalStatus:id=>dispatchBroker.approvalStatus(id)});
    const port=custodyRuntime.planArtifacts;
    const ws=(value="v1")=>builtinWorkspace(state,{"resource/test":dataFragment("test",value)});
    async function review(workspace=ws(),destroy=false,sourceReview=false,withSource=false,boundSource=false) {
      const workspaceId=`ws_${randomUUID()}`,environmentId=`env_${randomUUID()}`;
      const {operation:op}=await seedApprovedOperation(a,workspaceId,{proposal:{capability:sourceReview?"infrastructure.plan":destroy?"infrastructure.destroy":"infrastructure.apply",
        scope:{workspaceId,projectId:"proj_1",environmentId},input:{environmentId,...(sourceReview?{teardownReview:true}:{})}}});
      const lease=await repos.leases.acquire(a,{scope:`env:${op.environmentId}`,workspaceId,holder:`worker:producer:${op.id}`,ttlMs:120000});
      if(!lease)throw new Error("Review lease missing");
      await repos.operations.claimForExecution(a,{workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:executionHolder(op.id),leaseMs:120000,lease});
      let approvedSources: ApprovedSourceSnapshot[] | undefined;
      if(withSource) {
        // Explicit modeled GitHub transport with genuine branded capture and the owning native immutable store.
        const pipeline=mkNode("build_pipeline/web","build_pipeline","aws:codebuild_project",{source:{repo:"acme/app",ref:"main",dockerfile:"Dockerfile"}},{region:"eu-west-1",specDigest:digest("pipeline")});
        const service=mkNode("container_service/web","container_service","aws:ecs_service",{artifact:{type:"built",pipeline:pipeline.address}},{region:"eu-west-1",specDigest:digest("service")});
        for(const node of [pipeline,service])await repos.resources.upsertDesired(a,{workspaceId,projectId:op.projectId!,environmentId:op.environmentId!,node,status:"active"});
        if(boundSource) {
          sourceMaterial ??= await keys();
          vi.stubEnv("ZENITH_GITHUB_APP_ID","42");vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE",sourceMaterial.config.privateKeyFile);
          await a.query("insert into platform.github_source_bindings(workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values ($1,'42',7,99,'acme','app',1,'fixture-admin')",[workspaceId]);
        }
        const app=api();
        const fetchImpl:typeof fetch=async(raw,init)=>{const url=String(raw);
          if(url==="https://api.github.com/repos/acme/app")return Response.json({id:99,name:"app",owner:{login:"acme"},private:boundSource});
          if(url.startsWith("https://api.github.com/repos/acme/app/commits/"))return new Response("a".repeat(40));
          if(url.startsWith("https://codeload.github.com/acme/app/tar.gz/"))return new Response(new Uint8Array(gzipSync(writeTar([{path:"root/Dockerfile",bytes:Buffer.from("FROM scratch\n")},{path:"root/app.txt",bytes:Buffer.from("immutable source fixture")}]))));
          return app(raw,init);
        };
        const store=createApprovedSourceSnapshotStore(a),source=createOwningSourceBundles(a,{sourceSnapshots:store,fetchImpl});
        const input:SourceCaptureInput={workspaceId,operationId:op.id,projectId:op.projectId!,environmentId:op.environmentId!,serviceAddress:service.address,serviceSpecDigest:service.specDigest,
          pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,provider:"aws",region:service.region,repository:"acme/app",requestedRef:"main",dockerfile:"Dockerfile",recipeDigest:sourceRecipe(service,pipeline),archiveFormat:"zip"};
        const captured=await source.port.capture(input);await store.retain(captured,lease);approvedSources=[captured];
      }
      const executableSourceDigest=approvedSources && sourceSnapshotSetDigest(approvedSources);
      const custody:PlanCustodyInput={workspaceId,projectId:op.projectId!,environmentId:op.environmentId!,operationId:op.id,proposalDigest:op.proposalDigest,inputDigest:op.inputDigest,expiresAt:op.expiresAt,sourceDigest:digest("source"),graphDigest:digest(workspace.addressMap)};
      const localA=await mkdtemp(path.join(temp,"producer-"));
      const plan=await producer({url,key,fingerprint,ws:workspace,custody,lease,workRoot:localA,cache,destroy,executableSourceDigest,approvedSources,evidenceId:`evd_${op.id}`});
      await rm(localA,{recursive:true,force:true});
      expect(await readdir(temp)).not.toContain(path.basename(localA));
      return {op,lease,custody,planDigest:plan.planDigest,workspace,destroy,executableSourceDigest};
    }
    const activeDirectory=async()=> {
      const entries=await readdir(temp,{withFileTypes:true});
      const dirs=entries.filter(entry=>entry.isDirectory()&&entry.name.startsWith("zenith-tofu-run-"));
      if (dirs.length!==1) throw new Error("Private worker workspace is not exclusive.");
      return path.join(temp,dirs[0].name,"work");
    };
    return {url,a,b,temp,state,cache,runner,key,fingerprint,port,tofu:custodyRuntime.tofu,ws,review,activeDirectory,fixtureBroker,closeSourceFixture:async()=>{await sourceMaterial?.close();vi.unstubAllEnvs();},setDispatchBroker:(broker:Pick<BrokerPort,"approvalStatus">)=>{dispatchBroker=broker;}};
  }
  it("matching immutable source identity consumes original bytes and a different source digest refuses before dispatch",async()=>{
    await fixture(async f=>{
      const r=await f.review(f.ws(),false,false,true);let dispatches=0;
      await expect(f.port.consume(r,(original,dispatch)=>f.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest,
        normalize:{fingerprintKey:f.fingerprint,executableSourceDigest:"b".repeat(64)},beforeDispatch:async()=>{dispatches++;await dispatch();}}))).rejects.toThrow();
      expect(dispatches).toBe(0);
      // Failed original attempts are intentionally not reused: obtain a new review/operation.
      const positive=await f.review(f.ws(),false,false,true);
      const result=await f.port.consume(positive,(original,dispatch)=>f.tofu.applyVerifiedPlan(positive.workspace,{original,custody:positive.custody,approvedDigest:positive.planDigest,
        normalize:{fingerprintKey:f.fingerprint,executableSourceDigest:positive.executableSourceDigest},beforeDispatch:async()=>{
          const bytes=await readFile(path.join(await f.activeDirectory(),"reviewed.tfplan"));expect(sha(bytes)).toBe(original.manifest.rawSha256);
          dispatches++;await dispatch();
        }}));expect(result.apply.exitCode).toBe(0);expect(result.plan.executableSourceDigest).toBe(positive.executableSourceDigest);expect(dispatches).toBe(1);
    });
  });
  it("independent saved binary with matching native private source binding applies the exact original once",async()=>{
    await fixture(async f=>{
      const r=await f.review(f.ws(),false,false,true,true);let entered=0;
      const native=await createApprovedSourceSnapshotStore(f.b).list({workspaceId:r.op.workspaceId,operationId:r.op.id,projectId:r.op.projectId!,environmentId:r.op.environmentId!});
      expect(native).toHaveLength(1);expect(native[0].githubBinding).toEqual({appId:"42",installationId:7,repositoryId:99,version:1});expect(sourceSnapshotSetDigest(native)).toBe(r.executableSourceDigest);
      const result=await f.port.consume(r,original=>f.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest,normalize:{fingerprintKey:f.fingerprint,executableSourceDigest:r.executableSourceDigest},beforeDispatch:async()=>{
        expect(sha(await readFile(path.join(await f.activeDirectory(),"reviewed.tfplan")))).toBe(original.manifest.rawSha256);entered++;
        await writeFile(path.join(await f.activeDirectory(),"tfplan"),"fresh source fallback forbidden");
      }}));
      expect(result.apply.exitCode).toBe(0);expect(entered).toBe(1);
      expect(await f.b.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[r.op.workspaceId,r.op.id])).toEqual([{phase:"succeeded"}]);
      await expect(f.port.consume(r,async()=>undefined)).rejects.toThrow();expect(entered).toBe(1);
    });
  },180000);
  it("independent saved binary refuses committed private source revocation before original apply without a fresh fallback",async()=>{
    await fixture(async f=>{
      const r=await f.review(f.ws(),false,false,true,true);let reached=0;
      const beforeState=await readFile(f.state).catch(()=>null);
      await expect(f.port.consume(r,original=>f.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest,normalize:{fingerprintKey:f.fingerprint,executableSourceDigest:r.executableSourceDigest},beforeDispatch:async()=>{
        expect(sha(await readFile(path.join(await f.activeDirectory(),"reviewed.tfplan")))).toBe(original.manifest.rawSha256);reached++;
        await f.a.query("update platform.github_source_bindings set revoked_at=clock_timestamp(),version=version+1 where workspace_id=$1",[r.op.workspaceId]);
      }}))).rejects.toThrow("unconfirmed");
      expect(reached).toBe(1);expect(await readFile(f.state).catch(()=>null)).toEqual(beforeState);
      expect(await f.b.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[r.op.workspaceId,r.op.id])).toEqual([{phase:"ready"}]);
      expect(await f.b.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[r.op.workspaceId,r.op.id])).toHaveLength(1);
    });
  },180000);
  it("producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys",async()=>{
    await fixture(async f=>{
      const reviewed=await f.review();
      const result=await f.port.consume(reviewed,async(original,dispatch)=>f.tofu.applyVerifiedPlan(reviewed.workspace,{original,custody:reviewed.custody,approvedDigest:reviewed.planDigest,normalize:{fingerprintKey:f.fingerprint},beforeDispatch:async()=>{
        expect(sha(await readFile(path.join(await f.activeDirectory(),"reviewed.tfplan")))).toBe(original.manifest.rawSha256);
        // Poison only the freshly generated file. Success proves the command consumes the reviewed original instead.
        await writeFile(path.join(await f.activeDirectory(),"tfplan"),"not-an-executable-plan",{mode:0o600});
        await dispatch();
      }}));
      expect(result.apply.exitCode).toBe(0); expect(result.plan.summary.create).toBe(1);
      await repos.leases.release(f.a,reviewed.lease);
      const destroy=await f.review(f.ws(),true);
      const removed=await f.port.consume(destroy,(original,dispatch)=>f.tofu.applyVerifiedPlan(destroy.workspace,{original,custody:destroy.custody,approvedDigest:destroy.planDigest,destroy:true,normalize:{fingerprintKey:f.fingerprint},beforeDispatch:dispatch}));
      expect(removed.apply.exitCode).toBe(0); expect(removed.plan.summary.delete).toBe(1);
      expect((await planWorkspace(f.ws(),undefined,{runner:f.runner,destroy:true,normalize:{fingerprintKey:f.fingerprint}})).plan.empty).toBe(true);
    });
  },240000);
  it("fresh semantic drift refuses before dispatch and has no original/fresh fallback",async()=>{
    await fixture(async f=>{const r=await f.review();let dispatches=0;
      // Same reviewed configuration: an independent actor applies it first, moving live state.
      const external=await planWorkspace(r.workspace,undefined,{runner:f.runner,normalize:{fingerprintKey:f.fingerprint}});
      await applyVerifiedPlan(r.workspace,{runner:f.runner,approvedDigest:external.plan.planDigest,normalize:{fingerprintKey:f.fingerprint}});
      const beforeState=await readFile(f.state);
      await expect(f.port.consume(r,(original,dispatch)=>f.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest,normalize:{fingerprintKey:f.fingerprint},beforeDispatch:async()=>{dispatches++;await dispatch();}}))).rejects.toThrow();
      expect(dispatches).toBe(0);
      expect(await readFile(f.state)).toEqual(beforeState);
      expect(await f.b.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[r.op.workspaceId,r.op.id])).toEqual([{phase:"ready"}]);
    });
  },180000);
  it("source/config/backend/address-map/lock/tool and operation swaps refuse before mutation",async()=>{
    await fixture(async f=>{const r=await f.review();let calls=0;
      for(const key of ["sourceDigest","graphDigest","operationId","workspaceId","projectId","environmentId"] as const){
        await expect(f.port.inspect({...r,custody:{...r.custody,[key]:digest(`changed-${key}`)}},async()=>{calls++;})).rejects.toThrow();
      }
      let configRefusal:unknown;let runnerRefusal:unknown;
      const variantRefusals:unknown[]=[];
      const custodyRefusal=await f.port.consume(r,async original=>{
        configRefusal=await f.tofu.applyVerifiedPlan(f.ws("changed"),{original,custody:r.custody,approvedDigest:r.planDigest,beforeDispatch:async()=>{calls++;}}).catch((err:unknown)=>err);
        for(const variant of [{...r.workspace,addressMap:{}},{...r.workspace,lockDigest:digest("wrong-lock")}])
          variantRefusals.push(await f.tofu.applyVerifiedPlan(variant,{original,custody:r.custody,approvedDigest:r.planDigest,beforeDispatch:async()=>{calls++;}}).catch((err:unknown)=>err));
        const replacementRunner=new TofuRunner({expectedVersion:"0.0.0",workRoot:f.temp,pluginCacheDir:f.cache});
        runnerRefusal=await f.tofu.applyVerifiedPlan(r.workspace,{runner:replacementRunner,original,custody:r.custody,approvedDigest:r.planDigest}).catch((err:unknown)=>err);
      }).catch((err:unknown)=>err);
      // Assertion failures must not satisfy the expected custody rejection themselves.
      expect(custodyRefusal).toBeInstanceOf(PlanArtifactError);
      expect(custodyRefusal).toMatchObject({code:"plan_artifact_unavailable",message:"Reviewed plan artifact is unavailable or changed; a new review is required."});
      expect(configRefusal).toBeInstanceOf(TofuPlanProvenanceError);
      expect(configRefusal).toMatchObject({code:"plan_provenance_changed",message:"Reviewed plan provenance changed; a new review is required."});
      expect(configRefusal).not.toHaveProperty("currentDigest");
      expect(variantRefusals).toHaveLength(2);
      for(const refusal of variantRefusals)expect(refusal).toBeInstanceOf(Error);
      expect(runnerRefusal).toBeInstanceOf(Error);
      expect(runnerRefusal).toMatchObject({message:"Production plan custody does not accept a runner override."});
      expect(calls).toBe(0);
      expect(await readFile(f.state).catch(()=>null)).toBeNull();
      expect(await f.b.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[r.custody.workspaceId,r.op.id])).toEqual([{phase:"ready"}]);
      expect((await repos.evidence.list(f.b,r.custody.workspaceId,{operationId:r.op.id})).filter(e=>e.kind==="tofu_apply")).toHaveLength(0);
    });
  },180000);
  it("tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch",async()=>{
    await fixture(async f=>{const r=await f.review();
      await expect(f.port.consume(r,(original,dispatch)=>f.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest,normalize:{fingerprintKey:f.fingerprint},beforeDispatch:async()=>{await writeFile(path.join(await f.activeDirectory(),"reviewed.tfplan"),"altered");await dispatch();}}))).rejects.toThrow("unconfirmed");
      expect(await readFile(f.state).catch(()=>null)).toBeNull();
      await expect(f.port.consume(r,async()=>"retry")).rejects.toThrow();
      expect(await f.b.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[r.custody.workspaceId,r.op.id])).toEqual([{phase:"uncertain"}]);
    });
  },180000);
  it("source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL",async()=>{
    await fixture(async f=>{
      const create=await f.review();
      await f.port.consume(create,original=>f.tofu.applyVerifiedPlan(create.workspace,{original,custody:create.custody,approvedDigest:create.planDigest,normalize:{fingerprintKey:f.fingerprint}}));
      await repos.leases.release(f.a,create.lease);
      const source=await f.review(f.ws(),true,true);
      const h=await makeHarness({kind:"memory",engine:scriptedEngine("handoff-policy",input=>input.request.capability==="infrastructure.destroy"?requireApproval(1,"admin"):allowDecision())});
      h.deps.store=new PlatformBrokerStore(f.a);h.deps.clock={now:()=>new Date()};
      h.world.workspaces.add(source.op.workspaceId);h.world.projects.set(source.op.projectId!,{workspaceId:source.op.workspaceId});
      h.world.environments.set(source.op.environmentId!,{projectId:source.op.projectId!,class:"sandbox",provider:"aws",region:"ap-south-1"});
      h.world.members.set(`${source.op.workspaceId}|${source.op.principal.id}`,"admin");h.world.members.set(`${source.op.workspaceId}|browser-admin`,"admin");
      const broker=createBroker(h.deps);
      const destination=await broker.propose({capability:"infrastructure.destroy",scope:{workspaceId:source.op.workspaceId,projectId:source.op.projectId,environmentId:source.op.environmentId},input:{environmentId:source.op.environmentId}},source.op.principal,
        {via:"workflow",teardownReview:true,destroyPlan:{operationId:source.op.id,planDigest:source.planDigest}});
      const storedDestination=await repos.operations.get(f.a,source.op.workspaceId,destination.operation.id);
      if(!storedDestination)throw new Error("Authoritative destroy destination is missing.");
      const sourceRef=z.object({broker:z.object({destroyPlan:z.object({operationId:z.string().min(1),evidenceId:z.string().min(1)})})}).parse(storedDestination.proposal).broker.destroyPlan;
      if(sourceRef.operationId!==source.op.id)throw new Error("Authoritative destroy source binding differs.");
      const association={workspaceId:source.op.workspaceId,sourceOperationId:source.op.id,destinationOperationId:destination.operation.id,sourceEvidenceId:sourceRef.evidenceId,planDigest:source.planDigest,lease:source.lease};
      const sourceEvidence=await repos.evidence.get(f.a,source.op.workspaceId,sourceRef.evidenceId);
      if(!sourceEvidence)throw new Error("Authoritative destroy source evidence is missing.");
      await repos.evidence.insert(f.a,{id:`evd_${destination.operation.id}`,workspaceId:source.op.workspaceId,operationId:destination.operation.id,kind:"tofu_plan",digest:source.planDigest,summary:sourceEvidence.summary,simulated:false});
      await f.port.associate(association);
      expect(await f.a.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[source.op.workspaceId,destination.operation.id])).toHaveLength(0);
      await repos.operations.transition(f.a,{workspaceId:source.op.workspaceId,id:source.op.id,from:["running"],to:"succeeded",fence:source.lease,patch:{result:{operationId:destination.operation.id,planDigest:source.planDigest}}});
      await repos.leases.release(f.a,source.lease);
      await expect(broker.approve({workspaceId:source.op.workspaceId,operationId:destination.operation.id,proposalDigest:destination.operation.proposalDigest,planDigest:source.planDigest,
        approver:{kind:"integration",id:"agent",name:"Agent refusal fixture"},session:sessionFor("browser-admin")})).rejects.toThrow();
      const human=await broker.approve({workspaceId:source.op.workspaceId,operationId:destination.operation.id,proposalDigest:destination.operation.proposalDigest,planDigest:source.planDigest,
        approver:user("browser-admin"),session:sessionFor("browser-admin")});
      expect(human.operation.status).toBe("approved");
      await repos.operations.claimForExecution(f.b,{workspaceId:source.op.workspaceId,id:destination.operation.id,expectedDigest:destination.operation.proposalDigest,holder:executionHolder(destination.operation.id),leaseMs:120000});
      const lease=await repos.leases.acquire(f.b,{scope:source.lease.scope,workspaceId:source.op.workspaceId,holder:`worker:destination:${destination.operation.id}`,ttlMs:120000});
      if(!lease)throw new Error("Destination execution fence is missing.");
      const custody={...source.custody,operationId:storedDestination.id,proposalDigest:storedDestination.proposalDigest,inputDigest:storedDestination.inputDigest,expiresAt:storedDestination.expiresAt};
      const workerBroker=createExecutionBroker(f.b,async()=>broker);f.setDispatchBroker(workerBroker);
      const isolated=createWorld();
      const rt=createRuntime({...isolated.deps,...createPlatformPorts(f.b),broker:workerBroker,planArtifacts:f.port,tofu:f.tofu});
      try {expect((await checkDestroyApproval(rt,destination.operation.id)).approved).toBe(true);}finally{isolated.dispose();}
      const grant=await workerBroker.issueGrant(destination.operation.id,"worker",lease);
      expect(grant.claims.op).toBe(destination.operation.id);expect(grant.claims.cap).toBe("infrastructure.destroy");
      const removed=await f.port.consume({custody,planDigest:source.planDigest,lease},original=>f.tofu.applyVerifiedPlan(source.workspace,{original,custody,approvedDigest:source.planDigest,destroy:true,normalize:{fingerprintKey:f.fingerprint},beforeDispatch:async()=>{
        expect(original.manifest.operationId).toBe(source.op.id);
        expect(sha(await readFile(path.join(await f.activeDirectory(),"reviewed.tfplan")))).toBe(original.manifest.rawSha256);
        await writeFile(path.join(await f.activeDirectory(),"tfplan"),"fresh fallback forbidden");
      }}));
      expect(removed.plan.summary.delete).toBe(1);expect(removed.apply.exitCode).toBe(0);
      expect((await repos.approvals.listForOperation(f.b,source.op.workspaceId,destination.operation.id))[0].consumedAt).toBeDefined();
      await expect(f.port.consume({custody,planDigest:source.planDigest,lease},async()=>undefined)).rejects.toThrow();
    });
  },240000);
  it("restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse",async()=>{
    await fixture(async f=>{
      const tools=await matchingPostgresTools(f.a);
      const r=await f.review();const {bin}=await f.runner.binary();
      const dump=path.join(f.temp,"private-restore.dump");
      // pg_dump/pg_restore operate on private files; contents never enter test results or logs.
      await writeFile(dump,"",{flag:"wx",mode:0o600});
      await privatePostgresTool(tools.dump,["--format=custom","--file",dump],f.url);
      await chmod(dump,0o600);
      await withScratchDatabase(async restored=>{
        await privatePostgresTool(tools.restore,["--no-owner","--no-acl","--dbname",new URL(restored).pathname.slice(1),dump],restored);
        const db=await openPlatformDb({kind:"postgres",url:restored,max:2});
        try {
          const restoredRuntime=createIsolatedPlanArtifactRuntimeForTests(db,{...process.env,ZENITH_PLAN_ARTIFACT_KEY:f.key,ZENITH_TOFU_BIN:bin,ZENITH_WORKER_PLAN_DIR:f.temp,ZENITH_TOFU_PLUGIN_CACHE:f.cache},f.fixtureBroker(db));
          expect(()=>createPlanArtifactRuntime(db,{})).toThrow();
          const wrong=createPlanArtifactRuntime(db,{ZENITH_PLAN_ARTIFACT_KEY:randomBytes(32).toString("hex"),ZENITH_TOFU_BIN:bin});
          await expect(wrong.planArtifacts.inspect(r,async()=>undefined)).rejects.toThrow();
          const restoredPlan=await restoredRuntime.planArtifacts.consume(r,original=>restoredRuntime.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest,normalize:{fingerprintKey:f.fingerprint}}));
          expect(restoredPlan.apply.exitCode).toBe(0);
        } finally {await db.close();}
      });
    });
  },240000);
  it("fake cipher authority and arbitrary runner handles cannot mint production admission",async()=>{
    await fixture(async f=>{
      const r=await f.review();let saved:ApprovedPlan|undefined;
      await f.port.inspect(r,async original=>{saved=original;await expect(f.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest})).rejects.toThrow("custody");});
      await expect(f.tofu.applyVerifiedPlan(r.workspace,{original:saved,custody:r.custody,approvedDigest:r.planDigest})).rejects.toThrow("custody");
      const fakeCipher={seal:()=>({iv:"",authTag:"",ciphertext:""}),open:()=>({value:""})} as unknown as ReturnType<typeof planArtifactCipherFromEnv>;
      const fake=createPlanEngineAuthority(fakeCipher,()=>undefined);
      await expect(f.port.consume(r,async original=>{
        const copy={manifest:{...original.manifest}};
        await expect(f.tofu.applyVerifiedPlan(r.workspace,{original:copy,custody:r.custody,approvedDigest:r.planDigest})).rejects.toThrow("custody");
        await expect(fake.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest})).rejects.toThrow("custody");
        await expect(f.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest,runner:f.runner})).rejects.toThrow("runner override");
        expect(()=>createPlanArtifactCodec(fakeCipher,handle=>({manifest:handle.manifest,bytes:Buffer.from("forged")})).sealProduced(copy)).toThrow();
        throw new Error("probe ends without dispatch");
      })).rejects.toThrow("probe ends");
      expect(await readFile(f.state).catch(()=>null)).toBeNull();
    });
  },180000);
  it("stale original state serial refuses even when independent fresh semantic plan is unchanged, with no fallback",async()=>{
    await fixture(async f=>{
      const initial=await planWorkspace(f.ws(),undefined,{runner:f.runner,normalize:{fingerprintKey:f.fingerprint}});
      await applyVerifiedPlan(f.ws(),{runner:f.runner,approvedDigest:initial.plan.planDigest,normalize:{fingerprintKey:f.fingerprint}});
      const r=await f.review(f.ws("v2"));
      await f.runner.run(r.workspace,{},async run=>{
        await run.init();const {bin}=await f.runner.binary();
        const pulled=await runFile(bin,["state","pull"],{cwd:run.workDir,maxBuffer:4*1024*1024,env:{NODE_ENV:"test",PATH:path.dirname(bin),HOME:f.temp}});
        const state=JSON.parse(pulled.stdout);state.serial+=1;
        const file=path.join(run.workDir,"advanced-state.json");await writeFile(file,JSON.stringify(state),{mode:0o600});
        await runFile(bin,["state","push",file],{cwd:run.workDir,maxBuffer:65536,env:{NODE_ENV:"test",PATH:path.dirname(bin),HOME:f.temp}});
      });
      const fresh=await planWorkspace(r.workspace,undefined,{runner:f.runner,normalize:{fingerprintKey:f.fingerprint}});
      expect(fresh.plan.planDigest).toBe(r.planDigest);
      await expect(f.port.consume(r,(original,dispatch)=>f.tofu.applyVerifiedPlan(r.workspace,{original,custody:r.custody,approvedDigest:r.planDigest,normalize:{fingerprintKey:f.fingerprint},beforeDispatch:dispatch}))).rejects.toThrow("unconfirmed");
      await expect(f.port.consume(r,async()=>"retry")).rejects.toThrow();
    });
  },240000);
});
