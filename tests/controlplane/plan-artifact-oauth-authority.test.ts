/** Genuine native default broker/OAuth journal and PostgreSQL CAS. Hosted REST/scope and policy protocols are explicit models; sealed bytes are synthetic, no cloud or real OpenTofu execution. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb, platformDb, resetPlatformDbForTests, repos, json, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { Principal, Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { PLATFORM_SCHEMA_VERSION } from "@/lib/controlplane/db/migrations";
import { Manifest, ManifestPolicies } from "@/lib/domain/types";
import { buildDesiredState } from "@/lib/execution/graph";
import { planCustody, scopeOf } from "@/lib/execution/runtime";
import { executionHolder, createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker, isDefaultCurrentDispatchRequirement } from "@/lib/platform/broker";
import { platformBroker, resetPlatformBrokerForTests, isDefaultPlatformBrokerFor } from "@/lib/capabilities/platform";
import { generateSigningJwk, serializePrivateJwk } from "@/lib/credentials";
import { pgAuthorityClient, closePgAuthorityClient } from "@/lib/hosted/authority/pg/client";
import { pgAgentJournal, resetPgAgentJournal } from "@/lib/agent-access/control/journal-pg";
import { agentJournal, isDefaultAgentJournalSelection } from "@/lib/agent-access/control/runtime";
import { planArtifactCipherFromEnv } from "@/lib/platform/plan-artifacts";
import * as artifacts from "@/lib/controlplane/db/repos/plan-artifacts";
import * as connections from "@/lib/controlplane/db/repos/connections";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { normalizePlan } from "@/lib/tofu/plan";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { stableJson } from "@/lib/tofu/stable";
import { TOFU_VERSION } from "@/lib/tofu/types";
import type { PlanArtifactManifest } from "@/lib/tofu/engine";
import { scriptedEngine, requireApproval, user, sessionFor } from "../capabilities/support";
import { savedNativePlan, consumeSavedNativePlan, type SavedNativePlan } from "./_support/saved-native-plan";
const state = vi.hoisted(() => ({
  snapshot: { workspaces: [] as {id:string}[], projects: [] as {id:string;workspaceId:string}[], environments: [] as {id:string;projectId:string;connectionId:string;class:string;region:string}[], connections: [] as {id:string;provider:string}[] },
  member: async (_ws:string,_id:string):Promise<{id:string;workspace_id:string;role:string}|null> => null,
  hold: undefined as undefined | { entered:()=>void; wait:Promise<void> },
}));
vi.mock("@/lib/db/store", async original => ({ ...await original<typeof import("@/lib/db/store")>(), isPostgres:()=>true,
  db:()=>state.snapshot, q:{connection:(id:string)=>state.snapshot.connections.find(c=>c.id===id)} }));
vi.mock("@/lib/db/postgres-store", async original => ({ ...await original<typeof import("@/lib/db/postgres-store")>(),
  // Explicit REST reply model reads actual native membership, then can retain
  // the old returned reply while another pool commits a role change.
  pgClient:()=>({from:(table:string)=>{if(table!=="members")throw new Error("Unexpected modeled REST collection.");const filters=new Map<string,string>();
    const query={select:()=>query,eq:(key:string,value:string)=>{filters.set(key,value);return query;},abortSignal:()=>query,
      maybeSingle:async()=>{const id=filters.get("id")!,data=await state.member(filters.get("workspace_id")!,id);if(id==="erin"&&state.hold){state.hold.entered();await state.hold.wait;}return {data,error:null};}};return query;}}),
}));
vi.mock("@/lib/policy", async original => ({ ...await original<typeof import("@/lib/policy")>(), loadPolicyEngine:async()=>scriptedEngine("native-oauth-policy",input=>{
  if(!input.request.mutates)return {outcome:"allow",reasons:[]};
  if(input.principal.kind!=="system"&&(input.principal.role==="viewer"||input.principal.kind==="integration"&&!input.principal.integrationScopes?.includes("write")))return {outcome:"deny",reasons:[]};
  return requireApproval(1,"admin",true);
}) }));
vi.mock("@/lib/execution/product-port", async original => ({ ...await original<typeof import("@/lib/execution/product-port")>(), workerStoreScope:async<T>(body:()=>Promise<T>)=>body() }));
vi.mock("@/lib/controlplane/db/repos/workflow-start-deploy-authority", async original => ({ ...await original<typeof import("@/lib/controlplane/db/repos/workflow-start-deploy-authority")>(),
  assertDefaultMcpProductTopology:async(owner:Sql)=>{if((await owner.query("select current_user as role")).length!==1)throw new Error("Modeled owning association unavailable.");},
  assertFinalMcpProductTopology:async(owner:Sql,tx:Sql)=>{if(owner===tx)throw new Error("Owning transaction required.");const rows=await tx.query("select current_user as role");if(rows.length!==1)throw new Error("Modeled hosted association unavailable.");},
}));
const PG_URL=process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim();
const explicitPort=()=>{try{return !!PG_URL&&!!new URL(PG_URL).port;}catch{return false;}};
if(process.env.ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED==="1"&&(!explicitPort()||PLATFORM_SCHEMA_VERSION<13))throw new Error("Native OAuth dispatch requires owned PostgreSQL with explicit port.");
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const tables=["workspaces","members","projects","environments","revisions","revision_manifests","deployments","connections"] as const;
describe.skipIf(!PG_URL)("native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",()=>{
  let db:PlatformDbHandle,peer:PlatformDbHandle,observer:PlatformDbHandle;
  const nativePlans:SavedNativePlan[]=[];
  beforeAll(async()=>{
    peer=await openPlatformDb({kind:"postgres",url:PG_URL!,migrate:true,max:1});observer=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});
    const migration=readFileSync(new URL("../../supabase/migrations/0001_system_of_record.sql",import.meta.url),"utf8");
    for(const name of tables){const ddl=new RegExp(`create table if not exists public\\.${name} \\([\\s\\S]*?\\n\\);`).exec(migration)?.[0];if(!ddl)throw new Error("Canonical product DDL unavailable.");await peer.exec(ddl);}
    await peer.exec("create schema if not exists agent");
    const agent=readFileSync(new URL("../../supabase/migrations/0006_agent_link.sql",import.meta.url),"utf8");
    for(const name of ["schema_migrations","agent_credentials"]){const ddl=new RegExp(`create table if not exists agent\\.${name} \\([\\s\\S]*?\\n\\);`).exec(agent)?.[0];if(!ddl)throw new Error("Canonical linked credential DDL unavailable.");await peer.exec(ddl);}
    await peer.query("insert into agent.schema_migrations(version,name,applied_at) values(1,'agent-link-v1','2026-01-01T00:00:00.000Z') on conflict do nothing");
    const versions=await peer.query<{version:number;name:string}>("select version,name from agent.schema_migrations order by version");
    expect(versions).toContainEqual({version:2,name:"agent-control-v1"});expect(versions).toContainEqual({version:3,name:"agent-oauth-grants-v1"});
    state.member=async(ws,id)=>(await db.query<{id:string;workspace_id:string;role:string}>("select id,workspace_id,role from public.members where workspace_id=$1 and id=$2",[ws,id]))[0]??null;
  },60000);
  beforeEach(async()=>{
    await resetPlatformDbForTests();resetPlatformBrokerForTests();await closePgAuthorityClient();Reflect.deleteProperty(globalThis,"__zenithPgCredentialAuthority");resetPgAgentJournal();Reflect.deleteProperty(globalThis,"__zenithAgentJournal");
    vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY","");vi.stubEnv("ZENITH_PLATFORM_DB","postgres");vi.stubEnv("ZENITH_PLATFORM_DB_URL",PG_URL!);vi.stubEnv("ZENITH_PLATFORM_DB_MAX","1");vi.stubEnv("SUPABASE_DB_URL",PG_URL!);vi.stubEnv("ZENITH_STORE","postgres");
    vi.stubEnv("ZENITH_AGENT_CONTROL","1");vi.stubEnv("ZENITH_AGENT_ORIGIN","https://zenith.example.test");vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER","https://issuer.example.test");vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS","https://issuer.example.test/jwks");
    vi.stubEnv("ZENITH_AGENT_OAUTH_CLIENT_CLAIM","client_id");vi.stubEnv("ZENITH_AGENT_OAUTH_SUBJECT_CLAIM","sub");
    const signing=await generateSigningJwk("EdDSA");vi.stubEnv("ZENITH_CONTROL_SIGNING_JWK",serializePrivateJwk(signing));
    db=await platformDb();
  });
  afterEach(async()=>{for(const saved of nativePlans.splice(0))await saved.close();state.hold=undefined;resetPlatformBrokerForTests();await resetPlatformDbForTests();await closePgAuthorityClient();Reflect.deleteProperty(globalThis,"__zenithPgCredentialAuthority");resetPgAgentJournal();Reflect.deleteProperty(globalThis,"__zenithAgentJournal");vi.restoreAllMocks();vi.unstubAllEnvs();});
  afterAll(async()=>{await observer?.close();await peer?.close();});
  async function defaultHarness(){
    const id=()=>randomUUID();const ids={wsA:`ws_${id()}`,wsB:`ws_${id()}`,projA:`proj_${id()}`,projB:`proj_${id()}`,envAProd:`env_${id()}`};
    const broker=await platformBroker();expect(isDefaultPlatformBrokerFor(broker,db)).toBe(true);return {ids,broker};
  }
  async function fixture(destroy = false, publicationFault?: "removed current human" | "foreign current human", retainHistorical = true) {
    const h = await defaultHarness();
    const workspaceId = h.ids.wsA, projectId = h.ids.projA, environmentId = h.ids.envAProd;
    const revisionId = `rev_${randomUUID()}`, deploymentId = `dep_${randomUUID()}`, connectionId = `public_${randomUUID()}`, nativeId = `conn_${randomUUID()}`;
    const manifest = Manifest.parse({ version: 1, services: [{ id: "web", name: "web", kind: "web", port: 3000,
      source: destroy ? { type: "git", repo: "acme/app", ref: "main", dockerfile: "Dockerfile" } : { type: "image", image: "example/web:v1" } }], resources: [], routes: [], bindings: [] });
    const policies = ManifestPolicies.parse({ approvalRequired: true, allowStatefulDeletion: false });
    const environment = { id: environmentId, name: "production", class: "production" as const, provider: "aws" as const,
      region: "us-east-1", baseDomain: "owning.example.test", connectionId, policies, deployedRevisionId: revisionId };
    const product = { workspace: { id: workspaceId, name: "Owning", slug: "owning" }, project: { id: projectId, name: "Owning", slug: "owning" },
      environment, revision: { id: revisionId, number: 1, manifest }, deploymentId };
    const desired = buildDesiredState(product);
    if (!desired.graph) throw new Error("Canonical worker graph fixture is unavailable.");
    let graph = desired.graph;
    const retained = destroy && retainHistorical ? { ...graph.nodes.find(node => node.kind === "container_service")!, address: "container_service/oldWeb" } : undefined;
    if (destroy) {
      if (retained) await repos.resources.upsertDesired(db, { workspaceId, projectId, environmentId, node: retained, status: "active" });
      const nodes = [...graph.nodes, ...(retained ? [retained] : [])].sort((a,b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
      graph = { ...graph, nodes, graphDigest: digest({ graphDigest: graph.graphDigest, nodes }) };
    }
    await connections.create(db, { id: nativeId, workspaceId, createdBy: "alice", config: { provider: "aws", mode: "aws_assume_role", accountId: "123456789012",
      region: environment.region, externalId: "modeled-product-authority", observeRoleArn: "arn:aws:iam::123456789012:role/zenith_observe_fixture",
      deployRoleArn: "arn:aws:iam::123456789012:role/zenith_deploy_fixture" } });
    await connections.recordVerification(db, { workspaceId, id: nativeId, ok: true });
    await db.query("insert into public.workspaces(id,workspace_id,slug,name,data) values($1,$1,$2,'Owning','{}'::jsonb)", [workspaceId, `owning-${randomUUID()}`]);
    await db.query("insert into public.members(id,workspace_id,email,role,data) values('alice',$1,'alice@example.test',$2,'{}'::jsonb),('erin',$1,'erin@example.test','admin','{}'::jsonb)", [workspaceId, destroy ? "viewer" : "admin"]);
    await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,'owning','Owning',$3::text::jsonb)", [projectId, workspaceId, json({ workingManifest: manifest })]);
    await db.query("insert into public.workspaces(id,workspace_id,slug,name,data) values($1,$1,$2,'Foreign','{}'::jsonb)", [h.ids.wsB, `foreign-${randomUUID()}`]);
    await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,'foreign','Foreign','{}'::jsonb)", [h.ids.projB, h.ids.wsB]);
    await db.query("insert into public.environments(id,workspace_id,project_id,class,connection_id,data,deployed_revision_id) values($1,$2,$3,'production',$4,$5::text::jsonb,$6)",
      [environmentId, workspaceId, projectId, connectionId, json({ name: environment.name, region: environment.region, baseDomain: environment.baseDomain, policies }), revisionId]);
    await db.query("insert into public.connections(id,workspace_id,provider,status,data) values($1,$2,'aws','healthy',$3::text::jsonb)", [connectionId, workspaceId, json({ region: environment.region, platformConnectionId: nativeId })]);
    await db.query("insert into public.revisions(id,workspace_id,project_id,number,data) values($1,$2,$3,1,$4::text::jsonb)", [revisionId, workspaceId, projectId, json({ message: "approved original" })]);
    await db.query("insert into public.revision_manifests(revision_id,workspace_id,manifest) values($1,$2,$3::text::jsonb)", [revisionId, workspaceId, json(manifest)]);
    state.snapshot = { workspaces: [{ id: workspaceId }], projects: [{ id: projectId, workspaceId }],
      environments: [{ ...environment, projectId }], connections: [{ id: connectionId, provider: "aws" }] };
    const principal: Principal = { kind: "integration", id: `integration_${randomUUID()}`, name: "Native OAuth product dispatch fixture", onBehalfOf: "alice" };
    principal.integrationId = principal.id;
    const journal=await agentJournal();expect(journal).toBe(pgAgentJournal());expect(isDefaultAgentJournalSelection(journal)).toBe(true);
    await journal.setGrant({subject:"alice",integrationId:principal.id,workspaceId,clientId:`client_${randomUUID()}`,
      oauthIssuer:"https://issuer.example.test",projectIds:[projectId],environmentIds:[environmentId],appIds:[],
      scopes:destroy?["read","plan"]:["read","plan","write"],expiresAt:new Date(Date.now()+120000).toISOString(),revoked:false});
    await repos.settings.putEnvironmentSettings(db, { workspaceId, environmentId, autonomyLevel: 5, updatedBy: "fixture" });
    const proposed = (await h.broker.propose({ capability: destroy ? "infrastructure.plan" : "deployment.deploy", scope: { workspaceId, projectId, environmentId },
      input: { revisionId, deploymentId, ...(destroy ? { environmentId, teardownReview: true } : {}) } }, principal)).operation;
    const op = await repos.operations.get(db, workspaceId, proposed.id);
    if (!op) throw new Error("Native original operation is unavailable.");
    await db.query("insert into public.deployments(id,workspace_id,project_id,environment_id,revision_id,status,data) values($1,$2,$3,$4,$5,'planning',$6::text::jsonb)",
      [deploymentId, workspaceId, projectId, environmentId, revisionId, json({ executor: "workflow", operationId: op.id })]);
    if (!destroy) await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") });
    const lease = await repos.leases.acquire(db, { workspaceId, scope: `env:${environmentId}`, holder: `worker:${op.id}`, ttlMs: 120_000 });
    if (!lease) throw new Error("Native original lease is unavailable.");
    await h.broker.beginExecution({ workspaceId, operationId: op.id, holder: executionHolder(op.id), audience: "worker", lease, leaseMs: 120_000 });
    const snapshots: never[] = [];
    const native = await connections.get(db, workspaceId, nativeId);
    if (!native) throw new Error("Native original provider is unavailable.");
    const custody = planCustody({ op, workspaceId, environmentId, scope: scopeOf(op), product, deploymentId }, graph.graphDigest, native);
    if (publicationFault === "removed current human") await observer.query("delete from public.members where workspace_id=$1 and id='alice'", [workspaceId]);
    if (publicationFault === "foreign current human") await observer.query("update public.members set workspace_id=$2 where workspace_id=$1 and id='alice'", [workspaceId, h.ids.wsB]);
    if(destroy) {
      const key=randomBytes(32).toString("hex"),saved=await savedNativePlan(db,{custody,lease,graph,key,destroy:true});nativePlans.push(saved);
      return {h,op,principal,worker:createExecutionBroker(db),retained,manifest:saved.row.manifest,graph,snapshots,lease,revisionId,deploymentId,connectionId,nativeId,
        access:{custody,planDigest:saved.plan.planDigest,lease},payload:"",cipher:planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:key}),plan:saved.plan,key,saved};
    }
    const plan = normalizePlan({ format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: [], output_changes: {} },
      { configDigest: digest("synthetic original config"), lockDigest: digest("synthetic original lock"), addressMap: {} });
    const facts = extractPlanFacts(plan), summary = { ...planEvidence({ plan, facts, cost: {}, graphDigest: graph.graphDigest, stage: "plan" }).summary,
      ...(destroy ? { destroy: true, destroyAddresses: [], statefulDeletes: [] } : {}) };
    const worker = createExecutionBroker(db), ports = createOperationsPort(db);
    await repos.evidence.insert(db, { workspaceId, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false });
    await ports.setPlanDigest({ workspaceId, operationId: op.id, planDigest: plan.planDigest });
    const decision = await worker.reevaluate(op.id, facts); await ports.setPolicyDecision({ workspaceId, operationId: op.id, decisionId: decision.decisionId });
    if (!destroy) {
    await ports.transition({ workspaceId, operationId: op.id, to: "awaiting_approval" });
    await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: plan.planDigest, approver: user("erin"), session: sessionFor("erin") });
    await repos.operations.claimForExecution(db, { workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: executionHolder(op.id), leaseMs: 120_000, lease, expectedPolicyVersion: "native-oauth-policy" });
    }
    const payload = "synthetic original OAuth target-bound SQL payload", key = randomBytes(32).toString("hex"), cipher = planArtifactCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: key });
    const manifestArtifact: PlanArtifactManifest = { ...custody, format: "zenith.plan-artifact.v1", purpose: destroy ? "destroy" : "deploy", planDigest: plan.planDigest,
      configDigest: plan.configDigest, lockDigest: plan.lockDigest, backendDigest: digest("synthetic backend"), addressMapDigest: digest("synthetic address map"),
      rawSha256: sha(payload), bytes: Buffer.byteLength(payload), executable: { version: "fixture", platform: "fixture", sha256: digest("fixture binary"), archiveSha256: null } };
    const sealed = cipher.seal(workspaceId, `zenith.tofu.plan-artifact.v1:${sha(stableJson(manifestArtifact))}`, Buffer.from(payload).toString("base64"));
    await artifacts.publish(db, { manifest: manifestArtifact, sealed, lease, evidence: { workspaceId, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false } });
    return { h, op, principal, worker, retained, manifest: manifestArtifact, graph, snapshots, lease, revisionId, deploymentId, connectionId, nativeId,
      access: { custody, planDigest: plan.planDigest, lease }, payload, cipher, plan, key, saved:undefined };
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  function heldApprover(){const entered=barrier(),release=barrier();state.hold={entered:entered.release,wait:release.promise};return {entered:entered.promise,release:()=>{state.hold=undefined;release.release();}};}
  async function dispatch(f:Fixture,access=f.access,attempt="native-oauth-attempt"){
    const authority=await createExecutionBroker(peer).approvalStatus(access.custody.operationId);
    expect(authority.approved).toBe(true);expect(authority.rejected).toBe(false);
    expect(await isDefaultCurrentDispatchRequirement(authority.dispatchApproval,peer,f.op.workspaceId,access.custody.operationId)).toBe(true);
    await artifacts.dispatch(peer,access,attempt,authority.dispatchApproval);
  }
  async function unchanged(f:Fixture,sql:Sql=observer){
    const row=(await sql.query<{manifest:PlanArtifactManifest;manifest_digest:string}>("select manifest,manifest_digest from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id]))[0];
    expect(row.manifest).toEqual(f.manifest);expect(row.manifest_digest).toBe(digest(f.manifest));
    const op=await repos.operations.get(sql,f.op.workspaceId,f.op.id);expect(op?.inputDigest).toBe(f.op.inputDigest);expect(op?.proposalDigest).toBe(f.op.proposalDigest);expect(op?.planDigest).toBe(f.access.planDigest);
  }
  async function destination(f:Fixture){
    const ws=f.op.workspaceId,proposed=await f.h.broker.propose({capability:"infrastructure.destroy",scope:{workspaceId:ws,projectId:f.op.projectId,environmentId:f.op.environmentId},input:{environmentId:f.op.environmentId}},
      f.principal,{via:"workflow",teardownReview:true,destroyPlan:{operationId:f.op.id,planDigest:f.access.planDigest}});
    const op=await repos.operations.get(db,ws,proposed.operation.id);if(!op)throw new Error("Native delegated destination unavailable.");
    const ref=z.object({broker:z.object({destroyPlan:z.object({operationId:z.string(),evidenceId:z.string()})})}).parse(op.proposal).broker.destroyPlan;
    const evidence=await repos.evidence.get(db,ws,ref.evidenceId);if(!evidence)throw new Error("Native original review unavailable.");
    await repos.evidence.insert(db,{workspaceId:ws,operationId:op.id,kind:"tofu_plan",digest:f.access.planDigest,summary:evidence.summary,simulated:false});
    await artifacts.associate(db,{workspaceId:ws,sourceOperationId:f.op.id,destinationOperationId:op.id,sourceEvidenceId:ref.evidenceId,planDigest:f.access.planDigest,lease:f.lease});
    await repos.operations.transition(db,{workspaceId:ws,id:f.op.id,from:["running"],to:"succeeded",fence:f.lease,patch:{result:{operationId:op.id,planDigest:f.access.planDigest}}});await repos.leases.release(db,f.lease);
    await f.h.broker.approve({workspaceId:ws,operationId:op.id,proposalDigest:op.proposalDigest,planDigest:f.access.planDigest,approver:user("erin"),session:sessionFor("erin")});
    await repos.operations.claimForExecution(db,{workspaceId:ws,id:op.id,expectedDigest:op.proposalDigest,holder:executionHolder(op.id),leaseMs:120000});
    const lease=await repos.operations.acquireExecutionLease(db,{workspaceId:ws,scope:f.lease.scope,holder:`worker:destination:${op.id}`,ttlMs:120000,operation:{id:op.id,proposalDigest:op.proposalDigest}});if(!lease)throw new Error("Native destination fence unavailable.");
    return {op,access:{custody:{...f.access.custody,operationId:op.id,proposalDigest:op.proposalDigest,inputDigest:op.inputDigest,expiresAt:op.expiresAt},planDigest:f.access.planDigest,lease}};
  }
  const changes=["grant revoked","grant expired","grant removed","issuer replaced","client replaced","subject replaced","workspace replaced","project scope narrowed","environment scope narrowed","write scope removed","nonempty app scope","null app metadata replaced","requester demoted","approver demoted","provider revoked","journal method replaced","runtime selector getter","client method replaced","configured issuer replaced","configured jwks replaced","authority target replaced","foreign linked collision introduced","benign product progress","unchanged grant"] as const;
  type Change=typeof changes[number];
  async function mutate(f:Fixture,change:Change,sql:Sql=observer):Promise<()=>void> {
    const id=f.principal.id,ws=f.op.workspaceId;
    if(change==="grant revoked")await sql.query("update agent.agent_oauth_grants set revoked=true where integration_id=$1",[id]);
    if(change==="grant expired")await sql.query("update agent.agent_oauth_grants set expires_at=$2 where integration_id=$1",[id,new Date(Date.now()-1000).toISOString()]);
    if(change==="grant removed")await sql.query("delete from agent.agent_oauth_grants where integration_id=$1",[id]);
    if(change==="issuer replaced")await sql.query("update agent.agent_oauth_grants set oauth_issuer='https://foreign.example.test' where integration_id=$1",[id]);
    if(change==="project scope narrowed")await sql.query("update agent.agent_oauth_grants set project_ids=$2::text::jsonb where integration_id=$1",[id,json([f.h.ids.projB])]);
    if(change==="environment scope narrowed")await sql.query("update agent.agent_oauth_grants set environment_ids='[]'::jsonb where integration_id=$1",[id]);
    if(change==="write scope removed")await sql.query("update agent.agent_oauth_grants set scopes='[\"read\",\"plan\"]'::jsonb where integration_id=$1",[id]);
    if(change==="nonempty app scope")await sql.query("update agent.agent_oauth_grants set app_ids='[\"app_owned\"]'::jsonb where integration_id=$1",[id]);
    if(change==="null app metadata replaced")await sql.query("update agent.agent_oauth_grants set app_ids=null where integration_id=$1",[id]);
    if(change==="client replaced"||change==="subject replaced"||change==="workspace replaced") {
      // The service role cannot change this immutable identity. This explicit
      // owning-admin fixture models an operator deleting/recreating a tuple;
      // it never disables the native guard or updates an immutable field.
      await sql.tx(async tx=>{
        const previous=(await tx.query<{tuple:Record<string,unknown>}>(`delete from agent.agent_oauth_grants where integration_id=$1 returning
          jsonb_build_object('integration_id',integration_id,'subject',subject,'client_id',client_id,'workspace_id',workspace_id,'oauth_issuer',oauth_issuer,
            'expires_at',expires_at,'revoked',revoked,'project_ids',project_ids,'environment_ids',environment_ids,'app_ids',app_ids,'scopes',scopes) as tuple`,[id]))[0].tuple;
        const replacement={...previous,...(change==="client replaced"?{client_id:"foreign-client"}:change==="subject replaced"?{subject:"foreign"}:{workspace_id:f.h.ids.wsB})};
        await tx.query(`insert into agent.agent_oauth_grants(integration_id,subject,client_id,workspace_id,oauth_issuer,expires_at,revoked,project_ids,environment_ids,app_ids,scopes)
          select integration_id,subject,client_id,workspace_id,oauth_issuer,expires_at,revoked,project_ids,environment_ids,app_ids,scopes
          from jsonb_to_record($1::text::jsonb) as g(integration_id text,subject text,client_id text,workspace_id text,oauth_issuer text,expires_at text,revoked boolean,
            project_ids jsonb,environment_ids jsonb,app_ids jsonb,scopes jsonb)`,[json(replacement)]);
      });
    }
    if(change==="requester demoted")await sql.query("update public.members set role='viewer' where workspace_id=$1 and id='alice'",[ws]);
    if(change==="approver demoted")await sql.query("update public.members set role='editor' where workspace_id=$1 and id='erin'",[ws]);
    if(change==="provider revoked")await connections.revoke(sql,ws,f.nativeId);
    if(change==="benign product progress"){
      await sql.query("update public.projects set name='Changed display',data=jsonb_set(data,'{workingManifest}','{}'::jsonb) where id=$1",[f.op.projectId]);
      await sql.query("update public.deployments set status='applying',data=data||'{\"progress\":75}'::jsonb where id=$1",[f.deploymentId]);
    }
    if(change==="foreign linked collision introduced")await sql.query(`insert into agent.agent_credentials(id,token_hash,subject,workspace_id,project_ids,scopes,client_name,issued_at,expires_at,created_by,revoked_at)
      values($1,$2,'foreign',$3,$4::text::jsonb,'["read"]'::jsonb,'explicit foreign collision',$5,$6,'foreign',$5)`,
      [id,digest(randomUUID()),f.h.ids.wsB,json([f.h.ids.projB]),new Date(Date.now()-1000).toISOString(),new Date(Date.now()+120000).toISOString()]);
    if(change==="configured issuer replaced"||change==="configured jwks replaced"||change==="authority target replaced"){
      const key=change==="authority target replaced"?"SUPABASE_DB_URL":change==="configured issuer replaced"?"ZENITH_AGENT_OAUTH_ISSUER":"ZENITH_AGENT_OAUTH_JWKS";
      const before=process.env[key]!;const foreign=new URL(before);if(change==="authority target replaced")foreign.username=`${foreign.username}.foreignRealm`;else foreign.hostname="foreign.example.test";
      vi.stubEnv(key,foreign.toString());return ()=>vi.stubEnv(key,before);
    }
    if(change==="journal method replaced"||change==="client method replaced"||change==="runtime selector getter"){
      let getters=0;const target=change==="runtime selector getter"?globalThis:change==="journal method replaced"?Object.getPrototypeOf(pgAgentJournal()):pgAuthorityClient();
      const key=change==="runtime selector getter"?"__zenithAgentJournal":change==="journal method replaced"?"grants":"unsafe";
      const before=Object.getOwnPropertyDescriptor(target,key)!;
      Object.defineProperty(target,key,change==="runtime selector getter"?{configurable:true,get:()=>{getters++;return pgAgentJournal();}}:{...before,value:async()=>[]});
      return ()=>{Object.defineProperty(target,key,before);expect(getters).toBe(0);};
    }
    return ()=>undefined;
  }
  it("genuine default OAuth grant admits exactly its original sealed bytes once",async()=>{
    const f=await fixture();const original=await artifacts.claim(db,f.access,"native-oauth-attempt");expect(original.manifest).toEqual(f.manifest);
    const bytes=Buffer.from(f.cipher.open(f.op.workspaceId,`zenith.tofu.plan-artifact.v1:${sha(stableJson(original.manifest))}`,
      {iv:original.iv,authTag:original.auth_tag,ciphertext:original.ciphertext}).value,"base64");
    expect(bytes.toString()).toBe(f.payload);expect(sha(bytes.toString())).toBe(f.manifest.rawSha256);
    await dispatch(f);await artifacts.finish(db,f.access,"native-oauth-attempt",true);
    await expect(artifacts.claim(peer,f.access,"fresh-replay")).rejects.toMatchObject({code:"plan_artifact_unavailable"});await unchanged(f);
  });
  it.each(changes)("final native OAuth dispatch fences %s committed during held approving-human read",async change=>{
    const f=await fixture();await artifacts.claim(db,f.access,"native-oauth-attempt");const held=heldApprover();let modeledProviderCalls=0;let restore:()=>void=()=>undefined;
    const pending=dispatch(f).then(()=>{modeledProviderCalls++;return undefined;},error=>error);
    try{await held.entered;restore=await mutate(f,change);await unchanged(f);}finally{held.release();}
    let error;try{error=await pending;}finally{restore();}
    const allowed=change==="unchanged grant"||change==="benign product progress";expect(modeledProviderCalls).toBe(allowed?1:0);
    if(allowed)expect(error).toBeUndefined();else expect(error).toBeDefined();
    const row=await db.query("select phase,attempt_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id]);
    expect(row).toEqual([{phase:allowed?"dispatched":"claimed",attempt_id:"native-oauth-attempt"}]);
    await artifacts.finish(db,f.access,"native-oauth-attempt",allowed);await unchanged(f);
  });
  const waited=["grant revoked","grant expired","project scope narrowed","environment scope narrowed","write scope removed","issuer replaced","client replaced","subject replaced","workspace replaced","null app metadata replaced","foreign linked collision introduced","configured issuer replaced","runtime selector getter","authority target replaced","unchanged grant"] as const;
  it.each(waited)("observed three-connection original use-row wait fences OAuth %s",async change=>{
    const f=await fixture();await artifacts.claim(db,f.access,"native-oauth-attempt");const holding=barrier(),release=barrier();let holderPid=0;let restore:()=>void=()=>undefined;
    const holder=observer.tx(async tx=>{holderPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;await tx.query("select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2 for update",[f.op.workspaceId,f.op.id]);holding.release();await release.promise;});
    await holding.promise;const waiterPid=(await peer.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;let modeledProviderCalls=0;
    const pending=dispatch(f).then(()=>{modeledProviderCalls++;return undefined;},error=>error);let observationError:unknown;
    try{const deadline=Date.now()+10000;let observed=false;
      while(Date.now()<deadline){const rows=await db.query<{wait_event_type:string;blockers:number[]}>("select wait_event_type,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1",[waiterPid]);if(rows[0]?.wait_event_type==="Lock"&&rows[0].blockers.includes(holderPid)){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}
      expect(observed).toBe(true);restore=await mutate(f,change,db);await unchanged(f,db);
    }catch(error){observationError=error;}finally{release.release();}
    await holder;let error;try{error=await pending;}finally{restore();}if(observationError)throw observationError;
    const allowed=change==="unchanged grant";expect(modeledProviderCalls).toBe(allowed?1:0);if(allowed)expect(error).toBeUndefined();else expect(error).toBeDefined();
    await artifacts.finish(db,f.access,"native-oauth-attempt",allowed);await unchanged(f);
  });
  it("OAuth plan-only viewer publication retains source-free Git destroy custody without provider writes",async()=>{
    const f=await fixture(true);expect(f.snapshots).toEqual([]);
    expect(await db.query("select phase,attempt_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"ready",attempt_id:null}]);
    const denied=await f.h.broker.propose({capability:"infrastructure.apply",scope:{workspaceId:f.op.workspaceId,projectId:f.op.projectId,environmentId:f.op.environmentId},input:{}},f.principal,{plan:f.plan});
    expect(denied.decision.outcome).toBe("deny");await unchanged(f);
  });
  it.each(["unchanged planning grant","revoked planning grant","plan scope removed","current admin demoted"] as const)("browser-approved exact OAuth delegated destroy fences %s after held admin read",async change=>{
    const f=await fixture(true),d=await destination(f);
    const saved=f.saved;if(!saved)throw new Error("Real native original destroy fixture is missing.");
    const callback=barrier();let held:ReturnType<typeof heldApprover>|undefined,modeledProviderCalls=0;
    const beforeState=await readFile(saved.statePath);
    const pending=consumeSavedNativePlan(db,saved,d.access,async()=>{held=heldApprover();callback.release();}).then(value=>{
      expect(value.originalSha).toBe(f.manifest.rawSha256);expect(value.result.apply.exitCode).toBe(0);modeledProviderCalls++;return undefined;
    },error=>error);
    await Promise.race([callback.promise,pending.then(()=>{throw new Error("The genuine held callback was not reached.");})]);if(!held)throw new Error("The genuine held grant callback was not reached.");
    expect(await observer.query("select generation from platform.cleanup_writer_holds where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,d.op.id])).toHaveLength(1);
    expect(await observer.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2 and capability='infrastructure.destroy'",[f.op.workspaceId,d.op.id])).toHaveLength(1);
    try{await held.entered;if(change==="revoked planning grant")await mutate(f,"grant revoked");
      if(change==="plan scope removed")await observer.query("update agent.agent_oauth_grants set scopes='[\"read\"]'::jsonb where integration_id=$1",[f.principal.id]);
      if(change==="current admin demoted")await mutate(f,"approver demoted");
    }finally{held.release();}const error=await pending,allowed=change==="unchanged planning grant";expect(modeledProviderCalls).toBe(allowed?1:0);
    if(allowed)expect(error).toBeUndefined();else {expect(error).toBeDefined();expect(await readFile(saved.statePath)).toEqual(beforeState);}await unchanged(f);
  },300000);
  it("uncertain OAuth dispatch retains its original attempt and refuses a fresh replay",async()=>{
    const f=await fixture();await artifacts.claim(db,f.access,"native-oauth-attempt");await dispatch(f);await artifacts.finish(db,f.access,"native-oauth-attempt",false);
    expect(await db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"uncertain"}]);
    await expect(dispatch(f)).rejects.toBeDefined();await expect(artifacts.claim(peer,f.access,"different-attempt")).rejects.toMatchObject({code:"plan_artifact_unavailable"});await unchanged(f);
  });
});
