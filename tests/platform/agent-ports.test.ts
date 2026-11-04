/** App composition plus real incident engine/fabric over mocked evidence. No live cloud reads. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { CredentialBroker, CredentialRequest } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { CredentialDeniedError } from "@/lib/credentials/types";
import { tempDataDir } from "../_support/data-dir";
import { argsFor, ids, makeHarness } from "../agent-v3/support";
import { CANARY, fakeAwsSession } from "../observability/_fixtures";
import type { FabricRequest } from "@/lib/agent-access/v3/ports";

tempDataDir("zenith-agent-ports-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { composeAgentPorts } = await import("@/lib/platform/agent-ports");
const { ensurePlatformApp, resetPlatformAppForTests } = await import("@/lib/platform/app");
const { defaultPorts, registerCredentialBroker, registerInvestigator } = await import("@/lib/agent-access/v3/adapters");
const { resetPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const { resetRunnerRuntime } = await import("@/lib/runners/runtime");
const { wireReconcilePorts } = await import("@/lib/reconcile/ports");
const { graphFor } = await import("@/lib/agent-access/v3/context");
let sql: Awaited<ReturnType<typeof openPlatformDb>>;
beforeAll(async () => {
  sql = await openPlatformDb({ kind: "pglite" });
  const connection = await repos.connections.create(sql, { id: "platform-connection", workspaceId: ids.ws, legacyConnectionId: "conn-a", createdBy: "contract-operator",
    config: { provider: "aws", mode: "runner", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy", runnerId: "runner-contract" } });
  await repos.connections.recordVerification(sql, { workspaceId: ids.ws, id: connection.id, ok: true, detail: "Mocked contract connection." });
});
afterAll(async () => { await sql.close(); });
afterEach(() => { resetPlatformAppForTests(); resetPlatformBrokerForTests(); resetRunnerRuntime(); wireReconcilePorts(null); vi.unstubAllEnvs(); });

async function setup(over: { denied?: boolean; failure?: boolean; hung?: boolean } = {}) {
  const h = await makeHarness();
  let inside = false;
  const requests: CredentialRequest[] = [];
  const credentials: CredentialBroker = {
    async withSession(req, fn) {
      requests.push(req);
      if (over.denied) throw new CredentialDeniedError(`secret=${CANARY.password}`, { reason: "runner_unavailable" });
      if (over.failure) throw new Error(`ARBITRARY-CREDENTIAL-CANARY-${CANARY.password}`);
      inside = true;
      try { return await fn(fakeAwsSession()); } finally { inside = false; }
    },
    verifyConnection: async () => ({ ok: false, detail: "Synthetic fixture" }),
  };
  const query = vi.fn(async () => {
    expect(inside).toBe(true);
    return { items: [{ timestamp: h.clock.now().toISOString(), environmentId: ids.env, address: "service/web-app", provider: "aws", severity: "error" as const,
      message: `password=${CANARY.password} connection refused ECONNREFUSED`, attributes: {}, native: {} }], sources: ["contract-fixture"], simulated: false, truncated: false, unavailable: [] };
  });
  const observe = vi.fn(async (ctx: DriverContext, node: ResourceNode) => {
    expect(inside).toBe(true); expect(ctx.session).toMatchObject({ provider: "aws" }); expect(ctx.workspaceId).toBe(ids.ws);
    if (over.hung) return new Promise<never>(() => {});
    return { address: node.address, presence: "present" as const, attributes: { replicas: { state: "known" as const, value: 2, observedAt: h.clock.now().toISOString() } }, source: "contract-driver", simulated: false, observedAt: h.clock.now().toISOString() };
  });
  const runtime = vi.fn(async (ctx: DriverContext, node: ResourceNode) => {
    expect(inside).toBe(true); expect(ctx.session).toMatchObject({ provider: "aws" });
    return { address: node.address, health: "unhealthy" as const, counts: { desired: 2, running: 0 }, signals: ["CrashLoopBackOff"], observedAt: h.clock.now().toISOString(), source: "contract-driver", simulated: false };
  });
  const composed = composeAgentPorts(sql, credentials, { reads: h.ports.reads, now: h.clock.now,
    sources: (input) => {
      expect(inside).toBe(true); expect(input.sessions.aws?.provider).toBe("aws"); expect(input.workspaceId).toBe(ids.ws);
      return [{ id: "contract-fixture", provider: "aws", supports: ["log", "metric", "event"], searchLogs: query,
        queryMetrics: async () => ({ items: [], sources: ["contract-fixture"], unavailable: [], simulated: false, truncated: false }), searchEvents: async () => ({ items: [], sources: ["contract-fixture"], unavailable: [], simulated: false, truncated: false }) }];
    },
    drivers: () => ({ id: "contract-driver", provider: "aws", nativeType: "aws:contract", kind: "container_service", capabilities: { compile: false, observe: true, runtime: true, verify: false, discover: false, operations: [], evidence: { observe: "contract", runtime: "contract" } }, observe, runtime, expectedAttributes: () => ({ replicas: 2 }) }),
  });
  registerCredentialBroker(credentials, composed.observability); registerInvestigator(composed.investigator);
  const defaults = defaultPorts(); h.ports.observability = defaults.observability; h.ports.investigator = defaults.investigator;
  const environment = h.environments.get(ids.env)!;
  const grant: CapabilityGrantClaims = { jti: "contract-read", sub: "agent", iss: "zenith", aud: "worker", iat: Math.floor(h.clock.ms / 1000), exp: Math.floor(h.clock.ms / 1000) + 900,
    ws: ids.ws, proj: ids.project, env: ids.env, cap: "logs.read", op: "read-contract", digest: "0".repeat(64) };
  const request: FabricRequest = { workspaceId: ids.ws, environment, grant, graph: graphFor(h.projects.get(ids.project)!.workingManifest, environment) };
  return { h, credentials, composed, requests, query, observe, runtime, request, inside: () => inside };
}

describe("registered app agent ports", () => {
  it("registers both ports exactly once after the schema guard and resets them for isolation", async () => {
    const defaults = defaultPorts(); expect(defaults.investigator.available).toBe(false);
    const first = ensurePlatformApp(sql); expect(ensurePlatformApp(sql)).toBe(first); expect(await first).toBe(true);
    expect(defaults.investigator.available).toBe(true); expect(defaults.observability).toBe(defaultPorts().observability);
    resetPlatformAppForTests(); expect(defaults.investigator.available).toBe(false);
  });

  it("keeps the incident engine unavailable when platform configuration is absent", async () => {
    // Isolate every production configuration source, including the genuine Supabase fallback.
    vi.stubEnv("ZENITH_PLATFORM_DB", ""); vi.stubEnv("ZENITH_PLATFORM_DB_URL", ""); vi.stubEnv("SUPABASE_DB_URL", "");
    expect(await ensurePlatformApp()).toBe(false); expect(defaultPorts().investigator.available).toBe(false);
  });

  it("resolves the product connection id before opening the observe session and never returns its credentials", async () => {
    const s = await setup(); const result = await s.h.invoke("zenith_query_logs", argsFor("zenith_query_logs"));
    expect(result.ok).toBe(true); expect(result.data.count).toBe(1);
    expect(s.requests[0]).toMatchObject({ connectionId: "platform-connection", purpose: "observe", grant: { cap: "logs.read", ws: ids.ws, proj: ids.project, env: ids.env } });
    expect(s.query).toHaveBeenCalledOnce(); expect(s.inside()).toBe(false); expect(JSON.stringify(result)).not.toContain(CANARY.password);
  });

  it("produces incident findings from mocked runtime and log evidence without starting a workflow", async () => {
    const s = await setup(); const result = await s.h.invoke("zenith_investigate_incident", { ...argsFor("zenith_investigate_incident"), symptom: "service unavailable" });
    expect(result.ok).toBe(true); expect(result.data.investigated).toBe(true);
    expect(s.observe).toHaveBeenCalled(); expect(s.runtime).toHaveBeenCalled(); expect(s.query).toHaveBeenCalled(); expect(s.requests).toHaveLength(1);
    expect(result.data.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "fail" })]));
    expect(result.data.hypotheses).not.toEqual([]); expect(JSON.stringify(result)).not.toContain(CANARY.password);
    expect(s.h.starts.deploy).toEqual([]); expect(s.h.starts.dayTwo).toEqual([]); expect(s.inside()).toBe(false);
  });

  it.each(["zenith_query_logs", "zenith_query_metrics", "zenith_investigate_incident"] as const)("%s uniformly refuses foreign and missing workspaces before credentials", async (tool) => {
    const s = await setup();
    for (const workspaceId of [ids.foreignWs, "missing-workspace"]) {
      const result = await s.h.invoke(tool, { ...argsFor(tool), target: { workspaceId, projectId: ids.foreignProject, environmentId: ids.foreignEnv } });
      expect(result.error?.code).toBe("not_found");
    }
    expect(s.requests).toEqual([]); expect(s.query).not.toHaveBeenCalled();
  });

  it("refuses mismatched, expired, mutating and resource-scoped grants before the broker", async () => {
    const s = await setup();
    for (const change of [{ ws: "foreign" }, { proj: "foreign" }, { env: "foreign" }, { cap: "service.restart" }, { exp: 0 }, { res: "resource-id" }]) {
      await expect(s.composed.observability.withFabric({ ...s.request, grant: { ...s.request.grant, ...change } }, async () => null)).rejects.toThrow();
    }
    expect(s.requests).toEqual([]);
  });

  it("refuses a callback query outside the authorized tenant or signal type", async () => {
    const s = await setup();
    await expect(s.composed.observability.withFabric(s.request, (fabric) => fabric.searchLogs({ scope: { workspaceId: "foreign", environmentId: ids.env }, range: { from: s.h.clock.now().toISOString() } }))).rejects.toThrow();
    await expect(s.composed.observability.withFabric(s.request, (fabric) => fabric.queryMetrics({ scope: { workspaceId: ids.ws, environmentId: ids.env }, range: { from: s.h.clock.now().toISOString() }, metrics: ["cpu.utilization"] }))).rejects.toThrow("signal");
    expect(s.query).not.toHaveBeenCalled(); expect(s.inside()).toBe(false);
  });

  it.each([{ denied: true }, { failure: true }])("reports broker failure safely: %j", async (over) => {
    const s = await setup(over); const result = await s.h.invoke("zenith_query_logs", argsFor("zenith_query_logs"));
    expect(result.ok).toBe(true); expect(result.data.count).toBe(0); expect(result.unavailable[0].source).toBe("credential-broker");
    expect(JSON.stringify(result)).not.toContain(CANARY.password); expect(s.query).not.toHaveBeenCalled(); expect(s.inside()).toBe(false);
  });

  it("does not repeat a callback that throws after a session was opened", async () => {
    const s = await setup(); const callback = vi.fn(async () => { throw new Error("callback failure"); });
    await expect(s.composed.observability.withFabric(s.request, callback)).rejects.toThrow("callback failure");
    expect(callback).toHaveBeenCalledOnce(); expect(s.requests).toHaveLength(1); expect(s.inside()).toBe(false);
  });

  it("marks recent changes unknown when the bounded ledger read is incomplete", async () => {
    const s = await setup();
    const list = vi.spyOn(repos.operations, "list").mockResolvedValue({ items: [], nextCursor: "more-history" });
    try {
      const result = await s.h.invoke("zenith_investigate_incident", argsFor("zenith_investigate_incident"));
      expect(result.ok).toBe(true);
      const evidence = result.untrusted_data?.content.evidence as { check: string; finding: string }[];
      expect(evidence.find((e) => e.check === "changes.recent")?.finding).toContain("coverage is unknown");
    } finally { list.mockRestore(); }
  });

  it("rechecks grant expiry before a query inside an already opened callback", async () => {
    const s = await setup();
    await expect(s.composed.observability.withFabric(s.request, (fabric) => {
      s.h.clock.ms += 901_000;
      return fabric.searchLogs({ scope: { workspaceId: ids.ws, environmentId: ids.env }, range: { from: s.h.clock.now().toISOString() } });
    })).rejects.toThrow("expired");
    expect(s.query).not.toHaveBeenCalled(); expect(s.inside()).toBe(false);
  });

  it("aborts a hung investigation promptly and releases the credential callback", async () => {
    const s = await setup({ hung: true }); const controller = new AbortController();
    const work = s.composed.investigator.investigate({ workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env, grant: { ...s.request.grant, cap: "incident.investigate" },
      range: { from: new Date(s.h.clock.ms - 30 * 60_000).toISOString(), to: s.h.clock.now().toISOString() }, signal: controller.signal });
    await vi.waitFor(() => expect(s.observe).toHaveBeenCalled());
    controller.abort(); await expect(work).rejects.toThrow(); expect(s.inside()).toBe(false);
  });
});
