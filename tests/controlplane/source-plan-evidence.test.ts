/** Actual PostgreSQL evidence selection; source/tool/product ports are explicit isolated models, never provider or raw-plan proof. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlatformDb, PLATFORM_SCHEMA_VERSION, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import { digest } from "@/lib/controlplane/digest";
import { createEvidencePort } from "@/lib/execution/platform";
import { approvedSources, immutableSourceSnapshot, sourceRecipe, sourceSnapshotSetDigest } from "@/lib/execution/source-snapshot";
import { createIsolatedApprovedSourceStoreForTests } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { createRuntime, scopeOf } from "@/lib/execution/runtime";
import { createWorld } from "../execution/fakes/world";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";
import { PG_URL, newWorkspace, seedApprovedOperation } from "./_support/harness";

if(process.env.ZENITH_TEST_SOURCE_PLAN_EVIDENCE_REQUIRED==="1") {
  if(!PG_URL)throw new Error("Source plan evidence acceptance requires owned PostgreSQL.");
  if(PLATFORM_SCHEMA_VERSION<13)throw new Error("Source plan evidence requires the canonical registered schema13.");
}

describe.skipIf(!PG_URL)("source plan evidence authority [postgres]",()=>{
  let db:PlatformDbHandle,peer:PlatformDbHandle;
  beforeAll(async()=>{
    db=await openPlatformDb({kind:"postgres",url:PG_URL!,migrate:true,max:1});
    peer=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});
  },60_000);
  afterAll(async()=>{await peer?.close();await db?.close();});
  async function fixture() {
    const workspaceId=newWorkspace(),projectId=`proj_${workspaceId}`,environmentId=`env_${workspaceId}`;
    const {operation}=await seedApprovedOperation(db,workspaceId,{proposal:{scope:{workspaceId,projectId,environmentId}}});
    return {operation,workspaceId,projectId,environmentId,planDigest:digest("source evidence plan"),port:createEvidencePort(peer)};
  }
  async function insert(f:Awaited<ReturnType<typeof fixture>>,stage:"plan"|"final_plan",options:{digest?:string;kind?:"tofu_plan"|"build";simulated?:boolean;executableSourceDigest?:string}={}) {
    return repos.evidence.insert(db,{workspaceId:f.workspaceId,operationId:f.operation.id,kind:options.kind??"tofu_plan",digest:options.digest??f.planDigest,
      summary:{stage,planDigest:f.planDigest,...(options.executableSourceDigest?{executableSourceDigest:options.executableSourceDigest}:{})},simulated:options.simulated??false});
  }
  function sourceFor(f:Awaited<ReturnType<typeof fixture>>) {
      const region="eu-west-1";
      const pipeline=mkNode("build_pipeline/web","build_pipeline","aws:codebuild_project",{source:{repo:"acme/web",ref:"main",dockerfile:"Dockerfile"}},{region,specDigest:digest("pipeline")});
      const service=mkNode("container_service/web","container_service","aws:ecs_service",{artifact:{type:"built",pipeline:pipeline.address}},{region,specDigest:digest("service")});
      const source=immutableSourceSnapshot({format:"zenith.approved-source.v1",workspaceId:f.workspaceId,operationId:f.operation.id,projectId:f.projectId,environmentId:f.environmentId,
        serviceAddress:service.address,serviceSpecDigest:service.specDigest,pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,provider:"aws",region,
        owner:"acme",repo:"web",repositoryId:99,requestedRef:"main",commitSha:"a".repeat(40),githubBinding:null,dockerfile:"Dockerfile",dockerfileDigest:digest("Dockerfile"),
        recipeDigest:sourceRecipe(service,pipeline),archiveFormat:"zip",archiveDigest:digest("modeled archive"),archiveBytes:100});
      const graph={version:1 as const,environmentId:f.environmentId,manifestDigest:digest("manifest"),graphDigest:digest("graph"),nodes:[service,pipeline],edges:[],notes:[]};
      return {source,graph};
  }
  async function sourceCheck(f:Awaited<ReturnType<typeof fixture>>) {
    const world=createWorld(),{source,graph}=sourceFor(f);
    try {
      const sources=createIsolatedApprovedSourceStoreForTests({list:async()=>[source],retain:async s=>s,assertCurrent:async()=>undefined,assertReviewed:async()=>undefined});
      const verify=vi.fn(async()=>undefined),capture=vi.fn(async()=>source),prepare=vi.fn();
      const rt=createRuntime({...world.deps,evidence:f.port,sourceSnapshots:sources,sourceBundle:{verify,capture,prepare}});
      const op={...f.operation,planDigest:f.planDigest};
      const product={...world.product.base,project:{...world.product.base.project,id:f.projectId}};
      await expect(approvedSources(rt,{op,workspaceId:f.workspaceId,environmentId:f.environmentId,scope:scopeOf(op),product},graph,
        {scope:`env:${f.environmentId}`,holder:`worker:${op.id}`,fenceToken:1},false)).rejects.toThrow("does not bind");
      expect(capture).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();expect(world.build.started).toHaveLength(0);expect(world.tofu.applyCalls).toHaveLength(0);
    } finally {world.dispose();}
  }
  it("selects the original plan after a later final plan with the same digest without deleting either row",async()=>{
    const f=await fixture(),original=await insert(f,"plan"),final=await insert(f,"final_plan");
    expect(db).not.toBe(peer);expect(db.kind).toBe("postgres");expect(peer.kind).toBe("postgres");
    const query={workspaceId:f.workspaceId,operationId:f.operation.id,kind:"tofu_plan" as const,digest:f.planDigest};
    expect(await f.port.find({...query,stage:"plan"})).toEqual(original);
    expect(await f.port.find({...query,stage:"final_plan"})).toEqual(final);
    expect(await f.port.find(query)).toEqual(final);
    expect(await repos.evidence.get(peer,f.workspaceId,original.id)).toEqual(original);
    expect(await repos.evidence.get(peer,f.workspaceId,final.id)).toEqual(final);
  });
  it("keeps plan selection scoped to the exact tenant operation kind digest and stage",async()=>{
    const f=await fixture(),foreign=await fixture(),original=await insert(f,"plan");
    await insert(f,"final_plan");await insert(f,"plan",{digest:digest("different plan")});await insert(f,"plan",{kind:"build"});await insert(foreign,"plan");
    const query={workspaceId:f.workspaceId,operationId:f.operation.id,kind:"tofu_plan" as const,digest:f.planDigest,stage:"plan" as const};
    expect(await f.port.find(query)).toEqual(original);
    expect(await f.port.find({...query,workspaceId:foreign.workspaceId})).toBeNull();
    expect(await f.port.find({...query,operationId:foreign.operation.id})).toBeNull();
    expect(await f.port.find({...query,digest:digest("absent plan")})).toBeNull();
    expect(await f.port.find({...query,kind:"verification"})).toBeNull();
  });
  it("refuses final-only source evidence before a build or tool mutation",async()=>{
    const f=await fixture(),final=await insert(f,"final_plan");
    expect(await f.port.find({workspaceId:f.workspaceId,operationId:f.operation.id,kind:"tofu_plan",digest:f.planDigest,stage:"plan"})).toBeNull();
    await sourceCheck(f);
    expect(await repos.evidence.get(peer,f.workspaceId,final.id)).toEqual(final);
  });
  it("retains the non-simulated review guard when selecting a plan stage",async()=>{
    const f=await fixture(),row=await insert(f,"plan",{simulated:true,executableSourceDigest:sourceSnapshotSetDigest([sourceFor(f).source])});
    expect(await f.port.find({workspaceId:f.workspaceId,operationId:f.operation.id,kind:"tofu_plan",digest:f.planDigest,stage:"plan"})).toEqual(row);
    await sourceCheck(f);
    expect(await repos.evidence.get(peer,f.workspaceId,row.id)).toEqual(row);
  });
});
