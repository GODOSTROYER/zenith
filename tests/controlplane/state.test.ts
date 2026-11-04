/**
 * Desired/observed/runtime resource state, drift, settings, connections,
 * incidents, cost, events, evidence and policy decisions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import type { AwsConnectionConfig } from "@/lib/credentials/types";
import type { Investigation } from "@/lib/incidents/types";
import type { CostEstimate } from "@/lib/placement/types";
import type { Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { LANES, expectCode, newWorkspace, openLane, seedApprovedOperation, sleep, uid } from "./_support/harness";

const hex = (c: string): string => c.repeat(64);

function node(address: string, over: Partial<ResourceNode> = {}): ResourceNode {
  return {
    address,
    kind: "container_service",
    provider: "aws",
    region: "ap-south-1",
    nativeType: "aws:ecs_service",
    ownership: "managed",
    spec: { replicas: 2, secretRef: "vault:db-password" },
    origin: ["service/web"],
    dependsOn: ["network/main"],
    specDigest: hex("a"),
    labels: { app: "web" },
    ...over,
  };
}

function observation(address: string, over: Partial<Observation> = {}): Observation {
  return {
    address,
    externalId: "arn:aws:ecs:ap-south-1:123456789012:service/web",
    presence: "present",
    attributes: {
      desiredCount: { state: "known", value: 3, observedAt: new Date().toISOString() },
      image: { state: "unknown", reason: "access_denied", detail: "ecs:DescribeTaskDefinition denied" },
    },
    native: { launchType: "FARGATE" },
    observedAt: new Date().toISOString(),
    source: "aws.ecs_service@1",
    simulated: false,
    ...over,
  };
}

const AWS_CONFIG: AwsConnectionConfig = {
  provider: "aws",
  mode: "oidc_web_identity",
  accountId: "123456789012",
  observeRoleArn: "arn:aws:iam::123456789012:role/zenith-observe",
  deployRoleArn: "arn:aws:iam::123456789012:role/zenith-deploy",
  region: "ap-south-1",
};

describe.each(LANES)("platform state [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });
  const db = () => ctx.db;

  describe("resources (desired + ownership)", () => {
    it("upserts by (environment, address), keeping the id stable, and maps the node back", async () => {
      const ws = newWorkspace();
      const env = uid("env");
      const created = await repos.resources.upsertDesired(db(), { workspaceId: ws, projectId: "proj_1", environmentId: env, node: node("service/web"), revisionId: "rev_1" });
      expect(created).toMatchObject({ workspaceId: ws, environmentId: env, address: "service/web", kind: "container_service", provider: "aws", region: "ap-south-1", nativeType: "aws:ecs_service", ownership: "managed", status: "planned", revisionId: "rev_1", specDigest: hex("a") });
      expect(created.spec).toEqual({ replicas: 2, secretRef: "vault:db-password" });
      expect(created.dependsOn).toEqual(["network/main"]);
      expect(created.labels).toEqual({ app: "web" });

      const updated = await repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("service/web", { spec: { replicas: 5 }, specDigest: hex("b") }), status: "updating" });
      expect(updated.id).toBe(created.id);
      expect(updated).toMatchObject({ status: "updating", specDigest: hex("b"), revisionId: "rev_1", projectId: "proj_1" });
      expect(updated.spec).toEqual({ replicas: 5 });
      expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));

      await repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("network/main", { kind: "network" }) });
      expect((await repos.resources.listByEnvironment(db(), ws, env)).map((r) => r.address)).toEqual(["network/main", "service/web"]);
      expect((await repos.resources.getByAddress(db(), ws, env, "service/web"))?.id).toBe(created.id);
      expect((await repos.resources.get(db(), ws, created.id))?.address).toBe("service/web");
    });

    it("never changes ownership as a side effect; changeOwnership is explicit and conditional", async () => {
      const ws = newWorkspace();
      const env = uid("env");
      const ref = await repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("resource/db", { ownership: "referenced", externalRef: "arn:aws:rds:x" }) });
      expect(ref.externalId).toBe("arn:aws:rds:x");
      await expectCode(repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("resource/db", { ownership: "managed" }) }), "conflict");
      expect((await repos.resources.get(db(), ws, ref.id))?.ownership).toBe("referenced");
      expect(await repos.resources.changeOwnership(db(), { workspaceId: ws, id: ref.id, from: "managed", to: "external" })).toBeNull(); // wrong current value
      expect((await repos.resources.changeOwnership(db(), { workspaceId: ws, id: ref.id, from: "referenced", to: "managed" }))?.ownership).toBe("managed");
      expect(await repos.resources.changeOwnership(db(), { workspaceId: newWorkspace(), id: ref.id, from: "managed", to: "external" })).toBeNull();
      await expectCode(repos.resources.changeOwnership(db(), { workspaceId: ws, id: ref.id, from: "managed", to: "managed" }), "invalid_input");
    });

    it("an environment belongs to one workspace: another workspace cannot write into it", async () => {
      const wsA = newWorkspace();
      const env = uid("env");
      await repos.resources.upsertDesired(db(), { workspaceId: wsA, environmentId: env, node: node("service/web") });
      const wsB = newWorkspace();
      await expectCode(repos.resources.upsertDesired(db(), { workspaceId: wsB, environmentId: env, node: node("service/web") }), "tenant_mismatch");
      await expectCode(repos.resources.upsertDesired(db(), { workspaceId: wsB, environmentId: env, node: node("service/other") }), "tenant_mismatch");
      expect(await repos.resources.listByEnvironment(db(), wsB, env)).toEqual([]);
      expect(await repos.resources.getByAddress(db(), wsB, env, "service/web")).toBeNull();
      expect(await repos.resources.listByEnvironment(db(), wsA, env)).toHaveLength(1);
    });

    it("hides deleted resources by default, validates statuses and digests, and refuses literal secrets in a spec", async () => {
      const ws = newWorkspace();
      const env = uid("env");
      const r = await repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("service/web") });
      expect((await repos.resources.setStatus(db(), ws, r.id, "deleted"))?.status).toBe("deleted");
      expect(await repos.resources.listByEnvironment(db(), ws, env)).toEqual([]);
      expect(await repos.resources.listByEnvironment(db(), ws, env, { includeDeleted: true })).toHaveLength(1);
      expect(await repos.resources.setStatus(db(), newWorkspace(), r.id, "active")).toBeNull();
      await expectCode(repos.resources.setStatus(db(), ws, r.id, "bogus" as never), "invalid_input");
      await expectCode(repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("x", { specDigest: "nope" }) }), "invalid_input");
      await expectCode(repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("x", { ownership: "mine" as never }) }), "invalid_input");
      await expectCode(repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("x", { spec: { conn: "postgres://admin:hunter2@db.internal/app" } }) }), "secret_material");
    });
  });

  describe("observations and runtime", () => {
    async function seededResource() {
      const ws = newWorkspace();
      const env = uid("env");
      const resource = await repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("service/web") });
      return { ws, env, resource };
    }

    it("stores an observation exactly as read — unknown attributes stay unknown — and returns the latest", async () => {
      const { ws, resource } = await seededResource();
      expect(await repos.observations.latestObservation(db(), ws, resource.id)).toBeNull();
      const t0 = Date.now();
      await repos.observations.appendObservation(db(), { workspaceId: ws, resourceId: resource.id, observation: observation("service/web", { observedAt: new Date(t0 - 5000).toISOString(), presence: "unknown", attributes: {} }) });
      const obs = observation("service/web", { observedAt: new Date(t0).toISOString(), simulated: true });
      await repos.observations.appendObservation(db(), { workspaceId: ws, resourceId: resource.id, observation: obs });
      const latest = await repos.observations.latestObservation(db(), ws, resource.id);
      expect(latest).toEqual(obs);
      expect(latest?.attributes.image).toEqual({ state: "unknown", reason: "access_denied", detail: "ecs:DescribeTaskDefinition denied" });
      expect((await repos.observations.observationHistory(db(), ws, resource.id)).map((o) => o.presence)).toEqual(["present", "unknown"]);
    });

    it("trims history to the latest N per resource on append and via prune", async () => {
      const { ws, resource } = await seededResource();
      const base = Date.now() - 60_000;
      for (let i = 0; i < 5; i++)
        await repos.observations.appendObservation(db(), { workspaceId: ws, resourceId: resource.id, keepLatest: 3, observation: observation("service/web", { observedAt: new Date(base + i * 1000).toISOString(), error: `#${i}` }) });
      const kept = await repos.observations.observationHistory(db(), ws, resource.id);
      expect(kept.map((o) => o.error)).toEqual(["#4", "#3", "#2"]);
      expect(await repos.observations.pruneObservations(db(), { workspaceId: ws, keepPerResource: 1 })).toBe(2);
      expect((await repos.observations.observationHistory(db(), ws, resource.id)).map((o) => o.error)).toEqual(["#4"]);
      expect(await repos.observations.pruneObservations(db(), { workspaceId: newWorkspace(), keepPerResource: 1 })).toBe(0);
      await expectCode(repos.observations.pruneObservations(db(), { workspaceId: ws, keepPerResource: 0 }), "invalid_input");
    });

    it("attaches only to a resource of the same workspace and address", async () => {
      const { ws, resource } = await seededResource();
      await expectCode(repos.observations.appendObservation(db(), { workspaceId: newWorkspace(), resourceId: resource.id, observation: observation("service/web") }), "not_found");
      await expectCode(repos.observations.appendObservation(db(), { workspaceId: ws, resourceId: resource.id, observation: observation("service/other") }), "not_found");
      await expectCode(repos.observations.appendObservation(db(), { workspaceId: ws, resourceId: resource.id, observation: observation("service/web", { native: { secret: "-----BEGIN PRIVATE KEY-----\nx" } }) }), "secret_material");
      expect(await repos.observations.latestObservation(db(), newWorkspace(), resource.id)).toBeNull();
    });

    it("latestObservationsByEnvironment returns one (the newest) per resource", async () => {
      const { ws, env, resource } = await seededResource();
      const second = await repos.resources.upsertDesired(db(), { workspaceId: ws, environmentId: env, node: node("resource/db", { kind: "postgres" }) });
      const t = Date.now();
      for (const [i, r] of [resource, resource, second].entries())
        await repos.observations.appendObservation(db(), { workspaceId: ws, resourceId: r.id, observation: observation(r.address, { observedAt: new Date(t + i * 1000).toISOString(), error: `o${i}` }) });
      const latest = await repos.observations.latestObservationsByEnvironment(db(), ws, env);
      expect(latest).toHaveLength(2);
      expect(latest.find((o) => o.resourceId === resource.id)?.error).toBe("o1");
      expect(await repos.observations.latestObservationsByEnvironment(db(), newWorkspace(), env)).toEqual([]);
    });

    it("runtime keeps the latest per resource: an older write loses, a newer wins", async () => {
      const { ws, env, resource } = await seededResource();
      const t = Date.now();
      const rt = (offset: number, running: number): RuntimeState => ({
        address: "service/web",
        health: running >= 3 ? "healthy" : "degraded",
        counts: { desired: 3, running, pending: 3 - running },
        signals: running < 3 ? [`task_stopped:OutOfMemory`] : [],
        observedAt: new Date(t + offset).toISOString(),
        source: "aws.ecs_service@1",
        simulated: false,
      });
      expect(await repos.observations.upsertRuntime(db(), { workspaceId: ws, resourceId: resource.id, runtime: rt(1000, 2) })).toBe(true);
      expect(await repos.observations.upsertRuntime(db(), { workspaceId: ws, resourceId: resource.id, runtime: rt(0, 3) })).toBe(false); // older loses
      expect((await repos.observations.getRuntime(db(), ws, resource.id))?.counts).toEqual({ desired: 3, running: 2, pending: 1 });
      expect(await repos.observations.upsertRuntime(db(), { workspaceId: ws, resourceId: resource.id, runtime: rt(2000, 3) })).toBe(true);
      const current = await repos.observations.getRuntime(db(), ws, resource.id);
      expect(current).toMatchObject({ health: "healthy", signals: [], simulated: false });
      expect((await repos.observations.listRuntimeByEnvironment(db(), ws, env)).map((r) => r.resourceId)).toEqual([resource.id]);
      expect(await repos.observations.getRuntime(db(), newWorkspace(), resource.id)).toBeNull();
      await expectCode(repos.observations.upsertRuntime(db(), { workspaceId: newWorkspace(), resourceId: resource.id, runtime: rt(3000, 3) }), "not_found");
    });
  });

  describe("drift reports", () => {
    it("persists findings, unknown/inaccessible results and unobserved addresses, latest first, bounded per environment", async () => {
      const ws = newWorkspace();
      const env = uid("env");
      const t = Date.now();
      for (let i = 0; i < 4; i++)
        await repos.drift.insert(db(), {
          workspaceId: ws,
          keepLatest: 2,
          report: {
            environmentId: env,
            graphDigest: hex(String(i)),
            computedAt: new Date(t + i * 1000).toISOString(),
            findings: [{ address: "service/web", class: i === 3 ? "inaccessible" : "changed", severity: "high", repairable: true, autoRepairEligible: false, explanation: `pass ${i}`, fields: [{ attribute: "replicas", desired: 3, observed: 2 }] }],
            unobserved: ["secret/api-key"],
            simulated: false,
          },
        });
      const all = await repos.drift.list(db(), ws, env);
      expect(all).toHaveLength(2);
      expect(all.map((r) => r.graphDigest)).toEqual([hex("3"), hex("2")]);
      const latest = await repos.drift.latest(db(), ws, env);
      expect(latest?.findings[0]).toMatchObject({ class: "inaccessible", explanation: "pass 3" });
      expect(latest?.unobserved).toEqual(["secret/api-key"]);
      expect(await repos.drift.latest(db(), newWorkspace(), env)).toBeNull();
      expect(await repos.drift.list(db(), newWorkspace(), env)).toEqual([]);
    });

    it("refuses a report for an environment that belongs to another workspace", async () => {
      const wsA = newWorkspace();
      const env = uid("env");
      await repos.resources.upsertDesired(db(), { workspaceId: wsA, environmentId: env, node: node("service/web") });
      const report = { environmentId: env, graphDigest: hex("1"), computedAt: new Date().toISOString(), findings: [], unobserved: [], simulated: false };
      await expectCode(repos.drift.insert(db(), { workspaceId: newWorkspace(), report }), "tenant_mismatch");
      await repos.drift.insert(db(), { workspaceId: wsA, report });
    });
  });

  describe("environment settings and workspace policy", () => {
    it("returns the conservative default for an unconfigured environment, without writing it", async () => {
      const ws = newWorkspace();
      const env = uid("env");
      const s = await repos.settings.getEnvironmentSettings(db(), ws, env);
      expect(s).toMatchObject({ autonomyLevel: 1, version: 0, isDefault: true, policyParams: {} });
      expect(await db().query("select 1 from platform.environment_settings where environment_id = $1", [env])).toEqual([]);
    });

    it("writes with optimistic concurrency: a stale expectedVersion conflicts, nobody silently overwrites", async () => {
      const ws = newWorkspace();
      const env = uid("env");
      const created = await repos.settings.putEnvironmentSettings(db(), { workspaceId: ws, environmentId: env, autonomyLevel: 3, policyParams: { maxCostUsd: 100 }, updatedBy: "u1", expectedVersion: 0 });
      expect(created).toMatchObject({ autonomyLevel: 3, version: 1, isDefault: false, updatedBy: "u1", policyParams: { maxCostUsd: 100 } });
      await expectCode(repos.settings.putEnvironmentSettings(db(), { workspaceId: ws, environmentId: env, autonomyLevel: 5, updatedBy: "u2", expectedVersion: 0 }), "conflict");
      const next = await repos.settings.putEnvironmentSettings(db(), { workspaceId: ws, environmentId: env, autonomyLevel: 2, updatedBy: "u2", expectedVersion: 1 });
      expect(next).toMatchObject({ autonomyLevel: 2, version: 2 });
      await expectCode(repos.settings.putEnvironmentSettings(db(), { workspaceId: ws, environmentId: env, autonomyLevel: 4, updatedBy: "u3", expectedVersion: 1 }), "conflict");
      expect((await repos.settings.getEnvironmentSettings(db(), ws, env)).autonomyLevel).toBe(2);
    });

    it("validates the autonomy level, refuses secrets, and never lets another workspace take or read an environment", async () => {
      const ws = newWorkspace();
      const env = uid("env");
      for (const bad of [-1, 6, 1.5, Number.NaN]) await expectCode(repos.settings.putEnvironmentSettings(db(), { workspaceId: ws, environmentId: env, autonomyLevel: bad as never, updatedBy: "u" }), "invalid_input");
      await expectCode(repos.settings.putEnvironmentSettings(db(), { workspaceId: ws, environmentId: env, autonomyLevel: 1, policyParams: { k: "-----BEGIN PRIVATE KEY-----\nx" }, updatedBy: "u" }), "secret_material");
      await repos.settings.putEnvironmentSettings(db(), { workspaceId: ws, environmentId: env, autonomyLevel: 4, updatedBy: "u" });
      await expectCode(repos.settings.putEnvironmentSettings(db(), { workspaceId: newWorkspace(), environmentId: env, autonomyLevel: 5, updatedBy: "intruder" }), "tenant_mismatch");
      const foreign = await repos.settings.getEnvironmentSettings(db(), newWorkspace(), env);
      expect(foreign).toMatchObject({ isDefault: true, autonomyLevel: 1 }); // sees a default, not the other tenant's row
      expect((await repos.settings.getEnvironmentSettings(db(), ws, env)).autonomyLevel).toBe(4);
    });

    it("workspace policy: default, versioned writes, isolation", async () => {
      const ws = newWorkspace();
      expect(await repos.settings.getWorkspacePolicy(db(), ws)).toMatchObject({ params: {}, version: 0, isDefault: true });
      const v1 = await repos.settings.putWorkspacePolicy(db(), { workspaceId: ws, params: { costApprovalThresholdUsd: 50 }, updatedBy: "admin", expectedVersion: undefined });
      expect(v1).toMatchObject({ version: 1, params: { costApprovalThresholdUsd: 50 } });
      const v2 = await repos.settings.putWorkspacePolicy(db(), { workspaceId: ws, params: { costApprovalThresholdUsd: 75 }, updatedBy: "admin", expectedVersion: 1 });
      expect(v2.version).toBe(2);
      await expectCode(repos.settings.putWorkspacePolicy(db(), { workspaceId: ws, params: {}, updatedBy: "admin", expectedVersion: 1 }), "conflict");
      expect(await repos.settings.getWorkspacePolicy(db(), newWorkspace())).toMatchObject({ isDefault: true, params: {} });
    });
  });

  describe("provider connections", () => {
    it("creates pending, verifies, lists workspace-scoped, and revoke is terminal", async () => {
      const ws = newWorkspace();
      const conn = await repos.connections.create(db(), { workspaceId: ws, config: AWS_CONFIG, createdBy: "u1" });
      expect(conn).toMatchObject({ workspaceId: ws, status: "pending_verification", config: AWS_CONFIG, createdBy: "u1" });
      const verified = await repos.connections.recordVerification(db(), { workspaceId: ws, id: conn.id, ok: true, detail: "sts:GetCallerIdentity ok" });
      expect(verified).toMatchObject({ status: "verified", verificationDetail: "sts:GetCallerIdentity ok" });
      expect(verified?.verifiedAt).toBeDefined();
      expect((await repos.connections.recordVerification(db(), { workspaceId: ws, id: conn.id, ok: false, detail: "expired trust" }))?.status).toBe("failed");
      expect((await repos.connections.list(db(), ws)).map((c) => c.id)).toEqual([conn.id]);
      expect(await repos.connections.list(db(), newWorkspace())).toEqual([]);
      expect(await repos.connections.get(db(), newWorkspace(), conn.id)).toBeNull();
      expect(await repos.connections.revoke(db(), newWorkspace(), conn.id)).toBeNull();

      const revoked = await repos.connections.revoke(db(), ws, conn.id);
      expect(revoked?.status).toBe("revoked");
      expect(revoked?.revokedAt).toBeDefined();
      expect(await repos.connections.recordVerification(db(), { workspaceId: ws, id: conn.id, ok: true })).toBeNull(); // terminal
      expect(await repos.connections.list(db(), ws)).toEqual([]);
      expect(await repos.connections.list(db(), ws, { includeRevoked: true })).toHaveLength(1);
      expect((await repos.connections.revoke(db(), ws, conn.id))?.revokedAt).toBe(revoked?.revokedAt); // idempotent
    });

    it("rejects any config member named like a secret — at any depth — and any key-material value", async () => {
      const ws = newWorkspace();
      const make = (extra: Record<string, unknown>) => repos.connections.create(db(), { workspaceId: ws, createdBy: "u", config: { ...AWS_CONFIG, ...extra } as never });
      for (const key of ["secretAccessKey", "SecretAccessKey", "secret_access_key", "password", "passwd", "token", "sessionToken", "accessToken", "privateKey", "private_key", "apiKey", "api-key", "clientSecret", "accessKey", "bearerToken"])
        await expectCode(make({ [key]: "x" }), "secret_material");
      await expectCode(make({ nested: { deeper: [{ password: "x" }] } }), "secret_material");
      await expectCode(make({ note: "-----BEGIN RSA PRIVATE KEY-----\nMIIB" }), "secret_material");
      await expectCode(make({ keyId: "AKIAABCDEFGHIJKLMNOP" }), "secret_material");
      expect(await repos.connections.list(db(), ws, { includeRevoked: true })).toEqual([]);
    });

    it("allows references: credentialRef, ARNs, secret names", async () => {
      const ws = newWorkspace();
      const conn = await repos.connections.create(db(), {
        workspaceId: ws,
        createdBy: "u",
        config: { provider: "kubernetes", mode: "kubeconfig_ref", server: "https://k8s.example.com", credentialRef: "vault:k8s-token", namespaces: ["prod"], eks: { clusterName: "c", awsConnectionId: "conn_1" } },
      });
      expect(conn.config).toMatchObject({ credentialRef: "vault:k8s-token" });
      const named = await repos.connections.create(db(), { workspaceId: ws, createdBy: "u", config: { ...AWS_CONFIG, externalId: "zx-123", secretArn: "arn:aws:secretsmanager:ap-south-1:123456789012:secret:x", tokenName: "vault-token" } as never });
      expect(named.id).toBeDefined();
    });
  });

  describe("incidents and investigations", () => {
    it("opens, lists, moves forward conditionally, and resolved is terminal", async () => {
      const ws = newWorkspace();
      const inc = await repos.incidents.openIncident(db(), { workspaceId: ws, environmentId: "env_1", title: "5xx spike on web", severity: "high", source: "alert", document: { alarm: "HTTPCode_Target_5XX_Count" } });
      expect(inc).toMatchObject({ status: "open", severity: "high", workspaceId: ws });
      expect(inc.correlationId).toMatch(/^corr_/);
      expect(inc.resolvedAt).toBeUndefined();
      expect((await repos.incidents.listIncidents(db(), ws, { status: ["open"] })).map((i) => i.id)).toEqual([inc.id]);
      expect(await repos.incidents.listIncidents(db(), ws, { status: "resolved" })).toEqual([]);

      expect(await repos.incidents.transitionIncident(db(), { workspaceId: ws, id: inc.id, from: ["investigating"], to: "mitigating" })).toBeNull();
      const investigating = await repos.incidents.transitionIncident(db(), { workspaceId: ws, id: inc.id, from: ["open"], to: "investigating", summary: "checking target health" });
      expect(investigating).toMatchObject({ status: "investigating", summary: "checking target health" });
      const resolved = await repos.incidents.transitionIncident(db(), { workspaceId: ws, id: inc.id, from: ["open", "investigating", "mitigating"], to: "resolved" });
      expect(resolved?.resolvedAt).toBeDefined();
      await expectCode(repos.incidents.transitionIncident(db(), { workspaceId: ws, id: inc.id, from: ["resolved"], to: "open" }), "invalid_state");
      await expectCode(repos.incidents.transitionIncident(db(), { workspaceId: ws, id: inc.id, from: ["mitigating"], to: "investigating" }), "invalid_state");
      expect(await repos.incidents.transitionIncident(db(), { workspaceId: newWorkspace(), id: inc.id, from: ["open"], to: "investigating" })).toBeNull();
      expect(await repos.incidents.getIncident(db(), newWorkspace(), inc.id)).toBeNull();
    });

    it("stores a finished investigation whole and reads it back scoped to its workspace", async () => {
      const ws = newWorkspace();
      const inc = await repos.incidents.openIncident(db(), { workspaceId: ws, environmentId: "env_1", title: "db down", severity: "critical", source: "user" });
      const investigation: Investigation = {
        id: uid("inv"),
        incidentId: inc.id,
        workspaceId: ws,
        environmentId: "env_1",
        startedAt: new Date(Date.now() - 2000).toISOString(),
        finishedAt: new Date().toISOString(),
        path: [{ hop: "database", address: "resource/db", status: "failing" }],
        evidence: [{ id: "e1", hop: "database", address: "resource/db", check: "aws.rds.DescribeDBInstances", outcome: "fail", finding: "instance is stopped", observedAt: new Date().toISOString(), data: { status: "stopped" }, simulated: false }],
        hypotheses: [{ id: "h1", code: "db_stopped", title: "Database is stopped", confidence: 0.9, category: "runtime", supportingEvidence: ["e1"], contradictingEvidence: [], remediations: [] }],
        recentChanges: [],
        simulated: false,
      };
      expect(await repos.incidents.insertInvestigation(db(), investigation)).toEqual(investigation);
      expect(await repos.incidents.getInvestigation(db(), ws, investigation.id)).toEqual(investigation);
      expect(await repos.incidents.listInvestigationsForIncident(db(), ws, inc.id)).toEqual([investigation]);
      expect(await repos.incidents.getInvestigation(db(), newWorkspace(), investigation.id)).toBeNull();
      expect(await repos.incidents.listInvestigationsForIncident(db(), newWorkspace(), inc.id)).toEqual([]);
    });
  });

  describe("cost estimates", () => {
    const estimate = (usd: number): CostEstimate => ({ kind: "estimate", catalogVersion: "2026-09-30.1", currency: "USD", monthlyUsd: usd, lines: [], assumptions: { egressGb: 100 }, included: ["NAT gateway"], excluded: ["data transfer"], computedAt: new Date().toISOString() });

    it("stores an estimate as a number and the full document, newest first, workspace scoped", async () => {
      const ws = newWorkspace();
      const a = await repos.cost.insert(db(), { workspaceId: ws, environmentId: "env_1", estimate: estimate(123.45) });
      await sleep(5);
      const b = await repos.cost.insert(db(), { workspaceId: ws, environmentId: "env_1", operationId: "op_1", estimate: estimate(200) });
      expect(typeof a.monthlyUsd).toBe("number");
      expect(a.monthlyUsd).toBeCloseTo(123.45);
      expect(a.estimate.kind).toBe("estimate");
      expect((await repos.cost.list(db(), ws, { environmentId: "env_1" })).map((c) => c.id)).toEqual([b.id, a.id]);
      expect((await repos.cost.list(db(), ws, { operationId: "op_1" })).map((c) => c.id)).toEqual([b.id]);
      expect(await repos.cost.get(db(), newWorkspace(), a.id)).toBeNull();
      expect(await repos.cost.list(db(), newWorkspace())).toEqual([]);
      await expectCode(repos.cost.insert(db(), { workspaceId: ws, estimate: { ...estimate(1), kind: "invoice" as never } }), "invalid_input");
    });
  });

  describe("events", () => {
    const evt = (ws: string, over: Record<string, unknown> = {}) => ({ type: "operation.started" as const, workspaceId: ws, correlationId: "corr_1", ...over });

    it("appends with a monotonic seq, lists per workspace with filters and paging", async () => {
      const ws = newWorkspace();
      const s1 = await repos.events.append(db(), evt(ws, { operationId: "op_a", data: { n: 1 } }));
      const s2 = await repos.events.append(db(), evt(ws, { operationId: "op_a", type: "operation.succeeded", correlationId: "corr_2" }));
      const s3 = await repos.events.append(db(), evt(ws, { operationId: "op_b", actor: { kind: "system", id: "system", name: "Zenith" } }));
      expect(typeof s1).toBe("number");
      expect(s2).toBeGreaterThan(s1);
      expect(s3).toBeGreaterThan(s2);
      const all = await repos.events.list(db(), ws);
      expect(all.map((e) => e.seq)).toEqual([s1, s2, s3]);
      expect(all[0]).toMatchObject({ type: "operation.started", data: { n: 1 }, workspaceId: ws });
      expect(all[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(all[2].actor).toEqual({ kind: "system", id: "system", name: "Zenith" });
      expect((await repos.events.list(db(), ws, { operationId: "op_a" })).map((e) => e.seq)).toEqual([s1, s2]);
      expect((await repos.events.list(db(), ws, { correlationId: "corr_2" })).map((e) => e.seq)).toEqual([s2]);
      expect((await repos.events.list(db(), ws, { afterSeq: s1, limit: 1 })).map((e) => e.seq)).toEqual([s2]);
      expect((await repos.events.list(db(), ws, { type: "operation.succeeded" })).map((e) => e.seq)).toEqual([s2]);
      await expectCode(repos.events.list(db(), ws, { afterSeq: -1 }), "invalid_input");
    });

    it("is idempotent by id within a workspace and refuses the same id from another", async () => {
      const ws = newWorkspace();
      const id = uid("evt");
      const first = await repos.events.append(db(), evt(ws, { id }));
      expect(await repos.events.append(db(), evt(ws, { id }))).toBe(first);
      expect(await repos.events.list(db(), ws)).toHaveLength(1);
      await expectCode(repos.events.append(db(), evt(newWorkspace(), { id })), "conflict");
    });

    it("never crosses workspaces, refuses secret values, malformed types and oversized data", async () => {
      const ws = newWorkspace();
      await repos.events.append(db(), evt(ws));
      expect(await repos.events.list(db(), newWorkspace())).toEqual([]);
      await expectCode(repos.events.append(db(), evt(ws, { data: { auth: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" } })), "secret_material");
      await expectCode(repos.events.append(db(), evt(ws, { data: { url: "https://admin:hunter2@db.example.com/x" } })), "secret_material");
      await expectCode(repos.events.append(db(), evt(ws, { type: "Not A Type" })), "invalid_input");
      await expectCode(repos.events.append(db(), evt(ws, { data: { blob: "x".repeat(70_000) } })), "invalid_input");
      // key names alone are not refused in free-form data: a usage counter called tokenCount is legitimate
      await repos.events.append(db(), evt(ws, { data: { tokenCount: 1200 } }));
      expect(await repos.events.list(db(), ws)).toHaveLength(2);
    });
  });

  describe("evidence and policy decisions", () => {
    it("evidence: insert, get, list scoped; refuses secrets and bad digests", async () => {
      const ws = newWorkspace();
      const ev = await repos.evidence.insert(db(), { workspaceId: ws, operationId: "op_1", kind: "tofu_plan", digest: hex("c"), summary: { adds: 3, destroys: 0 }, blobRef: "s3://evidence/plan.json", simulated: false });
      expect(ev).toMatchObject({ kind: "tofu_plan", digest: hex("c"), summary: { adds: 3, destroys: 0 }, blobRef: "s3://evidence/plan.json", simulated: false });
      expect(await repos.evidence.get(db(), ws, ev.id)).toEqual(ev);
      expect((await repos.evidence.list(db(), ws, { operationId: "op_1" })).map((e) => e.id)).toEqual([ev.id]);
      expect(await repos.evidence.get(db(), newWorkspace(), ev.id)).toBeNull();
      expect(await repos.evidence.list(db(), newWorkspace())).toEqual([]);
      await expectCode(repos.evidence.insert(db(), { workspaceId: ws, kind: "tofu_plan", digest: "bad", summary: {}, simulated: false }), "invalid_input");
      await expectCode(repos.evidence.insert(db(), { workspaceId: ws, kind: "tofu_plan", digest: hex("d"), summary: { out: "AKIAABCDEFGHIJKLMNOP" }, simulated: false }), "secret_material");
      await expect(repos.evidence.insert(db(), { workspaceId: ws, kind: "not_a_kind" as never, digest: hex("d"), summary: {}, simulated: false })).rejects.toMatchObject({ sqlstate: "23514" });
    });

    it("policy decisions: insert, get, list for an operation; tenant-checked", async () => {
      const seeded = await seedApprovedOperation(db());
      const ws = seeded.workspaceId;
      const d = await repos.policyDecisions.insert(db(), { workspaceId: ws, operationId: seeded.operation.id, policyVersion: hex("a"), inputDigest: hex("b"), outcome: "require_approval", reasons: [{ code: "prod", message: "needs approval", rule: "zenith.rules.prod" }], approval: { count: 2, minRole: "admin", separationOfDuties: true }, constraints: { maxReplicas: 5 } });
      expect(d).toMatchObject({ outcome: "require_approval", approval: { count: 2, minRole: "admin", separationOfDuties: true }, constraints: { maxReplicas: 5 } });
      expect(d.reasons[0].rule).toBe("zenith.rules.prod");
      expect(await repos.policyDecisions.get(db(), ws, d.id)).toEqual(d);
      expect((await repos.policyDecisions.listForOperation(db(), ws, seeded.operation.id)).map((x) => x.id)).toEqual([d.id]);
      expect(await repos.policyDecisions.get(db(), newWorkspace(), d.id)).toBeNull();
      expect(await repos.policyDecisions.listForOperation(db(), newWorkspace(), seeded.operation.id)).toEqual([]);
      await expectCode(repos.policyDecisions.insert(db(), { workspaceId: ws, policyVersion: "v", inputDigest: hex("b"), outcome: "maybe" as never, reasons: [] }), "invalid_input");
      await expect(
        repos.policyDecisions.insert(db(), { workspaceId: newWorkspace(), operationId: seeded.operation.id, policyVersion: "v", inputDigest: hex("b"), outcome: "allow", reasons: [] })
      ).rejects.toMatchObject({ sqlstate: "23503" });
    });
  });
});
