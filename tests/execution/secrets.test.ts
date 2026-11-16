/** Real vault/activity logic with mocked AWS SDK and scripted execution ports. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DescribeSecretCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, type World } from "./fakes/world";
import { ENV, PROJECT, WS, OP, webDbManifest } from "./fakes/fixtures";
import { createRuntime } from "@/lib/execution/runtime";
import { loadExecContext } from "@/lib/execution/context";
import { requireExecutable } from "@/lib/execution/desired";
import { syncEnvironmentSecrets } from "@/lib/execution/secrets";
import { putSecretAsync } from "@/lib/secrets";
import { LeaseLostError } from "@/lib/controlplane/types";
import type { ResourceNode } from "@/lib/resources/types";

const sm = mockClient(SecretsManagerClient);
const CANARY = "execution-sync-canary-KEEP-IN-MEMORY-123";
const worlds: World[] = [];
const arnFor = (n: ResourceNode) => `arn:aws:secretsmanager:us-east-1:123456789012:secret:zenith/zenith-${ENV}-${n.address.replace(/[^A-Za-z0-9_-]/g, "-")}-abcdef`;
beforeEach(() => { sm.reset(); vi.stubEnv("ZENITH_STORE", "file"); vi.stubEnv("ZENITH_SECRET_KEY", randomBytes(32).toString("base64")); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); while (worlds.length) worlds.pop()!.dispose(); });

async function fixture(count = 1) {
  const w = createWorld({ script: { observe: async (ctx, n) => ({ address: n.address, presence: "present", externalId: arnFor(n), attributes: {}, observedAt: ctx.now().toISOString(), source: "contract.fake", simulated: false }) } });
  worlds.push(w); vi.stubEnv("ZENITH_DATA", w.planDir);
  const manifest = webDbManifest();
  manifest.services[0].env = Array.from({ length: count }, (_, i) => ({ key: `KEY_${i}`, secretRef: `vault:${PROJECT}/svc-web/KEY_${i}` }));
  w.product.setManifest(manifest);
  await w.activities.markOperation({ operationId: OP, status: "running" });
  const lease = await w.lease();
  const rt = createRuntime(w.deps);
  const ec = await loadExecContext(rt, OP);
  const { graph } = requireExecutable(rt, ec);
  const nodes = graph.nodes.filter((n) => n.kind === "secret");
  for (const n of nodes) await putSecretAsync(WS, n.spec.secretRef as string, CANARY, "test-actor");
  const issue = w.broker.issueGrant.bind(w.broker);
  vi.spyOn(w.broker, "issueGrant").mockImplementation(async (...args) => {
    const result = await issue(...args);
    if (result.claims.cap === "secret.write") result.claims.constraints = { secretResources: nodes.map(arnFor) };
    return result;
  });
  sm.on(DescribeSecretCommand).callsFake((input: { SecretId?: string }) => {
    const n = nodes.find((n) => arnFor(n) === input.SecretId)!;
    return { ARN: input.SecretId, Tags: [{ Key: "zenith:managed", Value: "true" }, { Key: "zenith:workspace", Value: WS }, { Key: "zenith:environment", Value: ENV }, { Key: "zenith:resource", Value: n.address }], VersionIdsToStages: {} };
  });
  sm.on(PutSecretValueCommand).resolves({});
  const sync = () => syncEnvironmentSecrets(rt, ec, graph, w.connections.connections[0], lease, new AbortController().signal);
  return { w, rt, ec, graph, nodes, lease, sync };
}

describe("deployment secret sync gate", () => {
  it("syncs before any workload rollout and keeps canaries out of every persisted/output channel", async () => {
    const { w, lease } = await fixture();
    const deploy = vi.spyOn(w.workloads, "deployImage");
    deploy.mockImplementation(async () => { expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(1); return {}; });
    const args = { operationId: OP, lease, images: [{ service: "container_service/web", imageUri: `ghcr.io/web@sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` }] };
    const result = await w.activities.deployWorkloads(args);
    expect(result).toEqual({ services: 1 }); expect(deploy).toHaveBeenCalledTimes(1);
    expect(w.credentials.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "secret.write", purpose: "secret.write", revoked: true })]));
    expect(w.evidence.rows.find((r) => r.summary.kind === "secret.sync")?.summary).toMatchObject({ status: "done", completed: 1 });
    const channels = JSON.stringify({ args, result, stored: w.stored(), logs: w.logs, heartbeats: w.heartbeats, grants: w.broker.grants });
    expect(channels).not.toContain(CANARY);
    expect(readFileSync(path.join(w.planDir, "secrets.json"), "utf8")).not.toContain(CANARY);
  });
  it.each(["denied", "throttled", "unreachable"])("fails before rollout on %s and reports partial progress", async (reason) => {
    const { w, lease } = await fixture(2);
    sm.on(PutSecretValueCommand).resolvesOnce({}).rejectsOnce(Object.assign(new Error(CANARY), { name: reason === "denied" ? "AccessDeniedException" : reason === "throttled" ? "ThrottlingException" : CANARY }));
    const deploy = vi.spyOn(w.workloads, "deployImage");
    const error = await w.activities.deployWorkloads({ operationId: OP, lease, images: [] }).catch((e: unknown) => e);
    expect(String(error)).toContain("1/2 completed"); expect(String(error)).not.toContain(CANARY);
    expect(deploy).not.toHaveBeenCalled();
    expect(w.evidence.rows.find((r) => r.summary.kind === "secret.sync")?.summary).toMatchObject({ status: "partial", completed: 1, total: 2, reason });
    expect(JSON.stringify({ stored: w.stored(), logs: w.logs, error: String(error) })).not.toContain(CANARY);
  });
  it.each(["wrong-env", "foreign-workspace", "expired", "widened", "missing-resources", "wrong-op", "wrong-fence"])("refuses %s grants before decryption or writing", async (kind) => {
    const { w, sync } = await fixture();
    const implementation = vi.mocked(w.broker.issueGrant).getMockImplementation()!;
    vi.mocked(w.broker.issueGrant).mockImplementation(async (...args) => {
      const r = await implementation(...args);
      if (r.claims.cap === "secret.write") {
        if (kind === "wrong-env") r.claims.env = "foreign";
        if (kind === "foreign-workspace") r.claims.ws = "foreign";
        if (kind === "expired") r.claims.exp = 1;
        if (kind === "widened") (r.claims.constraints!.secretResources as string[]).push("*");
        if (kind === "missing-resources") delete r.claims.constraints;
        if (kind === "wrong-op") r.claims.op = "other-op";
        if (kind === "wrong-fence") r.claims.fence = 99;
      }
      return r;
    });
    await expect(sync()).rejects.toThrow("denied");
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(0);
    expect(w.credentials.sessions.filter((s) => s.purpose === "secret.write")).toHaveLength(0);
  });
  it("preserves the real broker's refusal instead of elevating a deployment grant locally", async () => {
    const { w, sync } = await fixture();
    const implementation = vi.mocked(w.broker.issueGrant).getMockImplementation()!;
    vi.mocked(w.broker.issueGrant).mockImplementation(async (...args) => {
      if (args[3]?.capability === "secret.write") throw new Error("Requested grant does not attenuate this operation.");
      return implementation(...args);
    });
    await expect(sync()).rejects.toThrow("Secret sync failed");
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });
  it("does not read missing vault values into outputs/errors, and does not roll workloads", async () => {
    const { w, nodes, sync } = await fixture();
    const { removeSecretAsync } = await import("@/lib/secrets");
    await removeSecretAsync(WS, nodes[0].spec.secretRef as string);
    await expect(sync()).rejects.toThrow("missing");
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(0);
    expect(w.stored()).not.toContain(CANARY);
  });
  it("records partial evidence without echoing a broken persistence sink", async () => {
    const { w, sync } = await fixture();
    vi.spyOn(w.evidence, "append").mockRejectedValue(new Error(CANARY));
    expect(await sync()).toMatchObject({ status: "done", completed: 1 });
    expect(JSON.stringify(w.logs)).not.toContain(CANARY);
  });
  it("preserves lease-loss classification and stops before the next secret write", async () => {
    const { w, lease, sync } = await fixture(2);
    sm.on(PutSecretValueCommand).callsFakeOnce(() => {
      vi.spyOn(w.leases, "assertFence").mockRejectedValue(new LeaseLostError(lease.scope, lease.fenceToken));
      return {};
    });
    await expect(sync()).rejects.toBeInstanceOf(LeaseLostError);
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(1);
    expect(w.evidence.rows.find((r) => r.summary.kind === "secret.sync")?.summary).toMatchObject({ status: "partial", completed: 1 });
  });
  it("bounds a stalled secret write and records its outcome as unknown", async () => {
    const { w, rt, sync } = await fixture();
    const send = SecretsManagerClient.prototype.send as (command: unknown, options: unknown) => Promise<unknown>;
    vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(function (this: SecretsManagerClient, command, options) {
      if (!(command instanceof PutSecretValueCommand)) return send.call(this, command, options);
      const signal = (options as { abortSignal: AbortSignal }).abortSignal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(CANARY)), { once: true });
      });
    });
    rt.limits.nodeTimeoutMs = 20;
    const error = await sync().catch((e: unknown) => e);
    expect(String(error)).toContain("write outcome is unknown"); expect(String(error)).not.toContain(CANARY);
    expect(w.evidence.rows.find((r) => r.summary.kind === "secret.sync")?.summary).toMatchObject({ status: "partial", completed: 0, outcomeUnknown: true });
  });
});
