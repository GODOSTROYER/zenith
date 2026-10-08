import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { KubeConfig } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { createDefaultManagedSubstrate } from "@/lib/platform/zenith-managed";
import { createReleasePorts } from "@/lib/platform/release";
import { createZenithSourceStore } from "@/lib/platform/zenith-managed-build";
import { createK8sClient, listByKind, READ_ONLY_KINDS } from "@/lib/providers/kubernetes/client";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { DriverContext } from "@/lib/drivers/types";
import { createProductPort } from "@/lib/execution/product-port";
import type { ResourceNode } from "@/lib/resources/types";
import { digest } from "@/lib/controlplane/digest";
import { dig } from "@/lib/providers/kubernetes/util";
import { readIsolatedBuildConfig } from "@/lib/providers/kubernetes/build";

const enabled = process.env.ZENITH_TEST_ISOLATED_BUILD_KIND === "1";
if (!enabled) console.warn("J6 kind isolation/release not run: needs ZENITH_TEST_ISOLATED_BUILD_KIND=1, enforcing CNI, userns runtime/profiles, registry and seeded default product/vault.");
function archive(files: Record<string,Uint8Array>): Uint8Array {
 const blocks:Buffer[]=[];
 for(const [name,bytes] of Object.entries(files)){
  const header=Buffer.alloc(512);header.write(name,0,100);header.write("0000755\0",100);header.write("0000000\0",108);header.write("0000000\0",116);
  header.write(bytes.length.toString(8).padStart(11,"0")+"\0",124);header.write("00000000000\0",136);header.fill(32,148,156);header.write("0",156);header.write("ustar\0",257);header.write("00",263);
  header.write(header.reduce((n,b)=>n+b,0).toString(8).padStart(6,"0")+"\0 ",148);blocks.push(header,Buffer.from(bytes),Buffer.alloc((512-bytes.length%512)%512));
 }
 blocks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(blocks));
}
describe.skipIf(!enabled)("J6 operated default managed isolated build and release",()=>{
 it("builds source through default ports, proves actual isolation, migrates, waits ready and independently reads the running artifact",async()=>{
  // No provider, credential, tenant, source or release port doubles. J1 seeds a disposable product tenant.
  const workspaceId=process.env.ZENITH_J6_WORKSPACE_ID!,environmentId=process.env.ZENITH_J6_ENVIRONMENT_ID!;
  expect(workspaceId).toBeTruthy();expect(environmentId).toMatch(/^env-j6-/);expect(process.env.KUBECONFIG).toBeTruthy();
  const product=await createProductPort().loadContext({workspaceId,environmentId});
  expect(product.workspace.id).toBe(workspaceId);expect(product.environment.id).toBe(environmentId);
  const config=readIsolatedBuildConfig(), managed=createDefaultManagedSubstrate();
  expect(managed.status().configured).toBe(true);
  const session=await managed.openSession({workspaceId,environmentId}), operationId="op-j6-"+randomBytes(4).toString("hex");
  const ctx:DriverContext={workspaceId,environmentId,operationId,provider:"zenith",region:managed.substrate().region,session,signal:AbortSignal.timeout(840_000),log:()=>undefined,tags:{},now:()=>new Date()};
  const make=(address:string,kind:ResourceNode["kind"],spec:Record<string,unknown>):ResourceNode=>({address,kind,provider:"zenith",region:ctx.region,nativeType:kind==="container_service"?"k8s:Deployment":kind==="network"?"zenith:Namespace":"zenith:BuildPipeline",spec,specDigest:digest(spec),ownership:"managed",origin:[],dependsOn:[],labels:{}});
  const service=make("container_service/j6","container_service",{workload:"web",size:"small",vcpu:0.1,memoryMb:64,replicas:1,port:8080,zones:1,subnetTier:"private",env:[],artifact:{type:"built",pipeline:"build_pipeline/j6",registry:"container_registry/j6"}});
  const pipeline=make("build_pipeline/j6","build_pipeline",{source:{repo:"local/j6",ref:"approved-local-fixture",dockerfile:"Dockerfile"},output:{registry:"container_registry/j6"},location:"customer_account"});
  const binary=readFileSync(process.env.ZENITH_J6_FIXTURE_BINARY!);
  const data=archive({"Dockerfile":Buffer.from('FROM scratch\nCOPY app /app\nUSER 65532:65532\nEXPOSE 8080\nENTRYPOINT ["/app"]\n'),app:binary});
  const source={archive:data,sha256:createHash("sha256").update(data).digest("hex"),bytes:data.length};
  const stored=await createZenithSourceStore(managed).upload(ctx,source);
  // This assertion ensures the assembler actually replaced the default builder imports.
  const ports=createReleasePorts({managed});
  const handle=await ports.build.startBuild(ctx,{service,pipeline,source:{s3Key:stored.name,bucket:stored.namespace,digest:source.sha256},idempotencyKey:operationId});
  expect(JSON.parse(handle.buildId).probeUID).toBeTruthy();
  const built=await ports.build.waitForBuild(ctx,handle,{timeoutMs:600_000});
  expect(built.status,built.detail).toBe("succeeded");expect(built.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(built.attestation?.isolation).toMatchObject({metadata:{exposes:"none"},network:{egress:"allowlisted"},identity:{deployCredentials:"absent"}});
  const image={uri:built.imageUri!,digest:built.digest!};
  const net=make("network/main","network",{zones:1});
  const runtime=managed.databaseRuntime({workspaceId,projectId:product.project.id,environmentId,nodes:[net,service]});
  const applied=await applyZenithEnvironment({session,expect:{workspaceId,environmentId},toolkit:managed.toolkit,nodes:[net,service],builtImages:{[service.address]:image.uri},resolveSecret:runtime.resolveSecret,signal:ctx.signal});
  expect(applied.ok).toBe(true);
  await ports.workloads.deployImage(ctx,service,image,{idempotencyKey:operationId+"-rollout"});
  expect(await ports.workloads.waitSteady(ctx,service,{timeoutMs:120_000})).toMatchObject({steady:true});
  const migration=await ports.migrations.runOneOffTask(ctx,service,["/app","migrate"],{idempotencyKey:operationId+"-migration",timeoutMs:120_000});
  expect(migration.exitCode).toBe(0);
  expect(await ports.workloads.readServing!(ctx,service)).toMatchObject({supported:true,digest:image.digest});
  const ns=tenantNamespace(workspaceId,environmentId),client=createK8sClient(session.kubernetes,{signal:ctx.signal});
  const pods=await listByKind(client,READ_ONLY_KINDS.Pod,ns);expect(pods.truncated).toBe(false);
  const pod=pods.items.find(p=>dig(p,"status","phase")==="Running"&&dig(p,"spec","containers",0,"image")===image.uri);
  expect(pod).toBeDefined();
  const admin=new KubeConfig();admin.loadFromFile(process.env.KUBECONFIG!);
  const {CoreV1Api}=await import("@kubernetes/client-node");
  const result=await admin.makeApiClient(CoreV1Api).connectGetNamespacedPodProxyWithPath({name:String(dig(pod,"metadata","name"))+":8080",namespace:ns,path:"/"});
  expect(String(result)).toContain("zenith-j6-source-release");
  expect(config.builderImage).toBe(built.attestation?.builderImage);
 },900_000);
});



