/** Native SQL custody controls. Synthetic artifact/browser/history fixtures do not prove executable mixed effects. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";
const PG_URL = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim();
if (process.env.ZENITH_TEST_MIXED_CHILD_CUSTODY_REQUIRED === "1" && !PG_URL)
  throw new Error("Mixed-child custody acceptance requires an owned native PostgreSQL database.");
tempDataDir("zenith-mixed-child-custody-", { fast: true });
const { openPlatformDb } = await import("@/lib/controlplane/db");
const repos = await import("@/lib/controlplane/db/repos");
const mixed = await import("@/lib/controlplane/db/repos/mixed-child-intents");
const { digest, sha256Hex } = await import("@/lib/controlplane/digest");
const { stableJson } = await import("@/lib/tofu/stable");
const { expandManifest } = await import("@/lib/resources/expand");
const { makePlan, change } = await import("../execution/fakes/fixtures");
const { extractPlanFacts } = await import("@/lib/policy/plan-facts");
const { planEvidence } = await import("@/lib/execution/plan-evidence");
const { seedApprovedOperation, uid, user, newWorkspace } = await import("./_support/harness");
const { START_CONFIG, get: getWorkflowStartIntent } = await import("@/lib/controlplane/db/repos/workflow-start-intents");
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import type { MixedChildIds } from "@/lib/controlplane/db/repos/mixed-child-intents";
import type { ManifestV2 } from "@/lib/resources/manifest-v2";
import type { ProviderConnection } from "@/lib/credentials/types";
import type { PlanArtifactManifest } from "@/lib/tofu/engine";

const policies = { deletion: "approval" as const, allowStatefulDeletion: false };
const hex = (label: unknown) => digest(label);
const resource = (name: string) => ({ id: `res-${name}`, name, kind: "object_store" as const, config: {}, size: "small" as const, ownership: "managed" as const });
const parentManifest = (): ManifestV2 => ({ version: 2, services: [], resources: [resource("us"),resource("eu")], routes: [], bindings: [],
  nodePlacement: { "res-us": {provider:"aws",region:"us-east-1"}, "res-eu":{provider:"gcp",region:"us-central1"} } });
const childManifest = (): ManifestV2 => ({ version: 2, services: [], resources: [resource("eu")], routes: [], bindings: [],
  nodePlacement: { "res-eu":{provider:"gcp",region:"us-central1"} } });
let db: PlatformDbHandle, peer: PlatformDbHandle, observer: PlatformDbHandle;

async function fixture() {
  const workspaceId=newWorkspace(),projectId=uid("project"),requester=user(),approver=user(),parentEnv=uid("env"),childEnv=uid("env");
  const parentRevision=uid("revision"),childRevision=uid("revision"),parentConnection=uid("connection"),childConnection=uid("connection");
  await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,$1,'mixed candidate','{}'::jsonb)",[projectId,workspaceId]);
  await db.query("insert into public.members(id,workspace_id,email,role,data) values($1,$3,'requester@example.test','admin','{}'::jsonb),($2,$3,'approver@example.test','admin','{}'::jsonb)",[requester.id,approver.id,workspaceId]);
  const configs: ProviderConnection["config"][]=[{provider:"aws",mode:"oidc_web_identity",accountId:"123456789012",region:"us-east-1",
    observeRoleArn:"arn:aws:iam::123456789012:role/observe",deployRoleArn:"arn:aws:iam::123456789012:role/deploy",stateBucket:`zt-state-${workspaceId.replaceAll("_","-")}`},
    {provider:"gcp",mode:"oidc_web_identity",projectId:"zenith-mixed-native",region:"us-central1",stateBucket:`zt-gcp-${workspaceId.replaceAll("_","-")}`,
      workloadIdentityProvider:"projects/123456/locations/global/workloadIdentityPools/test/providers/test",observeServiceAccount:"observe@example.iam.gserviceaccount.com",deployServiceAccount:"deploy@example.iam.gserviceaccount.com"}];
  const nativeConnections=[];
  for (let i=0;i<2;i++) {
    const productId=i===0?parentConnection:childConnection,environmentId=i===0?parentEnv:childEnv,revisionId=i===0?parentRevision:childRevision;
    const config=configs[i];
    if (config.provider!=="aws" && config.provider!=="gcp") throw new Error("The mixed custody fixture requires its AWS or GCP region configuration.");
    const conn=await repos.connections.create(db,{workspaceId,legacyConnectionId:productId,config,createdBy:requester.id});
    await repos.connections.recordVerification(db,{workspaceId,id:conn.id,ok:true}); nativeConnections.push(conn.id);
    await db.query("insert into public.connections(id,workspace_id,provider,status,data) values($1,$2,$3,'verified',$4::text::jsonb)",
      [productId,workspaceId,config.provider,JSON.stringify({platformConnectionId:conn.id})]);
    await db.query("insert into public.environments(id,workspace_id,project_id,class,connection_id,data) values($1,$2,$3,'production',$4,$5::text::jsonb)",
      [environmentId,workspaceId,projectId,productId,JSON.stringify({name:i===0?"parent":"child",region:config.region,baseDomain:"mixed.example.test",policies})]);
    await db.query("insert into public.revisions(id,workspace_id,project_id,number,data) values($1,$2,$3,$4,'{}'::jsonb)",[revisionId,workspaceId,projectId,i+1]);
    await db.query("insert into public.revision_manifests(revision_id,workspace_id,manifest) values($1,$2,$3::text::jsonb)",
      [revisionId,workspaceId,JSON.stringify(i===0?parentManifest():childManifest())]);
    // The native driver must persist JSON objects, not JSON-encoded strings.
    // Fixed shape labels make a failed prerequisite diagnostic value-free.
    const shapes=await db.query<{connection:string;environment:string;manifest:string}>(`select jsonb_typeof(c.data) as connection,
      jsonb_typeof(e.data) as environment,jsonb_typeof(r.manifest) as manifest from public.connections c
      join public.environments e on e.workspace_id=c.workspace_id and e.connection_id=c.id
      join public.revision_manifests r on r.workspace_id=c.workspace_id and r.revision_id=$4
      where c.workspace_id=$1 and c.id=$2 and e.id=$3`,[workspaceId,productId,environmentId,revisionId]);
    expect(shapes).toEqual([{connection:"object",environment:"object",manifest:"object"}]);
  }
  async function reviewed(parent: boolean) {
    const environmentId=parent?parentEnv:childEnv,revisionId=parent?parentRevision:childRevision;
    const manifest=parent?parentManifest():childManifest();
    const graph=expandManifest(manifest,{id:environmentId,name:parent?"parent":"child",class:"production",provider:parent?"aws":"gcp",region:parent?"us-east-1":"us-central1",baseDomain:"mixed.example.test"});
    const seeded=await seedApprovedOperation(db,workspaceId,{requester,proposal:{capability:"infrastructure.apply",
      scope:{workspaceId,projectId,environmentId},input:{revisionId},summary:"Explicitly synthetic reviewed mixed custody fixture"}});
    const id=seeded.operation.id;
    await repos.operations.claimForExecution(db,{workspaceId,id,expectedDigest:seeded.operation.proposalDigest,holder:`workflow:${id}`});
    const plan=makePlan({seed:id,changes:graph.nodes.map(n=>change({address:`fixture.${n.address.replaceAll("/","_")}`,nodeAddress:n.address,type:n.nativeType,action:"create"}))});
    await repos.operationExecution.setPlanDigest(db,{workspaceId,id,planDigest:plan.planDigest});
    await repos.operationExecution.suspendForApproval(db,{workspaceId,id});
    const decision=await repos.policyDecisions.insert(db,{workspaceId,operationId:id,policyVersion:hex("policy"),inputDigest:hex({id}),outcome:"require_approval",
      reasons:[],approval:{count:1,minRole:"admin",separationOfDuties:true}});
    await repos.operationExecution.setPolicyDecision(db,{workspaceId,id,decisionId:decision.id});
    const exact=await repos.approvals.record(db,{workspaceId,operationId:id,approver,approverRole:"admin",decision:"approve",
      proposalDigest:seeded.operation.proposalDigest,policyVersion:decision.policyVersion,planDigest:plan.planDigest,expectedApprovalRound:1});
    // The public human identity is modeled, but the exact native round/plan decision is recorded by the real repository.
    expect(exact.approval.operationId).toBe(id); expect(exact.operation.planDigest).toBe(plan.planDigest);
    const artifact: PlanArtifactManifest={format:"zenith.plan-artifact.v1",purpose:"deploy",workspaceId,projectId,environmentId,operationId:id,
      proposalDigest:seeded.operation.proposalDigest,inputDigest:seeded.operation.inputDigest,expiresAt:seeded.operation.expiresAt,
      sourceDigest:graph.manifestDigest,graphDigest:graph.graphDigest,configDigest:plan.configDigest,lockDigest:plan.lockDigest,
      backendDigest:hex("synthetic backend bytes"),addressMapDigest:hex("synthetic address map"),planDigest:plan.planDigest,rawSha256:hex("synthetic plan bytes"),bytes:1,
      executable:{version:"synthetic",platform:"synthetic",sha256:hex("synthetic executable"),archiveSha256:null}};
    // Deliberately synthetic sealed data proves SQL retention only; it cannot become a produced/approved engine handle.
    await db.query(`insert into platform.plan_artifacts(workspace_id,operation_id,manifest,manifest_digest,plan_digest,iv,auth_tag,ciphertext,expires_at)
      values($1,$2,$3::text::jsonb,$4,$5,$6,$7,'synthetic non-executable custody', $8::timestamptz)`,
      [workspaceId,id,JSON.stringify(artifact),sha256Hex(stableJson(artifact)),plan.planDigest,"A".repeat(16),"A".repeat(24),artifact.expiresAt]);
    expect((await db.query<{shape:string}>("select jsonb_typeof(manifest) as shape from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[workspaceId,id]))[0]?.shape).toBe("object");
    const evidence=planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:graph.graphDigest,stage:"plan"});
    await repos.evidence.insert(db,{workspaceId,operationId:id,kind:"tofu_plan",digest:evidence.digest,summary:evidence.summary,simulated:false});
    if (parent) {
      await repos.operations.transition(db,{workspaceId,id,from:["approved"],to:"queued",patch:{workflowId:`op-${id}`}});
      await repos.operations.claimForExecution(db,{workspaceId,id,expectedDigest:seeded.operation.proposalDigest,holder:`workflow:${id}`,leaseMs:300_000,expectedPolicyVersion:decision.policyVersion});
      const args={workspaceId,operationId:id,projectId,environmentId,revisionId,deploymentId:`dep-${id}`,connectionId:parentConnection,preApproved:true,build:false};
      const argumentsDigest=digest(args),binding={format:"zenith.workflow-start.v1",kind:"deploy",arguments:args,namespace:"synthetic-mixed-fixture",
        endpointDigest:hex("synthetic frontend"),taskQueue:"synthetic-mixed-fixture",workflowType:"infrastructureDeployWorkflow",workflowId:`op-${id}`,
        argumentsDigest,proposalDigest:seeded.operation.proposalDigest,inputDigest:seeded.operation.inputDigest,
        sourceDigest:digest({proposalDigest:seeded.operation.proposalDigest,inputDigest:seeded.operation.inputDigest,argumentsDigest}),configDigest:digest(START_CONFIG)};
      // This parent history row is a native SQL fixture, not independent Temporal raw-history proof.
      await db.query(`insert into platform.workflow_start_intents(workspace_id,operation_id,binding,binding_digest,phase,attempt_id,run_id,observed_start_at,evidence_digest,attempted_at,acknowledged_at)
        values($1,$2,$3::text::jsonb,$4,'acknowledged',$5,$6,clock_timestamp(),$7,clock_timestamp(),clock_timestamp())`,
        [workspaceId,id,JSON.stringify(binding),digest(binding),randomUUID(),randomUUID(),hex("synthetic history")]);
      expect((await db.query<{shape:string}>("select jsonb_typeof(binding) as shape from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2",[workspaceId,id]))[0]?.shape).toBe("object");
      // The real validator must accept this synthetic row before custody tests.
      // Compare only fixed state and booleans; never print the binding or artifact.
      const history=await getWorkflowStartIntent(db,workspaceId,id);
      if(!history)throw new Error("The owning synthetic acknowledged history fixture is unavailable.");
      expect(history.phase).toBe("acknowledged");
      expect(history.binding_digest===digest(binding)).toBe(true);
      expect(history.workspace_id===workspaceId && history.operation_id===id && history.binding.workflowId===`op-${id}`
        && history.binding.proposalDigest===seeded.operation.proposalDigest && history.binding.inputDigest===seeded.operation.inputDigest
        && history.binding.argumentsDigest===argumentsDigest && history.binding.arguments.environmentId===environmentId).toBe(true);
    }
    return {operationId:id,planDigest:plan.planDigest,approvalId:exact.approval.id,artifact,decisionId:decision.id};
  }
  const parent=await reviewed(true),child=await reviewed(false);
  const ids:MixedChildIds={workspaceId,parentOperationId:parent.operationId,childOperationId:child.operationId};
  return {ids,parent,child,requester,approver,projectId,parentEnv,childEnv,parentConnection,childConnection,nativeConnections};
}
async function unchanged(f: Awaited<ReturnType<typeof fixture>>) {
  return { approvals:await db.query("select id,consumed_at from platform.approvals where workspace_id=$1 order by id",[f.ids.workspaceId]),
    operations:await db.query("select id,status,lease_holder,lease_scope,fence_token from platform.operations where workspace_id=$1 order by id",[f.ids.workspaceId]),
    starts:await db.query("select operation_id,binding_digest,phase,attempt_id,run_id from platform.workflow_start_intents where workspace_id=$1 order by operation_id",[f.ids.workspaceId]) };
}
async function nativeWait(f: Awaited<ReturnType<typeof fixture>>, change: () => Promise<void>) {
  await mixed.retain(db,f.ids);
  let held!:()=>void,release!:()=>void; const entered=new Promise<void>(r=>held=r),unlock=new Promise<void>(r=>release=r);
  const holder=peer.tx(async tx=>{await tx.query("select child_operation_id from platform.mixed_child_intents where workspace_id=$1 and child_operation_id=$2 for update",[f.ids.workspaceId,f.ids.childOperationId]);held();await unlock;});
  await entered; let settled=false;
  const pending=mixed.retain(db,f.ids).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
  try {
    const deadline=Date.now()+10_000; let observed=false;
    while(Date.now()<deadline) {
      const rows=await observer.query<{waiting:boolean}>(`select exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
        and wait_event_type='Lock' and query like '%select phase from platform.mixed_child_intents%') as waiting`);
      if(rows[0]?.waiting){observed=true;break;} if(settled)break; await new Promise(r=>setTimeout(r,10));
    }
    expect(observed).toBe(true);expect(settled).toBe(false);await change();
  } finally {release();await holder;}
  const result=await pending;expect(result).toHaveProperty("error.code","changed");
  expect((await mixed.get(db,f.ids))?.phase).toBe("prepared");
}

describe.skipIf(!PG_URL)("native mixed child custody [postgres]",()=>{
  beforeAll(async()=>{
    db=await openPlatformDb({kind:"postgres",url:PG_URL,migrate:true,max:3});
    peer=await openPlatformDb({kind:"postgres",url:PG_URL,migrate:true,max:3});
    observer=await openPlatformDb({kind:"postgres",url:PG_URL,migrate:true,max:2});
    await db.exec(await readFile(path.resolve("supabase/migrations/0001_system_of_record.sql"),"utf8"));
  },120_000);
  afterAll(async()=>{await Promise.all([observer?.close(),peer?.close(),db?.close()]);});
  it("retains an immutable native child candidate with separate provider and backend identities but no execution authority",async()=>{
    const f=await fixture(),before=await unchanged(f),saved=await mixed.retain(db,f.ids);
    expect(saved).toMatchObject({phase:"prepared",executionEnabled:false,descriptor:{parentEffectCoverage:"unsupported",compilerReferenceCoverage:"unavailable",artifactBytesAuthenticated:false,connectionAuthorization:"not_minted"}});
    expect(saved.descriptor.child).toMatchObject({operationId:f.child.operationId,planDigest:f.child.planDigest,approvalRound:1,identity:{provider:"gcp",accountId:"zenith-mixed-native",backendKind:"gcs"}});
    expect(saved.descriptor.parent).toMatchObject({operationId:f.parent.operationId,identity:{provider:"aws",accountId:"123456789012",backendKind:"s3"},historyAuthenticated:false});
    expect(saved.descriptor.nodes.map(n=>n.address)).toEqual(["object_store/eu"]);
    expect((await mixed.get(peer,f.ids))?.descriptor_digest).toBe(saved.descriptor_digest);expect(await unchanged(f)).toEqual(before);
    expect(JSON.stringify(saved)).not.toContain("synthetic non-executable custody");
  });
  it("duplicate independent-pool retention yields one exact immutable descriptor and prepared intent",async()=>{
    const f=await fixture();const values=await Promise.all([mixed.retain(db,f.ids),mixed.retain(peer,f.ids)]);
    expect(new Set(values.map(v=>v.descriptor_digest)).size).toBe(1);
    expect(await db.query("select child_operation_id from platform.mixed_child_intents where workspace_id=$1",[f.ids.workspaceId])).toEqual([{child_operation_id:f.child.operationId}]);
  });
  it("foreign workspace reads and retention neither expose nor mutate native custody or approvals",async()=>{
    const f=await fixture();await mixed.retain(db,f.ids);const before=await unchanged(f),foreign={...f.ids,workspaceId:newWorkspace()};
    expect(await mixed.get(peer,foreign)).toBeNull();await expect(mixed.reserve(peer,foreign)).rejects.toMatchObject({code:"unsupported_parent_effects"});await expect(mixed.retain(peer,foreign)).rejects.toMatchObject({code:"unavailable"});
    expect(await unchanged(f)).toEqual(before);expect((await mixed.get(db,f.ids))?.phase).toBe("prepared");
  });
  it("the native repository refuses structural database branding before any callback",async()=>{
    let calls=0;const fake={kind:"postgres",query:async()=>{calls++;return[];},tx:async()=>{calls++;}};
    await expect(mixed.retain(fake as unknown as PlatformDbHandle,{workspaceId:"ws-x",parentOperationId:"op-parent",childOperationId:"op-child"})).rejects.toMatchObject({code:"unavailable"});expect(calls).toBe(0);
  });
  it("native ID capture refuses hostile getters and supplied approval flags without evaluating them",async()=>{
    let calls=0;const hostile=Object.defineProperty({parentOperationId:"op-parent",childOperationId:"op-child"},"workspaceId",{enumerable:true,get(){calls++;return"ws-x";}});
    await expect(mixed.retain(db,hostile as unknown as MixedChildIds)).rejects.toMatchObject({code:"unavailable"});expect(calls).toBe(0);
    await expect(mixed.retain(db,{workspaceId:"ws-x",parentOperationId:"op-parent",childOperationId:"op-child",approved:true} as MixedChildIds)).rejects.toMatchObject({code:"unavailable"});
  });
  it("a genuinely reviewed child still cannot reserve Start when mixed parent effects are unsupported",async()=>{
    const f=await fixture();await mixed.retain(db,f.ids);const before=await unchanged(f);
    await expect(mixed.reserve(db,f.ids)).rejects.toMatchObject({code:"unsupported_parent_effects"});expect(await unchanged(f)).toEqual(before);
    expect((await mixed.get(db,f.ids))?.phase).toBe("prepared");
  });
  it("missing child concrete review cannot borrow parent approvals",async()=>{
    const f=await fixture();await peer.query("update platform.operations set approval_round=0 where workspace_id=$1 and id=$2",[f.ids.workspaceId,f.child.operationId]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});expect(await mixed.get(db,f.ids)).toBeNull();
  });
  it("child approval consumption cannot be inferred or performed by custody retention",async()=>{
    const f=await fixture();await peer.query("update platform.approvals set consumed_at=clock_timestamp() where workspace_id=$1 and id=$2",[f.ids.workspaceId,f.child.approvalId]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});expect(await mixed.get(db,f.ids)).toBeNull();
  });
  it.each(["parent","child"] as const)("%s plan digest edits refuse native child retention",async side=>{
    const f=await fixture();await peer.query("update platform.operations set plan_digest=$3 where workspace_id=$1 and id=$2",[f.ids.workspaceId,f[side].operationId,hex("changed plan")]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});expect(await mixed.get(db,f.ids)).toBeNull();
  });
  it.each(["requester","approver"] as const)("%s current human demotion refuses custody despite retained approved rows",async subject=>{
    const f=await fixture();await peer.query("update public.members set role='viewer' where workspace_id=$1 and id=$2",[f.ids.workspaceId,f[subject].id]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});
  });
  it.each(["parent","child"] as const)("%s current connection revocation refuses custody",async side=>{
    const f=await fixture();await repos.connections.revoke(peer,f.ids.workspaceId,f.nativeConnections[side==="parent"?0:1]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});
  });
  it.each(["expired","foreign","taken over","partial pair"] as const)("a parent environment lease that is %s cannot qualify native custody",async state=>{
    const f=await fixture();const lease=await repos.leases.acquire(db,{workspaceId:f.ids.workspaceId,scope:`env:${f.parentEnv}`,holder:`worker:mixfixture:${f.parent.operationId}`,ttlMs:300_000});
    if(!lease)throw new Error("Owned parent lease fixture unavailable.");
    await repos.operations.bindExecutionLease(db,{workspaceId:f.ids.workspaceId,id:f.parent.operationId,expectedDigest:f.parent.artifact.proposalDigest,lease});
    if(state==="partial pair")await peer.query("update platform.operations set fence_token=null where workspace_id=$1 and id=$2",[f.ids.workspaceId,f.parent.operationId]);
    else if(state==="foreign")await peer.query("update platform.leases set workspace_id=$3 where scope=$1 and workspace_id=$2",[lease.scope,f.ids.workspaceId,newWorkspace()]);
    else {
      await peer.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where scope=$1 and workspace_id=$2",[lease.scope,f.ids.workspaceId]);
      if(state==="taken over")expect(await repos.leases.acquire(peer,{workspaceId:f.ids.workspaceId,scope:lease.scope,holder:`worker:otherfixture:${f.parent.operationId}`,ttlMs:300_000})).toMatchObject({fenceToken:lease.fenceToken+1});
    }
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});expect(await mixed.get(db,f.ids)).toBeNull();
  });
  it("an existing foreign settings row cannot masquerade as absent owning environment policy",async()=>{
    const f=await fixture();await peer.query("insert into platform.environment_settings(environment_id,workspace_id,autonomy_level,policy_params,updated_by) values($1,$2,1,'{}'::jsonb,'fixture')",[f.childEnv,newWorkspace()]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});
  });
  it("a child environment cannot redirect custody to a second unrelated same-workspace connection",async()=>{
    const f=await fixture();await peer.query("update public.environments set connection_id=$3 where workspace_id=$1 and id=$2",[f.ids.workspaceId,f.childEnv,f.parentConnection]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});
  });
  it("original plan evidence edits refuse immutable metadata reapplication without consuming another approval",async()=>{
    const f=await fixture();await mixed.retain(db,f.ids);const before=await unchanged(f);
    await peer.query("update platform.evidence set summary=jsonb_set(summary,'{graphDigest}',to_jsonb($3::text)) where workspace_id=$1 and operation_id=$2 and kind='tofu_plan'",[f.ids.workspaceId,f.child.operationId,hex("changed graph")]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});expect(await unchanged(f)).toEqual(before);
  });
  it("foreign project or revision cannot be copied into a child's immutable scope",async()=>{
    const f=await fixture();await peer.query("update public.revisions set project_id=$3 where workspace_id=$1 and id=(select proposal->'input'->>'revisionId' from platform.operations where workspace_id=$1 and id=$2)",[f.ids.workspaceId,f.child.operationId,uid("foreign")]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});
  });
  it("changed provider backend identity cannot replace previously retained child custody",async()=>{
    const f=await fixture();const before=await mixed.retain(db,f.ids);
    await peer.query("update platform.provider_connections set config=jsonb_set(config,'{stateBucket}',to_jsonb($3::text)) where workspace_id=$1 and id=$2",[f.ids.workspaceId,f.nativeConnections[1],"another-bucket"]);
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"changed"});expect((await mixed.get(db,f.ids))?.descriptor_digest).toBe(before.descriptor_digest);
  });
  it.each(["connection","approver","evidence","parent approval","child approval","settings"] as const)("committed %s change during an observed native outbox row wait refuses custody reapplication",async target=>{
    const f=await fixture();const before=await unchanged(f);
    await nativeWait(f,async()=>{
      if(target==="connection")expect(await repos.connections.revoke(observer,f.ids.workspaceId,f.nativeConnections[1])).not.toBeNull();
      else if(target==="approver")expect(await observer.query("update public.members set role='viewer' where workspace_id=$1 and id=$2 returning id",[f.ids.workspaceId,f.approver.id])).toEqual([{id:f.approver.id}]);
      else if(target==="parent approval" || target==="child approval") expect(await observer.query("update platform.approvals set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2 returning id",[f.ids.workspaceId,target==="parent approval"?f.parent.approvalId:f.child.approvalId])).toHaveLength(1);
      else if(target==="settings") await repos.settings.putEnvironmentSettings(observer,{workspaceId:f.ids.workspaceId,environmentId:f.childEnv,autonomyLevel:1,policyParams:{},updatedBy:f.requester.id});
      else expect(await observer.query("update platform.evidence set summary=jsonb_set(summary,'{graphDigest}',to_jsonb($3::text)) where workspace_id=$1 and operation_id=$2 and kind='tofu_plan' returning id",[f.ids.workspaceId,f.child.operationId,hex("changed waited evidence")])).toHaveLength(1);
    });expect(await unchanged(f)).toEqual(before);
  });
  it("immutable descriptor rows cannot be edited or deleted and prepared outbox rows cannot be promoted",async()=>{
    const f=await fixture();await mixed.retain(db,f.ids);
    for(const statement of ["update platform.mixed_child_custody set descriptor=descriptor where workspace_id=$1", "delete from platform.mixed_child_custody where workspace_id=$1",
      "update platform.mixed_child_intents set phase='attempted',attempt_id=$2,attempted_at=clock_timestamp() where workspace_id=$1", "delete from platform.mixed_child_intents where workspace_id=$1"])
      await expect(db.tx(tx=>tx.query(statement,statement.includes("$2")?[f.ids.workspaceId,randomUUID()]:[f.ids.workspaceId]))).rejects.toMatchObject({sqlstate:"23514"});
    expect((await mixed.get(db,f.ids))?.phase).toBe("prepared");
  });
  it.each(["attempted","acknowledged"] as const)("an explicitly synthetic %s tombstone remains diagnostic and cannot supply a second Start",async phase=>{
    const original=await fixture(),sample=await mixed.retain(db,original.ids),f=await fixture();
    const descriptor={...sample.descriptor,workspaceId:f.ids.workspaceId,parent:{...sample.descriptor.parent,operationId:f.parent.operationId},child:{...sample.descriptor.child,operationId:f.child.operationId}};
    const descriptorDigest=digest(descriptor),attemptId=randomUUID(),runId=phase==="acknowledged"?randomUUID():null;
    const receipt=phase==="acknowledged"?{format:"zenith.mixed-child-history.v1",workspaceId:f.ids.workspaceId,parentOperationId:f.parent.operationId,childOperationId:f.child.operationId,descriptorDigest,attemptId,runId}:null;
    // Direct SQL state fault fixture, not accepted native history or a public acknowledgment registrar.
    await db.tx(async tx=>{
      await tx.query("insert into platform.mixed_child_custody(workspace_id,parent_operation_id,child_operation_id,partition_id,descriptor,descriptor_digest) values($1,$2,$3,$4,$5::text::jsonb,$6)",[f.ids.workspaceId,f.parent.operationId,f.child.operationId,descriptor.partitionId,JSON.stringify(descriptor),descriptorDigest]);
      await tx.query(`insert into platform.mixed_child_intents(workspace_id,parent_operation_id,child_operation_id,descriptor_digest,phase,attempt_id,attempted_at,run_id,receipt,acknowledged_at)
        values($1,$2,$3,$4,$5,$6,clock_timestamp(),$7,$8::text::jsonb,case when $5='acknowledged' then clock_timestamp() else null end)`,[f.ids.workspaceId,f.parent.operationId,f.child.operationId,descriptorDigest,phase,attemptId,runId,receipt?JSON.stringify(receipt):null]);
    });
    const saved=await mixed.get(peer,f.ids);expect(saved).toMatchObject({phase,executionEnabled:false,attempt_id:attemptId,run_id:runId});
    const before=await unchanged(f);await expect(mixed.reserve(db,f.ids)).rejects.toMatchObject({code:"nonreplayable"});
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"nonreplayable"});expect(await unchanged(f)).toEqual(before);
    await expect(db.tx(tx=>tx.query("update platform.mixed_child_intents set phase='prepared',attempt_id=null,attempted_at=null,run_id=null,receipt=null,acknowledged_at=null where workspace_id=$1",[f.ids.workspaceId]))).rejects.toMatchObject({sqlstate:"23514"});
    expect((await mixed.get(db,f.ids))?.attempt_id).toBe(attemptId);
  });
  it("an uncertain native parent cannot provide a new child custody continuation",async()=>{
    const f=await fixture();await repos.operations.transition(peer,{workspaceId:f.ids.workspaceId,id:f.parent.operationId,from:["running"],to:"uncertain",patch:{error:"Synthetic lost parent outcome fixture"}});
    await expect(mixed.retain(db,f.ids)).rejects.toMatchObject({code:"unavailable"});await expect(mixed.reserve(db,f.ids)).rejects.toMatchObject({code:"unsupported_parent_effects"});
  });
  it.each(["executionEnabled","artifactBytesAuthenticated"] as const)("a direct SQL candidate cannot set %s or omit its non-authority bound",async key=>{
    const original=await fixture(),sample=await mixed.retain(db,original.ids),f=await fixture();
    const descriptor={...sample.descriptor,workspaceId:f.ids.workspaceId,parent:{...sample.descriptor.parent,operationId:f.parent.operationId},child:{...sample.descriptor.child,operationId:f.child.operationId},[key]:true};
    const insert=(value:Record<string,unknown>)=>db.tx(tx=>tx.query("insert into platform.mixed_child_custody(workspace_id,parent_operation_id,child_operation_id,partition_id,descriptor,descriptor_digest) values($1,$2,$3,$4,$5::text::jsonb,$6)",[f.ids.workspaceId,f.parent.operationId,f.child.operationId,sample.partition_id,JSON.stringify(value),digest(value)]));
    await expect(insert(descriptor)).rejects.toMatchObject({sqlstate:"23514"});
    const missing={...descriptor} as Record<string,unknown>;delete missing[key];await expect(insert(missing)).rejects.toMatchObject({sqlstate:"23514"});
    expect(await mixed.get(db,f.ids)).toBeNull();
  });
  it("a missing child operation cannot manufacture a retained candidate or a parent fallback Start",async()=>{
    const f=await fixture(),input={...f.ids,childOperationId:uid("missing")};await expect(mixed.retain(db,input)).rejects.toMatchObject({code:"unavailable"});
    await expect(mixed.reserve(db,input)).rejects.toMatchObject({code:"unsupported_parent_effects"});expect(await mixed.get(db,input)).toBeNull();
  });
  it("RLS and exact narrower service grants do not expose child custody to browser roles",async()=>{
    const tables=await db.query<{name:string;rls:boolean}>("select c.relname as name,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform' and c.relname in ('mixed_child_custody','mixed_child_intents') order by c.relname");
    expect(tables).toEqual([{name:"mixed_child_custody",rls:true},{name:"mixed_child_intents",rls:true}]);
    expect(await db.query("select policyname from pg_policies where schemaname='platform' and tablename in ('mixed_child_custody','mixed_child_intents')")).toEqual([]);
    const roles=await db.query<{rolname:string}>("select rolname from pg_roles where rolname in ('anon','authenticated','service_role')");
    for(const table of ["mixed_child_custody","mixed_child_intents"])
      for(const role of roles)
        for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])
          expect((await db.query<{allowed:boolean}>("select has_table_privilege($1,$2,$3) as allowed",[role.rolname,`platform.${table}`,privilege]))[0].allowed)
            .toBe(role.rolname==="service_role" && (["SELECT","INSERT"].includes(privilege) || table==="mixed_child_intents" && privilege==="UPDATE"));
  });
});
