/** Owning PG source/review custody in preparation; standalone App contracts also use local SQL. HTTP/SDK replies are modeled, never live builds. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { BatchGetProjectsCommand, CodeBuildClient } from "@aws-sdk/client-codebuild";
import { GetBucketTaggingCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { StoredResource } from "@/lib/execution/ports";
import { sha256Hex } from "@/lib/controlplane/digest";
import { openPlatformDb, repos, PLATFORM_SCHEMA_VERSION, type PlatformDbHandle } from "@/lib/controlplane/db";
import { installGithubSourceSchema } from "@/lib/sources/github/schema";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { captureGithubWebhookFence } from "@/lib/sources/github/webhook-store";
import { createSourceBundles, createOwningSourceBundles } from "@/lib/platform/source-bundle";
import { api, binding, INSTALL_TOKEN, keys } from "../sources/fixtures";
import { writeTar } from "../_support/tar";
import { createApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { sourceRecipe, sourceSnapshotSetDigest } from "@/lib/execution/source-snapshot";
import { createOperationsPort } from "@/lib/execution/platform";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { normalizePlan } from "@/lib/tofu/plan";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { digest } from "@/lib/controlplane/digest";
import { PG_URL, seedApprovedOperation, withScratchDatabase } from "../controlplane/_support/harness";
import type { LeaseRef } from "@/lib/workflows/types";

const capture = vi.hoisted(() => ({ db: undefined as PlatformDbHandle | undefined }));
vi.mock("@/lib/controlplane/db/open", async (original) => ({ ...await original<typeof import("@/lib/controlplane/db/open")>(), platformDb: async () => capture.db! }));
let material: Awaited<ReturnType<typeof keys>>;
const held:LeaseRef[]=[];
let releaseScratch:(()=>void)|undefined,scratchOwner:Promise<void>|undefined;
if(process.env.ZENITH_TEST_SOURCE_FIXTURE_REQUIRED==="1") {
  if(!PG_URL)throw new Error("Default source fixture acceptance requires owned PostgreSQL.");
  if(PLATFORM_SCHEMA_VERSION<13)throw new Error("Default source fixtures require the canonical registered schema13.");
}
beforeAll(async () => {
  material = await keys();
  if(PG_URL) {
    let ready!:()=>void,failed!:(error:unknown)=>void;
    const opened=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});
    const released=new Promise<void>(resolve=>{releaseScratch=resolve;});
    // Fixed App fixture scopes live only in this positively owned physical
    // database. Preserve binding audit rows until the whole owner is disposed.
    scratchOwner=withScratchDatabase(async url=>{
      try {
        capture.db=await openPlatformDb({kind:"postgres",url,migrate:true,max:1});
        ready();await released;
      } finally {await capture.db?.close();capture.db=undefined;}
    });
    void scratchOwner.catch(failed);
    await opened;
  } else capture.db=await openPlatformDb({kind:"pglite"});
  await installGithubSourceSchema(capture.db!);
  const fence = await captureGithubWebhookFence(capture.db!, binding.appId, binding.installationId);
  await createGithubSourceStore(capture.db!).bind({ ...binding, actorId: "human", expectedVersion: 0, installationGeneration: fence.generation });
},60_000);
afterEach(async() => { while(held.length)await repos.leases.release(capture.db!,held.pop()!);vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => {
  try {
    if(scratchOwner){releaseScratch?.();await scratchOwner;}
    else await capture.db?.close();
  } finally {await material?.close();}
});

describe("C3 default GitHub App acquisition", () => {
  const source = { repo: "acme/app", ref: "a".repeat(40) };
  function configured() {
    vi.stubEnv("ZENITH_GITHUB_APP_ID", "42"); vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE", material.config.privateKeyFile);
  }
  function download() {
    return vi.fn<typeof fetch>(async (_url, options) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization === `Bearer ${INSTALL_TOKEN}`).toBe(true);
      return new Response(new Uint8Array(gzipSync(writeTar([{ path: "app-ref/Dockerfile", bytes: Buffer.from("FROM scratch\n") }]))));
    });
  }
  it.skipIf(!PG_URL)("uses the default connector in the existing composition hook and returns archive identifiers only", async () => {
    configured(); const fetchImpl = download(); const githubApi = api(); vi.stubGlobal("fetch", githubApi);
    const s3 = mockClient(S3Client); const cb = mockClient(CodeBuildClient);
    try {
      const region = "us-east-1"; const accountId = "123456789012"; const bucket = "zenith-env-a-web-src";
      const node = (address: string, kind: ResourceNode["kind"], spec: Record<string, unknown>): ResourceNode => ({ address, kind, provider: "aws", region, spec, specDigest: sha256Hex(JSON.stringify(spec)), ownership: "managed", nativeType: "aws:fixture", origin: [], dependsOn: [], labels: {} });
      const service = node("container_service/web", "container_service", { artifact: { type: "built", pipeline: "build_pipeline/web" } });
      const pipeline = { ...node("build_pipeline/web", "build_pipeline", { source, location: "customer_account" }), externalRef: `arn:aws:codebuild:${region}:${accountId}:project/zenith-env-a-web` };
      const rows: StoredResource[] = [service, pipeline].map((item) => ({ ...item, id: item.address, workspaceId: "ws-a", environmentId: "env-a", status: "active", externalId: item.externalRef }));
      const session: AwsSession = { provider: "aws", accountId, region, transport: "direct", expiresAt: "2099-01-01T00:00:00Z", client: (ctor) => new ctor({ region }), childProcessEnv: () => { throw new Error("Unused accessor."); } };
      const db=capture.db;if(!db || db.kind!=="postgres")throw new Error("Owned GitHub source preparation PostgreSQL is unavailable.");
      const projectId="proj-github-source-compatibility";
      const {operation}=await seedApprovedOperation(db,"ws-a",{ttlMs:120_000,proposal:{capability:"deployment.deploy",scope:{workspaceId:"ws-a",projectId,environmentId:"env-a"}}});
      const lease=await repos.leases.acquire(db,{workspaceId:"ws-a",scope:"env:env-a",holder:`worker:${operation.id}`,ttlMs:120_000});if(!lease)throw new Error("GitHub source fixture lease is unavailable.");held.push(lease);
      await repos.operations.claimForExecution(db,{workspaceId:"ws-a",id:operation.id,expectedDigest:operation.proposalDigest,holder:`workflow:${operation.id}`,leaseMs:120_000,lease});
      for(const item of [service,pipeline])await repos.resources.upsertDesired(db,{workspaceId:"ws-a",projectId,environmentId:"env-a",node:item,status:"active"});
      const ctx: DriverContext = { operationId:operation.id,provider: "aws", region, workspaceId: "ws-a", environmentId: "env-a", session, signal: new AbortController().signal, log: vi.fn(), tags: {}, now: () => new Date() };
      const tags = { "zenith:workspace": "ws-a", "zenith:environment": "env-a", "zenith:managed": "true", "zenith:resource": pipeline.address };
      cb.on(BatchGetProjectsCommand).resolves({ projects: [{ name: "zenith-env-a-web", arn: pipeline.externalRef, source: { type: "S3", location: `${bucket}/bootstrap.zip` }, tags: Object.entries(tags).map(([key, value]) => ({ key, value })) }] });
      s3.on(GetBucketTaggingCommand).resolves({ TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }); s3.on(PutObjectCommand).resolves({});
      const sourceSnapshots=createApprovedSourceSnapshotStore(db);
      const transport=vi.fn<typeof fetch>(async(raw,init)=>{
        const url=String(raw);
        if(url==="https://api.github.com/repos/acme/app" || url.startsWith("https://api.github.com/repos/acme/app/commits/")) {
          expect(new Headers(init?.headers).get("Authorization")===`Bearer ${INSTALL_TOKEN}`).toBe(true);
          return url.includes("/commits/")?new Response(source.ref):Response.json({id:99,name:"app",owner:{login:"acme"},private:true});
        }
        return url.startsWith("https://api.github.com/")?githubApi(raw,init):fetchImpl(raw,init);
      });
      const bundles=createOwningSourceBundles(db,{fetchImpl:transport,sourceSnapshots,resources:{list:async()=>rows}});
      const approvedSource=await bundles.port.capture!({workspaceId:ctx.workspaceId,operationId:operation.id,projectId,environmentId:ctx.environmentId,
        serviceAddress:service.address,serviceSpecDigest:service.specDigest,pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,provider:"aws",region,
        repository:source.repo,requestedRef:source.ref,dockerfile:"Dockerfile",recipeDigest:sourceRecipe(service,pipeline),archiveFormat:"zip"});
      await sourceSnapshots.retain(approvedSource,lease);
      const plan=normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},
        {configDigest:digest("config"),lockDigest:digest("lock"),addressMap:{},executableSourceDigest:sourceSnapshotSetDigest([approvedSource])});
      await repos.evidence.insert(db,{workspaceId:ctx.workspaceId,operationId:operation.id,kind:"tofu_plan",digest:plan.planDigest,
        summary:planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:digest("graph"),stage:"plan",approvedSources:[approvedSource]}).summary,simulated:false});
      await createOperationsPort(db).setPlanDigest({workspaceId:ctx.workspaceId,operationId:operation.id,planDigest:plan.planDigest});
      transport.mockClear();fetchImpl.mockClear();githubApi.mockClear();
      const result = await bundles.port.prepare(ctx, { service, source,approvedSource });
      expect(result.digest).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(result).includes(INSTALL_TOKEN)).toBe(false);
      expect(githubApi).toHaveBeenCalledTimes(4); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls.filter(([url])=>String(url)==="https://api.github.com/repos/acme/app")).toHaveLength(2);
      expect(transport.mock.calls.filter(([url])=>String(url).includes("/commits/"))).toHaveLength(2);
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
      expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes(INSTALL_TOKEN))).toBe(true);
    } finally { s3.restore(); cb.restore(); }
  });
  it("refuses a different repository before downloading any bytes", async () => {
    configured(); const githubApi = api(); vi.stubGlobal("fetch", githubApi); const fetchImpl = download();
    const { defaultGithubAccess } = await import("@/lib/sources/github/runtime");
    const bundler = createSourceBundles({ fetchImpl, withGithubAccess: (input, fn) => defaultGithubAccess({ ...input, workspaceId: "ws-a" }, fn) });
    await expect(bundler.read({ ...source, repo: "foreign/private" })).rejects.toThrow("acquisition failed");
    expect(fetchImpl).not.toHaveBeenCalled(); expect(githubApi).not.toHaveBeenCalled();
  });
  it("keeps standalone public archive reads anonymous when the App is configured", async () => {
    configured(); const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      expect((options?.headers as Record<string, string>).Authorization === undefined).toBe(true);
      return new Response(new Uint8Array(gzipSync(writeTar([{ path: "app-ref/a", bytes: Buffer.from("public") }]))));
    });
    const githubApi = api(); vi.stubGlobal("fetch", githubApi);
    expect((await createSourceBundles({ fetchImpl }).read(source)).bytes).toBeGreaterThan(0); expect(githubApi).not.toHaveBeenCalled();
  });
  it("does not leak an authenticated download failure or retry anonymously", async () => {
    configured(); vi.stubGlobal("fetch", api()); const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error(INSTALL_TOKEN); });
    const { defaultGithubAccess } = await import("@/lib/sources/github/runtime");
    const error = await createSourceBundles({ fetchImpl, withGithubAccess: (input, fn) => defaultGithubAccess({ ...input, workspaceId: "ws-a" }, fn) }).read(source).catch((error: unknown) => error);
    expect(String(error).includes(INSTALL_TOKEN)).toBe(false); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
