/** Real pinned builtin OpenTofu bytes and native default paired custody; hosted association/policy are supplied by the owning suite's explicit models. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, chmod, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Sql } from "@/lib/controlplane/types";
import { repos } from "@/lib/controlplane/db";
import { digest } from "@/lib/controlplane/digest";
import { Manifest, ManifestPolicies } from "@/lib/domain/types";
import { buildDesiredState } from "@/lib/execution/graph";
import { planCustody, scopeOf } from "@/lib/execution/runtime";
import { executionHolder } from "@/lib/execution/platform";
import { platformBroker } from "@/lib/capabilities/platform";
import { user, sessionFor } from "../../capabilities/support";
import { z } from "zod/v4";
import type { TofuWorkspace } from "@/lib/tofu/types";
import type { ResourceGraph } from "@/lib/resources/types";
import type { LeaseRef } from "@/lib/workflows/types";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";
import { planWorkspace, applyVerifiedPlan, type PlanCustodyInput } from "@/lib/tofu/engine";
import { createPlanArtifactRuntime } from "@/lib/platform/plan-artifacts";
import { createExecutionBroker } from "@/lib/platform/broker";
import { createOperationsPort } from "@/lib/execution/platform";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import * as artifacts from "@/lib/controlplane/db/repos/plan-artifacts";

export type NativePublication=(input:Readonly<{workspace:TofuWorkspace;custody:PlanCustodyInput;lease:LeaseRef;key:string;root:string;fingerprint:string;destroy:boolean}>)=>Promise<{planDigest:string}>;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function savedNativePlan(db: Sql, input: Readonly<{ custody: PlanCustodyInput; lease: LeaseRef; graph: ResourceGraph; key: string; destroy: boolean; root?:string; workspace?:TofuWorkspace; bootstrap?:boolean; publication?:NativePublication }>) {
  const root = input.root ?? await realpath(await mkdtemp(path.join(os.tmpdir(), "zenith-native-original-")));
  await chmod(root, 0o700);
  const statePath = path.join(root, "terraform.tfstate"), fingerprint = randomBytes(32).toString("hex");
  const workspace = input.workspace ?? assembleWorkspace({ graph: input.graph,
    fragments: new Map(input.graph.nodes.map((node, index) => [node.address, {
      resource: { terraform_data: { [`fixture_${index}`]: { input: node.specDigest } } }, addresses: [`terraform_data.fixture_${index}`],
    }])), providerSet: "builtin", region: "us-east-1", backend: { kind: "local", path: statePath }, tags: {} });
  const env = { ...process.env, ZENITH_PLAN_ARTIFACT_KEY: input.key, ZENITH_WORKER_PLAN_DIR: root };
  const runtime = createPlanArtifactRuntime(db, env);
  try {
    if (input.destroy && input.bootstrap!==false) {
      // Actual local fixture bootstrap, before the immutable destroy review.
      // It is not a provider settlement receipt or native delivery-history exception.
      const runner = new TofuRunner({ workRoot: root });
      const seeded = await planWorkspace(workspace, undefined, { runner, normalize: { fingerprintKey: fingerprint } });
      await applyVerifiedPlan(workspace, { runner, approvedDigest: seeded.plan.planDigest, normalize: { fingerprintKey: fingerprint } });
      await chmod(statePath, 0o600);
    }
    const published=input.publication?await input.publication({workspace,custody:input.custody,lease:input.lease,key:input.key,root,fingerprint,destroy:input.destroy}):undefined;
    const produced = await runtime.tofu.planWorkspace(workspace, undefined, { custody: input.custody,
      destroy: input.destroy, normalize: { fingerprintKey: fingerprint } });
    const facts = extractPlanFacts(produced.plan);
    const summary = { ...planEvidence({ plan: produced.plan, facts, cost: {}, graphDigest: input.graph.graphDigest, stage: "plan" }).summary,
      ...(input.destroy ? { destroy: true, destroyAddresses: produced.plan.resourceChanges.map(change => change.address), statefulDeletes: [] } : {}) };
    if(published&&published.planDigest!==produced.plan.planDigest)throw new Error("Independent native original digest changed.");
    if(!published)await runtime.planArtifacts.publish({ produced: produced.produced, lease: input.lease, evidence: {
      workspaceId: input.custody.workspaceId, operationId: input.custody.operationId, kind: "tofu_plan", digest: produced.plan.planDigest, summary, simulated: false,
    } });
    const worker = createExecutionBroker(db), operations = createOperationsPort(db);
    const decision = await worker.reevaluate(input.custody.operationId, facts);
    await operations.setPolicyDecision({ workspaceId: input.custody.workspaceId, operationId: input.custody.operationId, decisionId: decision.decisionId });
    const row = (await db.query<artifacts.ArtifactRow>("select * from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",
      [input.custody.workspaceId, input.custody.operationId]))[0];
    if (!row || row.manifest.planDigest !== produced.plan.planDigest || row.manifest_digest !== digest(row.manifest)) throw new Error("Native original fixture publication is unavailable.");
    return { root, statePath, workspace, fingerprint, runtime, row, plan: produced.plan, summary,
      close: () => input.root ? Promise.resolve() : rm(root, { recursive: true, force: true }) };
  } catch (error) { if(!input.root)await rm(root, { recursive: true, force: true }); throw error; }
}
export type SavedNativePlan = Awaited<ReturnType<typeof savedNativePlan>>;
/** The callback is fixture observation only. Genuine held origin, signed grant and dispatch predicates remain production code. */
export async function consumeSavedNativePlan(db: Sql, saved: SavedNativePlan, access: artifacts.ArtifactAccess,
  afterHeldGrant: () => Promise<void> = async () => undefined, beforeOriginalDispatch: (directory:string)=>Promise<void> = async()=>undefined) {
  let entered = 0, originalSha: string | undefined;
  const result = await saved.runtime.planArtifacts.consume(access, async original => {
    if (original.manifest.purpose === "destroy") {
      const grant = await createExecutionBroker(db).issueGrant(access.custody.operationId, "worker", access.lease, { capability: "infrastructure.destroy" });
      if (grant.claims.op !== access.custody.operationId || grant.claims.ws !== access.custody.workspaceId || grant.claims.fence !== access.lease.fenceToken)
        throw new Error("Native held fixture grant is unavailable.");
      // Bearer never leaves this local fixture callback or reaches the builtin process.
    }
    await afterHeldGrant();
    return saved.runtime.tofu.applyVerifiedPlan(saved.workspace, { original, custody: access.custody, approvedDigest: access.planDigest,
      destroy: original.manifest.purpose === "destroy", normalize: { fingerprintKey: saved.fingerprint }, beforeDispatch: async () => {
        const directories = (await readdir(saved.root, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith("zenith-tofu-run-"));
        if (directories.length !== 1) throw new Error("Native original fixture work directory is not exclusive.");
        const bytes = await readFile(path.join(saved.root, directories[0].name, "work", "reviewed.tfplan"));
        originalSha = sha(bytes); bytes.fill(0);
        if (originalSha !== original.manifest.rawSha256) throw new Error("Native original fixture bytes changed.");
        await beforeOriginalDispatch(path.join(saved.root,directories[0].name,"work"));
        entered++;
      } });
  });
  return { result, entered, originalSha };
}

/** Canonical product rows and one real local backend for a same-scope builtin continuation fixture. */
export async function standaloneProductScope(db:Sql) {
  const workspaceId=`ws_${randomUUID()}`,projectId=`proj_${randomUUID()}`,environmentId=`env_${randomUUID()}`,revisionId=`rev_${randomUUID()}`;
  const connectionId=`public_${randomUUID()}`,nativeId=`conn_${randomUUID()}`,key=randomBytes(32).toString("hex");
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"zenith-native-settlement-")));await chmod(root,0o700);
  const manifest=Manifest.parse({version:1,services:[{id:"web",name:"web",kind:"web",port:3000,source:{type:"image",image:"example/web:v1"}}],resources:[],routes:[],bindings:[]});
  const policies=ManifestPolicies.parse({approvalRequired:true,allowStatefulDeletion:false});
  const environment={id:environmentId,name:"production",class:"production" as const,provider:"aws" as const,region:"us-east-1",baseDomain:"owning.example.test",connectionId,policies,deployedRevisionId:revisionId};
  const product={workspace:{id:workspaceId,name:"Owning",slug:"owning"},project:{id:projectId,name:"Owning",slug:"owning"},environment,revision:{id:revisionId,number:1,manifest}};
  const desired=buildDesiredState(product);if(!desired.graph)throw new Error("Canonical builtin product graph unavailable.");
  await repos.connections.create(db,{id:nativeId,workspaceId,createdBy:"planner",config:{provider:"aws",mode:"aws_assume_role",accountId:"123456789012",region:environment.region,
    externalId:"modeled-builtin-product",observeRoleArn:"arn:aws:iam::123456789012:role/zenith_observe_fixture",deployRoleArn:"arn:aws:iam::123456789012:role/zenith_deploy_fixture"}});
  await repos.connections.recordVerification(db,{workspaceId,id:nativeId,ok:true});
  await db.query("insert into public.workspaces(id,workspace_id,slug,name,data) values($1,$1,$2,'Owning','{}'::jsonb)",[workspaceId,`owning-${randomUUID()}`]);
  await db.query("insert into public.members(id,workspace_id,email,role,data) values('planner',$1,'planner@example.test','editor','{}'::jsonb),('destination-user',$1,'destination@example.test','editor','{}'::jsonb),('erin',$1,'browser@example.test','admin','{}'::jsonb)",[workspaceId]);
  await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,'owning','Owning',$3::text::jsonb)",[projectId,workspaceId,JSON.stringify({workingManifest:manifest})]);
  await db.query("insert into public.environments(id,workspace_id,project_id,class,connection_id,data,deployed_revision_id,created_at) values($1,$2,$3,'production',$4,$5::text::jsonb,$6,clock_timestamp())",[environmentId,workspaceId,projectId,connectionId,JSON.stringify({name:environment.name,region:environment.region,baseDomain:environment.baseDomain,policies}),revisionId]);
  await db.query("insert into public.connections(id,workspace_id,provider,status,data) values($1,$2,'aws','healthy',$3::text::jsonb)",[connectionId,workspaceId,JSON.stringify({region:environment.region,platformConnectionId:nativeId})]);
  await db.query("insert into public.revisions(id,workspace_id,project_id,number,data) values($1,$2,$3,1,'{}'::jsonb)",[revisionId,workspaceId,projectId]);
  await db.query("insert into public.revision_manifests(revision_id,workspace_id,manifest) values($1,$2,$3::text::jsonb)",[revisionId,workspaceId,JSON.stringify(manifest)]);
  await repos.settings.putEnvironmentSettings(db,{workspaceId,environmentId,autonomyLevel:5,updatedBy:"fixture"});
  const address=desired.graph.nodes.find(node=>node.kind==="container_service")?.address;if(!address)throw new Error("Canonical builtin fixture service unavailable.");
  const workspace=assembleWorkspace({graph:desired.graph,fragments:new Map([[address,{resource:{terraform_data:{test:{input:"v1"}}},addresses:["terraform_data.test"]}]]),
    providerSet:"builtin",region:environment.region,backend:{kind:"local",path:path.join(root,"terraform.tfstate")},tags:{}});
  return {workspaceId,projectId,environmentId,revisionId,connectionId,nativeId,key,root,product,graph:desired.graph,workspace,
    snapshot:{workspaces:[{id:workspaceId}],projects:[{id:projectId,workspaceId}],environments:[{...environment,projectId}],connections:[{id:connectionId,provider:"aws"}]},
    close:()=>rm(root,{recursive:true,force:true})};
}
export type StandaloneProductScope=Awaited<ReturnType<typeof standaloneProductScope>>;
export async function reviewedStandalonePlan(db:Sql,scope:StandaloneProductScope,destroy=false,publication?:NativePublication) {
  const broker=await platformBroker(),deploymentId=`dep_${randomUUID()}`;
  const proposed=(await broker.propose({capability:destroy?"infrastructure.plan":"deployment.deploy",scope:{workspaceId:scope.workspaceId,projectId:scope.projectId,environmentId:scope.environmentId},
    input:{revisionId:scope.revisionId,deploymentId,...(destroy?{environmentId:scope.environmentId,teardownReview:true}:{})}},user("planner"))).operation;
  const op=await repos.operations.get(db,scope.workspaceId,proposed.id);if(!op)throw new Error("Canonical reviewed operation unavailable.");
  await db.query("insert into public.deployments(id,workspace_id,project_id,environment_id,revision_id,status,data) values($1,$2,$3,$4,$5,'planning',$6::text::jsonb)",
    [deploymentId,scope.workspaceId,scope.projectId,scope.environmentId,scope.revisionId,JSON.stringify({executor:"workflow",operationId:op.id})]);
  if(!destroy)await broker.approve({workspaceId:scope.workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,approver:user("erin"),session:sessionFor("erin")});
  const lease=await repos.leases.acquire(db,{scope:`env:${scope.environmentId}`,workspaceId:scope.workspaceId,holder:`worker:original:${op.id}`,ttlMs:300000});if(!lease)throw new Error("Canonical reviewed fence unavailable.");
  // No bearer is issued for this providerless builtin. Exact current native browser approval is consumed at each claim/dispatch.
  await repos.operations.claimForExecution(db,{workspaceId:scope.workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:executionHolder(op.id),leaseMs:300000,lease});
  const native=await repos.connections.get(db,scope.workspaceId,scope.nativeId);if(!native)throw new Error("Canonical native target unavailable.");
  const nodes=[...scope.graph.nodes].sort((a,b)=>a.address<b.address?-1:a.address>b.address?1:0);
  const graph=destroy?{...scope.graph,nodes,graphDigest:digest({graphDigest:scope.graph.graphDigest,nodes})}:scope.graph;
  const custody=planCustody({op,workspaceId:scope.workspaceId,environmentId:scope.environmentId,scope:scopeOf(op),product:{...scope.product,deploymentId},deploymentId},graph.graphDigest,native);
  const saved=await savedNativePlan(db,{custody,lease,graph,key:scope.key,destroy,root:scope.root,workspace:scope.workspace,bootstrap:false,publication});
  if(!destroy) {
    const operations=createOperationsPort(db);await operations.transition({workspaceId:scope.workspaceId,operationId:op.id,to:"awaiting_approval"});
    await broker.approve({workspaceId:scope.workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,planDigest:saved.plan.planDigest,approver:user("erin"),session:sessionFor("erin")});
    await repos.operations.claimForExecution(db,{workspaceId:scope.workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:executionHolder(op.id),leaseMs:300000,lease});
  }
  return {op,lease,saved,access:{custody,planDigest:saved.plan.planDigest,lease}};
}
export async function associatedStandaloneDestroy(db:Sql,scope:StandaloneProductScope,source:Awaited<ReturnType<typeof reviewedStandalonePlan>>) {
  const broker=await platformBroker(),proposed=await broker.propose({capability:"infrastructure.destroy",scope:{workspaceId:scope.workspaceId,projectId:scope.projectId,environmentId:scope.environmentId},input:{environmentId:scope.environmentId}},
    user("destination-user"),{via:"workflow",teardownReview:true,destroyPlan:{operationId:source.op.id,planDigest:source.saved.plan.planDigest}});
  const op=await repos.operations.get(db,scope.workspaceId,proposed.operation.id);if(!op)throw new Error("Canonical associated destination unavailable.");
  const ref=z.object({broker:z.object({destroyPlan:z.object({operationId:z.string(),evidenceId:z.string()})})}).parse(op.proposal).broker.destroyPlan;
  const evidence=await repos.evidence.get(db,scope.workspaceId,ref.evidenceId);if(!evidence)throw new Error("Canonical associated original evidence unavailable.");
  await repos.evidence.insert(db,{workspaceId:scope.workspaceId,operationId:op.id,kind:"tofu_plan",digest:source.saved.plan.planDigest,summary:evidence.summary,simulated:false});
  await source.saved.runtime.planArtifacts.associate({workspaceId:scope.workspaceId,sourceOperationId:source.op.id,destinationOperationId:op.id,sourceEvidenceId:ref.evidenceId,planDigest:source.saved.plan.planDigest,lease:source.lease});
  await repos.operations.transition(db,{workspaceId:scope.workspaceId,id:source.op.id,from:["running"],to:"succeeded",fence:source.lease,patch:{result:{operationId:op.id,planDigest:source.saved.plan.planDigest}}});
  await repos.leases.release(db,source.lease);
  await broker.approve({workspaceId:scope.workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,planDigest:source.saved.plan.planDigest,approver:user("erin"),session:sessionFor("erin")});
  await repos.operations.claimForExecution(db,{workspaceId:scope.workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:executionHolder(op.id),leaseMs:300000});
  const lease=await repos.operations.acquireExecutionLease(db,{workspaceId:scope.workspaceId,scope:source.lease.scope,holder:`worker:destination:${op.id}`,ttlMs:300000,operation:{id:op.id,proposalDigest:op.proposalDigest}});if(!lease)throw new Error("Canonical associated fence unavailable.");
  return {op,access:{custody:{...source.access.custody,operationId:op.id,proposalDigest:op.proposalDigest,inputDigest:op.inputDigest,expiresAt:op.expiresAt},planDigest:source.saved.plan.planDigest,lease}};
}
