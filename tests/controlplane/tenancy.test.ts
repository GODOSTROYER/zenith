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
import type { ResourceNode } from "@/lib/resources/types";
import { LANES, approve, newWorkspace, openLane, seedAwaitingApproval, uid, user } from "./_support/harness";

/** Functions exercised by the sweep (each named `namespace.function`). */
const SWEPT = new Set([
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
  "policyDecisions.get", "policyDecisions.listForOperation",
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
    expect(await bound.events.list("ws_x")).toEqual([]);
  });
});

/** Turn "not found in your workspace" refusals into an empty result for the sweep. */
async function seen<T>(promise: Promise<T>): Promise<unknown> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ControlStoreError && ["operation_not_found", "not_found", "tenant_mismatch"].includes(err.code)) return null;
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

    // ------------------------ workspace B tries everything -------------------------
    const dig = seeded.operation.proposalDigest;
    const attempts: Record<string, () => Promise<unknown>> = {
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
    expect(new Set(Object.keys(attempts))).toEqual(SWEPT); // the sweep runs exactly what is classified as swept

    for (const [name, attempt] of Object.entries(attempts)) {
      const result = await attempt();
      expect(isEmpty(result), `${name} leaked or acted across tenants: ${JSON.stringify(result)?.slice(0, 200)}`).toBe(true);
    }

    // ------------------------ and A's data is exactly as it was -------------------------
    expect((await repos.operations.get(db, A, opId))?.status).toBe("approved");
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
