/** Owning PostgreSQL source/review custody with modeled GitHub/Blob/ACR replies; no live provider proof. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createOwningSourceBundles } from "@/lib/platform/source-bundle";
import { createReleasePorts } from "@/lib/platform/release";
import { azureSourceWorld } from "./source-bundle-azure-fixtures";
import { CONTAINER } from "../providers/azure/source-storage-fixtures";
import { IMAGE, DIGEST, registryId } from "../providers/azure/release-fixtures";
import { openPlatformDb, repos, PLATFORM_SCHEMA_VERSION, type PlatformDbHandle } from "@/lib/controlplane/db";
import { createApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { sourceRecipe, sourceSnapshotSetDigest } from "@/lib/execution/source-snapshot";
import { createOperationsPort } from "@/lib/execution/platform";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { normalizePlan } from "@/lib/tofu/plan";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { digest } from "@/lib/controlplane/digest";
import { PG_URL, seedApprovedOperation } from "../controlplane/_support/harness";
import { api, INSTALL_TOKEN, keys } from "../sources/fixtures";
import type { LeaseRef } from "@/lib/workflows/types";

let db:PlatformDbHandle,material:Awaited<ReturnType<typeof keys>>;
const held:LeaseRef[]=[];let privateWorkspace:string|undefined;
if(process.env.ZENITH_TEST_SOURCE_FIXTURE_REQUIRED==="1") {
  if(!PG_URL)throw new Error("Default source fixture acceptance requires owned PostgreSQL.");
  if(PLATFORM_SCHEMA_VERSION<13)throw new Error("Default source fixtures require the canonical registered schema13.");
}
beforeAll(async()=>{if(PG_URL){db=await openPlatformDb({kind:"postgres",url:PG_URL,migrate:true,max:1});material=await keys();}},60_000);
afterEach(async()=>{
  if(privateWorkspace){await db.query("delete from platform.github_source_bindings where workspace_id=$1",[privateWorkspace]);privateWorkspace=undefined;}
  while(held.length)await repos.leases.release(db,held.pop()!);vi.unstubAllEnvs();
});
afterAll(async()=>{try {await material?.close();}finally {await db?.close();}});
async function fixture(bound=false) {
  if(!db || db.kind!=="postgres")throw new Error("Owned Azure source fixture PostgreSQL is unavailable.");
  const w=azureSourceWorld(),projectId="proj-source-compatibility";
  const {operation}=await seedApprovedOperation(db,w.ctx.workspaceId,{ttlMs:120_000,proposal:{capability:"deployment.deploy",scope:{workspaceId:w.ctx.workspaceId,projectId,environmentId:w.ctx.environmentId}}});
  const lease=await repos.leases.acquire(db,{workspaceId:w.ctx.workspaceId,scope:`env:${w.ctx.environmentId}`,holder:`worker:${operation.id}`,ttlMs:120_000});
  if(!lease)throw new Error("Azure source fixture lease is unavailable.");held.push(lease);
  await repos.operations.claimForExecution(db,{workspaceId:w.ctx.workspaceId,id:operation.id,expectedDigest:operation.proposalDigest,holder:`workflow:${operation.id}`,leaseMs:120_000,lease});
  w.ctx.operationId=operation.id;
  for(const node of [w.service,w.pipeline])await repos.resources.upsertDesired(db,{workspaceId:w.ctx.workspaceId,projectId,environmentId:w.ctx.environmentId,node,status:"active"});
  if(bound){
    vi.stubEnv("ZENITH_GITHUB_APP_ID","42");vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE",material.config.privateKeyFile);
    await db.query("insert into platform.github_source_bindings(workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values ($1,'42',7,99,'acme','app',1,'fixture-admin')",[w.ctx.workspaceId]);privateWorkspace=w.ctx.workspaceId;
  }
  const githubApi=api(),sourceSnapshots=createApprovedSourceSnapshotStore(db);
  const fetchImpl=vi.fn<typeof fetch>(async(raw,init)=>{
    const url=String(raw);
    if(url==="https://api.github.com/repos/acme/app" || url.startsWith("https://api.github.com/repos/acme/app/commits/")){
      expect(new Headers(init?.headers).get("Authorization")===`Bearer ${INSTALL_TOKEN}`).toBe(bound);
      return url.includes("/commits/")?new Response("a".repeat(40)):Response.json({id:99,name:"app",owner:{login:"acme"},private:bound});
    }
    if(url.startsWith("https://api.github.com/"))return githubApi(raw,init);
    return w.fetchImpl(raw,init);
  });
  const deps={...w.deps,sourceSnapshots,fetchImpl},bundles=createOwningSourceBundles(db,deps);
  const approvedSource=await bundles.port.capture!({workspaceId:w.ctx.workspaceId,operationId:operation.id,projectId,environmentId:w.ctx.environmentId,
    serviceAddress:w.service.address,serviceSpecDigest:w.service.specDigest,pipelineAddress:w.pipeline.address,pipelineSpecDigest:w.pipeline.specDigest,provider:"azure",region:w.ctx.region,
    repository:w.source.repo,requestedRef:w.source.ref,dockerfile:w.source.dockerfile,recipeDigest:sourceRecipe(w.service,w.pipeline),archiveFormat:"tar.gz"});
  await sourceSnapshots.retain(approvedSource,lease);
  const plan=normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},
    {configDigest:digest("config"),lockDigest:digest("lock"),addressMap:{},executableSourceDigest:sourceSnapshotSetDigest([approvedSource])});
  await repos.evidence.insert(db,{workspaceId:w.ctx.workspaceId,operationId:operation.id,kind:"tofu_plan",digest:plan.planDigest,
    summary:planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:digest("graph"),stage:"plan",approvedSources:[approvedSource]}).summary,simulated:false});
  await createOperationsPort(db).setPlanDigest({workspaceId:w.ctx.workspaceId,operationId:operation.id,planDigest:plan.planDigest});
  w.fetchImpl.mockClear();fetchImpl.mockClear();githubApi.mockClear();
  const prepare=(core=bundles)=>core.port.prepare(w.ctx,{service:w.service,source:w.source,approvedSource});
  return {...w,deps,bundles,approvedSource,prepare};
}

describe("provider-dispatched Azure source preparation", () => {
  it.skipIf(!PG_URL)("prepares canonical tar.gz in the bound container and passes exact bytes to ACR", async () => {
    const w = await fixture();
    const prepared = await w.prepare();
    expect(prepared).toMatchObject({ s3Key: `zenith/env-1/web/${prepared.digest}.tar.gz`, bucket: "zenithsource/source-bundles", objectKey: prepared.s3Key, uri: `https://zenithsource.blob.core.windows.net/source-bundles/${prepared.s3Key}` });
    const stored = w.storage.blobs.get(`/${CONTAINER}/${prepared.s3Key}`)!;
    expect(gunzipSync(stored)).toEqual(gunzipSync((await w.bundles.read(w.source)).archive));
    const ports = createReleasePorts({ azure: { readSource: w.bundles.readAzureSource, launches: w.receipts.port, uploadFetch: w.uploadFetch } });
    const handle = await ports.build.startBuild(w.ctx, { pipeline: w.pipeline, service: w.service, registry: w.registry, source: prepared, idempotencyKey: "c3-build" });
    expect(w.state.schedules).toBe(1);
    expect(w.uploadFetch).toHaveBeenCalledWith(expect.stringContaining("sig="), expect.objectContaining({ body: stored }));
    expect(await ports.build.waitForBuild(w.ctx, handle, { timeoutMs: 1000 })).toEqual({
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
    expect(handle.buildId).not.toContain("sig="); expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it.skipIf(!PG_URL)("rereads the stored bundle on another instance without downloading a moving GitHub ref", async () => {
    const w = await fixture(); const prepared = await w.prepare();
    const reader = createOwningSourceBundles(db,{ ...w.deps, fetchImpl: vi.fn(async () => { throw new Error("Moving ref must not be downloaded at build start."); }) });
    expect(await reader.readAzureSource(w.ctx, prepared)).toEqual(w.storage.blobs.get(`/${CONTAINER}/${prepared.s3Key}`));
    expect(w.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.skipIf(!PG_URL).each(["undefined", "resolver returning null"] as const)("clearly refuses missing storage bindings before downloading source: %s", async label => {
    const azureStorage=label==="undefined"?undefined:vi.fn(async()=>null);
    const w = await fixture();
    await expect(w.prepare(createOwningSourceBundles(db,{ ...w.deps, azureStorage }))).rejects.toThrow("storage account/container binding");
    expect(w.fetchImpl).not.toHaveBeenCalled(); expect(w.fetcher).not.toHaveBeenCalled();
  });
  it.skipIf(!PG_URL).each(["workspaceId", "environmentId"] as const)("refuses a cross-tenant %s resource lookup", async (field) => {
    const w = await fixture(); w.rows[0][field] = "foreign";
    await expect(w.prepare()).rejects.toThrow("boundary");
    expect(w.resolveStorage).not.toHaveBeenCalled(); expect(w.fetchImpl).not.toHaveBeenCalled();
  });
  it.skipIf(!PG_URL)("refuses a different pipeline source and a mismatched provider/session before acquisition", async () => {
    const w = await fixture();
    await expect(w.bundles.port.prepare(w.ctx, { service: w.service, source: { ...w.source, ref: "foreign-ref" },approvedSource:w.approvedSource })).rejects.toThrow("repository and ref");
    await expect(w.bundles.port.prepare({ ...w.ctx, provider: "gcp" }, { service: w.service, source: w.source,approvedSource:w.approvedSource })).rejects.toThrow("matching");
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });
  it.skipIf(!PG_URL)("refuses changed stored bytes before an ACR upload or schedule", async () => {
    const w = await fixture(); const prepared = await w.prepare();
    const blob = w.storage.blobs.get(`/${CONTAINER}/${prepared.s3Key}`)!; blob[0] ^= 255;
    const ports = createReleasePorts({ azure: { readSource: w.bundles.readAzureSource, launches: w.receipts.port, uploadFetch: w.uploadFetch } });
    await expect(ports.build.startBuild(w.ctx, { service: w.service, pipeline: w.pipeline, registry: w.registry, source: prepared, idempotencyKey: "bad-source" })).rejects.toThrow("could not be read");
    expect(w.uploadFetch).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(0);
  });
  it.skipIf(!PG_URL)("propagates C3's lowered compressed-size ceiling to the stored source reader", async () => {
    const w = await fixture(); const prepared = await w.prepare();
    await expect(createOwningSourceBundles(db,{ ...w.deps, limits: { maxArchiveBytes: 4 } }).readAzureSource(w.ctx, prepared)).rejects.toThrow("size bound");
  });
  it.skipIf(!PG_URL)("binds the private GitHub connector to the activity's tenant and environment", async () => {
    const w = await fixture(true),query=vi.spyOn(db,"query");
    try {
      await w.prepare();
      const bindingReads=query.mock.calls.filter(([sql])=>sql.includes("from platform.github_source_bindings"));
      expect(bindingReads.length).toBeGreaterThan(0);expect(bindingReads.every(([,params])=>params?.[0]===w.ctx.workspaceId)).toBe(true);
      expect(w.approvedSource).toMatchObject({owner:"acme",repo:"app",workspaceId:w.ctx.workspaceId,environmentId:w.ctx.environmentId,operationId:w.ctx.operationId,githubBinding:{appId:"42",installationId:7,repositoryId:99,version:1}});
      expect(w.fetcher.mock.calls.every(([, init]) => !JSON.stringify(init).includes(INSTALL_TOKEN))).toBe(true);
    } finally {query.mockRestore();}
  });
});
