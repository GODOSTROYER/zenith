/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-MAN-01: a `zenith`-provider (Zenith-managed) environment deploys through
 * the default journey: the same validate / plan / policy / approval / final plan
 * / apply / deploy / verify activities the workflow calls, with no injected
 * provider session, session opener or release port.
 *
 * Real: the execution activities, graph expansion and the managed provider's
 * classification, the managed render and tenancy isolation gate, the Kubernetes
 * renderer/apply/release ports, the managed substrate port and the control-plane
 * tenant resolver. Scripted (as in every execution test): the ledger/store fakes
 * and the capability broker. Cluster side: the Kubernetes contract fake
 * (tests/providers/kubernetes/fake-api.ts), CONTRACT evidence only; the same
 * journey against a real kind cluster is tests/providers/zenith/managed-kind.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionActivities } from "@/lib/execution/activities";
import { StepFailedError, TofuPlanChangedError } from "@/lib/execution/errors";
import { createKubernetesToolkit } from "@/lib/platform/kubernetes-toolkit";
import { createProductTenantResolver } from "@/lib/platform/zenith-managed";
import { createZenithMigrationsPort, createZenithWorkloadsPort } from "@/lib/platform/release-zenith";
import { findDriver } from "@/lib/drivers/types";
import { registerKubernetesDrivers } from "@/lib/providers/kubernetes/drivers";
import { createKubernetesSession } from "@/lib/providers/kubernetes/session";
import { registerZenithDrivers } from "@/lib/providers/zenith/drivers";
import type { ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import { createManagedSubstrate, readManagedConfigs } from "@/lib/providers/zenith/managed-substrate";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { AsyncSecretsBackend } from "@/lib/secrets/backend";
import type { ZenithEnv } from "@/lib/providers/zenith/substrate";
import { startFakeK8s, type FakeK8s } from "../providers/kubernetes/fake-api";
import { FULL_ENV } from "../providers/zenith/support";
import { FakeAdmin, MemoryKeyStore, MemorySink } from "../managed-serving/_support/storage";
import { createWorld, type World } from "./fakes/world";
import { ENV, OP, WS, bucketManifest } from "./fakes/fixtures";

const NS = tenantNamespace(WS, ENV);
const WEB_A = `registry.example.com/acme/web@sha256:${"a".repeat(64)}`;
const WEB_B = `registry.example.com/acme/web@sha256:${"b".repeat(64)}`;
const emptyVault: AsyncSecretsBackend = { kind: "file", get: async () => undefined, list: async () => [], put: async () => undefined, putIfAbsent: async (_w, r) => r, remove: async () => undefined };
/** Ingress mode: no platform Gateway/Certificate objects, which the Kubernetes contract fake does not serve. */
const SUBSTRATE_ENV = { ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx" };

const manifest = (webImage: string) => {
  const svc = (over: Record<string, unknown>) => ({ size: "small", replicas: 1, env: [], ownership: "managed", ...over });
  return {
    version: 2,
    services: [
      svc({ id: "svc-web", name: "web", kind: "worker", source: { type: "image", image: webImage } }),
      svc({ id: "svc-nightly", name: "nightly", kind: "cron", schedule: "0 0 1 1 *", source: { type: "image", image: webImage } }),
    ],
    resources: [], routes: [], bindings: [],
  };
};

let fake: FakeK8s;
let world: World | undefined;
beforeEach(async () => { fake = await startFakeK8s(); });
afterEach(async () => { world?.dispose(); world = undefined; vi.restoreAllMocks(); await fake.close(); });

function managedOver(w: World, env: ZenithEnv = SUBSTRATE_ENV, tier: "free" | "starter" = "free"): ManagedSubstratePort {
  return createManagedSubstrate({
    ...readManagedConfigs(env),
    toolkit: createKubernetesToolkit(),
    tenants: createProductTenantResolver(w.product, { defaultPlanTier: tier }),
    // The substrate's URL must be https; the contract fake is plain http on loopback, so only the URL is swapped.
    createKubernetesSession: (config, signal) => createKubernetesSession({ ...config, server: fake.url }, { resolveCredential: async () => fake.token, allowInsecureLoopback: true }, signal),
    resolvePlatformCredential: async () => fake.token,
    fetch: globalThis.fetch,
    backend: emptyVault,
  });
}

async function start(managed?: (w: World) => ManagedSubstratePort | undefined) {
  registerKubernetesDrivers();
  registerZenithDrivers({ toolkit: createKubernetesToolkit() });
  const w = createWorld();
  world = w;
  w.product.base.environment.provider = "zenith";
  w.product.base.environment.region = "zenith-managed";
  w.product.setManifest(manifest(WEB_A));
  const port = managed ? managed(w) : managedOver(w);
  const activities = createExecutionActivities({
    ...w.deps,
    drivers: (provider, nativeType) => findDriver(provider, nativeType) as never,
    ...(port ? { managed: port, workloads: createZenithWorkloadsPort(port), migrations: createZenithMigrationsPort() } : {}),
  });
  let lease: Awaited<ReturnType<World["lease"]>> | undefined;
  const need = async () => (lease ??= await activities.acquireLease({ operationId: OP, scope: `env:${ENV}`, ttlMs: 300_000 }));
  await activities.markOperation({ operationId: OP, status: "running" });
  return {
    w,
    validate: () => activities.validateDesiredState({ operationId: OP }),
    plan: async () => activities.planInfrastructure({ operationId: OP, lease: await need() }),
    policy: (planDigest: string) => activities.evaluatePolicy({ operationId: OP, planDigest }),
    approve: (approved = true) => { w.broker.approval = { approved, rejected: false, ...(approved ? { approvalId: "human-fixture" } : {}) }; },
    finalPlan: async (planDigest: string) => activities.finalPlan({ operationId: OP, approvedPlanDigest: planDigest, lease: await need() }),
    apply: async (planDigest: string) => activities.applyInfrastructure({ operationId: OP, planDigest, lease: await need() }),
    deploy: async (images: { service: string; imageUri: string; digest: string }[] = []) => activities.deployWorkloads({ operationId: OP, lease: await need(), images }),
    verify: () => activities.verifyInfrastructure({ operationId: OP }),
    release: async () => { if (lease) await activities.releaseLease({ lease }); lease = undefined; },
  };
}

/** requests that changed the cluster: a server-side dry-run is a PATCH too, but it writes nothing */
const realWrites = () => fake.writes().filter((r) => r.query.dryRun !== "All");

describe("deploying a Zenith-managed environment through the default journey", () => {
  it("validates, plans, passes policy, applies in the tenant namespace, releases a digest and verifies", async () => {
    const j = await start();
    const validation = await j.validate();
    expect(validation.problems).toEqual([]);
    expect(validation.nodes).toBeGreaterThan(2);

    const plan = await j.plan();
    expect(plan).toMatchObject({ delete: 0, replace: 0, empty: false, destroysData: false });
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(realWrites()).toEqual([]); // planning writes nothing
    const row = j.w.evidence.rows.find((e: any) => e.kind === "tofu_plan" && e.digest === plan.planDigest)!;
    expect(row.summary).toMatchObject({ engine: "zenith-managed-apply", planDigest: plan.planDigest, destroysData: false });
    expect((row.summary as any).semantics).toBeDefined(); // the reviewed executable semantics the approval binds (PROD-DUR-03)

    expect((await j.policy(plan.planDigest)).outcome).toBe("allow");
    j.approve();
    expect((await j.finalPlan(plan.planDigest)).planDigest).toBe(plan.planDigest);
    expect(realWrites()).toEqual([]);

    const applied = await j.apply(plan.planDigest);
    expect(applied.applied).toBe(plan.create + plan.update);
    expect(applied.outputsDigest).toMatch(/^[0-9a-f]{64}$/);
    // the tenancy baseline AND the workloads, all in the tenant's namespace
    for (const [kind, name] of [["Deployment", "web"], ["CronJob", "nightly"], ["ResourceQuota", "zenith-quota"], ["LimitRange", "zenith-limits"], ["NetworkPolicy", "zenith-default-deny"], ["ServiceAccount", "zenith-tenant"]] as const) {
      expect(fake.get(kind, NS, name), `${kind}/${name}`).toBeDefined();
    }
    expect(fake.get("Namespace", undefined, NS)).toBeDefined();
    expect((fake.get("Namespace", undefined, NS) as any).metadata.labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect((fake.get("Deployment", NS, "web") as any).spec.template.spec.containers[0].image).toBe(WEB_A);
    // every write targeted this tenant's namespace and nothing else
    expect(realWrites().length).toBeGreaterThan(0);
    for (const r of realWrites()) expect(r.path, `${r.method} ${r.path}`).toContain(NS);
    expect(j.w.evidence.rows.some((e: any) => e.kind === "tofu_apply" && e.summary.planDigest === plan.planDigest)).toBe(true);
    expect(j.w.events.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(["resource.planned", "resource.applying", "resource.applied"]));

    // A literal manifest image must retain its reviewed digest through release and verification.
    const deployed = await j.deploy([{ service: "container_service/web", imageUri: WEB_A, digest: `sha256:${"a".repeat(64)}` }]);
    expect(deployed.services).toBeGreaterThan(0);
    expect((fake.get("Deployment", NS, "web") as any).spec.template.spec.containers[0].image).toBe(WEB_A);

    const verified = await j.verify();
    expect(verified.failed).toBe(0);
    await j.release();
  });

  it("reports configuration drift when a released pin differs from the literal manifest image", async () => {
    const j = await start();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve();
    await j.apply(plan.planDigest);
    await j.deploy([{ service: "container_service/web", imageUri: WEB_B, digest: `sha256:${"b".repeat(64)}` }]);
    expect((fake.get("Deployment", NS, "web") as any).spec.template.spec.containers[0].image).toBe(WEB_B);
    expect(await j.verify()).toMatchObject({ status: "failed" });
    const verification = j.w.evidence.rows.find((e) => e.kind === "verification")!.summary as any;
    expect(verification.nodes).toContainEqual({ address: "container_service/web", driver: "zenith.deployment@1", status: "failed", failed: ["configuration"], unknown: [] });
    await j.release();
  });

  it("plans a scoped object store without writes and provisions it only after reviewed approval", async () => {
    const storage = { admin: new FakeAdmin(), sink: new MemorySink(), store: new MemoryKeyStore(WS, ENV) };
    const j = await start((w) => {
      const port = managedOver(w, { ...SUBSTRATE_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:zenith-managed/object-store-admin" }, "starter");
      const runtime = port.databaseRuntime.bind(port);
      vi.spyOn(port, "databaseRuntime").mockImplementation((input) => ({ ...runtime(input), storage }));
      return port;
    });
    j.w.product.setManifest(bucketManifest("media"));
    expect((await j.validate()).problems).toEqual([]);
    const plan = await j.plan();
    expect(plan.create).toBeGreaterThan(0);
    expect(storage.admin.calls).toEqual([]);
    expect(storage.sink.puts).toEqual([]);
    expect(realWrites()).toEqual([]);
    expect(await j.policy(plan.planDigest)).toMatchObject({ outcome: "allow" });
    j.approve();
    expect((await j.finalPlan(plan.planDigest)).planDigest).toBe(plan.planDigest);
    const applied = await j.apply(plan.planDigest);
    expect(applied.applied).toBe(plan.create + plan.update);
    expect(storage.store.rows).toEqual([expect.objectContaining({ address: "object_store/media", status: "active" })]);
    expect(storage.admin.principals.size).toBe(1);
    expect(storage.sink.puts).toHaveLength(2);
    await j.release();
  });

  it.each(["admin configuration", "scoped runtime ports"] as const)("refuses an object-store plan before writes without %s", async (missing) => {
    const env = { ...SUBSTRATE_ENV, ...(missing === "scoped runtime ports" ? { ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:zenith-managed/object-store-admin" } : {}) };
    const j = await start((w) => managedOver(w, env, "starter"));
    j.w.product.setManifest(bucketManifest("media"));
    expect((await j.validate()).problems).toEqual([]);
    await expect(j.plan()).rejects.toThrow(/object_store\/media/);
    expect(realWrites()).toEqual([]);
    expect(j.w.evidence.rows.filter((row) => row.kind === "tofu_plan")).toEqual([]);
    await j.release();
  });

  it("binds the plan digest to the live cluster: an already applied plan is no longer the reviewed one", async () => {
    const j = await start();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve();
    await j.apply(plan.planDigest);
    const before = realWrites().length;
    await expect(j.finalPlan(plan.planDigest)).rejects.toBeInstanceOf(TofuPlanChangedError);
    await expect(j.apply(plan.planDigest)).rejects.toBeInstanceOf(TofuPlanChangedError);
    expect(realWrites().length).toBe(before);
    await j.release();
  });

  it("refuses the apply without a current human approval, and writes nothing", async () => {
    const j = await start();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve(false);
    await expect(j.apply(plan.planDigest)).rejects.toBeInstanceOf(StepFailedError);
    await expect(j.apply(plan.planDigest)).rejects.toThrow(/approval/);
    expect(realWrites()).toEqual([]);
    await j.release();
  });

  it("refuses to plan over a namespace Zenith does not own, naming the cause, and never adopts it", async () => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } });
    const j = await start();
    await expect(j.plan()).rejects.toThrow(/does not own/);
    expect(realWrites()).toEqual([]);
    expect((fake.get("Namespace", undefined, NS) as any).metadata.labels?.["app.kubernetes.io/managed-by"]).toBeUndefined();
    await j.release();
  });

  it("refuses a namespace read outage instead of approving an unvalidated create plan", async () => {
    const j = await start((w) => {
      const managed = managedOver(w);
      vi.spyOn(managed.toolkit, "read").mockRejectedValue(new Error("cluster read unavailable"));
      return managed;
    });
    await expect(j.plan()).rejects.toThrow(/cluster read unavailable/);
    expect(realWrites()).toEqual([]);
    expect(j.w.evidence.rows.filter((row: any) => row.kind === "tofu_plan")).toEqual([]);
    await j.release();
  });

  it("fails by variable name when the substrate is not configured, before touching any cluster", async () => {
    const j = await start((w) => createManagedSubstrate({
      ...readManagedConfigs({}), toolkit: createKubernetesToolkit(), tenants: createProductTenantResolver(w.product),
      createKubernetesSession: async () => { throw new Error("must not open a session"); }, resolvePlatformCredential: async () => "x", fetch: globalThis.fetch, backend: emptyVault,
    }));
    await expect(j.validate()).resolves.toBeDefined();
    await expect(j.plan()).rejects.toThrow(/ZENITH_MANAGED_CLUSTER_SERVER/);
    expect(fake.requests).toEqual([]);
    await j.release();
  });

  it("refuses a managed environment on a worker that composed no substrate, by name", async () => {
    const j = await start(() => undefined);
    await expect(j.plan()).rejects.toThrow(/no Zenith-managed substrate composed/);
    expect(fake.requests).toEqual([]);
    await j.release();
  });
});
