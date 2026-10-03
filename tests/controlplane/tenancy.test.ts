/**
 * Cross-tenant negative sweep.
 *
 * Workspace A gets one of everything; workspace B then calls EVERY read and
 * mutation that takes a workspace id, naming A's ids, and must see nothing and
 * change nothing. A completeness guard fails this file when a repository
 * function is added without being classified below, so a new function cannot
 * quietly skip the tenancy check.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { bindRepos } from "@/lib/controlplane/db/repos";
import { ControlStoreError } from "@/lib/controlplane/db";
import { digest } from "@/lib/controlplane/digest";
import type { BrokerProposal } from "@/lib/capabilities/types";
import { executionHolder } from "@/lib/execution/platform";
import type { PlanArtifactManifest } from "@/lib/tofu/engine";
import type { ResourceNode } from "@/lib/resources/types";
import { LANES, PG_URL, approve, newWorkspace, openLane, proposalFor, seedApprovedOperation, seedAwaitingApproval, uid, user } from "./_support/harness";
import { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, sessionFor } from "../capabilities/support";
import { makePlan, change } from "../execution/fakes/fixtures";
import { buildPlanFacts } from "@/lib/capabilities/evaluate";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { registerEnvironment } from "@/lib/reconcile/platform";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";

closeSharedPgliteAfterAll();

/** These run in the real-PostgreSQL canonical-broker sweep below, never as PGlite authority. */
const BUILD_LAUNCH_SWEPT = new Set(["buildLaunches.claim", "buildLaunches.get", "buildLaunches.acknowledge", "buildLaunches.observeTerminal"]);

/** Functions exercised by the sweep (each named `namespace.function`). */
const SWEPT = new Set([
  ...BUILD_LAUNCH_SWEPT,
  "approvals.consume", "approvals.listForOperation", "approvals.record", "approvals.requiredApprovalCount", "approvals.consumeApprovals",
  "connections.get", "connections.list", "connections.recordVerification", "connections.revoke",
  "cost.get", "cost.list",
  "drift.latest", "drift.list",
  "events.list",
  "evidence.get", "evidence.list",
  "grants.consume", "grants.get", "grants.isRevoked", "grants.revoke", "grants.revokeForOperation", "grants.status",
  "incidents.getIncident", "incidents.getInvestigation", "incidents.listIncidents", "incidents.listInvestigationsForIncident", "incidents.transitionIncident",
  "jobs.appendLogs", "jobs.cancel", "jobs.claimNext", "jobs.get", "jobs.listForOperation", "jobs.listLogs", "jobs.markRunning", "jobs.settle",
  "leases.listActive",
  "machines.getMachine", "machines.heartbeatMachine", "machines.listMachines", "machines.revokeMachine",
  "observations.getRuntime", "observations.latestObservation", "observations.latestObservationsByEnvironment", "observations.listRuntimeByEnvironment", "observations.observationHistory", "observations.pruneObservations",
  "operations.claimForExecution", "operations.get", "operations.heartbeat", "operations.list", "operations.transition",
  "operationExecution.suspendForApproval", "operationExecution.setPlanDigest", "operationExecution.setPolicyDecision", "operationExecution.deny",
  "policyDecisions.get", "policyDecisions.listForOperation",
  "planArtifacts.publish", "planArtifacts.read", "planArtifacts.associate", "planArtifacts.claim", "planArtifacts.dispatch", "planArtifacts.finish",
  "resources.changeOwnership", "resources.get", "resources.getByAddress", "resources.listByEnvironment", "resources.setStatus",
  "runners.getRunner", "runners.heartbeat", "runners.listRunners", "runners.revokeRunner",
  "settings.getEnvironmentSettings", "settings.getWorkspacePolicy",
]);

/** Writes that bind the new row to the workspace they are given; their tenant checks are tested with the owning suite. */
const WRITES = new Set([
  "connections.create", "cost.insert", "drift.insert", "events.append", "evidence.insert", "grants.insert", "incidents.openIncident", "incidents.insertInvestigation",
  "jobs.enqueue", "machines.upsertTarget", "observations.appendObservation", "observations.upsertRuntime", "operations.create", "policyDecisions.insert",
  "resources.upsertDesired", "runners.createRegistrationToken", "settings.putEnvironmentSettings", "settings.putWorkspacePolicy", "idempotency.reserve", "idempotency.complete",
]);

/** Deliberately not workspace-filtered, with the reason. */
const EXEMPT: Record<string, string> = {
  "buildLaunches.BuildLaunchError": "pure error class, contains no SQL or tenant data",
  "buildLaunches.createIsolatedBuildClaimerForTests": "NODE_ENV=test-only factory captures one actual isolated broker; returns the same scoped claim implementation, takes no tenant data or SQL itself, and is excluded from bindRepos",
  "planArtifacts.PlanArtifactError": "pure error class, contains no SQL or tenant data",
  "planArtifacts.expire": "system logical-expiry maintenance; workspace taken from database candidates, never from tenant input",
  "leases.acquire": "keyed by a globally unique scope string; a workspace-tagged scope refuses a foreign workspace (tested in leases.test.ts)",
  "leases.renew": "keyed by scope + holder + fence",
  "leases.release": "keyed by scope + holder + fence",
  "leases.current": "keyed by scope",
  "leases.assertFence": "keyed by scope + fence",
  "nonces.remember": "keyed by agent id (globally unique); never read by tenants",
  "nonces.prune": "system maintenance",
  "idempotency.prune": "system maintenance",
  "operations.markUncertainExpired": "system reconciler; every returned record carries its workspace",
  "operations.expireOverdue": "system reconciler",
  "operations.getForSystem": "trusted worker lookup by id only; tests/execution/ledger-approval.test.ts uses the returned workspace for all later calls",
  "jobs.expireStale": "system reaper",
  "operations.toOperation": "pure row mapper",
  "runners.generateRegistrationToken": "pure helper",
  "runners.hashRegistrationToken": "pure helper",
  "runners.consumeRegistrationToken": "keyed by the token hash; the workspace comes FROM the token",
  "runners.registerRunner": "the workspace comes from the registration token, never from the caller",
  "machines.registerMachine": "the workspace comes from the registration token, never from the caller",
  "runners.findRunnerForAuth": "the one documented unscoped lookup: a signed request names only the agent id",
  "machines.findMachineForAuth": "the one documented unscoped lookup: a signed request names only the machine id",
};

const hex = (c: string): string => c.repeat(64);

describe("completeness guard", () => {
  it("every repository function is classified: swept, a workspace-bound write, or exempt with a reason", () => {
    const unclassified: string[] = [];
    for (const [ns, mod] of Object.entries(repos)) {
      if (typeof mod !== "object" || mod === null || ns === "bindRepos") continue;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;
        const key = `${ns}.${name}`;
        if (!SWEPT.has(key) && !WRITES.has(key) && !(key in EXEMPT)) unclassified.push(key);
      }
    }
    expect(unclassified, `classify these in tests/controlplane/tenancy.test.ts`).toEqual([]);
  });

  it("nothing is classified twice, and every classified name still exists", () => {
    const all = new Set<string>();
    for (const [ns, mod] of Object.entries(repos)) {
      if (typeof mod !== "object" || mod === null) continue;
      for (const [name, value] of Object.entries(mod)) if (typeof value === "function") all.add(`${ns}.${name}`);
    }
    for (const key of [...SWEPT, ...WRITES, ...Object.keys(EXEMPT)]) expect(all.has(key), `${key} exists`).toBe(true);
    const overlap = [...SWEPT].filter((k) => WRITES.has(k) || k in EXEMPT);
    expect(overlap).toEqual([]);
  });

  it("bindRepos exposes every repository function except the pure helpers, with sql pre-applied", async () => {
    const stub = { query: async () => [], tx: async <T>(fn: (s: never) => Promise<T>) => fn(undefined as never) };
    const bound = bindRepos(stub as never);
    expect(Object.keys(bound.operations)).toEqual(expect.arrayContaining(["create", "get", "list", "transition", "claimForExecution"]));
    expect(Object.keys(bound.operations)).not.toContain("toOperation");
    expect(Object.keys(bound.runners)).not.toContain("generateRegistrationToken");
    expect(Object.keys(bound.planArtifacts)).not.toContain("PlanArtifactError");
    expect(Object.keys(bound.buildLaunches)).toEqual(expect.arrayContaining(["claim", "get", "acknowledge", "observeTerminal"]));
    expect(Object.keys(bound.buildLaunches)).not.toContain("BuildLaunchError");
    expect(Object.keys(bound.buildLaunches)).not.toContain("createIsolatedBuildClaimerForTests");
    expect(await bound.events.list("ws_x")).toEqual([]);
  });
});

/** Turn "not found in your workspace" refusals into an empty result for the sweep. */
async function seen<T>(promise: Promise<T>): Promise<unknown> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ControlStoreError && ["operation_not_found", "not_found", "tenant_mismatch"].includes(err.code)) return null;
    if (err instanceof repos.planArtifacts.PlanArtifactError) return null;
    throw err;
  }
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "unknown") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("items" in o) return Array.isArray(o.items) && o.items.length === 0;
    if (o.isDefault === true) return true;
    if ("revoked" in o) return false;
  }
  return false;
}

describe.each(LANES)("tenant isolation sweep [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  it("workspace B can neither see nor change anything of workspace A", async () => {
    const db = ctx.db;
    // ------------------------------ seed workspace A ------------------------------
    const seeded = await seedAwaitingApproval(db);
    const A = seeded.workspaceId;
    const B = newWorkspace();
    const decided = await approve(db, seeded, user("approver"));
    const strict = await seedAwaitingApproval(db, { workspaceId: A, count: 3 }); // A's decision that demands three approvers
    const opId = seeded.operation.id;
    const active = await seedApprovedOperation(db, A);
    await repos.operations.claimForExecution(db, { workspaceId: A, id: active.operation.id, expectedDigest: active.operation.proposalDigest, holder: "worker" });
    const activeDecision = await repos.policyDecisions.insert(db, { workspaceId: A, operationId: active.operation.id, outcome: "require_approval", policyVersion: "v", inputDigest: hex("a"), reasons: [] });
    const denyDecision = await repos.policyDecisions.insert(db, { workspaceId: A, operationId: opId, outcome: "deny", policyVersion: "v", inputDigest: hex("a"), reasons: [] });
    const envId = seeded.operation.environmentId as string;
    const now = Date.now();

    const jti = uid("jti");
    await repos.grants.insert(db, { jti, workspaceId: A, operationId: opId, capability: "infrastructure.apply", audience: "worker", issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
    await repos.events.append(db, { type: "operation.approved", workspaceId: A, operationId: opId, correlationId: "corr_a" });
    const evidence = await repos.evidence.insert(db, { workspaceId: A, operationId: opId, kind: "tofu_plan", digest: hex("c"), summary: {}, simulated: false });
    await repos.settings.putEnvironmentSettings(db, { workspaceId: A, environmentId: envId, autonomyLevel: 4, updatedBy: "u" });
    await repos.settings.putWorkspacePolicy(db, { workspaceId: A, params: { k: 1 }, updatedBy: "u" });
    const connection = await repos.connections.create(db, {
      workspaceId: A,
      createdBy: "u",
      config: { provider: "aws", mode: "oidc_web_identity", accountId: "123456789012", observeRoleArn: "arn:aws:iam::123456789012:role/o", deployRoleArn: "arn:aws:iam::123456789012:role/d", region: "ap-south-1" },
    });
    const node: ResourceNode = { address: "service/web", kind: "container_service", provider: "aws", region: "ap-south-1", nativeType: "aws:ecs_service", ownership: "managed", spec: {}, origin: [], dependsOn: [], specDigest: hex("a"), labels: {} };
    const resource = await repos.resources.upsertDesired(db, { workspaceId: A, environmentId: envId, node });
    await repos.observations.appendObservation(db, { workspaceId: A, resourceId: resource.id, observation: { address: "service/web", presence: "present", attributes: {}, observedAt: new Date().toISOString(), source: "test", simulated: false } });
    await repos.observations.upsertRuntime(db, { workspaceId: A, resourceId: resource.id, runtime: { address: "service/web", health: "healthy", counts: {}, signals: [], observedAt: new Date().toISOString(), source: "test", simulated: false } });
    await repos.drift.insert(db, { workspaceId: A, report: { environmentId: envId, graphDigest: hex("d"), computedAt: new Date().toISOString(), findings: [], unobserved: [], simulated: false } });
    const { tokenHash } = repos.runners.generateRegistrationToken("runner");
    await repos.runners.createRegistrationToken(db, { workspaceId: A, kind: "runner", createdBy: "u", tokenHash });
    const runner = await repos.runners.registerRunner(db, { tokenHash, name: "r", publicKey: "A".repeat(43) });
    const job = await repos.jobs.enqueue(db, { id: uid("job"), workspaceId: A, runnerId: runner.id, operationId: opId, kind: "tofu.run", capability: "infrastructure.apply", envelope: "a.b.c" });
    await repos.jobs.appendLogs(db, { workspaceId: A, runnerId: runner.id, jobId: job.id, batchSeq: 1, lines: [{ ts: new Date().toISOString(), stream: "stdout", line: "hello" }] });
    const machine = await repos.machines.upsertTarget(db, { workspaceId: A, environmentId: envId, name: "web-1", transport: "aws_ssm", targetId: "i-0abc" });
    const incident = await repos.incidents.openIncident(db, { workspaceId: A, environmentId: envId, title: "t", severity: "low", source: "user" });
    await repos.incidents.insertInvestigation(db, { id: uid("inv"), incidentId: incident.id, workspaceId: A, environmentId: envId, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), path: [], evidence: [], hypotheses: [], recentChanges: [], simulated: false });
    const cost = await repos.cost.insert(db, { workspaceId: A, environmentId: envId, estimate: { kind: "estimate", catalogVersion: "v1", currency: "USD", monthlyUsd: 10, lines: [], assumptions: {}, included: [], excluded: [], computedAt: new Date().toISOString() } });
    const decision = await repos.policyDecisions.listForOperation(db, A, opId);
    const investigations = await repos.incidents.listInvestigationsForIncident(db, A, incident.id);
    await repos.leases.acquire(db, { scope: `env:${envId}`, holder: "w", ttlMs: 60_000, workspaceId: A });
    expect(decision.length).toBeGreaterThan(0);
    expect(investigations).toHaveLength(1);

    // Synthetic ciphertext exercises SQL tenancy only; no engine authenticity or durable runtime claim.
    const artifactSource=await seedApprovedOperation(db,A,{proposal:{capability:"infrastructure.plan",scope:{workspaceId:A,projectId:"proj_1",environmentId:envId},input:{environmentId:envId,teardownReview:true}}});
    await repos.operations.claimForExecution(db,{workspaceId:A,id:artifactSource.operation.id,expectedDigest:artifactSource.operation.proposalDigest,holder:executionHolder(artifactSource.operation.id)});
    const artifactLease=await repos.leases.current(db,`env:${envId}`);
    if(!artifactLease)throw new Error("Tenant artifact fixture lease is unavailable.");
    const source=artifactSource.operation,artifactDigest=hex("d");
    const manifest:PlanArtifactManifest={workspaceId:A,operationId:source.id,projectId:"proj_1",environmentId:envId,proposalDigest:source.proposalDigest,inputDigest:source.inputDigest,expiresAt:source.expiresAt,
      sourceDigest:hex("a"),graphDigest:hex("b"),format:"zenith.plan-artifact.v1",purpose:"destroy",configDigest:hex("c"),lockDigest:hex("e"),backendDigest:hex("f"),addressMapDigest:hex("a"),planDigest:artifactDigest,
      rawSha256:hex("b"),bytes:1,executable:{version:"synthetic",platform:"synthetic",sha256:hex("c"),archiveSha256:null}};
    const artifactEvidenceId=uid("evd_artifact");
    const artifactInput:repos.planArtifacts.PublishArtifact={manifest,sealed:{iv:"A".repeat(16),authTag:"A".repeat(24),ciphertext:"synthetic-tenant-fixture"},lease:artifactLease,evidence:{id:artifactEvidenceId,workspaceId:A,operationId:source.id,kind:"tofu_plan",digest:artifactDigest,summary:{planDigest:artifactDigest},simulated:false}};
    await repos.planArtifacts.publish(db,artifactInput);
    const destroyProposal:BrokerProposal={
      ...proposalFor(A,{capability:"infrastructure.destroy",scope:{workspaceId:A,projectId:"proj_1",environmentId:envId},input:{environmentId:envId},planDigest:artifactDigest}),
      broker:{v:1,risk:"medium",destroyPlan:{operationId:source.id,evidenceId:artifactEvidenceId,retained:[]}},
    };
    const destination=await seedAwaitingApproval(db,{workspaceId:A,proposal:destroyProposal});
    const associationInput={workspaceId:A,sourceOperationId:source.id,destinationOperationId:destination.operation.id,sourceEvidenceId:artifactEvidenceId,planDigest:artifactDigest,lease:artifactLease};
    await repos.planArtifacts.associate(db,associationInput);
    const artifactAccess={custody:manifest,planDigest:artifactDigest,lease:artifactLease};
    const artifactBefore=await repos.planArtifacts.read(db,artifactAccess);
    const associationsBefore=await db.query("select * from platform.plan_artifact_associations where workspace_id=$1",[A]);
    let usesBefore=await db.query("select * from platform.plan_artifact_uses where workspace_id=$1 order by operation_id",[A]);
    const foreignAccess={...artifactAccess,custody:{...manifest,workspaceId:B}};

    // ------------------------ workspace B tries everything -------------------------
    const dig = seeded.operation.proposalDigest;
    const attempts: Record<string, () => Promise<unknown>> = {
      "planArtifacts.publish": () => seen(repos.planArtifacts.publish(db,{...artifactInput,manifest:{...manifest,workspaceId:B},evidence:{...artifactInput.evidence,workspaceId:B}})),
      "planArtifacts.read": () => seen(repos.planArtifacts.read(db,foreignAccess)),
      "planArtifacts.associate": () => seen(repos.planArtifacts.associate(db,{...associationInput,workspaceId:B})),
      "planArtifacts.claim": () => seen(repos.planArtifacts.claim(db,foreignAccess,"foreign-attempt")),
      "planArtifacts.dispatch": async () => {
        await repos.planArtifacts.claim(db,artifactAccess,"tenant-owner-attempt");
        usesBefore=await db.query("select * from platform.plan_artifact_uses where workspace_id=$1 order by operation_id",[A]);
        return seen(repos.planArtifacts.dispatch(db,foreignAccess,"tenant-owner-attempt"));
      },
      "planArtifacts.finish": () => repos.planArtifacts.finish(db,foreignAccess,"tenant-owner-attempt",false),
      "operationExecution.suspendForApproval": () => repos.operationExecution.suspendForApproval(db, { workspaceId: B, id: active.operation.id }),
      "operationExecution.setPlanDigest": () => repos.operationExecution.setPlanDigest(db, { workspaceId: B, id: opId, planDigest: hex("d") }),
      "operationExecution.setPolicyDecision": () => repos.operationExecution.setPolicyDecision(db, { workspaceId: B, id: active.operation.id, decisionId: activeDecision.id }),
      "operationExecution.deny": () => repos.operationExecution.deny(db, { workspaceId: B, id: opId, decisionId: denyDecision.id }),
      "approvals.consume": () => repos.approvals.consume(db, { workspaceId: B, operationId: opId, proposalDigest: dig }),
      "approvals.consumeApprovals": () => repos.approvals.consumeApprovals(db, { workspaceId: B, operationId: opId, proposalDigest: dig }),
      "approvals.listForOperation": () => repos.approvals.listForOperation(db, B, opId),
      "approvals.record": () => seen(repos.approvals.record(db, { workspaceId: B, operationId: opId, approver: user(), approverRole: "admin", decision: "reject", proposalDigest: dig, policyVersion: "v" })),
      // B must not learn A's policy decision (3 approvers): it gets the default 1
      "approvals.requiredApprovalCount": async () => ((await repos.approvals.requiredApprovalCount(db, B, strict.decision.id)) === 1 ? null : "leaked"),
      "connections.get": () => repos.connections.get(db, B, connection.id),
      "connections.list": () => repos.connections.list(db, B, { includeRevoked: true }),
      "connections.recordVerification": () => repos.connections.recordVerification(db, { workspaceId: B, id: connection.id, ok: true }),
      "connections.revoke": () => repos.connections.revoke(db, B, connection.id),
      "cost.get": () => repos.cost.get(db, B, cost.id),
      "cost.list": () => repos.cost.list(db, B, { environmentId: envId }),
      "drift.latest": () => repos.drift.latest(db, B, envId),
      "drift.list": () => repos.drift.list(db, B, envId),
      "events.list": () => repos.events.list(db, B, { operationId: opId }),
      "evidence.get": () => repos.evidence.get(db, B, evidence.id),
      "evidence.list": () => repos.evidence.list(db, B, { operationId: opId }),
      "grants.consume": () => repos.grants.consume(db, { workspaceId: B, jti }),
      "grants.get": () => repos.grants.get(db, B, jti),
      "grants.isRevoked": () => repos.grants.isRevoked(db, B, jti),
      "grants.revoke": () => repos.grants.revoke(db, B, jti),
      "grants.revokeForOperation": () => repos.grants.revokeForOperation(db, B, opId),
      "grants.status": () => repos.grants.status(db, B, jti),
      "incidents.getIncident": () => repos.incidents.getIncident(db, B, incident.id),
      "incidents.getInvestigation": () => repos.incidents.getInvestigation(db, B, investigations[0].id),
      "incidents.listIncidents": () => repos.incidents.listIncidents(db, B),
      "incidents.listInvestigationsForIncident": () => repos.incidents.listInvestigationsForIncident(db, B, incident.id),
      "incidents.transitionIncident": () => repos.incidents.transitionIncident(db, { workspaceId: B, id: incident.id, from: ["open"], to: "resolved" }),
      "jobs.appendLogs": () => repos.jobs.appendLogs(db, { workspaceId: B, runnerId: runner.id, jobId: job.id, batchSeq: 2, lines: [{ ts: new Date().toISOString(), stream: "stdout", line: "x" }] }),
      "jobs.cancel": () => repos.jobs.cancel(db, B, job.id),
      "jobs.claimNext": () => repos.jobs.claimNext(db, { workspaceId: B, runnerId: runner.id }),
      "jobs.get": () => repos.jobs.get(db, B, job.id),
      "jobs.listForOperation": () => repos.jobs.listForOperation(db, B, opId),
      "jobs.listLogs": () => repos.jobs.listLogs(db, { workspaceId: B, jobId: job.id }),
      "jobs.markRunning": () => repos.jobs.markRunning(db, { workspaceId: B, runnerId: runner.id, jobId: job.id, leaseMs: 60_000 }),
      "jobs.settle": () => repos.jobs.settle(db, { workspaceId: B, runnerId: runner.id, jobId: job.id, status: "succeeded" }),
      "leases.listActive": () => repos.leases.listActive(db, B),
      "machines.getMachine": () => repos.machines.getMachine(db, B, machine.id),
      "machines.heartbeatMachine": () => repos.machines.heartbeatMachine(db, { workspaceId: B, id: machine.id }),
      "machines.listMachines": () => repos.machines.listMachines(db, B, { environmentId: envId }),
      "machines.revokeMachine": () => repos.machines.revokeMachine(db, B, machine.id),
      "observations.getRuntime": () => repos.observations.getRuntime(db, B, resource.id),
      "observations.latestObservation": () => repos.observations.latestObservation(db, B, resource.id),
      "observations.latestObservationsByEnvironment": () => repos.observations.latestObservationsByEnvironment(db, B, envId),
      "observations.listRuntimeByEnvironment": () => repos.observations.listRuntimeByEnvironment(db, B, envId),
      "observations.observationHistory": () => repos.observations.observationHistory(db, B, resource.id),
      "observations.pruneObservations": () => repos.observations.pruneObservations(db, { workspaceId: B, keepPerResource: 1 }),
      "operations.claimForExecution": () => seen(repos.operations.claimForExecution(db, { workspaceId: B, id: opId, expectedDigest: dig, holder: "w" })),
      "operations.get": () => repos.operations.get(db, B, opId),
      "operations.heartbeat": () => repos.operations.heartbeat(db, { workspaceId: B, id: opId, holder: "w" }),
      "operations.list": () => repos.operations.list(db, B, { environmentId: envId }),
      "operations.transition": () => repos.operations.transition(db, { workspaceId: B, id: opId, from: ["approved"], to: "cancelled" }),
      "policyDecisions.get": () => repos.policyDecisions.get(db, B, decision[0].id),
      "policyDecisions.listForOperation": () => repos.policyDecisions.listForOperation(db, B, opId),
      "resources.changeOwnership": () => repos.resources.changeOwnership(db, { workspaceId: B, id: resource.id, from: "managed", to: "external" }),
      "resources.get": () => repos.resources.get(db, B, resource.id),
      "resources.getByAddress": () => repos.resources.getByAddress(db, B, envId, "service/web"),
      "resources.listByEnvironment": () => repos.resources.listByEnvironment(db, B, envId, { includeDeleted: true }),
      "resources.setStatus": () => repos.resources.setStatus(db, B, resource.id, "deleted"),
      "runners.getRunner": () => repos.runners.getRunner(db, B, runner.id),
      "runners.heartbeat": () => repos.runners.heartbeat(db, { workspaceId: B, id: runner.id }),
      "runners.listRunners": () => repos.runners.listRunners(db, B),
      "runners.revokeRunner": () => repos.runners.revokeRunner(db, B, runner.id),
      "settings.getEnvironmentSettings": () => repos.settings.getEnvironmentSettings(db, B, envId),
      "settings.getWorkspacePolicy": () => repos.settings.getWorkspacePolicy(db, B),
    };
    // The four build-launch functions have actual broker/PG positive controls
    // in the separate sweep below; all remaining functions run in both lanes.
    expect(new Set(Object.keys(attempts))).toEqual(new Set([...SWEPT].filter(key=>!BUILD_LAUNCH_SWEPT.has(key))));

    for (const [name, attempt] of Object.entries(attempts)) {
      const result = await attempt();
      expect(isEmpty(result), `${name} leaked or acted across tenants: ${JSON.stringify(result)?.slice(0, 200)}`).toBe(true);
    }

    // ------------------------ and A's data is exactly as it was -------------------------
    expect(await repos.planArtifacts.read(db,artifactAccess)).toEqual(artifactBefore);
    expect(await db.query("select * from platform.plan_artifact_associations where workspace_id=$1",[A])).toEqual(associationsBefore);
    expect(await db.query("select * from platform.plan_artifact_uses where workspace_id=$1 order by operation_id",[A])).toEqual(usesBefore);
    for(const table of ["plan_artifacts","plan_artifact_associations","plan_artifact_uses"])
      expect(await db.query(`select operation_id from platform.${table} where workspace_id=$1`,[B])).toHaveLength(0);
    expect((await repos.operations.get(db,A,source.id))?.planDigest).toBe(artifactDigest);
    expect((await repos.operations.get(db,A,destination.operation.id))?.status).toBe("awaiting_approval");
    expect(await repos.approvals.listForOperation(db,A,destination.operation.id)).toHaveLength(0);
    expect(await repos.evidence.list(db,A,{operationId:source.id})).toHaveLength(1);
    expect((await repos.operations.get(db, A, opId))?.status).toBe("approved");
    expect((await repos.operations.get(db, A, opId))?.planDigest).toBeUndefined();
    expect((await repos.operations.get(db, A, active.operation.id))?.status).toBe("running");
    expect((await repos.operations.get(db, A, active.operation.id))?.policyDecisionId).toBeUndefined();
    expect(await repos.approvals.listForOperation(db, A, opId)).toHaveLength(1);
    expect((await repos.approvals.listForOperation(db, A, opId))[0].consumedAt).toBeUndefined();
    expect(decided.approval.id).toBeDefined();
    expect(await repos.grants.status(db, A, jti)).toBe("active");
    expect((await repos.connections.get(db, A, connection.id))?.status).toBe("pending_verification");
    expect((await repos.resources.get(db, A, resource.id))?.ownership).toBe("managed");
    expect((await repos.resources.get(db, A, resource.id))?.status).toBe("planned");
    expect((await repos.runners.getRunner(db, A, runner.id))?.status).toBe("active");
    expect((await repos.jobs.get(db, A, job.id))?.status).toBe("queued");
    expect(await repos.jobs.listLogs(db, { workspaceId: A, jobId: job.id })).toHaveLength(1);
    expect((await repos.machines.getMachine(db, A, machine.id))?.status).toBe("active");
    expect((await repos.incidents.getIncident(db, A, incident.id))?.status).toBe("open");
    expect((await repos.settings.getEnvironmentSettings(db, A, envId)).autonomyLevel).toBe(4);
    expect(await repos.observations.latestObservation(db, A, resource.id)).not.toBeNull();
    expect(await repos.leases.listActive(db, A)).toHaveLength(1);
  });
});

describe.skipIf(!PG_URL)("build launch tenant isolation sweep [postgres]",()=>{
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async()=>{ctx=await openLane(LANES.find(l=>l.name==="postgres")!);},60000);
  afterAll(async()=>{await ctx?.close();});

  it("sweeps claim/get/acknowledge/observeTerminal with current owning authority and preserves A exactly",async()=>{
    const db=ctx.db, h=await makeHarness({kind:"postgres",engine:scriptedEngine("tenant-build-policy",()=>requireApproval(1,"admin",true))});
    const A=h.ids.wsA,B=newWorkspace(),environmentId=h.ids.envAProd,accountId="123456789012",region="eu-west-1";
    h.deps.clock={now:()=>new Date()};
    h.world.environments.get(environmentId)!.region=region;
    const {operation:op}=await h.broker.propose({capability:"deployment.deploy",scope:{workspaceId:A,projectId:h.ids.projA,environmentId},input:{}},user("alice"));
    const decide=(planDigest?:string)=>h.broker.approve({workspaceId:A,operationId:op.id,proposalDigest:op.proposalDigest,planDigest,approver:user("erin"),session:sessionFor("erin")});
    await decide();
    await h.broker.beginExecution({workspaceId:A,operationId:op.id,holder:`workflow:${op.id}`,audience:"worker"});
    const ports=createOperationsPort(db),worker=createExecutionBroker(db,async()=>h.broker);
    const plan=makePlan({changes:[change({address:"aws_codebuild_project.web",type:"aws_codebuild_project",action:"create"})]}),facts=buildPlanFacts(plan)!;
    await repos.evidence.insert(db,{workspaceId:A,operationId:op.id,kind:"tofu_plan",digest:plan.planDigest,summary:planEvidence({plan,facts,cost:{},graphDigest:digest("tenant-graph"),stage:"plan"}).summary,simulated:false});
    await ports.setPlanDigest({workspaceId:A,operationId:op.id,planDigest:plan.planDigest});
    const policy=await worker.reevaluate(op.id,facts);
    await ports.setPolicyDecision({workspaceId:A,operationId:op.id,decisionId:policy.decisionId});
    await ports.transition({workspaceId:A,operationId:op.id,to:"awaiting_approval"});
    await decide(plan.planDigest);
    const lease=await repos.leases.acquire(db,{workspaceId:A,scope:`env:${environmentId}`,holder:`worker:${op.id}`,ttlMs:60000});
    if(!lease)throw new Error("Tenant build fixture lease unavailable.");
    await repos.operations.claimForExecution(db,{workspaceId:A,id:op.id,expectedDigest:op.proposalDigest,holder:`workflow:${op.id}`,leaseMs:60000,lease,expectedPolicyVersion:"tenant-build-policy"});
    // Synthetic completed-plan use is fixture provenance, not provider/apply acceptance.
    await db.query("insert into platform.plan_artifact_uses(workspace_id,operation_id,phase) values ($1,$2,'succeeded')",[A,op.id]);
    const pipeline=mkNode("build_pipeline/web","build_pipeline","aws:codebuild_project",{source:{repo:"https://github.com/acme/web",ref:"revision"}},{region,specDigest:digest("tenant-pipeline")});
    const service=mkNode("container_service/web","container_service","aws:ecs_service",{artifact:{type:"built",pipeline:pipeline.address}},{region,specDigest:digest("tenant-service")});
    for(const node of [pipeline,service])await repos.resources.upsertDesired(db,{workspaceId:A,environmentId,node,status:"active"});
    const connection=await repos.connections.create(db,{workspaceId:A,createdBy:"tenant-fixture-admin",config:{provider:"aws",mode:"oidc_web_identity",accountId,region,observeRoleArn:`arn:aws:iam::${accountId}:role/observe`,deployRoleArn:`arn:aws:iam::${accountId}:role/deploy`}});
    await repos.connections.recordVerification(db,{workspaceId:A,id:connection.id,ok:true});
    await registerEnvironment(db,{environment:{workspaceId:A,environmentId,provider:"aws",region,class:"development",connection:{id:connection.id,status:"verified"}}});
    const sourceDigest=digest("tenant-source"),buildId="zenith-build-web:11111111-2222-3333-4444-555555555555";
    const binding:repos.buildLaunches.BuildLaunchBinding={workspaceId:A,operationId:op.id,environmentId,serviceAddress:service.address,serviceSpecDigest:service.specDigest,pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,
      accountId,region,projectName:"zenith-build-web",projectArn:`arn:aws:codebuild:${region}:${accountId}:project/zenith-build-web`,sourceBucket:"zenith-source-fixture",sourceKey:`zenith/${environmentId}/web/${sourceDigest}.zip`,sourceDigest,settingsDigest:digest("tenant-settings"),executedSettingsDigest:digest("tenant-executed-settings")};
    const fence={scope:lease.scope,token:lease.fenceToken},claim=repos.buildLaunches.createIsolatedBuildClaimerForTests(h.broker);
    const first=await claim(db,binding,fence);
    expect(first).toMatchObject({claimed:true,launch:{workspace_id:A,phase:"dispatched",build_id:null}});
    let current=first.launch;
    const foreignBinding={...binding,workspaceId:B};
    const foreignLaunch=():repos.buildLaunches.BuildLaunch=>({...current,workspace_id:B,binding:foreignBinding,binding_digest:digest(foreignBinding)});
    const receiptRows=()=>db.query("select * from platform.build_launches where workspace_id=$1 and operation_id=$2 order by service_address",[A,op.id]);
    const authorityRows=async()=>({
      operation:await db.query("select * from platform.operations where workspace_id=$1 and id=$2",[A,op.id]),
      approvals:await db.query("select * from platform.approvals where workspace_id=$1 and operation_id=$2 order by id",[A,op.id]),
      lease:await db.query("select * from platform.leases where scope=$1",[fence.scope]),
      resources:await db.query("select * from platform.resources where workspace_id=$1 and environment_id=$2 order by address",[A,environmentId]),
      connection:await db.query("select * from platform.provider_connections where workspace_id=$1 and id=$2",[A,connection.id]),
      planUse:await db.query("select * from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[A,op.id]),
    });
    const authorityBefore=await authorityRows();
    const attempts:Record<string,()=>Promise<void>>={
      "buildLaunches.claim":async()=>{await expect(claim(ctx.db2,foreignBinding,fence)).rejects.toBeInstanceOf(repos.buildLaunches.BuildLaunchError);},
      "buildLaunches.acknowledge":async()=>{await expect(repos.buildLaunches.acknowledge(ctx.db2,foreignLaunch(),buildId,["tenant-accepted-request"])).rejects.toBeInstanceOf(repos.buildLaunches.BuildLaunchError);},
      "buildLaunches.get":async()=>{expect(await repos.buildLaunches.get(ctx.db2,B,op.id,buildId)).toBeNull();},
      "buildLaunches.observeTerminal":async()=>{await expect(repos.buildLaunches.observeTerminal(ctx.db2,foreignLaunch(),{status:"STOPPED",finishedAt,requestId:"tenant-terminal-read"})).rejects.toBeInstanceOf(repos.buildLaunches.BuildLaunchError);},
    };
    expect(new Set(Object.keys(attempts))).toEqual(BUILD_LAUNCH_SWEPT);
    const foreignAttempt=async(name:string)=>{
      const before=await receiptRows();
      await attempts[name]();
      expect(await receiptRows(),`${name} preserved A's immutable receipt`).toEqual(before);
      expect(await authorityRows(),`${name} preserved A's authority`).toEqual(authorityBefore);
      expect(await db.query("select * from platform.build_launches where workspace_id=$1",[B])).toHaveLength(0);
    };
    await foreignAttempt("buildLaunches.claim");
    await foreignAttempt("buildLaunches.acknowledge");
    current=await repos.buildLaunches.acknowledge(db,first.launch,buildId,["tenant-accepted-request"]);
    expect(current.phase).toBe("accepted");
    expect(await repos.buildLaunches.get(db,A,op.id,buildId)).toEqual(current);
    await foreignAttempt("buildLaunches.get");
    await db.query("select pg_sleep(0.002)");
    const [provider]=await db.query<{finished_at:string;within_receipt_window:boolean}>(`select date_trunc('milliseconds',clock_timestamp())::text as finished_at,
      date_trunc('milliseconds',clock_timestamp())>=created_at as within_receipt_window
      from platform.build_launches where workspace_id=$1 and operation_id=$2 and phase='accepted'`,[A,op.id]);
    expect(provider.within_receipt_window).toBe(true);
    const finishedAt=new Date(provider.finished_at);
    await foreignAttempt("buildLaunches.observeTerminal");
    const terminal=await repos.buildLaunches.observeTerminal(db,current,{status:"STOPPED",finishedAt,requestId:"tenant-terminal-read"});
    expect(terminal).toMatchObject({phase:"terminal",terminal_status:"STOPPED"});
    expect(await authorityRows()).toEqual(authorityBefore);
  },15000);
});
