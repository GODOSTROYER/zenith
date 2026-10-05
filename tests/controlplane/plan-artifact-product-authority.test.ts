/** Actual native SQL/custody. Current roles, hosted association, GitHub and provider counters are explicit models; sealed bytes are synthetic. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { z } from "zod/v4";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { platformDb, resetPlatformDbForTests, repos, json, assertPlatformSchemaCurrent, type PlatformDbHandle } from "@/lib/controlplane/db";
import { PLATFORM_SCHEMA_VERSION } from "@/lib/controlplane/db/migrations";
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { Manifest, ManifestPolicies } from "@/lib/domain/types";
import { buildDesiredState } from "@/lib/execution/graph";
import { planCustody, scopeOf } from "@/lib/execution/runtime";
import { executionHolder, createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { planArtifactCipherFromEnv } from "@/lib/platform/plan-artifacts";
import * as artifacts from "@/lib/controlplane/db/repos/plan-artifacts";
import * as connections from "@/lib/controlplane/db/repos/connections";
import { createApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { createOwningSourceBundles } from "@/lib/platform/source-bundle";
import { sourceRecipe, sourceSnapshotSetDigest, type ApprovedSourceSnapshot } from "@/lib/execution/source-snapshot";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { normalizePlan } from "@/lib/tofu/plan";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { stableJson } from "@/lib/tofu/stable";
import { TOFU_VERSION } from "@/lib/tofu/types";
import type { PlanArtifactManifest } from "@/lib/tofu/engine";
import { PG_URL, makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, allowDecision, user, sessionFor } from "../capabilities/support";
import { writeTar } from "../_support/tar";
import { api } from "../sources/fixtures";
import { platformBroker, resetPlatformBrokerForTests } from "@/lib/capabilities/platform";
import { generateSigningJwk, serializePrivateJwk } from "@/lib/credentials";
import { openNativePlanFixtureDatabase, type NativePlanFixtureDatabase, savedNativePlan, consumeSavedNativePlan, type SavedNativePlan } from "./_support/saved-native-plan";
import { readFile } from "node:fs/promises";

const nativeState=vi.hoisted(()=>({snapshot:{workspaces:[] as {id:string}[],projects:[] as {id:string;workspaceId:string}[],environments:[] as {id:string;projectId:string;connectionId:string;class:string;region:string}[],connections:[] as {id:string;provider:string}[]},
  member:async(_ws:string,_id:string):Promise<{id:string;workspace_id:string;role:string}|null>=>null,
  hold:undefined as undefined|{entered:()=>void;wait:Promise<void>}}));
vi.mock("@/lib/db/store",async original=>({...await original<typeof import("@/lib/db/store")>(),isPostgres:()=>true,db:()=>nativeState.snapshot,
  q:{connection:(id:string)=>nativeState.snapshot.connections.find(row=>row.id===id)}}));
vi.mock("@/lib/db/postgres-store",async original=>({...await original<typeof import("@/lib/db/postgres-store")>(),pgClient:()=>({from:(table:string)=>{
  if(table!=="members")throw new Error("Unexpected modeled product collection.");const filters=new Map<string,string>();
  const query={select:()=>query,eq:(key:string,value:string)=>{filters.set(key,value);return query;},abortSignal:()=>query,maybeSingle:async()=>{
    const id=filters.get("id")!,data=await nativeState.member(filters.get("workspace_id")!,id);
    if(id==="erin"&&nativeState.hold){nativeState.hold.entered();await nativeState.hold.wait;}return {data,error:null};}};return query;}})}));
vi.mock("@/lib/policy",async original=>({...await original<typeof import("@/lib/policy")>(),loadPolicyEngine:async()=>scriptedEngine("plan-product-policy",
  input=>input.request.mutates?requireApproval(1,"admin",true):allowDecision())}));
vi.mock("@/lib/execution/product-port", async original => ({ ...await original<typeof import("@/lib/execution/product-port")>(),
  workerStoreScope: async <T>(body: () => Promise<T>): Promise<T> => body() }));
vi.mock("@/lib/controlplane/db/repos/workflow-start-deploy-authority", async original => ({
  ...await original<typeof import("@/lib/controlplane/db/repos/workflow-start-deploy-authority")>(),
  assertDefaultMcpProductTopology:async(owner:Sql)=>{if((await owner.query("select current_user as role")).length!==1)throw new Error("Modeled owning association unavailable.");},
  // Hosted REST/SQL association is explicitly modeled. The owning transaction
  // and its native SQL identity remain real; MCP R3 owns private factory proof.
  assertFinalMcpProductTopology: async (_sql: Sql, tx: Sql) => {
    if (tx === _sql) throw new Error("Modeled hosted composition requires the owning transaction.");
    const rows = await tx.query<{ role: string }>("select current_user as role");
    if (rows.length !== 1 || !rows[0].role) throw new Error("Modeled hosted composition is unavailable.");
  },
}));
const required = process.env.ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED === "1";
if (required && (!PG_URL || PLATFORM_SCHEMA_VERSION < 13)) throw new Error("Plan product authority requires owned PostgreSQL and canonical schema13.");
closeSharedPgliteAfterAll();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const tables = ["workspaces", "members", "projects", "environments", "revisions", "revision_manifests", "deployments", "connections"] as const;

const NATIVE_PLAN_BASE_URL=PG_URL;
describe.skipIf(!PG_URL)("paired plan product dispatch authority [postgres; modeled current roles and hosted association]", () => {
  let db: PlatformDbHandle, peer: PlatformDbHandle, observer: PlatformDbHandle;
  let native:NativePlanFixtureDatabase|undefined, PG_URL=NATIVE_PLAN_BASE_URL!, nativeCaseFailed=false;
  const nativePlans:SavedNativePlan[]=[];
  const configure=()=>{vi.stubEnv("ZENITH_PLATFORM_DB","postgres");vi.stubEnv("ZENITH_PLATFORM_DB_URL",PG_URL!);vi.stubEnv("ZENITH_PLATFORM_DB_MAX","1");vi.stubEnv("SUPABASE_DB_URL",PG_URL!);vi.stubEnv("ZENITH_STORE","postgres");vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY","");};
  beforeAll(async () => {
    native=await openNativePlanFixtureDatabase(PG_URL);PG_URL=native.url;
    configure();await resetPlatformDbForTests();db=await native.remember(await platformDb());
    peer = await native.open();
    observer = await native.open();
    await assertPlatformSchemaCurrent(db);
    nativeState.member=async(ws,id)=>(await observer.query<{id:string;workspace_id:string;role:string}>("select id,workspace_id,role from public.members where workspace_id=$1 and id=$2",[ws,id]))[0]??null;
    const migration = readFileSync(new URL("../../supabase/migrations/0001_system_of_record.sql", import.meta.url), "utf8");
    for (const name of tables) {
      const ddl = new RegExp(`create table if not exists public\\.${name} \\([\\s\\S]*?\\n\\);`).exec(migration)?.[0];
      if (!ddl) throw new Error("Canonical product collection DDL is unavailable.");
      await db.exec(ddl);
    }
  }, 60_000);
  beforeEach(async()=>{onTestFailed(()=>{nativeCaseFailed=true;});configure();resetPlatformBrokerForTests();const signing=await generateSigningJwk("EdDSA");vi.stubEnv("ZENITH_CONTROL_SIGNING_JWK",serializePrivateJwk(signing));});
  afterEach(async()=>{nativeState.hold=undefined;resetPlatformBrokerForTests();vi.restoreAllMocks();vi.unstubAllEnvs();});
  afterAll(async () => {
    const ended=await Promise.allSettled([resetPlatformDbForTests()]);
    const removed=await Promise.allSettled([native?.close()]);
    if(nativeCaseFailed||[...ended,...removed].some(result=>result.status==="rejected"))throw new Error("Native plan fixture teardown is unconfirmed; retaining backend roots.");
    const roots=await Promise.allSettled(nativePlans.splice(0).map(saved=>saved.close()));
    if(roots.some(result=>result.status==="rejected"))throw new Error("Native plan fixture backend root removal is unconfirmed.");
  },60_000);

  async function fixture(git = false, destroy = false) {
    const h = await makeHarness({ kind: "postgres", nativeDb: db, engine: scriptedEngine("plan-product-policy", input => input.request.mutates ? requireApproval(1, "admin", true) : allowDecision()) });
    h.deps.clock = { now: () => new Date() };
    const workspaceId = h.ids.wsA, projectId = h.ids.projA, environmentId = h.ids.envAProd;
    const revisionId = `rev_${randomUUID()}`, deploymentId = `dep_${randomUUID()}`, connectionId = `public_${randomUUID()}`, nativeId = `conn_${randomUUID()}`;
    const manifest = Manifest.parse({ version: 1, services: [{ id: "web", name: "web", kind: "web", port: 3000,
      source: git ? { type: "git", repo: "acme/app", ref: "main", dockerfile: "Dockerfile" } : { type: "image", image: "example/web:v1" } }], resources: [], routes: [], bindings: [] });
    const policies = ManifestPolicies.parse({ approvalRequired: true, allowStatefulDeletion: false });
    const environment = { id: environmentId, name: "production", class: "production" as const, provider: "aws" as const,
      region: "us-east-1", baseDomain: "owning.example.test", connectionId, policies, deployedRevisionId: revisionId };
    const product = { workspace: { id: workspaceId, name: "Owning", slug: "owning" }, project: { id: projectId, name: "Owning", slug: "owning" },
      environment, revision: { id: revisionId, number: 1, manifest }, deploymentId };
    const desired = buildDesiredState(product);
    if (!desired.graph) throw new Error("Canonical worker graph fixture is unavailable.");
    let graph = desired.graph;
    const retained = destroy ? { ...graph.nodes.find(node => node.kind === "container_service")!, address: "container_service/oldWeb" } : undefined;
    if (retained) {
      await repos.resources.upsertDesired(db, { workspaceId, projectId, environmentId, node: retained, status: "active" });
      const nodes = [...graph.nodes, retained].sort((a,b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
      graph = { ...graph, nodes, graphDigest: digest({ graphDigest: graph.graphDigest, nodes }) };
    }
    await connections.create(db, { id: nativeId, workspaceId, createdBy: "alice", config: { provider: "aws", mode: "aws_assume_role", accountId: "123456789012",
      region: environment.region, externalId: "modeled-product-authority", observeRoleArn: "arn:aws:iam::123456789012:role/zenith_observe_fixture",
      deployRoleArn: "arn:aws:iam::123456789012:role/zenith_deploy_fixture" } });
    await connections.recordVerification(db, { workspaceId, id: nativeId, ok: true });
    await db.query("insert into public.workspaces(id,workspace_id,slug,name,data) values($1,$1,$2,'Owning','{}'::jsonb)", [workspaceId, `owning-${randomUUID()}`]);
    await db.query("insert into public.members(id,workspace_id,email,role,data) values('alice',$1,'alice@example.test','admin','{}'::jsonb),('erin',$1,'erin@example.test','admin','{}'::jsonb)", [workspaceId]);
    await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,'owning','Owning',$3::text::jsonb)", [projectId, workspaceId, json({ workingManifest: manifest })]);
    await db.query("insert into public.workspaces(id,workspace_id,slug,name,data) values($1,$1,$2,'Foreign','{}'::jsonb)", [h.ids.wsB, `foreign-${randomUUID()}`]);
    await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,'foreign','Foreign','{}'::jsonb)", [h.ids.projB, h.ids.wsB]);
    await db.query("insert into public.environments(id,workspace_id,project_id,class,connection_id,data,deployed_revision_id,created_at) values($1,$2,$3,'production',$4,$5::text::jsonb,$6,clock_timestamp())",
      [environmentId, workspaceId, projectId, connectionId, json({ name: environment.name, region: environment.region, baseDomain: environment.baseDomain, policies }), revisionId]);
    await db.query("insert into public.connections(id,workspace_id,provider,status,data) values($1,$2,'aws','healthy',$3::text::jsonb)", [connectionId, workspaceId, json({ region: environment.region, platformConnectionId: nativeId })]);
    await db.query("insert into public.revisions(id,workspace_id,project_id,number,data) values($1,$2,$3,1,$4::text::jsonb)", [revisionId, workspaceId, projectId, json({ message: "approved original" })]);
    await db.query("insert into public.revision_manifests(revision_id,workspace_id,manifest) values($1,$2,$3::text::jsonb)", [revisionId, workspaceId, json(manifest)]);
    if(destroy) {
      nativeState.snapshot={workspaces:[{id:workspaceId}],projects:[{id:projectId,workspaceId}],environments:[{...environment,projectId}],connections:[{id:connectionId,provider:"aws"}]};
      h.broker=await platformBroker();
    }
    const proposed = (await h.broker.propose({ capability: destroy ? "infrastructure.plan" : "deployment.deploy", scope: { workspaceId, projectId, environmentId },
      input: { revisionId, deploymentId, ...(destroy ? { environmentId, teardownReview: true } : {}) } }, user("alice"))).operation;
    const op = await repos.operations.get(db, workspaceId, proposed.id);
    if (!op) throw new Error("Native original operation is unavailable.");
    await db.query("insert into public.deployments(id,workspace_id,project_id,environment_id,revision_id,status,data) values($1,$2,$3,$4,$5,'planning',$6::text::jsonb)",
      [deploymentId, workspaceId, projectId, environmentId, revisionId, json({ executor: "workflow", operationId: op.id })]);
    if (!destroy) await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") });
    const lease = await repos.leases.acquire(db, { workspaceId, scope: `env:${environmentId}`, holder: `worker:${op.id}`, ttlMs: 120_000 });
    if (!lease) throw new Error("Native original lease is unavailable.");
    await h.broker.beginExecution({ workspaceId, operationId: op.id, holder: executionHolder(op.id), audience: "worker", lease, leaseMs: 120_000 });
    const snapshots: ApprovedSourceSnapshot[] = [];
    if (git && !destroy) {
      const service = graph.nodes.find(node => node.address === "container_service/web"), pipeline = graph.nodes.find(node => node.address === "build_pipeline/web");
      if (!service || !pipeline) throw new Error("Canonical source recipe is unavailable.");
      for (const node of [service, pipeline]) await repos.resources.upsertDesired(db, { workspaceId, projectId, environmentId, node, status: "active" });
      const fallback = api();
      const fetchImpl: typeof fetch = async (raw, init) => {
        const url = String(raw);
        if (url === "https://api.github.com/repos/acme/app") return Response.json({ id: 99, name: "app", owner: { login: "acme" }, private: false });
        if (url.startsWith("https://api.github.com/repos/acme/app/commits/")) return new Response("a".repeat(40));
        if (url.startsWith("https://codeload.github.com/acme/app/tar.gz/")) return new Response(new Uint8Array(gzipSync(writeTar([{ path: "root/Dockerfile", bytes: Buffer.from("FROM scratch\n") }]))));
        return fallback(raw, init);
      };
      const store = createApprovedSourceSnapshotStore(db), bundles = createOwningSourceBundles(db, { sourceSnapshots: store, fetchImpl });
      const source = await bundles.port.capture({ workspaceId, operationId: op.id, projectId, environmentId,
        serviceAddress: service.address, serviceSpecDigest: service.specDigest, pipelineAddress: pipeline.address, pipelineSpecDigest: pipeline.specDigest,
        provider: "aws", region: environment.region, repository: "acme/app", requestedRef: "main", dockerfile: "Dockerfile", recipeDigest: sourceRecipe(service, pipeline), archiveFormat: "zip" });
      await store.retain(source, lease); snapshots.push(source);
    }
    const sourceDigest = snapshots.length ? sourceSnapshotSetDigest(snapshots) : undefined;
    const native = await connections.get(db, workspaceId, nativeId);
    if (!native) throw new Error("Native original provider is unavailable.");
    const custody = planCustody({ op, workspaceId, environmentId, scope: scopeOf(op), product, deploymentId, ...(sourceDigest ? { executableSourceDigest: sourceDigest } : {}) }, graph.graphDigest, native);
    if(destroy) {
      const key=randomBytes(32).toString("hex"),saved=await savedNativePlan(db,{custody,lease,graph,key,destroy:true});nativePlans.push(saved);
      return {h,op,worker:createExecutionBroker(db),retained,manifest:saved.row.manifest,graph,snapshots,lease,revisionId,deploymentId,connectionId,nativeId,
        access:{custody,planDigest:saved.plan.planDigest,lease},payload:"",saved};
    }
    const plan = normalizePlan({ format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: [], output_changes: {} },
      { configDigest: digest("synthetic original config"), lockDigest: digest("synthetic original lock"), addressMap: {}, ...(sourceDigest ? { executableSourceDigest: sourceDigest } : {}) });
    const facts = extractPlanFacts(plan), summary = { ...planEvidence({ plan, facts, cost: {}, graphDigest: graph.graphDigest, stage: "plan", ...(snapshots.length ? { approvedSources: snapshots } : {}) }).summary,
      ...(destroy ? { destroy: true, destroyAddresses: [], statefulDeletes: [] } : {}) };
    const worker = createExecutionBroker(db, async () => h.broker), ports = createOperationsPort(db);
    await repos.evidence.insert(db, { workspaceId, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false });
    await ports.setPlanDigest({ workspaceId, operationId: op.id, planDigest: plan.planDigest });
    const decision = await worker.reevaluate(op.id, facts); await ports.setPolicyDecision({ workspaceId, operationId: op.id, decisionId: decision.decisionId });
    if (!destroy) {
    await ports.transition({ workspaceId, operationId: op.id, to: "awaiting_approval" });
    await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: plan.planDigest, approver: user("erin"), session: sessionFor("erin") });
    await repos.operations.claimForExecution(db, { workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: executionHolder(op.id), leaseMs: 120_000, lease, expectedPolicyVersion: "plan-product-policy" });
    }
    const payload = "synthetic original target-bound SQL payload", key = randomBytes(32).toString("hex"), cipher = planArtifactCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: key });
    const manifestArtifact: PlanArtifactManifest = { ...custody, format: "zenith.plan-artifact.v1", purpose: destroy ? "destroy" : "deploy", planDigest: plan.planDigest,
      configDigest: plan.configDigest, lockDigest: plan.lockDigest, backendDigest: digest("synthetic backend"), addressMapDigest: digest("synthetic address map"),
      rawSha256: sha(payload), bytes: Buffer.byteLength(payload), executable: { version: "fixture", platform: "fixture", sha256: digest("fixture binary"), archiveSha256: null } };
    const sealed = cipher.seal(workspaceId, `zenith.tofu.plan-artifact.v1:${sha(stableJson(manifestArtifact))}`, Buffer.from(payload).toString("base64"));
    await artifacts.publish(db, { manifest: manifestArtifact, sealed, lease, evidence: { workspaceId, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false } });
    return { h, op, worker, retained, manifest: manifestArtifact, graph, snapshots, lease, revisionId, deploymentId, connectionId, nativeId,
      access: { custody, planDigest: plan.planDigest, lease }, payload, saved:undefined };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function delayRole(f: Fixture) {
    if(f.saved) {
      const entered=barrier(),release=barrier();nativeState.hold={entered:entered.release,wait:release.promise};
      return {entered:entered.promise,release:()=>{nativeState.hold=undefined;release.release();}};
    }
    const entered = barrier(), release = barrier(), roles = f.h.deps.roles;
    f.h.deps.roles = { resolve: async (principal, workspaceId) => {
      if (principal.kind === "user" && principal.id === "erin") { entered.release(); await release.promise; }
      return roles.resolve(principal, workspaceId);
    } };
    return { entered: entered.promise, release: release.release };
  }
  async function dispatch(f: Fixture, sql: Sql = peer, attempt = "product-attempt") {
    const authority = await createExecutionBroker(sql, async () => f.h.broker).approvalStatus(f.op.id);
    expect(authority.approved).toBe(true); expect(authority.rejected).toBe(false); expect(authority.dispatchApproval).toBeDefined();
    await artifacts.dispatch(sql, f.access, attempt, authority.dispatchApproval);
  }
  const changes = ["environment region", "environment policies", "environment base domain", "replaced public connection", "removed public connection", "public connection mapping", "public connection region",
    "deleted environment", "foreign environment workspace", "foreign environment project", "deleted project", "foreign project workspace",
    "deleted approved revision", "foreign approved revision workspace", "full approved manifest JSON", "deleted deployment", "foreign deployment scope",
    "native provider config", "native provider revocation", "subject demotion", "subject removal", "foreign subject workspace", "approver demotion", "approver removal", "foreign approver workspace", "workspace policy replacement", "environment settings introduction", "foreign environment settings introduction", "plan evidence mutation", "benign UI pointers", "unchanged target"] as const;
  type Change = typeof changes[number];
  async function mutate(f: Fixture, change: Change, sql: Sql = observer) {
    const ws = f.op.workspaceId, env = f.op.environmentId!, project = f.op.projectId!;
    switch (change) {
      case "environment region": await sql.query("update public.environments set data=jsonb_set(data,'{region}',to_jsonb('eu-west-1'::text)) where id=$1", [env]); break;
      case "environment policies": await sql.query("update public.environments set data=jsonb_set(data,'{policies}', '{\"approvalRequired\":false,\"allowStatefulDeletion\":true}'::jsonb) where id=$1", [env]); break;
      case "environment base domain": await sql.query("update public.environments set data=jsonb_set(data,'{baseDomain}',to_jsonb('other.example.test'::text)) where id=$1", [env]); break;
      case "replaced public connection": await sql.query("update public.environments set connection_id=$2 where id=$1", [env, `foreign_${randomUUID()}`]); break;
      case "removed public connection": await sql.query("update public.environments set connection_id=null where id=$1", [env]); break;
      case "public connection mapping": await sql.query("update public.connections set data=jsonb_set(data,'{platformConnectionId}',to_jsonb('foreign-native'::text)) where id=$1", [f.connectionId]); break;
      case "public connection region": await sql.query("update public.connections set data=jsonb_set(data,'{region}',to_jsonb('eu-west-1'::text)) where id=$1", [f.connectionId]); break;
      case "deleted environment": await sql.query("delete from public.environments where id=$1", [env]); break;
      case "foreign environment workspace": await sql.query("update public.environments set workspace_id=$2 where id=$1", [env, f.h.ids.wsB]); break;
      case "foreign environment project": await sql.query("update public.environments set project_id=$2 where id=$1", [env, f.h.ids.projB]); break;
      case "deleted project": await sql.query("delete from public.projects where id=$1", [project]); break;
      case "foreign project workspace": await sql.query("update public.projects set workspace_id=$2 where id=$1", [project, f.h.ids.wsB]); break;
      case "deleted approved revision": await sql.query("delete from public.revisions where id=$1", [f.revisionId]); break;
      case "foreign approved revision workspace": await sql.query("update public.revisions set workspace_id=$2 where id=$1", [f.revisionId, f.h.ids.wsB]); break;
      case "full approved manifest JSON": await sql.query("update public.revision_manifests set manifest=jsonb_set(manifest,'{services,0,source,image}',to_jsonb('example/web:v2'::text)) where revision_id=$1", [f.revisionId]); break;
      case "deleted deployment": await sql.query("delete from public.deployments where id=$1", [f.deploymentId]); break;
      case "foreign deployment scope": await sql.query("update public.deployments set workspace_id=$2 where id=$1", [f.deploymentId, f.h.ids.wsB]); break;
      case "native provider config": await sql.query("update platform.provider_connections set config=jsonb_set(config,'{region}',to_jsonb('eu-west-1'::text)) where workspace_id=$1 and id=$2", [ws, f.nativeId]); break;
      case "native provider revocation": await connections.revoke(sql, ws, f.nativeId); break;
      case "subject demotion": await sql.query("update public.members set role='viewer' where workspace_id=$1 and id='alice'", [ws]); break;
      case "subject removal": await sql.query("delete from public.members where workspace_id=$1 and id='alice'", [ws]); break;
      case "foreign subject workspace": await sql.query("update public.members set workspace_id=$2 where workspace_id=$1 and id='alice'", [ws, f.h.ids.wsB]); break;
      case "approver demotion": await sql.query("update public.members set role='editor' where workspace_id=$1 and id='erin'", [ws]); break;
      case "approver removal": await sql.query("delete from public.members where workspace_id=$1 and id='erin'", [ws]); break;
      case "foreign approver workspace": await sql.query("update public.members set workspace_id=$2 where workspace_id=$1 and id='erin'", [ws, f.h.ids.wsB]); break;
      case "workspace policy replacement": await sql.query("insert into platform.workspace_policy(workspace_id,params,version,updated_by) values($1,'{\"changed\":true}'::jsonb,1,'fixture')", [ws]); break;
      case "environment settings introduction": await repos.settings.putEnvironmentSettings(sql, { workspaceId: ws, environmentId: env, autonomyLevel: 2, updatedBy: "fixture" }); break;
      case "foreign environment settings introduction": await repos.settings.putEnvironmentSettings(sql, { workspaceId: f.h.ids.wsB, environmentId: env, autonomyLevel: 2, updatedBy: "fixture" }); break;
      case "plan evidence mutation": await sql.query("update platform.evidence set summary=summary || '{\"unreviewed\":true}'::jsonb where workspace_id=$1 and operation_id=$2 and kind='tofu_plan' and summary->>'stage'='plan'", [ws, f.op.id]); break;
      case "benign UI pointers":
        await sql.query("update public.projects set name='New display',data=jsonb_set(data,'{workingManifest}', '{}'::jsonb),version=version+1 where id=$1", [project]);
        await sql.query("update public.environments set deployed_revision_id=$2,active_deployment_id='new-ui-pointer',version=version+1 where id=$1", [env, `later_${randomUUID()}`]);
        await sql.query("update public.revisions set data=data || '{\"message\":\"New history label\"}'::jsonb,version=version+1 where id=$1", [f.revisionId]);
        await sql.query("update public.deployments set status='applying',data=data || '{\"steps\":[],\"progress\":42}'::jsonb,version=version+1 where id=$1", [f.deploymentId]);
        await sql.query("update public.members set email='new@example.test',data='{\"displayName\":\"New label\"}'::jsonb,version=version+1 where workspace_id=$1 and id in ('alice','erin')", [ws]); break;
      case "unchanged target": break;
    }
  }
  async function immutable(f: Fixture) {
    const row = (await observer.query<{ manifest_digest: string; manifest: PlanArtifactManifest }>("select manifest_digest,manifest from platform.plan_artifacts where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id]))[0];
    expect(row.manifest_digest).toBe(digest(f.manifest)); expect(row.manifest).toEqual(f.manifest);
    const op = (await repos.operations.get(observer, f.op.workspaceId, f.op.id))!;
    expect(op.inputDigest).toBe(f.op.inputDigest); expect(op.proposalDigest).toBe(f.op.proposalDigest); expect(op.planDigest).toBe(f.access.planDigest);
  }
  it.each(changes)("final original-plan product dispatch fences %s committed during held current role lookup", async change => {
    const f = await fixture(); await artifacts.claim(db, f.access, "product-attempt"); await immutable(f);
    const wait = delayRole(f); let modeledProviderCalls = 0;
    const result = dispatch(f).then(() => { modeledProviderCalls++; return undefined; }, error => error);
    try { await wait.entered; await mutate(f, change); await immutable(f); } finally { wait.release(); }
    const error = await result, permitted = ["unchanged target", "benign UI pointers"].includes(change);
    expect(modeledProviderCalls).toBe(permitted ? 1 : 0);
    if (permitted) {
      expect(error).toBeUndefined(); await artifacts.finish(peer, f.access, "product-attempt", true);
      await expect(artifacts.claim(db, f.access, "second-attempt")).rejects.toMatchObject({ code: "plan_artifact_unavailable" });
    } else {
      expect(error).toMatchObject({ code: "plan_artifact_unavailable" });
      expect(await db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "claimed" }]);
      await artifacts.finish(peer, f.access, "product-attempt", false);
      expect(await db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "ready" }]);
      // No write was dispatched. Custody may be claimed again, but each new
      // dispatch still needs the genuinely current product and human authority.
      const retry = await artifacts.claim(db, f.access, "fresh-product-attempt").then(row => ({ row, error: undefined }), error => ({ row: undefined, error }));
      if (retry.row) {
        expect(retry.row.manifest).toEqual(f.manifest);
        const freshlyPermitted = ["environment settings introduction", "plan evidence mutation"].includes(change);
        // The old held snapshot refused before any write. These two edits
        // preserve the normalized approved effects and still require a fresh
        // current policy, settings, evidence and consumed-human approval read.
        const current = dispatch(f, peer, "fresh-product-attempt").then(() => { modeledProviderCalls++; });
        if (freshlyPermitted) {
          await expect(current).resolves.toBeUndefined();
          await artifacts.finish(peer, f.access, "fresh-product-attempt", true);
          await expect(artifacts.claim(db, f.access, "replayed-product-attempt")).rejects.toMatchObject({ code: "plan_artifact_unavailable" });
        } else {
          await expect(current).rejects.toBeDefined();
          expect(await db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "claimed" }]);
          await artifacts.finish(peer, f.access, "fresh-product-attempt", false);
        }
      } else expect(retry.error).toMatchObject({ code: "plan_artifact_unavailable" });
      expect(modeledProviderCalls).toBe(["environment settings introduction", "plan evidence mutation"].includes(change) ? 1 : 0);
    }
    await immutable(f);
  });
  it.each(["environment region", "subject demotion", "approver demotion", "native provider revocation"] as const)("observed three-connection original use-row wait refuses committed %s before provider dispatch", async change => {
    const f = await fixture(); await artifacts.claim(db, f.access, "product-attempt");
    const holding = barrier(), release = barrier(); let holderPid = 0;
    const lock = observer.tx(async tx => {
      holderPid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
      await tx.query("select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2 for update", [f.op.workspaceId, f.op.id]); holding.release(); await release.promise;
    });
    await holding.promise; const waiterPid = (await peer.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
    let modeledProviderCalls = 0; const pending = dispatch(f).then(() => { modeledProviderCalls++; return undefined; }, error => error);
    try {
      const deadline = Date.now() + 10_000; let observed = false;
      while (Date.now() < deadline) {
        const rows = await db.query<{ wait_event_type: string; blockers: number[] }>("select wait_event_type,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1", [waiterPid]);
        if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(holderPid)) { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(observed).toBe(true); await mutate(f, change, db);
    } finally { release.release(); await lock; }
    expect(await pending).toMatchObject({ code: "plan_artifact_unavailable" }); expect(modeledProviderCalls).toBe(0);
    expect(await db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "claimed" }]);
    await artifacts.finish(db, f.access, "product-attempt", false);
  });
  it.each(["service", "pipeline"] as const)("current native full %s recipe mutation with unchanged spec digest refuses original product dispatch", async kind => {
    const f = await fixture(true); await artifacts.claim(db, f.access, "product-attempt"); const wait = delayRole(f);
    const pending = dispatch(f).then(() => undefined, error => error);
    try {
      await wait.entered; const address = kind === "service" ? "container_service/web" : "build_pipeline/web";
      await observer.query("update platform.resources set spec=spec || '{\"unreviewed\":true}'::jsonb where workspace_id=$1 and environment_id=$2 and address=$3", [f.op.workspaceId, f.op.environmentId, address]);
      expect(await createApprovedSourceSnapshotStore(observer).list({ workspaceId: f.op.workspaceId, operationId: f.op.id, projectId: f.op.projectId!, environmentId: f.op.environmentId! })).toEqual(f.snapshots);
    } finally { wait.release(); }
    expect(await pending).toMatchObject({ code: "plan_artifact_unavailable" }); await artifacts.finish(db, f.access, "product-attempt", false);
  });
  it("observed three-connection ready use-row wait refuses changed product target before original claim", async () => {
    const f = await fixture(), holding = barrier(), release = barrier(); let holderPid = 0;
    const lock = observer.tx(async tx => {
      holderPid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
      await tx.query("select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2 and phase='ready' for update", [f.op.workspaceId, f.op.id]);
      holding.release(); await release.promise;
    });
    await holding.promise; const waiterPid = (await peer.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
    const pending = artifacts.claim(peer, f.access, "product-attempt").then(() => undefined, error => error);
    try {
      let observed = false; const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const rows = await db.query<{ wait_event_type: string; blockers: number[] }>("select wait_event_type,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1", [waiterPid]);
        if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(holderPid)) { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(observed).toBe(true); await mutate(f, "environment region", db);
    } finally { release.release(); await lock; }
    expect(await pending).toMatchObject({ code: "plan_artifact_unavailable" });
    expect(await db.query("select phase,attempt_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "ready", attempt_id: null }]);
    expect(await db.query("select id from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='observation' and summary->>'phase'='claimed'", [f.op.workspaceId, f.op.id])).toHaveLength(0);
    await immutable(f);
  });
  it.each(["missing", "malformed", "foreign attempt"] as const)("exact native claimed witness %s refuses original product dispatch", async fault => {
    const f = await fixture(); await artifacts.claim(db, f.access, "product-attempt");
    if (fault === "missing") await observer.query("delete from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='observation' and summary->>'phase'='claimed'", [f.op.workspaceId, f.op.id]);
    else await observer.query("update platform.evidence set summary=jsonb_set(summary,'{attemptId}',to_jsonb($3::text)) where workspace_id=$1 and operation_id=$2 and kind='observation' and summary->>'phase'='claimed'", [f.op.workspaceId, f.op.id, fault === "malformed" ? "" : "foreign-attempt"]);
    await expect(dispatch(f)).rejects.toMatchObject({ code: "plan_artifact_unavailable" });
    expect(await db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "claimed" }]);
    await artifacts.finish(db, f.access, "product-attempt", false);
  });
  it("published product origin refuses combined public owning-row removal before first claim", async () => {
    const f = await fixture();
    const witness = await observer.query<{ summary: Record<string, unknown> }>("select summary from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='observation' and summary->>'phase'='published'", [f.op.workspaceId, f.op.id]);
    expect(witness).toHaveLength(1); expect(witness[0].summary).toMatchObject({ kind: "product", sourceDigest: f.manifest.sourceDigest });
    expect(Object.hasOwn(witness[0].summary, "provider")).toBe(false); expect(Object.hasOwn(witness[0].summary, "config")).toBe(false);
    await observer.tx(async tx => {
      for (const table of ["workspaces", "members", "projects", "environments", "revisions", "revision_manifests", "deployments", "connections"] as const)
        await tx.query(`delete from public.${table} where workspace_id=$1`, [f.op.workspaceId]);
    });
    await expect(artifacts.claim(peer, f.access, "product-attempt")).rejects.toMatchObject({ code: "plan_artifact_unavailable" });
    expect(await db.query("select phase,attempt_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "ready", attempt_id: null }]);
    await immutable(f);
  });
  it.each(["destination subject demotion", "original subject demotion", "approver demotion", "retained historical recipe mutation", "retained historical deletion", "retained historical foreign scope", "changed deployed destroy pointer", "unchanged destination"] as const)("associated product destroy keeps original revision and rechecks %s after held roles", async change => {
    const f = await fixture(true, true), ws = f.op.workspaceId;
    expect(f.snapshots).toEqual([]); expect(f.retained).toBeDefined();
    f.h.world.members.set(`${ws}|bob`, "editor");
    await observer.query("insert into public.members(id,workspace_id,email,role,data) values('bob',$1,'bob@example.test','editor','{}'::jsonb)", [ws]);
    const proposed = await f.h.broker.propose({ capability: "infrastructure.destroy", scope: { workspaceId: ws, projectId: f.op.projectId, environmentId: f.op.environmentId }, input: { environmentId: f.op.environmentId } },
      user("bob"), { via: "workflow", teardownReview: true, destroyPlan: { operationId: f.op.id, planDigest: f.access.planDigest } });
    const destination = await repos.operations.get(db, ws, proposed.operation.id);
    if (!destination) throw new Error("Native destination operation is unavailable.");
    const sourceRef = z.object({ broker: z.object({ destroyPlan: z.object({ operationId: z.string(), evidenceId: z.string() }) }) }).parse(destination.proposal).broker.destroyPlan;
    expect(sourceRef.operationId).toBe(f.op.id);
    const sourceEvidence = await repos.evidence.get(db, ws, sourceRef.evidenceId);
    if (!sourceEvidence) throw new Error("Native associated source evidence is unavailable.");
    await repos.evidence.insert(db, { workspaceId: ws, operationId: destination.id, kind: "tofu_plan", digest: f.access.planDigest, summary: sourceEvidence.summary, simulated: false });
    await artifacts.associate(db, { workspaceId: ws, sourceOperationId: f.op.id, destinationOperationId: destination.id, sourceEvidenceId: sourceRef.evidenceId, planDigest: f.access.planDigest, lease: f.lease });
    await repos.operations.transition(db, { workspaceId: ws, id: f.op.id, from: ["running"], to: "succeeded", fence: f.lease, patch: { result: { operationId: destination.id, planDigest: f.access.planDigest } } });
    await repos.leases.release(db, f.lease);
    await f.h.broker.approve({ workspaceId: ws, operationId: destination.id, proposalDigest: destination.proposalDigest, planDigest: f.access.planDigest, approver: user("erin"), session: sessionFor("erin") });
    await repos.operations.claimForExecution(db, { workspaceId: ws, id: destination.id, expectedDigest: destination.proposalDigest, holder: executionHolder(destination.id), leaseMs: 120_000 });
    const lease = await repos.operations.acquireExecutionLease(db, { workspaceId: ws, scope: f.lease.scope, holder: `worker:destination:${destination.id}`, ttlMs: 120_000, operation: { id: destination.id, proposalDigest: destination.proposalDigest } });
    if (!lease) throw new Error("Native destination lease is unavailable.");
    const access = { custody: { ...f.access.custody, operationId: destination.id, proposalDigest: destination.proposalDigest, inputDigest: destination.inputDigest, expiresAt: destination.expiresAt }, planDigest: f.access.planDigest, lease };
    const saved=f.saved;if(!saved)throw new Error("Real associated native plan is missing.");
    const callback=barrier();let wait:ReturnType<typeof delayRole>|undefined,modeledProviderCalls=0;
    const beforeState=await readFile(saved.statePath);
    const pending=consumeSavedNativePlan(db,saved,access,async()=>{wait=delayRole(f);callback.release();}).then(value=>{
      expect(value.originalSha).toBe(f.manifest.rawSha256);expect(value.result.apply.exitCode).toBe(0);modeledProviderCalls++;return undefined;
    },error=>error);
    await Promise.race([callback.promise,pending.then(()=>{throw new Error("The genuine held callback was not reached.");})]);
    if(!wait)throw new Error("The actual held current role boundary is missing.");
    expect(await observer.query("select generation from platform.cleanup_writer_holds where workspace_id=$1 and operation_id=$2",[ws,destination.id])).toHaveLength(1);
    try {
      await wait.entered;
      if (change === "destination subject demotion" || change === "original subject demotion") await observer.query("update public.members set role='viewer' where workspace_id=$1 and id=$2", [ws, change === "destination subject demotion" ? "bob" : "alice"]);
      if (change === "approver demotion") await observer.query("update public.members set role='editor' where workspace_id=$1 and id='erin'", [ws]);
      if (change === "changed deployed destroy pointer") await observer.query("update public.environments set deployed_revision_id=$2 where workspace_id=$1 and id=$3", [ws, `later_${randomUUID()}`, f.op.environmentId]);
      if (change === "retained historical recipe mutation") await observer.query("update platform.resources set spec=spec || '{\"unreviewed\":true}'::jsonb where workspace_id=$1 and environment_id=$2 and address=$3", [ws, f.op.environmentId, f.retained!.address]);
      if (change === "retained historical deletion") await observer.query("delete from platform.resources where workspace_id=$1 and environment_id=$2 and address=$3", [ws, f.op.environmentId, f.retained!.address]);
      if (change === "retained historical foreign scope") await observer.query("update platform.resources set project_id=$4 where workspace_id=$1 and environment_id=$2 and address=$3", [ws, f.op.environmentId, f.retained!.address, f.h.ids.projB]);
    } finally { wait.release(); }
    const result = await pending;
    if (!["unchanged destination", "original subject demotion"].includes(change)) { expect(result).toBeInstanceOf(Error); expect(modeledProviderCalls).toBe(0);expect(await readFile(saved.statePath)).toEqual(beforeState); }
    else { expect(result).toBeUndefined(); expect(modeledProviderCalls).toBe(1); }
    expect(await db.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2", [ws, destination.id])).toHaveLength(0);
    await immutable(f);
  });
  it("lost native claimed commit response retains the attempt and a second claim cannot replay", async () => {
    const f = await fixture(); const lost: Sql = { ...db, tx: async body => { await db.tx(body); throw new Error("Modeled lost native commit response."); } };
    await expect(artifacts.claim(lost, f.access, "product-attempt")).rejects.toThrow("lost native commit response");
    expect(await db.query("select phase,attempt_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "claimed", attempt_id: "product-attempt" }]);
    await expect(artifacts.claim(peer, f.access, "second-attempt")).rejects.toMatchObject({ code: "plan_artifact_unavailable" });
  });
  it("lost native dispatched commit response and uncertain completion never admit a new original dispatch", async () => {
    const f = await fixture(); await artifacts.claim(db, f.access, "product-attempt");
    const lost: Sql = { ...peer, tx: async body => { await peer.tx(body); throw new Error("Modeled lost native commit response."); } };
    await expect(dispatch(f, lost)).rejects.toThrow("lost native commit response");
    await artifacts.finish(db, f.access, "product-attempt", false);
    expect(await db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "uncertain" }]);
    await expect(dispatch(f)).rejects.toMatchObject({ code: "plan_artifact_unavailable" });
    await expect(artifacts.claim(peer, f.access, "second-attempt")).rejects.toMatchObject({ code: "plan_artifact_unavailable" });
    await immutable(f);
  });
});
