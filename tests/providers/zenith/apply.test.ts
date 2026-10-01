import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { managedDatabaseConnectionRef, unavailableDatabaseProvider } from "@/lib/providers/zenith/database";
import { createNeonProvider } from "@/lib/providers/zenith/neon";
import { assertSessionMatches, openZenithSession } from "@/lib/providers/zenith/session";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { ZenithError } from "@/lib/providers/zenith/types";
import { DB, DB_PASSWORD, FakeNeon, FakeToolkit, K8S_SESSION, MemorySink, NEON_KEY, NS, SECRET, TENANT, TYPICAL_GRAPH, WEB, resolver, session, substrate } from "./support";

const KEY_REF = "vault:zenith-managed/neon-api-key";
const DB_REF = managedDatabaseConnectionRef(TENANT.environmentId, "postgres/db");

let neon: FakeNeon;
let sink: MemorySink;
let toolkit: FakeToolkit;

beforeEach(async () => {
  neon = new FakeNeon();
  await neon.start();
  sink = new MemorySink();
  toolkit = new FakeToolkit();
});
afterEach(async () => {
  await neon.stop();
});

const neonProvider = () =>
  createNeonProvider({ provider: "neon", apiBase: neon.url, apiKeyRef: KEY_REF, regionId: "aws-us-east-2", egress: [] }, { fetch: (i, n) => fetch(i, n), resolveSecret: resolver(KEY_REF, NEON_KEY), sink, timeoutMs: 3000 });

/** Resolves the connection secret from the sink, like the vault behind the real executor. */
const vault = async (ref: string) => sink.values.get(ref);

const expectTenant = { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId };

describe("applyZenithEnvironment", () => {
  it("ensures the database, then applies the baseline, then the workloads, each as its own apply", async () => {
    const s = session(neonProvider());
    const report = await applyZenithEnvironment({ session: s, expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault });
    expect(report.ok).toBe(true);
    expect(report.blockedBy).toBeUndefined();
    expect(report.databases.map((d) => d.status)).toEqual(["created"]);
    expect(toolkit.applyCalls).toHaveLength(2);
    const [baseline, workloads] = toolkit.applyCalls;
    expect(baseline.objects.map((o) => o.kind)).toEqual(["Namespace", "ServiceAccount", "ResourceQuota", "LimitRange", "NetworkPolicy", "NetworkPolicy"]);
    expect(workloads.objects.some((o) => o.kind === "Deployment")).toBe(true);
    expect(workloads.objects.some((o) => o.kind === "HTTPRoute")).toBe(true);
    expect(workloads.objects.some((o) => o.kind === "StatefulSet")).toBe(false);
    expect(baseline.environmentId).toBe(TENANT.environmentId);
  });

  it("stores the connection secret before the workloads need it, so their Secret objects resolve", async () => {
    const s = session(neonProvider());
    const report = await applyZenithEnvironment({ session: s, expect: expectTenant, toolkit, nodes: [...TYPICAL_GRAPH], resolveSecret: vault });
    expect(report.ok).toBe(true);
    expect(sink.values.get(DB_REF)).toMatch(/^postgresql:/);
    expect(toolkit.applyCalls[1].objects.some((o) => o.kind === "Secret")).toBe(true);
  });

  it("converges: applying twice creates the database once", async () => {
    const s = session(neonProvider());
    await applyZenithEnvironment({ session: s, expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault });
    const second = await applyZenithEnvironment({ session: s, expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault });
    expect(second.databases.map((d) => d.status)).toEqual(["exists"]);
    expect(neon.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("applies nothing at all when the database provider is unavailable", async () => {
    const s = session(unavailableDatabaseProvider("no provider configured"));
    const report = await applyZenithEnvironment({ session: s, expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault });
    expect(report.ok).toBe(false);
    expect(report.blockedBy).toBe("database");
    expect(report.databases[0].error?.code).toBe("unavailable");
    expect(toolkit.applyCalls).toHaveLength(0);
  });

  it("applies nothing when creating the database fails", async () => {
    neon.failures.push({ match: "GET /projects", status: 500, times: 1 });
    const report = await applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault });
    expect(report.blockedBy).toBe("database");
    expect(toolkit.applyCalls).toHaveLength(0);
  });

  it("does not apply workloads when the baseline did not apply, and says so", async () => {
    toolkit.failApplyAt = 0;
    const report = await applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault });
    expect(report.ok).toBe(false);
    expect(report.blockedBy).toBe("baseline");
    expect(report.baseline?.refused).toBe(true);
    expect(report.workloads).toBeUndefined();
    expect(toolkit.applyCalls).toHaveLength(1);
  });

  it("reports a workload ownership conflict as blocked by workloads, with the baseline already in place", async () => {
    toolkit.failApplyAt = 1;
    const report = await applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault });
    expect(report.blockedBy).toBe("workloads");
    expect(report.baseline?.ok).toBe(true);
    expect(report.workloads?.results[0].status).toBe("ownership_conflict");
  });

  it("surfaces the apply layer's refusal of a kind it does not know (the documented dependency on the Kubernetes provider)", async () => {
    toolkit.refuseKinds = new Set(["ResourceQuota", "LimitRange", "HTTPRoute"]);
    const report = await applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: [WEB], resolveSecret: vault });
    expect(report.ok).toBe(false);
    expect(report.blockedBy).toBe("baseline");
    expect(JSON.stringify(report.baseline)).toMatch(/does not apply/);
  });

  it("refuses to act for a different tenant than the session was opened for", async () => {
    const s = session(neonProvider());
    await expect(applyZenithEnvironment({ session: s, expect: { workspaceId: "ws_other", environmentId: TENANT.environmentId }, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault })).rejects.toMatchObject({ code: "tenant_mismatch" });
    await expect(applyZenithEnvironment({ session: s, expect: { workspaceId: TENANT.workspaceId, environmentId: "env_other" }, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault })).rejects.toMatchObject({ code: "tenant_mismatch" });
    expect(toolkit.applyCalls).toHaveLength(0);
    expect(neon.requests).toHaveLength(0);
  });

  it("rejects a render error before touching the database or the cluster", async () => {
    const redis = { ...DB, address: "redis/cache", kind: "redis" as const, nativeType: "k8s:StatefulSet" };
    await expect(applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: [WEB, redis], resolveSecret: vault })).rejects.toBeInstanceOf(ZenithError);
    expect(toolkit.applyCalls).toHaveLength(0);
    expect(neon.requests).toHaveLength(0);
  });

  it("honors a cancelled signal on the database call and applies nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    const report = await applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault, signal: ac.signal });
    expect(report.ok).toBe(false);
    expect(report.blockedBy).toBe("database");
    expect(toolkit.applyCalls).toHaveLength(0);
  });
});

describe("applyZenithEnvironment: dry run", () => {
  it("creates and calls no database, and runs both phases as dry runs", async () => {
    const report = await applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault, dryRun: true });
    expect(report.ok).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.databases.map((d) => d.status)).toEqual(["planned"]);
    expect(neon.requests).toHaveLength(0);
    expect(toolkit.applyCalls.map((c) => c.dryRun)).toEqual([true, true]);
    expect(toolkit.store.size).toBe(0);
  });

  it("gets past a connection secret that does not exist yet with a placeholder that never reaches the report", async () => {
    const seen: string[] = [];
    const report = await applyZenithEnvironment({
      session: session(neonProvider()),
      expect: expectTenant,
      toolkit,
      nodes: [SECRET, DB],
      resolveSecret: async (ref) => (seen.push(ref), undefined),
      dryRun: true,
    });
    expect(report.ok).toBe(true);
    expect(seen).toContain(DB_REF);
    expect(JSON.stringify(report)).not.toContain("placeholder");
    expect(sink.values.size).toBe(0);
  });

  it("does NOT paper over a missing secret that is not the managed database's", async () => {
    const other = { ...SECRET, address: "secret/other", spec: { ...SECRET.spec, secretRef: "vault:p/s/OTHER" } };
    const report = await applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: [other], resolveSecret: async () => undefined, dryRun: true });
    expect(report.ok).toBe(false);
    expect(report.blockedBy).toBe("workloads");
    expect(JSON.stringify(report.workloads)).toMatch(/could not be resolved/);
  });
});

describe("no secret in any report", () => {
  it("keeps connection details, keys and placeholders out of everything it returns", async () => {
    const logs: string[] = [];
    const report = await applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: TYPICAL_GRAPH, resolveSecret: vault, log: (l) => logs.push(l) });
    const text = JSON.stringify(report) + logs.join("\n");
    for (const canary of [DB_PASSWORD, NEON_KEY, "postgresql://", "neon.tech", "app_owner"]) expect(text, canary).not.toContain(canary);
    // the Secret OBJECTS handed to the apply layer carry only the reference
    const applied = JSON.stringify(toolkit.applyCalls);
    for (const canary of [DB_PASSWORD, NEON_KEY, "postgresql://"]) expect(applied, canary).not.toContain(canary);
  });
});

describe("sessions", () => {
  it("opens a session scoped to the tenant namespace with only a credential reference", async () => {
    const configs: unknown[] = [];
    const s = await openZenithSession(
      TENANT,
      {
        substrate: substrate(),
        createKubernetesSession: async (config) => (configs.push(config), K8S_SESSION),
        databases: neonProvider(),
      }
    );
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ provider: "kubernetes", mode: "kubeconfig_ref", credentialRef: "vault:zenith-managed/kubeconfig", namespaces: [tenantNamespace(TENANT.workspaceId, TENANT.environmentId)] });
    expect(s.tenant).toEqual(TENANT);
    expect(JSON.stringify(s)).not.toMatch(/kubeconfig|token|vault:/i);
    expect(s.expiresAt).toBe(K8S_SESSION.expiresAt);
  });

  it("refuses an invalid tenant before opening any connection", async () => {
    let opened = 0;
    await expect(
      openZenithSession({ ...TENANT, workspaceSlug: "BAD SLUG" }, { substrate: substrate(), createKubernetesSession: async () => (opened++, K8S_SESSION), databases: neonProvider() })
    ).rejects.toMatchObject({ code: "invalid_tenant" });
    expect(opened).toBe(0);
  });

  it("assertSessionMatches refuses another workspace or environment", () => {
    const s = session(neonProvider());
    expect(() => assertSessionMatches(s, { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId })).not.toThrow();
    expect(() => assertSessionMatches(s, { workspaceId: "ws_x", environmentId: TENANT.environmentId })).toThrow(/different workspace or environment/);
    expect(() => assertSessionMatches(s, { workspaceId: TENANT.workspaceId, environmentId: "env_x" })).toThrow(ZenithError);
  });

  it("the namespace the session allows is the namespace the pipeline renders into", async () => {
    const report = await applyZenithEnvironment({ session: session(neonProvider()), expect: expectTenant, toolkit, nodes: [WEB], resolveSecret: vault });
    expect(report.namespace).toBe(NS);
  });
});
