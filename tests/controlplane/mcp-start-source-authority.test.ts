/** Actual owning PostgreSQL admission; role, GitHub HTTP and transport counters are explicit models. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Manifest } from "@/lib/domain/types";
import { digest } from "@/lib/controlplane/digest";
import { assertPlatformSchemaCurrent, isOpenedPlatformDbHandle, isOpenedPlatformPostgresTarget, json, openPlatformDb,
  platformDb, platformDbConfigFromEnv, repos, resetPlatformDbForTests, type PlatformDbHandle } from "@/lib/controlplane/db";
import { PLATFORM_SCHEMA_VERSION } from "@/lib/controlplane/db/migrations";
import type { Sql } from "@/lib/controlplane/types";
import * as connections from "@/lib/controlplane/db/repos/connections";
import * as intents from "@/lib/controlplane/db/repos/workflow-start-intents";
import * as productAuthority from "@/lib/controlplane/db/repos/workflow-start-deploy-authority";
import { assertDefaultMcpProductTopology, captureMcpDeployAuthority, type DeployOperation } from "@/lib/controlplane/db/repos/workflow-start-deploy-authority";
import { createApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { createOwningSourceBundles } from "@/lib/platform/source-bundle";
import { sourceRecipe, sourceSnapshotDigest, sourceSnapshotSetDigest, type ApprovedSourceSnapshot, type SourceCaptureInput } from "@/lib/execution/source-snapshot";
import { expandManifest } from "@/lib/resources/expand";
import { normalizePlan } from "@/lib/tofu/plan";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { createExecutionBroker } from "@/lib/platform/broker";
import { createOperationsPort, executionHolder } from "@/lib/execution/platform";
import { closeSharedPgliteAfterAll, integrationOf, makeHarness, PG_URL, requireApproval, scriptedEngine, sessionFor, user } from "../capabilities/support";
import { writeTar } from "../_support/tar";
import { api, keys } from "../sources/fixtures";

vi.mock("@/lib/execution/product-port", async original => ({
  ...await original<typeof import("@/lib/execution/product-port")>(),
  workerStoreScope: async <T>(body: () => Promise<T>): Promise<T> => body(),
}));
const required = process.env.ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED === "1";
if (required && !PG_URL) throw new Error("MCP final start source authority requires an explicitly owned PostgreSQL database.");
if (required && PLATFORM_SCHEMA_VERSION < 13) throw new Error("MCP final start source authority requires canonical schema13.");
closeSharedPgliteAfterAll();
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const productTables = ["members", "connections", "projects", "environments", "revisions", "revision_manifests", "deployments"] as const;

describe.skipIf(!PG_URL)("MCP final start source authority [postgres; modeled external protocols]", () => {
  let peer: PlatformDbHandle, observer: PlatformDbHandle, material: Awaited<ReturnType<typeof keys>>;
  beforeAll(async () => {
    peer = await openPlatformDb({ kind: "postgres", url: PG_URL!, migrate: true, max: 1 });
    observer = await openPlatformDb({ kind: "postgres", url: PG_URL!, migrate: false, max: 1 });
    await assertPlatformSchemaCurrent(peer);
    const migration = readFileSync(new URL("../../supabase/migrations/0001_system_of_record.sql", import.meta.url), "utf8");
    // Exact committed native collection DDL, never a caller-selected shadow schema.
    for (const name of productTables) {
      const ddl = new RegExp(`create table if not exists public\\.${name} \\([\\s\\S]*?\\n\\);`).exec(migration)?.[0];
      if (!ddl) throw new Error("Native product collection contract is unavailable.");
      await peer.exec(ddl);
    }
    material = await keys();
  }, 60_000);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => { await material?.close(); await observer?.close(); await peer?.close(); });

  async function fixture(options: { git?: boolean; bound?: boolean; initialPlan?: boolean; fault?: "missing source" | "foreign source" | "stripped source" } = {}) {
    const h = await makeHarness({ kind: "postgres", engine: scriptedEngine("mcp-final-source-policy", () => requireApproval(1, "admin", true)) });
    h.deps.clock = { now: () => new Date() };
    const db = h.db!, workspaceId = h.ids.wsA, projectId = h.ids.projA, environmentId = h.ids.envAProd;
    await assertPlatformSchemaCurrent(db);
    const revisionId = `revision_${randomUUID()}`, connectionId = `connection_${randomUUID()}`, platformConnectionId = `conn_${randomUUID()}`;
    await connections.create(db, { id: platformConnectionId, workspaceId, createdBy: "bob", config: {
      provider: "aws", mode: "aws_assume_role", accountId: "123456789012", region: "us-east-1", externalId: "modeled-start-source",
      observeRoleArn: "arn:aws:iam::123456789012:role/zenith_observe_fixture", deployRoleArn: "arn:aws:iam::123456789012:role/zenith_deploy_fixture",
    } });
    await connections.recordVerification(db, { workspaceId, id: platformConnectionId, ok: true });
    const manifest = Manifest.parse({ version: 1, services: [{ id: "web", name: "web", kind: "web", port: 3000,
      source: options.git ? { type: "git", repo: "acme/app", ref: "main", dockerfile: "Dockerfile" } : { type: "image", image: "example/web:v1" } }],
    resources: [], routes: [], bindings: [] });
    const environment = { id: environmentId, projectId, name: "production", class: "production" as const, region: "us-east-1",
      baseDomain: "owning.example.test", connectionId, policies: { approvalRequired: true, allowStatefulDeletion: false } };
    const graph = expandManifest(manifest, { ...environment, provider: "aws" });
    const key = "mcp-final-source-key", actor = { workspaceId, integrationId: h.ids.intRW, subject: "bob" };
    const reservationDigest = digest({ version: 1, ...actor, capability: "deployment.deploy", idempotencyKey: key });
    const deploymentId = `mcp-deploy-${reservationDigest}`;
    const input = { operation: "deploy" as const, admissionVersion: 1 as const, deploymentId, revisionId, revisionNumber: 1, connectionId,
      manifestDigest: digest(manifest), graphDigest: graph.graphDigest, environmentDigest: digest(environment),
      connectionDigest: digest({ id: connectionId, workspaceId, provider: "aws", region: "us-east-1", platformConnectionId }),
      build: !!options.git, estimate: { modeled: true } };
    await db.query("insert into public.members(id,workspace_id,email,role,data) values('bob',$1,'bob@example.test','editor','{}'::jsonb),('erin',$1,'erin@example.test','admin','{}'::jsonb)", [workspaceId]);
    await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,'owning','Owning',$3::text::jsonb)", [projectId, workspaceId, json({ workingManifest: manifest, origin: { type: "blank" } })]);
    await db.query("insert into public.connections(id,workspace_id,provider,status,data) values($1,$2,'aws','healthy',$3::text::jsonb)", [connectionId, workspaceId, json({ region: "us-east-1", platformConnectionId })]);
    await db.query("insert into public.environments(id,workspace_id,project_id,class,connection_id,data) values($1,$2,$3,'production',$4,$5::text::jsonb)",
      [environmentId, workspaceId, projectId, connectionId, json({ name: environment.name, region: environment.region, baseDomain: environment.baseDomain, policies: environment.policies })]);
    await db.query("insert into public.revisions(id,workspace_id,project_id,number,data) values($1,$2,$3,1,$4::text::jsonb)", [revisionId, workspaceId, projectId, json({ message: "saved", author: { type: "user", id: "bob", name: "Bob" } })]);
    await db.query("insert into public.revision_manifests(revision_id,workspace_id,manifest) values($1,$2,$3::text::jsonb)", [revisionId, workspaceId, json(manifest)]);
    // The genuine product projection is committed before the broker proposal.
    const saved = { executor: "workflow", mcpAdmission: { version: 1, ...actor, reservationDigest, input } };
    await db.query("insert into public.deployments(id,workspace_id,project_id,environment_id,revision_id,status,data) values($1,$2,$3,$4,$5,'planning',$6::text::jsonb)",
      [deploymentId, workspaceId, projectId, environmentId, revisionId, json(saved)]);
    const op = (await h.broker.propose({ capability: "deployment.deploy", scope: { workspaceId, projectId, environmentId }, input, idempotencyKey: key }, integrationOf(h, "intRW"))).operation;
    expect((await observer.query<{ data: typeof saved }>("select data from public.deployments where workspace_id=$1 and id=$2", [workspaceId, deploymentId]))[0].data).toEqual(saved);
    await db.query("update public.deployments set data=data || $3::text::jsonb,version=version+1 where workspace_id=$1 and id=$2", [workspaceId, deploymentId, json({ operationId: op.id })]);
    await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") });
    const lease = await repos.leases.acquire(db, { workspaceId, scope: `env:${environmentId}`, holder: `worker:${op.id}`, ttlMs: 120_000 });
    if (!lease) throw new Error("Native MCP source fixture lease is unavailable.");
    await h.broker.beginExecution({ workspaceId, operationId: op.id, holder: executionHolder(op.id), audience: "worker", lease, leaseMs: 120_000 });
    const request: intents.StartRequest = { kind: "deploy", arguments: { workspaceId, operationId: op.id, projectId, environmentId,
      revisionId, deploymentId, connectionId, build: !!options.git, preApproved: true }, namespace: "default",
    endpointDigest: digest("explicit modeled owned transport"), taskQueue: "mcp-final-source-fixture" };
    const snapshots: ApprovedSourceSnapshot[] = [];
    if (options.git && !options.initialPlan) {
      const service = graph.nodes.find(node => node.address === "container_service/web"), pipeline = graph.nodes.find(node => node.address === "build_pipeline/web");
      if (!service || !pipeline) throw new Error("Expanded immutable source recipe is unavailable.");
      for (const node of [service, pipeline]) await repos.resources.upsertDesired(db, { workspaceId, projectId, environmentId, node, status: "active" });
      if (options.bound) {
        await db.query("insert into platform.github_source_bindings(workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values ($1,'42',7,99,'acme','app',1,'fixture-admin')", [workspaceId]);
        vi.stubEnv("ZENITH_GITHUB_APP_ID", "42"); vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE", material.config.privateKeyFile);
      }
      const app = api();
      const fetchImpl: typeof fetch = async (raw, init) => {
        const url = String(raw);
        if (url === "https://api.github.com/repos/acme/app") return Response.json({ id: 99, name: "app", owner: { login: "acme" }, private: !!options.bound });
        if (url.startsWith("https://api.github.com/repos/acme/app/commits/")) return new Response("a".repeat(40));
        if (url.startsWith("https://codeload.github.com/acme/app/tar.gz/")) return new Response(new Uint8Array(gzipSync(writeTar([
          { path: "root/Dockerfile", bytes: Buffer.from("FROM scratch\n") }, { path: "root/app.txt", bytes: Buffer.from("immutable MCP source fixture") },
        ]))));
        return app(raw, init);
      };
      const store = createApprovedSourceSnapshotStore(db), source = createOwningSourceBundles(db, { sourceSnapshots: store, fetchImpl });
      const capture: SourceCaptureInput = { workspaceId, operationId: op.id, projectId, environmentId,
        serviceAddress: service.address, serviceSpecDigest: service.specDigest, pipelineAddress: pipeline.address, pipelineSpecDigest: pipeline.specDigest,
        provider: "aws", region: service.region, repository: "acme/app", requestedRef: "main", dockerfile: "Dockerfile",
        recipeDigest: sourceRecipe(service, pipeline), archiveFormat: "zip" };
      const snapshot = await source.port.capture(capture); snapshots.push(snapshot);
      if (!options.fault || options.fault === "stripped source") await store.retain(snapshot, lease);
      if (options.fault === "foreign source") {
        // Explicit corrupt ownership fixture. It has no native capture provenance and is never accepted as a caller proof.
        const foreign: ApprovedSourceSnapshot = { ...snapshot, projectId: h.ids.projB };
        await db.query("insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values($1,$2,$3,$4,$5,$6::text::jsonb,$7)",
          [workspaceId, op.id, foreign.projectId, environmentId, foreign.serviceAddress, json(foreign), sourceSnapshotDigest(foreign)]);
      }
      const plan = normalizePlan({ format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: [], output_changes: {} },
        { configDigest: digest("modeled normalized config"), lockDigest: digest("modeled normalized lock"), addressMap: {}, executableSourceDigest: sourceSnapshotSetDigest(snapshots) });
      const facts = extractPlanFacts(plan), summary = planEvidence({ plan, facts, cost: {}, graphDigest: graph.graphDigest, stage: "plan", approvedSources: snapshots }).summary;
      if (options.fault === "stripped source") {
        delete summary.executableSourceDigest;
        const view = summary.view;
        if (!view || typeof view !== "object" || Array.isArray(view)) throw new Error("Modeled source review view is unavailable.");
        for (const field of ["executableSourceDigest", "approvedSources", "approvedSourcesTruncated", "approvedSourcesOmitted"]) Reflect.deleteProperty(view, field);
      }
      // Concrete native review: actual evidence, write-once digest, a later human round and a fresh native claim.
      await repos.evidence.insert(db, { workspaceId, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false });
      const ports = createOperationsPort(db), worker = createExecutionBroker(db, async () => h.broker);
      await ports.setPlanDigest({ workspaceId, operationId: op.id, planDigest: plan.planDigest });
      if (!options.fault) {
        const policy = await worker.reevaluate(op.id, facts); await ports.setPolicyDecision({ workspaceId, operationId: op.id, decisionId: policy.decisionId });
        await ports.transition({ workspaceId, operationId: op.id, to: "awaiting_approval" });
        await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: plan.planDigest, approver: user("erin"), session: sessionFor("erin") });
        await repos.operations.claimForExecution(db, { workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: executionHolder(op.id), leaseMs: 120_000, lease, expectedPolicyVersion: "mcp-final-source-policy" });
      }
    }
    return { h, db, op, request, input, manifest, graph, connectionId, platformConnectionId, deploymentId, revisionId, snapshots };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const storeFor = (f: Fixture) => intents.createIsolatedStartIntentStoreForTests(f.h.broker);
  const inventory = (f: Fixture) => intents.get(observer, f.h.ids.wsA, f.op.id);
  async function live(f: Fixture) {
    expect(await observer.query("select status,lease_holder,proposal_digest,input_digest from platform.operations where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.op.id]))
      .toEqual([{ status: "running", lease_holder: executionHolder(f.op.id), proposal_digest: f.op.proposalDigest, input_digest: digest(f.input) }]);
  }
  function delayRole(f: Fixture, target: "approver" | "requester" = "approver") {
    const entered = barrier(), released = barrier(), roles = f.h.deps.roles; let reads = 0;
    f.h.deps.roles = { resolve: async (principal, workspaceId) => {
      if (target === "approver" ? principal.kind === "user" && principal.id === "erin"
        : principal.kind === "integration" && principal.id === f.h.ids.intRW) { reads++; entered.release(); await released.promise; }
      return roles.resolve(principal, workspaceId);
    } };
    return { entered: entered.promise, release: released.release, reads: () => reads };
  }
  const changes = ["full manifest JSON", "revision number", "foreign revision tenant", "foreign project tenant", "environment region",
    "replaced environment connection", "removed environment connection", "foreign environment tenant", "foreign deployment association",
    "missing deployment", "foreign deployment tenant", "foreign connection tenant", "foreign manifest tenant", "missing manifest", "revoked provider connection"] as const;
  type Change = typeof changes[number];
  async function mutate(f: Fixture, change: Change) {
    const ws = f.h.ids.wsA;
    switch (change) {
      case "full manifest JSON": await observer.query("update public.revision_manifests set manifest=jsonb_set(manifest,'{services,0,source,image}',to_jsonb('example/web:v2'::text)) where workspace_id=$1 and revision_id=$2", [ws, f.revisionId]); break;
      case "revision number": await observer.query("update public.revisions set number=2,version=version+1 where workspace_id=$1 and id=$2", [ws, f.revisionId]); break;
      case "foreign revision tenant": await observer.query("update public.revisions set workspace_id=$3 where workspace_id=$1 and id=$2", [ws, f.revisionId, f.h.ids.wsB]); break;
      case "foreign project tenant": await observer.query("update public.projects set workspace_id=$3 where workspace_id=$1 and id=$2", [ws, f.h.ids.projA, f.h.ids.wsB]); break;
      case "environment region": await observer.query("update public.environments set data=jsonb_set(data,'{region}',to_jsonb('eu-west-1'::text)) where workspace_id=$1 and id=$2", [ws, f.h.ids.envAProd]); break;
      case "replaced environment connection": await observer.query("update public.environments set connection_id=$3 where workspace_id=$1 and id=$2", [ws, f.h.ids.envAProd, `foreign_${randomUUID()}`]); break;
      case "removed environment connection": await observer.query("update public.environments set connection_id=null where workspace_id=$1 and id=$2", [ws, f.h.ids.envAProd]); break;
      case "foreign environment tenant": await observer.query("update public.environments set workspace_id=$3 where workspace_id=$1 and id=$2", [ws, f.h.ids.envAProd, f.h.ids.wsB]); break;
      case "foreign deployment association": await observer.query("update public.deployments set data=jsonb_set(data,'{operationId}',to_jsonb('foreign-operation'::text)) where workspace_id=$1 and id=$2", [ws, f.deploymentId]); break;
      case "missing deployment": await observer.query("delete from public.deployments where workspace_id=$1 and id=$2", [ws, f.deploymentId]); break;
      case "foreign deployment tenant": await observer.query("update public.deployments set workspace_id=$3 where workspace_id=$1 and id=$2", [ws, f.deploymentId, f.h.ids.wsB]); break;
      case "foreign connection tenant": await observer.query("update public.connections set workspace_id=$3 where workspace_id=$1 and id=$2", [ws, f.connectionId, f.h.ids.wsB]); break;
      case "foreign manifest tenant": await observer.query("update public.revision_manifests set workspace_id=$3 where workspace_id=$1 and revision_id=$2", [ws, f.revisionId, f.h.ids.wsB]); break;
      case "missing manifest": await observer.query("delete from public.revision_manifests where workspace_id=$1 and revision_id=$2", [ws, f.revisionId]); break;
      case "revoked provider connection": await connections.revoke(observer, ws, f.platformConnectionId); break;
    }
  }
  async function delayed(f: Fixture, phase: "prepare" | "claim", mutation: () => Promise<void>, target: "approver" | "requester" = "approver") {
    if (phase === "claim") await storeFor(f).prepare(f.db, f.request);
    const wait = delayRole(f, target), store = storeFor(f); let starts = 0;
    const pending = (phase === "claim" ? store.claim(peer, f.request).then(result => { if (result.dispatch) starts++; return result; }) : store.prepare(peer, f.request))
      .then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    try {
      await Promise.race([wait.entered, pending.then(result => { throw result.error ?? new Error("Native admission completed before the required role barrier."); })]);
      await mutation(); await live(f); expect(starts).toBe(0);
    } finally { wait.release(); }
    const result = await pending;
    expect(wait.reads()).toBe(1); expect(result.error).toMatchObject({ code: "workflow_start_intent" }); expect(starts).toBe(0);
    if (phase === "prepare") expect(await inventory(f)).toBeNull();
    else expect(await inventory(f)).toMatchObject({ phase: "prepared", attempt_id: null });
  }

  it.each(changes)("final native start CAS refuses %s committed during delayed human role lookup", async change => {
    const f = await fixture(); await delayed(f, "claim", () => mutate(f, change));
    expect((await repos.operations.get(observer, f.h.ids.wsA, f.op.id))?.inputDigest).toBe(digest(f.input));
  });
  it.each(["demotion", "removal", "foreign workspace", "unchanged membership", "benign member metadata"] as const)("subject %s during a held valid modeled grant is checked by the final native membership predicate", async change => {
    const f = await fixture(), before = await storeFor(f).prepare(f.db, f.request), roles = f.h.deps.roles;
    const entered = barrier(), released = barrier(); let memberReads = 0, grantReads = 0, returnedRole: string | undefined, starts = 0;
    f.h.deps.roles = { resolve: async (principal, workspaceId) => {
      if (principal.kind !== "integration" || principal.id !== f.h.ids.intRW) return roles.resolve(principal, workspaceId);
      expect(principal.onBehalfOf).toBe("bob"); expect(workspaceId).toBe(f.h.ids.wsA);
      // Model the canonical directory ordering: native membership is read,
      // then a valid grant reply is held. The final CAS must reject stale role.
      const rows = await observer.query<{ id: string; workspace_id: string; role: string }>("select id,workspace_id,role from public.members where workspace_id=$1 and id=$2", [workspaceId, principal.onBehalfOf]);
      memberReads++; expect(rows).toEqual([{ id: "bob", workspace_id: workspaceId, role: "editor" }]);
      const role = rows[0].role;
      if (role !== "editor") throw new Error("Native initial fixture membership is unavailable.");
      grantReads++; entered.release(); await released.promise; returnedRole = role;
      return { role, integrationScopes: ["read", "plan", "logs", "write"], allowedProjectIds: [f.h.ids.projA], allowedEnvironmentIds: [f.h.ids.envAProd] };
    } };
    const store = storeFor(f), pending = store.claim(peer, f.request).then(value => { if (value.dispatch) starts++; return { value, error: undefined }; }, (error: unknown) => ({ value: undefined, error }));
    try {
      await Promise.race([entered.promise, pending.then(result => { throw result.error ?? new Error("Native admission completed before the required grant barrier."); })]);
      if (change === "demotion") await observer.query("update public.members set role='viewer' where workspace_id=$1 and id='bob'", [f.h.ids.wsA]);
      if (change === "removal") await observer.query("delete from public.members where workspace_id=$1 and id='bob'", [f.h.ids.wsA]);
      if (change === "foreign workspace") await observer.query("update public.members set workspace_id=$2 where workspace_id=$1 and id='bob'", [f.h.ids.wsA, f.h.ids.wsB]);
      if (change === "benign member metadata") await observer.query("update public.members set email='updated@example.test',data=jsonb_build_object('name','Updated display name'),version=version+1,updated_at=now() where workspace_id=$1 and id='bob'", [f.h.ids.wsA]);
      await live(f); expect(starts).toBe(0);
    } finally { released.release(); }
    const result = await pending;
    expect(memberReads).toBe(1); expect(grantReads).toBe(1); expect(returnedRole).toBe("editor");
    if (change === "unchanged membership" || change === "benign member metadata") {
      expect(result.error).toBeUndefined(); expect(result.value?.dispatch).toBe(true); expect(result.value?.intent.binding).toEqual(before.binding);
      expect((await storeFor(f).claim(f.db, f.request)).dispatch).toBe(false); expect(starts).toBe(1);
    } else {
      expect(result.error).toMatchObject({ code: "workflow_start_intent" }); expect(starts).toBe(0);
      expect(await inventory(f)).toMatchObject({ phase: "prepared", attempt_id: null });
    }
  });
  it.each(["full manifest JSON", "revision number", "replaced environment connection", "revoked provider connection"] as const)("initial prepared intent refuses %s committed during delayed human role lookup", async change => {
    const f = await fixture(); await delayed(f, "prepare", () => mutate(f, change));
  });
  it("unchanged owning projection and genuine source-free absence permit one permanent start across independent pools", async () => {
    const f = await fixture(), store = storeFor(f);
    expect(await observer.query("select service_address from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [f.h.ids.wsA, f.op.id])).toEqual([]);
    const before = await store.prepare(f.db, f.request), wait = delayRole(f), delayedStore = storeFor(f); let starts = 0;
    const pending = delayedStore.claim(peer, f.request).then(result => { if (result.dispatch) starts++; return result; });
    try { await Promise.race([wait.entered, pending.then(() => { throw new Error("Native admission completed before the required role barrier."); })]); await live(f); expect(starts).toBe(0); } finally { wait.release(); }
    const first = await pending, second = await delayedStore.claim(f.db, f.request);
    expect(first.dispatch).toBe(true); expect(first.intent.binding_digest).toBe(before.binding_digest);
    expect(second.dispatch).toBe(false); expect(second.intent.attempt_id).toBe(first.intent.attempt_id); expect(starts).toBe(1);
    expect(await inventory(f)).toMatchObject({ phase: "attempted", attempt_id: first.intent.attempt_id });
  });
  it.each(["working copy and display", "history progress and newer UI pointer"] as const)("benign %s advance during role lookup preserves the exact original saved operation", async change => {
    const f = await fixture(), before = await storeFor(f).prepare(f.db, f.request), wait = delayRole(f), store = storeFor(f); let starts = 0;
    const pending = store.claim(peer, f.request).then(value => { if (value.dispatch) starts++; return value; });
    try {
      await Promise.race([wait.entered, pending.then(() => { throw new Error("Native admission completed before the required role barrier."); })]);
      if (change === "working copy and display") {
        await observer.query("update public.projects set name='New display name',data=jsonb_set(data,'{workingManifest}', $3::text::jsonb),version=version+1 where workspace_id=$1 and id=$2",
          [f.h.ids.wsA, f.h.ids.projA, json({ ...f.manifest, services: [] })]);
      } else {
        await observer.query("update public.revisions set data=data || $3::text::jsonb,version=version+1 where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.revisionId, json({ message: "new history label" })]);
        await observer.query("update public.deployments set status='awaiting_approval',data=data || $3::text::jsonb,version=version+1 where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.deploymentId, json({ progressLabel: "new display progress" })]);
        await observer.query("update public.environments set deployed_revision_id='unrelated-newer-revision',active_deployment_id='unrelated-newer-deployment',version=version+1 where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.h.ids.envAProd]);
      }
      await live(f); expect(starts).toBe(0);
    } finally { wait.release(); }
    const first = await pending;
    expect(first.dispatch).toBe(true); expect(first.intent.binding).toEqual(before.binding); expect(first.intent.binding.arguments.revisionId).toBe(f.revisionId);
    expect((await store.claim(f.db, f.request)).dispatch).toBe(false); expect(starts).toBe(1);
    expect((await observer.query<{ manifest: unknown }>("select manifest from public.revision_manifests where workspace_id=$1 and revision_id=$2", [f.h.ids.wsA, f.revisionId]))[0].manifest).toEqual(f.manifest);
  });
  it.each(["unchanged private binding", "revoked private binding", "removed private binding", "replaced private binding", "introduced public binding"] as const)("retained native source start fences %s during delayed human role lookup", async change => {
    const f = await fixture({ git: true, bound: change !== "introduced public binding" });
    await storeFor(f).prepare(f.db, f.request);
    const wait = delayRole(f), store = storeFor(f); let starts = 0;
    const pending = store.claim(peer, f.request).then(value => { if (value.dispatch) starts++; return { value, error: undefined }; }, (error: unknown) => ({ value: undefined, error }));
    try {
      await Promise.race([wait.entered, pending.then(result => { throw result.error ?? new Error("Native admission completed before the required role barrier."); })]);
      if (change === "revoked private binding") await observer.query("update platform.github_source_bindings set revoked_at=clock_timestamp(),version=version+1 where workspace_id=$1", [f.h.ids.wsA]);
      if (change === "removed private binding") await observer.query("delete from platform.github_source_bindings where workspace_id=$1", [f.h.ids.wsA]);
      if (change === "replaced private binding") await observer.query("update platform.github_source_bindings set installation_id=8,version=version+1 where workspace_id=$1", [f.h.ids.wsA]);
      if (change === "introduced public binding") await observer.query("insert into platform.github_source_bindings(workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values ($1,'42',7,99,'acme','app',1,'fixture-admin')", [f.h.ids.wsA]);
      await live(f); expect(starts).toBe(0);
    } finally { wait.release(); }
    const result = await pending; expect(wait.reads()).toBe(1);
    if (change === "unchanged private binding") {
      expect(result.error).toBeUndefined(); expect(result.value?.dispatch).toBe(true); expect(starts).toBe(1);
      expect((await store.claim(f.db, f.request)).dispatch).toBe(false); expect(starts).toBe(1);
    } else {
      expect(result.error).toMatchObject({ code: "workflow_start_intent" }); expect(starts).toBe(0);
      expect(await inventory(f)).toMatchObject({ phase: "prepared", attempt_id: null });
    }
  });
  it.each(["service", "pipeline"] as const)("final native source start refuses full %s JSON mutation with unchanged stored digest during role lookup", async kind => {
    const f = await fixture({ git: true, bound: true }), node = f.graph.nodes.find(value => value.address === (kind === "service" ? "container_service/web" : "build_pipeline/web"));
    if (!node) throw new Error("Owning recipe node is unavailable.");
    await delayed(f, "claim", async () => {
      await observer.query("update platform.resources set spec=spec || $3::text::jsonb where workspace_id=$1 and address=$2", [f.h.ids.wsA, node.address, json({ recipeChanged: true })]);
      expect((await observer.query<{ spec_digest: string }>("select spec_digest from platform.resources where workspace_id=$1 and environment_id=$2 and address=$3", [f.h.ids.wsA, f.h.ids.envAProd, node.address]))[0].spec_digest).toBe(node.specDigest);
    });
  });
  it("final native source start refuses changed planning evidence JSON with the same concrete plan digest during role lookup", async () => {
    const f = await fixture({ git: true, bound: true });
    const planDigest = (await observer.query<{ plan_digest: string }>("select plan_digest from platform.operations where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.op.id]))[0].plan_digest;
    expect(planDigest).toMatch(/^[a-f0-9]{64}$/);
    await delayed(f, "claim", async () => {
      await observer.query("update platform.evidence set summary=summary || $3::text::jsonb where workspace_id=$1 and operation_id=$2 and kind='tofu_plan' and summary->>'stage'='plan'",
        [f.h.ids.wsA, f.op.id, json({ reviewedMetadataChanged: true })]);
      expect((await observer.query<{ plan_digest: string }>("select plan_digest from platform.operations where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.op.id]))[0].plan_digest).toBe(planDigest);
    });
  });
  it.each(["missing source", "foreign source", "stripped source"] as const)("native source start refuses %s before creating any intent", async fault => {
    const f = await fixture({ git: true, bound: false, fault });
    const native = (await peer.query<DeployOperation>("select * from platform.operations where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.op.id]))[0];
    // Direct native capture refusal makes this negative independent of later approval refusal.
    await expect(peer.tx(tx => captureMcpDeployAuthority(tx, native))).rejects.toThrow("unavailable or changed");
    await live(f); await expect(storeFor(f).prepare(peer, f.request)).rejects.toMatchObject({ code: "workflow_start_intent" });
    expect(await inventory(f)).toBeNull();
  });
  it.each(["prepare", "claim"] as const)("concrete managed Git %s refuses combined native source and every review-field absence committed by an independent pool", async phase => {
    // Explicit corrupt planning fixture: this operation never retains source.
    // Immutable schema13 rows are neither deleted nor rewritten.
    const f = await fixture({ git: true, initialPlan: true }), store = storeFor(f);
    const initial = (await peer.query<DeployOperation>("select * from platform.operations where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.op.id]))[0];
    expect(initial.plan_digest).toBeNull(); expect(f.input.build).toBe(true);
    await expect(peer.tx(tx => captureMcpDeployAuthority(tx, initial))).resolves.toMatchObject({ sources: [], evidence: [] });
    expect(await observer.query("select service_address from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [f.h.ids.wsA, f.op.id])).toEqual([]);
    // This claim fixture retains a legitimate null-plan prepared intent before
    // the corrupt concrete plan is recorded. The request binding stays exact;
    // later approval checks can also refuse this explicit corrupt state.
    const prepared = phase === "claim" ? await store.prepare(f.db, f.request) : undefined;
    const plan = normalizePlan({ format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: [], output_changes: {} },
      { configDigest: digest("explicit corrupt omitted-source config"), lockDigest: digest("explicit corrupt omitted-source lock"), addressMap: {} });
    const facts = extractPlanFacts(plan), summary = planEvidence({ plan, facts, cost: {}, graphDigest: f.graph.graphDigest, stage: "plan" }).summary;
    // An independent native pool commits a concrete plan that omits both
    // source retention and every source review marker from its creation.
    await observer.tx(async tx => {
      await repos.evidence.insert(tx, { workspaceId: f.h.ids.wsA, operationId: f.op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false });
      await createOperationsPort(tx).setPlanDigest({ workspaceId: f.h.ids.wsA, operationId: f.op.id, planDigest: plan.planDigest });
    });
    const before = (await repos.operations.get(observer, f.h.ids.wsA, f.op.id))!;
    expect(before.planDigest).toBe(plan.planDigest); expect(before.inputDigest).toBe(digest(f.input)); expect(before.proposalDigest).toBe(f.op.proposalDigest);
    expect(await observer.query("select service_address from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [f.h.ids.wsA, f.op.id])).toEqual([]);
    const reviews = await observer.query<{ summary: Record<string, unknown> }>("select summary from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='tofu_plan' and digest=$3 and summary->>'stage'='plan'", [f.h.ids.wsA, f.op.id, before.planDigest]);
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      expect(Object.hasOwn(review.summary, "executableSourceDigest")).toBe(false);
      const view = review.summary.view;
      if (!view || typeof view !== "object" || Array.isArray(view)) throw new Error("Concrete original review fixture is unavailable.");
      for (const name of ["executableSourceDigest", "approvedSources", "approvedSourcesTruncated", "approvedSourcesOmitted"]) expect(Object.hasOwn(view, name)).toBe(false);
    }
    const native = (await peer.query<DeployOperation>("select * from platform.operations where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.op.id]))[0];
    // The same initially valid native capture now refuses concrete omission,
    // before approval or the retained intent binding can mask this guard.
    await expect(peer.tx(tx => captureMcpDeployAuthority(tx, native))).rejects.toThrow("unavailable or changed");
    await live(f);
    const transportStart = vi.fn(async () => undefined);
    const admission = phase === "prepare" ? store.prepare(peer, f.request) : store.claim(peer, f.request).then(async result => {
      if (result.dispatch) await transportStart();
      return result;
    });
    await expect(admission).rejects.toMatchObject({ code: "workflow_start_intent" });
    expect(transportStart).not.toHaveBeenCalled();
    const current = (await repos.operations.get(observer, f.h.ids.wsA, f.op.id))!;
    expect(current.planDigest).toBe(before.planDigest); expect(current.proposalDigest).toBe(before.proposalDigest); expect(current.inputDigest).toBe(before.inputDigest);
    expect(await observer.query("select attempt_id from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2 and attempt_id is not null", [f.h.ids.wsA, f.op.id])).toEqual([]);
    expect(await observer.query("select service_address from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [f.h.ids.wsA, f.op.id])).toEqual([]);
    if (phase === "prepare") expect(await inventory(f)).toBeNull();
    else {
      const retained = await inventory(f);
      if (!prepared || !retained) throw new Error("Initial prepared omission fixture is unavailable.");
      expect(retained).toMatchObject({ phase: "prepared", attempt_id: null });
      expect(retained.binding).toEqual(prepared.binding);
      expect(retained.binding_digest).toBe(prepared.binding_digest);
    }
  });
  it("initial managed Git planning start with null plan digest and genuine native source-review absence remains permitted once", async () => {
    const f = await fixture({ git: true, initialPlan: true }), store = storeFor(f);
    expect(await observer.query("select plan_digest from platform.operations where workspace_id=$1 and id=$2", [f.h.ids.wsA, f.op.id])).toEqual([{ plan_digest: null }]); expect(f.input.build).toBe(true);
    expect(await observer.query("select service_address from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [f.h.ids.wsA, f.op.id])).toEqual([]);
    expect(await observer.query("select id from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='tofu_plan' and summary->>'stage'='plan'", [f.h.ids.wsA, f.op.id])).toEqual([]);
    const before = await store.prepare(f.db, f.request), first = await store.claim(peer, f.request);
    expect(first.dispatch).toBe(true); expect(first.intent.binding).toEqual(before.binding);
    expect((await store.claim(f.db, f.request)).dispatch).toBe(false); expect(await inventory(f)).toMatchObject({ phase: "attempted", attempt_id: first.intent.attempt_id });
  });
  it.each(["revoked modeled integration", "demoted current human"] as const)("native source start refuses %s during its delayed current role lookup", async change => {
    const f = await fixture(); await delayed(f, "claim", async () => {
      if (change === "revoked modeled integration") f.h.world.integrations.delete(`${f.h.ids.wsA}|${f.h.ids.intRW}`);
      else f.h.world.members.set(`${f.h.ids.wsA}|erin`, "viewer");
    }, change === "revoked modeled integration" ? "requester" : "approver");
  });
  it.each(["connectionId", "preApproved"] as const)("immutable MCP argument binding refuses changed %s before source admission", async field => {
    const f = await fixture(), request = { ...f.request, arguments: { ...f.request.arguments, [field]: field === "preApproved" ? false : "foreign-connection" } };
    await expect(storeFor(f).prepare(peer, request)).rejects.toMatchObject({ code: "workflow_start_intent" });
    expect(await inventory(f)).toBeNull();
  });
  it("matching arbitrary public rows cannot replace default opener and configured product topology provenance", async () => {
    const f = await fixture(); vi.stubEnv("ZENITH_STORE", "postgres");
    vi.stubEnv("ZENITH_PLATFORM_DB", "postgres"); vi.stubEnv("ZENITH_PLATFORM_DB_URL", PG_URL!);
    vi.stubEnv("SUPABASE_DB_URL", "postgres://postgres@foreign.example.test:5432/postgres");
    // Genuine local PostgreSQL with equal rows does not establish hosted product ownership.
    await expect(assertDefaultMcpProductTopology(f.db)).rejects.toThrow("unavailable or changed");
    await expect(intents.prepare(peer, f.request)).rejects.toMatchObject({ code: "workflow_start_intent" });
    expect(await inventory(f)).toBeNull();
    const forged = { ...f.db };
    await expect(assertDefaultMcpProductTopology(forged)).rejects.toThrow("unavailable or changed");
  });
  function ownsTarget(db: unknown, url: string): boolean {
    const parsed = new URL(url);
    return isOpenedPlatformPostgresTarget(db, parsed.hostname, Number(parsed.port || "5432"), parsed.pathname.slice(1), decodeURIComponent(parsed.username));
  }
  it("genuine explicit-port native opener target remains equal only to its immutable opening host database and user", async () => {
    const parsed = new URL(PG_URL!);
    if (!parsed.hostname || !parsed.port || !parsed.username || !parsed.pathname.slice(1)) throw new Error("Native opening-target acceptance requires explicit host port database and user.");
    expect((await peer.query<{ database: string }>("select current_database() as database"))[0].database).toBe(parsed.pathname.slice(1));
    expect(isOpenedPlatformDbHandle(peer, "postgres")).toBe(true); expect(ownsTarget(peer, PG_URL!)).toBe(true);
    const changed = new URL(PG_URL!); changed.pathname = "/foreign-database";
    expect(ownsTarget(peer, changed.href)).toBe(false); changed.pathname = parsed.pathname; changed.port = parsed.port === "6543" ? "5432" : "6543";
    expect(ownsTarget(peer, changed.href)).toBe(false); expect(ownsTarget({ ...peer }, PG_URL!)).toBe(false);
  });
  it("genuine cached native handle refuses a changed shared-host pooler realm configuration without relabeling its opening target", async () => {
    await resetPlatformDbForTests();
    vi.stubEnv("ZENITH_PLATFORM_DB", "postgres"); vi.stubEnv("ZENITH_PLATFORM_DB_URL", PG_URL!);
    const cachedA = await platformDb(), openingA = new URL(PG_URL!), configB = new URL(PG_URL!);
    try {
      expect(ownsTarget(cachedA, PG_URL!)).toBe(true);
      // The actual opening and SQL are native. The alternate Supavisor realm
      // is a configuration model on the same endpoint, never an opened fake.
      configB.username = `postgres.${randomBytes(10).toString("hex")}`;
      configB.password = "";
      vi.stubEnv("ZENITH_PLATFORM_DB_URL", configB.href); vi.stubEnv("SUPABASE_DB_URL", configB.href);
      const current = platformDbConfigFromEnv(); expect(current.url).toBe(configB.href);
      expect(await platformDb()).toBe(cachedA); expect(new URL(current.url!).host).toBe(openingA.host);
      expect(new URL(current.url!).pathname).toBe(openingA.pathname);
      expect(ownsTarget(cachedA, current.url!)).toBe(false); expect(ownsTarget(cachedA, PG_URL!)).toBe(true);
      expect((await cachedA.query<{ database: string }>("select current_database() as database"))[0].database).toBe(openingA.pathname.slice(1));
    } finally { await resetPlatformDbForTests(); }
    expect(ownsTarget(cachedA, PG_URL!)).toBe(false);
  });
  it("opening option mutation after its awaited driver boundary cannot rewrite genuine target provenance", async () => {
    const options = { kind: "postgres" as const, url: PG_URL!, migrate: false, max: 1 }, changed = new URL(PG_URL!);
    changed.username = `postgres.${randomBytes(10).toString("hex")}`;
    const pending = openPlatformDb(options); options.url = changed.href;
    const opened = await pending;
    try {
      await opened.query("select 1 as actual_native_connection");
      expect(ownsTarget(opened, PG_URL!)).toBe(true); expect(ownsTarget(opened, changed.href)).toBe(false);
    } finally { await opened.close(); }
  });
  it("missing explicit port and PGPORT mutation across opening cannot acquire target provenance", async () => {
    const implicit = new URL(PG_URL!); implicit.port = ""; vi.stubEnv("PGPORT", "");
    const pending = openPlatformDb({ kind: "postgres", url: implicit.href, migrate: false, max: 1 });
    vi.stubEnv("PGPORT", "6543"); const opened = await pending;
    try {
      // This driver is intentionally not queried. No default port service is
      // contacted; the genuine opener lacks an immutable explicit port proof.
      expect(isOpenedPlatformDbHandle(opened, "postgres")).toBe(true);
      expect(ownsTarget(opened, implicit.href)).toBe(false); implicit.port = "6543"; expect(ownsTarget(opened, implicit.href)).toBe(false);
    } finally { await opened.close(); }
  });
  it.each(["user", "database"] as const)("native startup query %s override cannot obtain opening-target provenance from the URL realm", async field => {
    const actual = new URL(PG_URL!), changed = new URL(PG_URL!);
    if (field === "user") {
      changed.username = "postgres.modeledrealmabcdefgh";
      changed.searchParams.set("user", decodeURIComponent(actual.username));
    } else {
      changed.pathname = "/modeled_foreign_database";
      changed.searchParams.set("database", actual.pathname.slice(1));
    }
    const opened = await openPlatformDb({ kind: "postgres", url: changed.href, migrate: false, max: 1 });
    try {
      // Actual PostgreSQL accepts the query override in its StartupMessage.
      // The alternate pooler realm is modeled; no hosted pooler is contacted.
      const rows = await opened.query<{ database: string; role: string }>("select current_database() as database,current_user as role");
      expect(rows).toEqual([{ database: actual.pathname.slice(1), role: decodeURIComponent(actual.username) }]);
      expect(isOpenedPlatformDbHandle(opened, "postgres")).toBe(true);
      expect(ownsTarget(opened, changed.href)).toBe(false); expect(ownsTarget(opened, PG_URL!)).toBe(false);
    } finally { await opened.close(); }
  });
  it.each(["options", "application_name", "unknown", "duplicate sslmode", "unproved TLS mode"] as const)("native opener preserves legacy construction but refuses %s URL options for new fixed target provenance", async option => {
    const changed = new URL(PG_URL!); changed.search = "";
    if (option === "duplicate sslmode") { changed.searchParams.append("sslmode", "require"); changed.searchParams.append("sslmode", "verify-full"); }
    else if (option === "unproved TLS mode") changed.searchParams.set("sslmode", "prefer");
    else changed.searchParams.set(option, option === "options" ? "-c search_path=foreign" : "modeled");
    const opened = await openPlatformDb({ kind: "postgres", url: changed.href, migrate: false, max: 1 });
    try {
      // Driver construction is real and lazy. Unknown startup settings are
      // never sent to a server merely to test a refused proof.
      expect(isOpenedPlatformDbHandle(opened, "postgres")).toBe(true); expect(ownsTarget(opened, changed.href)).toBe(false);
    } finally { await opened.close(); }
  });
  it.each(["require", "verify-full"] as const)("one target-neutral sslmode %s retains genuine fixed opener provenance without claiming a TLS handshake", async mode => {
    const configured = new URL(PG_URL!); configured.search = ""; configured.searchParams.set("sslmode", mode);
    const opened = await openPlatformDb({ kind: "postgres", url: configured.href, migrate: false, max: 1 });
    try { expect(isOpenedPlatformDbHandle(opened, "postgres")).toBe(true); expect(ownsTarget(opened, configured.href)).toBe(true); }
    finally { await opened.close(); }
  });
  it("closed or accessor-tampered genuine opener cannot satisfy the scalar target predicate", async () => {
    const opened = await openPlatformDb({ kind: "postgres", url: PG_URL!, migrate: false, max: 1 });
    await opened.query("select 1 as actual_native_connection");
    const descriptor = Object.getOwnPropertyDescriptor(opened, "query");
    if (!descriptor || !("value" in descriptor)) throw new Error("Native opener method contract is unavailable.");
    const accessor = vi.fn(() => descriptor.value);
    try {
      Object.defineProperty(opened, "query", { get: accessor, configurable: true });
      expect(ownsTarget(opened, PG_URL!)).toBe(false); expect(accessor).not.toHaveBeenCalled();
    } finally { Object.defineProperty(opened, "query", descriptor); await opened.close(); }
    expect(ownsTarget(opened, PG_URL!)).toBe(false);
  });
  it("a retained prepared intent recaptures current native semantics without replacing its immutable binding", async () => {
    const f = await fixture(), store = storeFor(f), retained = await store.prepare(f.db, f.request);
    await mutate(f, "full manifest JSON");
    await expect(store.prepare(peer, f.request)).rejects.toMatchObject({ code: "workflow_start_intent" });
    expect(await inventory(f)).toMatchObject({ phase: "prepared", binding_digest: retained.binding_digest, attempt_id: null });
    await observer.query("update public.revision_manifests set manifest=$3::text::jsonb,version=version+1 where workspace_id=$1 and revision_id=$2", [f.h.ids.wsA, f.revisionId, json(f.manifest)]);
    const freshStore = storeFor(f), current = await freshStore.prepare(peer, f.request);
    expect(current.binding_digest).toBe(retained.binding_digest); expect(current.binding).toEqual(retained.binding); expect(current.phase).toBe("prepared");
    expect((await freshStore.claim(f.db, f.request)).dispatch).toBe(true);
    expect((await freshStore.claim(peer, f.request)).dispatch).toBe(false);
  });
  it("lost permanent attempt commit acknowledgement leaves no false dispatch proof and never replays after product drift", async () => {
    const f = await fixture(), store = storeFor(f); await store.prepare(f.db, f.request); let starts = 0;
    const fault: Sql = { query: peer.query.bind(peer), tx: async body => { await peer.tx(body); throw new Error("Explicit modeled postcommit acknowledgement loss"); } };
    await expect(store.claim(fault, f.request).then(value => { if (value.dispatch) starts++; })).rejects.toThrow("postcommit acknowledgement loss");
    const retained = await inventory(f); expect(retained).toMatchObject({ phase: "attempted" }); expect(retained?.attempt_id).toBeTruthy(); expect(starts).toBe(0);
    await mutate(f, "missing deployment");
    const again = await store.claim(f.db, f.request); expect(again.dispatch).toBe(false); expect(again.intent.attempt_id).toBe(retained?.attempt_id);
    expect((await store.prepare(peer, f.request)).attempt_id).toBe(retained?.attempt_id); expect(starts).toBe(0);
  });
  it("attempted and acknowledged recovery remains evidence only after topology source and current roles become unavailable", async () => {
    const f = await fixture(), store = storeFor(f); await store.prepare(f.db, f.request);
    const first = await store.claim(peer, f.request); expect(first.dispatch).toBe(true); let starts = 1;
    await mutate(f, "missing manifest"); vi.stubEnv("ZENITH_STORE", "file");
    f.h.deps.roles = { resolve: async () => { throw new Error("Explicit modeled unavailable current directory"); } };
    const attempted = await intents.claim(f.db, f.request); if (attempted.dispatch) starts++;
    expect(attempted.dispatch).toBe(false); expect(attempted.intent.attempt_id).toBe(first.intent.attempt_id);
    // Repository evidence sink only. A modeled readback is not authentic Temporal retained-history acceptance.
    const receipt = { runId: randomUUID(), startedAt: new Date().toISOString(), evidenceDigest: digest("explicit modeled original-history receipt") };
    const acknowledged = await intents.acknowledge(peer, first.intent, receipt);
    expect(acknowledged.phase).toBe("acknowledged"); expect(acknowledged.attempt_id).toBe(first.intent.attempt_id);
    const recovered = await intents.claim(f.db, f.request); if (recovered.dispatch) starts++;
    expect(recovered.dispatch).toBe(false); expect(recovered.intent).toMatchObject({ phase: "acknowledged", run_id: receipt.runId });
    expect((await intents.prepare(peer, f.request)).run_id).toBe(receipt.runId); expect(starts).toBe(1);
  });
  it.each(["unchanged", "restored nested REST transport", "default REST method", "default REST fetch", "default REST accessor", "store selection", "opening pooler realm", "configured database", "startup override"] as const)("post-role native CAS rechecks %s under explicit modeled hosted composition", async change => {
    const f = await fixture(); vi.resetModules();
    const origin = "https://abcdefghijklmnopqrst.supabase.co";
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", origin); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", randomBytes(32).toString("hex"));
    vi.stubEnv("ZENITH_STORE", "postgres"); vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", "");
    vi.stubEnv("ZENITH_PLATFORM_DB", "postgres"); vi.stubEnv("ZENITH_PLATFORM_DB_URL", PG_URL!); vi.stubEnv("SUPABASE_DB_URL", PG_URL!);
    const admin = await import("@/lib/supabase/admin"), product = await import("@/lib/db/postgres-store");
    product.resetPgClient(); const client = product.pgClient(), rest = Object.getOwnPropertyDescriptor(client, "rest")?.value;
    if (!rest || typeof rest !== "object") throw new Error("Actual native default SDK composition is unavailable.");
    const fetchDescriptor = Object.getOwnPropertyDescriptor(rest, "fetch");
    if (!fetchDescriptor || !("value" in fetchDescriptor)) throw new Error("Actual native SDK REST transport is unavailable.");
    const currentRoles = await import("@/lib/capabilities/current-product-roles"), scopes = await import("@/lib/platform/scopes"), policy = await import("@/lib/policy");
    // External roles/policy and hosted endpoint association are models. Native
    // SQL, default SDK construction and private method/target predicates are real.
    vi.spyOn(currentRoles, "currentProductRoleResolver").mockImplementation(() => f.h.deps.roles);
    vi.spyOn(scopes, "platformScopeResolver").mockReturnValue(f.h.deps.scopes);
    vi.spyOn(policy, "loadPolicyEngine").mockImplementation(() => f.h.deps.policy());
    const original = new URL(PG_URL!);
    const compositionModel = async (opened: Sql, tx: Sql) => {
      const url = process.env.SUPABASE_DB_URL, selected = url && new URL(url);
      if (!selected || process.env.ZENITH_STORE !== "postgres" || process.env.ZENITH_PLATFORM_DB_URL !== url
        || !isOpenedPlatformDbHandle(opened, "postgres") || !isOpenedPlatformPostgresTarget(opened, selected.hostname, Number(selected.port), selected.pathname.slice(1), decodeURIComponent(selected.username))
        || [...selected.searchParams].some(([key, value]) => key !== "sslmode" || !["require", "verify-full"].includes(value))
        || !admin.isDefaultAdminClientFor(client, origin) || !product.isDefaultProductClientFor(origin)) throw new Error("Explicit modeled hosted composition refused.");
      expect(await tx.query("select current_database() as database,current_user as role,current_schema() as schema"))
        .toEqual([{ database: original.pathname.slice(1), role: decodeURIComponent(original.username), schema: "public" }]);
    };
    const initial = vi.spyOn(productAuthority, "assertDefaultMcpProductTopology").mockImplementation(opened => compositionModel(opened, opened));
    const final = vi.spyOn(productAuthority, "assertFinalMcpProductTopology").mockImplementation(compositionModel);
    const entered = barrier(), released = barrier(), roles = f.h.deps.roles;
    let starts = 0, roleReads = 0; const accessor = vi.fn(() => fetchDescriptor.value);
    try {
      const before = await intents.prepare(f.db, f.request); expect(final).toHaveBeenCalledTimes(1);
      f.h.deps.roles = { resolve: async (principal, workspaceId) => {
        if (principal.kind === "user" && principal.id === "erin") { roleReads++; entered.release(); await released.promise; }
        return roles.resolve(principal, workspaceId);
      } };
      const pending = intents.claim(peer, f.request).then(value => { if (value.dispatch) starts++; return { value, error: undefined }; }, (error: unknown) => ({ value: undefined, error }));
      try {
        await Promise.race([entered.promise, pending.then(result => { throw result.error ?? new Error("Native admission completed before the required role barrier."); })]);
        if (change === "default REST method") Object.defineProperty(rest, "from", { value: () => { throw new Error("Explicit modeled changed REST method"); }, configurable: true });
        if (change === "default REST fetch" || change === "restored nested REST transport") Object.defineProperty(rest, "fetch", { ...fetchDescriptor, value: () => { throw new Error("Explicit modeled changed REST transport"); } });
        if (change === "restored nested REST transport") Object.defineProperty(rest, "fetch", fetchDescriptor);
        if (change === "default REST accessor") Object.defineProperty(rest, "from", { get: accessor, configurable: true });
        if (change === "store selection") vi.stubEnv("ZENITH_STORE", "file");
        if (["opening pooler realm", "configured database", "startup override"].includes(change)) {
          const changed = new URL(PG_URL!); changed.password = "";
          if (change === "opening pooler realm") changed.username = "postgres.modeledrealmabcdefgh";
          if (change === "configured database") changed.pathname = "/modeled_foreign_database";
          if (change === "startup override") changed.searchParams.set("user", "postgres.modeledrealmabcdefgh");
          vi.stubEnv("SUPABASE_DB_URL", changed.href); vi.stubEnv("ZENITH_PLATFORM_DB_URL", changed.href);
        }
        await live(f); expect(starts).toBe(0); expect(final).toHaveBeenCalledTimes(1);
      } finally { released.release(); }
      const result = await pending;
      expect(roleReads).toBe(1); expect(initial).toHaveBeenCalledTimes(2); expect(final).toHaveBeenCalledTimes(2); expect(accessor).not.toHaveBeenCalled();
      const session = final.mock.calls[1][1]; expect(session).not.toBe(peer); expect(isOpenedPlatformDbHandle(session)).toBe(false);
      if (change === "unchanged" || change === "restored nested REST transport") {
        expect(result.error).toBeUndefined(); expect(result.value?.dispatch).toBe(true); expect(result.value?.intent.binding).toEqual(before.binding);
        expect((await intents.claim(f.db, f.request)).dispatch).toBe(false); expect(starts).toBe(1);
      } else {
        expect(result.error).toMatchObject({ code: "workflow_start_intent" }); expect(starts).toBe(0); expect(await inventory(f)).toMatchObject({ phase: "prepared", attempt_id: null });
      }
    } finally { Reflect.deleteProperty(rest, "from"); Object.defineProperty(rest, "fetch", fetchDescriptor); product.resetPgClient(); }
  });
});

describe("default product client provenance [SDK protocol; no network]", () => {
  afterEach(async () => {
    const { resetPgClient } = await import("@/lib/db/postgres-store"); resetPgClient();
    vi.unstubAllEnvs(); vi.resetModules();
  });
  async function clients() {
    vi.resetModules();
    const origin = "https://abcdefghijklmnopqrst.supabase.co";
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", origin);
    // Ephemeral SDK construction material is never printed, persisted or sent.
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", randomBytes(32).toString("hex"));
    const admin = await import("@/lib/supabase/admin"), product = await import("@/lib/db/postgres-store");
    product.resetPgClient();
    return { origin, admin, product };
  }
  it("only the privately created default client satisfies the fixed owning target predicate", async () => {
    const { origin, admin, product } = await clients();
    const client = admin.createAdminClient(); expect(admin.isDefaultAdminClientFor(client, origin)).toBe(true);
    expect(admin.isDefaultAdminClientFor({ from: client.from, schema: client.schema }, origin)).toBe(false);
    expect(admin.isDefaultAdminClientFor(client, "https://otherprojectabcdefgh.supabase.co")).toBe(false);
    expect(admin.isDefaultAdminClientFor(client.schema("foreign"), origin)).toBe(false);
    const cached = product.pgClient(); expect(product.pgClient()).toBe(cached); expect(product.isDefaultProductClientFor(origin)).toBe(true);
  });
  it.each(["method", "method accessor", "rest URL", "rest schema"] as const)("changed cached default %s refuses private factory provenance", async change => {
    const { origin, admin, product } = await clients(), client = product.pgClient();
    expect(product.isDefaultProductClientFor(origin)).toBe(true);
    if (change === "method") Object.defineProperty(client, "from", { value: () => { throw new Error("Changed modeled SDK method"); }, configurable: true });
    else if (change === "method accessor") {
      const original = client.from, accessor = vi.fn(() => original);
      Object.defineProperty(client, "from", { get: accessor, configurable: true });
      expect(admin.isDefaultAdminClientFor(client, origin)).toBe(false); expect(accessor).not.toHaveBeenCalled();
    }
    else {
      const rest = Object.getOwnPropertyDescriptor(client, "rest")?.value;
      if (!rest || typeof rest !== "object") throw new Error("Locked SDK REST composition is unavailable.");
      Object.defineProperty(rest, change === "rest URL" ? "url" : "schemaName", { value: change === "rest URL" ? "https://foreign.example.test/rest/v1" : "foreign", configurable: true });
    }
    expect(admin.isDefaultAdminClientFor(client, origin)).toBe(false); expect(product.isDefaultProductClientFor(origin)).toBe(false);
  });
  it("changing process configuration after module capture cannot relabel the existing cached client", async () => {
    const { origin, admin, product } = await clients(), client = product.pgClient();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://otherprojectabcdefgh.supabase.co");
    expect(product.pgClient()).toBe(client); expect(product.isDefaultProductClientFor(origin)).toBe(true);
    expect(admin.isDefaultAdminClientFor(client, process.env.NEXT_PUBLIC_SUPABASE_URL!)).toBe(false);
  });
  it.each(["REST from", "REST schema", "REST fetch", "REST fetch accessor", "REST method accessor", "REST prototype", "REST prototype from", "REST prototype schema", "REST fetch descriptor", "REST object", "REST own descriptor"] as const)("actual cached SDK %s substitution refuses and exact original restoration permits native provenance", async change => {
    const { origin, admin, product } = await clients(), client = product.pgClient();
    const restDescriptor = Object.getOwnPropertyDescriptor(client, "rest"), rest = restDescriptor?.value;
    if (!restDescriptor || !("value" in restDescriptor) || !rest || typeof rest !== "object") throw new Error("Locked native REST composition is unavailable.");
    const prototype: unknown = Object.getPrototypeOf(rest);
    if (!prototype || typeof prototype !== "object") throw new Error("Locked native REST prototype is unavailable.");
    const fetchDescriptor = Object.getOwnPropertyDescriptor(rest, "fetch");
    if (!fetchDescriptor || !("value" in fetchDescriptor)) throw new Error("Locked native REST fetch is unavailable.");
    const fromDescriptor = Object.getOwnPropertyDescriptor(prototype, "from"), schemaDescriptor = Object.getOwnPropertyDescriptor(prototype, "schema");
    if (!fromDescriptor || !schemaDescriptor) throw new Error("Locked native REST methods are unavailable.");
    const accessor = vi.fn(() => fetchDescriptor.value);
    expect(product.isDefaultProductClientFor(origin)).toBe(true);
    try {
      if (change === "REST from") Object.defineProperty(rest, "from", { value: () => { throw new Error("Explicit modeled replaced REST method"); }, configurable: true });
      if (change === "REST schema") Object.defineProperty(rest, "schema", { value: () => { throw new Error("Explicit modeled replaced REST schema"); }, configurable: true });
      if (change === "REST fetch") Object.defineProperty(rest, "fetch", { ...fetchDescriptor, value: () => { throw new Error("Explicit modeled replaced REST transport"); } });
      if (change === "REST fetch accessor") Object.defineProperty(rest, "fetch", { get: accessor, configurable: true });
      if (change === "REST method accessor") Object.defineProperty(rest, "from", { get: accessor, configurable: true });
      if (change === "REST prototype") Object.setPrototypeOf(rest, {});
      if (change === "REST prototype from") Object.defineProperty(prototype, "from", { ...fromDescriptor, value: () => { throw new Error("Explicit modeled replaced REST prototype method"); } });
      if (change === "REST prototype schema") Object.defineProperty(prototype, "schema", { ...schemaDescriptor, value: () => { throw new Error("Explicit modeled replaced REST prototype schema"); } });
      if (change === "REST fetch descriptor") Object.defineProperty(rest, "fetch", { ...fetchDescriptor, writable: !fetchDescriptor.writable });
      if (change === "REST object") Object.defineProperty(client, "rest", { ...restDescriptor, value: { url: `${origin}/rest/v1`, schemaName: "public", fetch: fetchDescriptor.value } });
      if (change === "REST own descriptor") Object.defineProperty(client, "rest", { ...restDescriptor, enumerable: !restDescriptor.enumerable });
      expect(admin.isDefaultAdminClientFor(client, origin)).toBe(false); expect(product.isDefaultProductClientFor(origin)).toBe(false);
      expect(accessor).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(rest, "from"); Reflect.deleteProperty(rest, "schema"); Object.setPrototypeOf(rest, prototype);
      Object.defineProperty(prototype, "from", fromDescriptor); Object.defineProperty(prototype, "schema", schemaDescriptor);
      Object.defineProperty(rest, "fetch", fetchDescriptor); Object.defineProperty(client, "rest", restDescriptor);
    }
    expect(admin.isDefaultAdminClientFor(client, origin)).toBe(true); expect(product.pgClient()).toBe(client); expect(product.isDefaultProductClientFor(origin)).toBe(true);
  });
});
