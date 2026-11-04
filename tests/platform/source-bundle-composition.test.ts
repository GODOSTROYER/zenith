/** Default owning PostgreSQL composition; HTTP/cloud replies are modeled, never live provider proof. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb, repos, PLATFORM_SCHEMA_VERSION, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import type { ExecutionDeps, SourceBundlePort } from "@/lib/execution";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { azureSourceWorld } from "./source-bundle-azure-fixtures";
import { binding, accountId } from "../providers/azure/source-storage-fixtures";
import { connection } from "../providers/azure/_helpers";
import { builtinWorkspace } from "../tofu/_helpers";
import { IMAGE, DIGEST, registryId } from "../providers/azure/release-fixtures";
import { createApprovedSourceSnapshotStore, createIsolatedApprovedSourceStoreForTests } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { createOwningSourceBundles } from "@/lib/platform/source-bundle";
import { sourceRecipe, sourceSnapshotSetDigest } from "@/lib/execution/source-snapshot";
import { createOperationsPort } from "@/lib/execution/platform";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { normalizePlan } from "@/lib/tofu/plan";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { registerEnvironment } from "@/lib/reconcile/platform";
import { digest } from "@/lib/controlplane/digest";
import { PG_URL, seedApprovedOperation } from "../controlplane/_support/harness";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";
import type { LeaseRef } from "@/lib/workflows/types";

const captured = vi.hoisted(() => ({ deps: undefined as ExecutionDeps | undefined }));
vi.mock("@/lib/execution", async (original) => {
  const execution = await original<typeof import("@/lib/execution")>();
  return { ...execution, createExecutionActivities: vi.fn((deps: ExecutionDeps) => { captured.deps = deps; return {}; }) };
});
const { composeExecutionActivities } = await import("@/lib/platform/execution");
beforeEach(() => { captured.deps = undefined; });
const db: Sql = { query: vi.fn(async () => []), tx: async (fn) => fn(db) };
const options = { db, secretKey: "1".repeat(64), workerIdentity: "source-contract", planDir: "unused" };
let owningDb:PlatformDbHandle|undefined;
const held:LeaseRef[]=[];
if(process.env.ZENITH_TEST_SOURCE_FIXTURE_REQUIRED==="1") {
  if(!PG_URL)throw new Error("Default source fixture acceptance requires owned PostgreSQL.");
  if(PLATFORM_SCHEMA_VERSION<13)throw new Error("Default source fixtures require the canonical registered schema13.");
}
beforeAll(async()=>{if(PG_URL)owningDb=await openPlatformDb({kind:"postgres",url:PG_URL,migrate:true,max:1});},60_000);
afterEach(async()=>{while(held.length)await repos.leases.release(owningDb!,held.pop()!);});
afterAll(async()=>{await owningDb?.close();});
function nativeDb(){if(!owningDb || owningDb.kind!=="postgres")throw new Error("Owned default composition PostgreSQL fixture is unavailable.");return owningDb;}
async function reviewedAzure() {
  const w=azureSourceWorld(),db=nativeDb(),projectId="proj-source-compatibility";
  const {operation}=await seedApprovedOperation(db,w.ctx.workspaceId,{ttlMs:120_000,proposal:{capability:"deployment.deploy",scope:{workspaceId:w.ctx.workspaceId,projectId,environmentId:w.ctx.environmentId}}});
  const lease=await repos.leases.acquire(db,{workspaceId:w.ctx.workspaceId,scope:`env:${w.ctx.environmentId}`,holder:`worker:${operation.id}`,ttlMs:120_000});
  if(!lease)throw new Error("Default composition fixture lease is unavailable.");held.push(lease);
  await repos.operations.claimForExecution(db,{workspaceId:w.ctx.workspaceId,id:operation.id,expectedDigest:operation.proposalDigest,holder:`workflow:${operation.id}`,leaseMs:120_000,lease});
  w.ctx.operationId=operation.id;
  for(const node of [w.service,w.pipeline])await repos.resources.upsertDesired(db,{workspaceId:w.ctx.workspaceId,projectId,environmentId:w.ctx.environmentId,node,status:"active"});
  const sourceSnapshots=createApprovedSourceSnapshotStore(db);
  const fetchImpl=vi.fn<typeof fetch>(async(raw,init)=>{
    const url=String(raw);
    if(url==="https://api.github.com/repos/acme/app")return Response.json({id:99,name:"app",owner:{login:"acme"},private:false});
    if(url.startsWith("https://api.github.com/repos/acme/app/commits/"))return new Response("a".repeat(40));
    return w.fetchImpl(raw,init);
  });
  const deps={...w.deps,sourceSnapshots,fetchImpl};
  const bundles=createOwningSourceBundles(db,deps);
  const approvedSource=await bundles.port.capture!({workspaceId:w.ctx.workspaceId,operationId:operation.id,projectId,environmentId:w.ctx.environmentId,
    serviceAddress:w.service.address,serviceSpecDigest:w.service.specDigest,pipelineAddress:w.pipeline.address,pipelineSpecDigest:w.pipeline.specDigest,provider:"azure",region:w.ctx.region,
    repository:w.source.repo,requestedRef:w.source.ref,dockerfile:w.source.dockerfile,recipeDigest:sourceRecipe(w.service,w.pipeline),archiveFormat:"tar.gz"});
  await sourceSnapshots.retain(approvedSource,lease);
  const plan=normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},
    {configDigest:digest("config"),lockDigest:digest("lock"),addressMap:{},executableSourceDigest:sourceSnapshotSetDigest([approvedSource])});
  await repos.evidence.insert(db,{workspaceId:w.ctx.workspaceId,operationId:operation.id,kind:"tofu_plan",digest:plan.planDigest,
    summary:planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:digest("graph"),stage:"plan",approvedSources:[approvedSource]}).summary,simulated:false});
  await createOperationsPort(db).setPlanDigest({workspaceId:w.ctx.workspaceId,operationId:operation.id,planDigest:plan.planDigest});
  w.fetchImpl.mockClear();fetchImpl.mockClear();
  return {...w,deps,approvedSource,operation};
}

describe("source-bundle execution wiring", () => {
  it("provides a source port using the platform resource store by default", () => {
    composeExecutionActivities(options);
    expect(captured.deps?.sourceBundle?.prepare).toBeTypeOf("function"); expect(captured.deps?.resources.list).toBeTypeOf("function");
  });
  it("keeps read-only source composition available while refusing a default infrastructure engine without PostgreSQL",async()=>{
    composeExecutionActivities(options);
    expect(captured.deps?.sourceBundle?.prepare).toBeTypeOf("function");
    const deps=captured.deps;
    if(!deps?.tofu || !deps.planArtifacts)throw new Error("Default lazy custody ports were not composed.");
    const ws=builtinWorkspace("isolated-read-only-source-state",{});
    const tofu=deps.tofu;const callsBefore=vi.mocked(db.query).mock.calls.length;
    await expect(async()=>tofu.planWorkspace(ws)).rejects.toThrow("PostgreSQL");
    await expect(async()=>tofu.applyVerifiedPlan(ws,{approvedDigest:"a".repeat(64)})).rejects.toThrow("PostgreSQL");
    expect(db.query).toHaveBeenCalledTimes(callsBefore);
  });
  it("keeps an explicit sourceBundle override authoritative", async () => {
    const prepared={s3Key:"isolated-source",digest:"a".repeat(64),bucket:"fixture",objectKey:"isolated-source",uri:"fixture://isolated-source"};
    const prepare=vi.fn(async()=>prepared),sourceBundle:SourceBundlePort={prepare};
    const sourceSnapshots=createIsolatedApprovedSourceStoreForTests({list:async()=>[],retain:async s=>s,assertCurrent:async()=>undefined,assertReviewed:async()=>undefined});
    composeExecutionActivities({ ...options, ports: { sourceBundle,sourceSnapshots } });
    const w=azureSourceWorld(),input={service:w.service,source:w.source};
    expect(await captured.deps!.sourceBundle!.prepare(w.ctx,input)).toBe(prepared);
    expect(prepare).toHaveBeenCalledOnce();expect(prepare).toHaveBeenCalledWith(w.ctx,input);
  });
  it.skipIf(!PG_URL)("forwards the download configuration and preserves resource overrides", () => {
    const resources = { list: vi.fn() } as unknown as ExecutionDeps["resources"];
    expect(() => composeExecutionActivities({ ...options,db:nativeDb(), ports: { resources }, sourceBundles: { timeoutMs: 0 } })).toThrow("deadline");
    composeExecutionActivities({ ...options,db:nativeDb(), ports: { resources }, sourceBundles: { timeoutMs: 100 } });
    expect(captured.deps?.resources).toBe(resources);
  });
  it.skipIf(!PG_URL)("uses the injected resource store with the activity's workspace and environment", async () => {
    const list = vi.fn(async () => []); const resources = { list } as unknown as ExecutionDeps["resources"];
    composeExecutionActivities({ ...options,db:nativeDb(), ports: { resources } });
    const ctx = { provider: "aws", region: "us-east-1", workspaceId: "ws-bound", environmentId: "env-bound", session: { provider: "aws", region: "us-east-1" }, signal: new AbortController().signal } as DriverContext;
    const service: ResourceNode = { provider: "aws", region: "us-east-1", ownership: "managed", address: "container_service/web", kind: "container_service", nativeType: "aws:ecs_service", origin: [], dependsOn: [], labels: {}, specDigest: "a".repeat(64), spec: { artifact: { type: "built", pipeline: "build_pipeline/web" } } };
    await expect(captured.deps!.sourceBundle!.prepare(ctx, { service, source: { repo: "acme/app", ref: "v1" } })).rejects.toThrow("stored desired resource");
    expect(list).toHaveBeenCalledWith("ws-bound", "env-bound");
  });
  it.skipIf(!PG_URL)("composes Azure preparation, stored-source reading and the SQL launch journal by default", async () => {
    const w = await reviewedAzure();
    const query=vi.spyOn(nativeDb(),"query");
    vi.stubGlobal("fetch", w.uploadFetch);
    try {
      composeExecutionActivities({ ...options, db: nativeDb(), sourceBundles: { fetchImpl: w.deps.fetchImpl,sourceSnapshots:w.deps.sourceSnapshots, azureStorage: w.resolveStorage }, ports: { resources: w.resources as unknown as ExecutionDeps["resources"] } });
      const deps = captured.deps!;
      const prepared = await deps.sourceBundle!.prepare(w.ctx, { service: w.service, source: w.source,approvedSource:w.approvedSource });
      const handle = await deps.build!.startBuild(w.ctx, { pipeline: w.pipeline, service: w.service, registry: w.registry, source: prepared, idempotencyKey: `composed-azure-build-${w.operation.id}` });
      expect(await deps.build!.waitForBuild(w.ctx, handle, { timeoutMs: 1000 })).toEqual({
        status: "succeeded", digest: DIGEST, imageUri: IMAGE,
        attestation: {
          builderId: registryId, invocationId: "run1",
          isolation: {
            profileId: "azure.acr-tasks.v1",
            identity: { principal: "acr-tasks-run", dedicated: true, deployCredentials: "absent" },
            metadata: { exposes: "build_identity_only", mechanism: "the run exposes no user-assigned identity; the task agent has no access to deploy credentials" },
            network: { egress: "unrestricted", mechanism: "ACR Tasks shared agents have public egress; configure spec.isolation.workerPool" },
            dependencies: { downloads: "direct" }, filesystem: { sourceMount: "read_only" },
            resources: { timeoutSec: 1800, computeClass: "cpu-2" },
          },
        },
      });
      expect(w.fetchImpl).toHaveBeenCalledTimes(1); expect(w.state.schedules).toBe(1);
      const journalCalls=query.mock.calls.filter(([sql])=>sql.includes("platform.idempotency_keys"));
      expect(journalCalls).toHaveLength(2);expect(journalCalls[0][0]).toContain("insert into platform.idempotency_keys");expect(journalCalls[1][0]).toContain("update platform.idempotency_keys");
      expect(w.ctx.log).not.toHaveBeenCalled();
    } finally { query.mockRestore();vi.unstubAllGlobals(); }
  });
  it.skipIf(!PG_URL)("uses the trusted connection binding without a source resolver override through ACR launch", async () => {
    const w = await reviewedAzure(),sourceDb=nativeDb();
    const trusted=await repos.connections.create(sourceDb,{workspaceId:w.ctx.workspaceId,createdBy:"fixture-admin",config:{...connection,subscriptionId:w.ctx.session.subscriptionId,region:w.ctx.region,sourceStorage:{[w.ctx.environmentId]:binding}}});
    await repos.connections.recordVerification(sourceDb,{workspaceId:w.ctx.workspaceId,id:trusted.id,ok:true});
    const node=mkNode(binding.resourceAddress,"object_store","azure:object_store",{},{region:w.ctx.region,externalRef:accountId});node.provider="azure";
    await repos.resources.upsertDesired(sourceDb,{workspaceId:w.ctx.workspaceId,projectId:w.operation.projectId!,environmentId:w.ctx.environmentId,node,status:"active"});
    await registerEnvironment(sourceDb,{environment:{workspaceId:w.ctx.workspaceId,projectId:w.operation.projectId!,environmentId:w.ctx.environmentId,provider:"azure",region:w.ctx.region,class:"development",connection:{id:trusted.id,status:"verified"}}});
    const query=vi.spyOn(sourceDb,"query");
    vi.stubGlobal("fetch", w.uploadFetch);
    try {
      composeExecutionActivities({ ...options, db: sourceDb, sourceBundles: { fetchImpl: w.deps.fetchImpl,sourceSnapshots:w.deps.sourceSnapshots }, ports: { resources: w.resources as unknown as ExecutionDeps["resources"] } });
      const prepared = await captured.deps!.sourceBundle!.prepare(w.ctx, { service: w.service, source: w.source,approvedSource:w.approvedSource });
      await captured.deps!.build!.startBuild(w.ctx, { pipeline: w.pipeline, service: w.service, registry: w.registry, source: prepared, idempotencyKey: `trusted-composed-build-${w.operation.id}` });
      expect(query.mock.calls.find(([sql])=>sql.includes("select connection_id from platform.reconcile_state"))?.[1]).toEqual([w.ctx.workspaceId,w.ctx.environmentId,w.ctx.region]);
      expect(query.mock.calls.find(([sql])=>sql.includes("from platform.provider_connections"))?.[1]).toEqual([w.ctx.workspaceId,trusted.id]);
      expect(query.mock.calls.find(([sql,params])=>sql.includes("from platform.resources") && params?.includes(binding.resourceAddress))?.[1]).toEqual([w.ctx.workspaceId,w.ctx.environmentId,binding.resourceAddress]);
      expect(w.resolveStorage).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(1);
      expect(w.fetchImpl).toHaveBeenCalledOnce(); expect(w.ctx.log).not.toHaveBeenCalled();
    } finally { query.mockRestore();vi.unstubAllGlobals(); }
  });
  it.skipIf(!PG_URL)("refuses an Azure environment without a binding in the composed preparation port", async () => {
    const w = await reviewedAzure();
    await nativeDb().query("delete from platform.reconcile_state where workspace_id=$1 and environment_id=$2",[w.ctx.workspaceId,w.ctx.environmentId]);
    composeExecutionActivities({ ...options,db:nativeDb(),sourceBundles:{fetchImpl:w.deps.fetchImpl,sourceSnapshots:w.deps.sourceSnapshots}, ports: { resources: w.resources as unknown as ExecutionDeps["resources"] } });
    await expect(captured.deps!.sourceBundle!.prepare(w.ctx, { service: w.service, source: w.source,approvedSource:w.approvedSource })).rejects.toThrow("storage account/container binding");
    expect(w.fetchImpl).not.toHaveBeenCalled();expect(w.fetcher).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(0);
  });
});
