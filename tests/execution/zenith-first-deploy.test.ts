/* eslint-disable @typescript-eslint/no-explicit-any */
/** Default composition contract: real PGlite semantics/custody/effects, scripted cluster and approvals. */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionActivities } from "@/lib/execution/activities";
import { createLeasesPort, createOperationsPort } from "@/lib/execution/platform";
import type { LeaseRef } from "@/lib/workflows/types";
import { createDefaultManagedSubstrate, DEFAULT_PLATFORM_VAULT_SCOPE } from "@/lib/platform/zenith-managed";
import { createIsolationCustody } from "@/lib/platform/zenith-isolation-custody";
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import { createEffectLedger } from "@/lib/effects/ledger";
import { vaultCipherFromEnv } from "@/lib/secrets";
import type { AsyncSecretsBackend, SecretRecord } from "@/lib/secrets/backend";
import { createKubernetesSession as realSession } from "@/lib/providers/kubernetes/session";
import { registerKubernetesDrivers } from "@/lib/providers/kubernetes/drivers";
import { registerZenithDrivers } from "@/lib/providers/zenith/drivers";
import { findDriver } from "@/lib/drivers/types";
import { createKubernetesToolkit } from "@/lib/platform/kubernetes-toolkit";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { setOpsRuntimeForTests } from "@/lib/ops/runtime";
import type { ZenithEnv } from "@/lib/providers/zenith/substrate";
import type { AccessAttributes } from "@/lib/providers/kubernetes/guest";
import { LANES, openLane, seedApprovedOperation } from "../controlplane/_support/harness";
import { startFakeK8s, type FakeK8s } from "../providers/kubernetes/fake-api";
import { FULL_ENV } from "../providers/zenith/support";
import { createWorld, type World } from "./fakes/world";
import { WS, ENV, PROJECT, REVISION, DEPLOYMENT } from "./fakes/fixtures";

const seams = vi.hoisted(() => ({ session: vi.fn(), guest: vi.fn() }));
vi.mock("@/lib/providers/kubernetes", async load => ({ ...await load<any>(), createKubernetesSession: seams.session }));
vi.mock("@/lib/providers/kubernetes/guest", async load => ({ ...await load<any>(), createGuestClusterPort: seams.guest }));
const ns = tenantNamespace(WS, ENV);

describe.each(LANES)("default first managed deploy ($name, contract only)", lane => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let fake: FakeK8s;
  let world: World;
  let issued: string[];
  let resolved: string[];
  let records: Map<string, SecretRecord>;
  let key: string;
  let revokeAfterMint: boolean;
  let activeLease: LeaseRef | undefined;
  beforeAll(async () => { ctx = await openLane(lane); }, 120_000);
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => {
    // Each case reuses the same workspace fixture; reset the process-local OPS token bucket so one case cannot exhaust another.
    setOpsRuntimeForTests(undefined);
    fake = await startFakeK8s();
    records = new Map(); issued = []; resolved = []; key = randomBytes(32).toString("hex"); revokeAfterMint = false;
    seams.session.mockImplementation(async (config, options, signal) => {
      // Resolve the exact real composition's vault reference; only the transport token is scripted.
      await options.resolveCredential(config.credentialRef, signal);
      return realSession({ ...config, server: fake.url, caData: undefined }, { resolveCredential: async () => fake.token, allowInsecureLoopback: true }, signal);
    });
    seams.guest.mockImplementation(() => ({
      allowed: async (a: AccessAttributes) => a.namespace === ns && ((a.verb === "create" && a.resource === "deployments") || (a.verb === "get" && a.resource === "secrets")),
      ensureServiceAccount: async (namespace: string, name: string) => {
        const account = fake.get("ServiceAccount", namespace, name) as any;
        if (!account) throw new Error("missing issued identity");
        return { uid: account.metadata.uid };
      },
      requestToken: async (namespace: string, name: string, uid: string, audiences: string[], ttl: number) => {
        const exp = Math.floor(Date.now() / 1000) + ttl;
        const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
        const token = `${b64({ alg: "none" })}.${b64({ sub: `system:serviceaccount:${namespace}:${name}`, aud: audiences.length ? audiences : ["https://kubernetes.default.svc"], exp, "kubernetes.io": { serviceaccount: { uid } } })}.${randomBytes(16).toString("base64url")}`;
        issued.push(token);
        if (revokeAfterMint) world.broker.approval = { approved: false, rejected: true };
        return { token, expiresAt: new Date(exp * 1000).toISOString() };
      },
    }));
  });
  afterEach(async () => { if (activeLease) await createLeasesPort(ctx.db).release(activeLease); activeLease = undefined; world?.dispose(); await fake.close(); vi.clearAllMocks(); });

  async function start() {
    const seeded = await seedApprovedOperation(ctx.db, WS, { proposal: { capability: "deployment.deploy", scope: { workspaceId: WS, projectId: PROJECT, environmentId: ENV }, input: { revisionId: REVISION, deploymentId: DEPLOYMENT } } });
    world = createWorld({ op: seeded.operation, semantics: createPlatformSemanticsStore(ctx.db) });
    world.product.base.environment.provider = "zenith";
    world.product.base.environment.region = "zenith-managed";
    world.product.setManifest({ version: 2, services: [{ id: "web", name: "web", kind: "worker", size: "small", replicas: 1, env: [], ownership: "managed", source: { type: "image", image: `registry.example.com/web@sha256:${"a".repeat(64)}` } }], resources: [], routes: [], bindings: [] });
    vi.spyOn(world.broker, "approvalStatus").mockImplementation(async () => {
      const op = await world.ops.get(seeded.operation.id);
      return { ...world.broker.approval, ...(op?.planDigest ? { dispatchApproval: { planDigest: op.planDigest, proposalDigest: op.proposalDigest, approvalIds: ["human-contract"], requiredApprovalCount: 1, approvalRound: 1 } } : {}) };
    });
    const backend: AsyncSecretsBackend = { kind: "file", get: async (scope, ref) => records.get(`${scope}|${ref}`), list: async scope => [...records.entries()].filter(([k]) => k.startsWith(`${scope}|`)).map(([,v]) => v), put: async (scope, record) => { records.set(`${scope}|${record.ref}`, record); }, putIfAbsent: async (scope, record) => { const saved = records.get(`${scope}|${record.ref}`) ?? record; records.set(`${scope}|${record.ref}`, saved); return saved; }, remove: async () => undefined };
    const env: ZenithEnv = { ...FULL_ENV, ZENITH_SECRET_KEY: key, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx", ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:zenith-managed/operators" };
    const managed = createDefaultManagedSubstrate({ env, product: world.product, db: ctx.db, operatorCredentialBackend: backend,
      readPlatformSecret: async (scope, ref) => {
        resolved.push(ref);
        if (ref === env.ZENITH_MANAGED_KUBECONFIG_REF) return fake.token;
        const sealed = await backend.get(scope, ref);
        return sealed ? vaultCipherFromEnv(env).open(scope, ref, sealed).value : undefined;
      } });
    registerKubernetesDrivers(); registerZenithDrivers({ toolkit: createKubernetesToolkit() });
    const leases = createLeasesPort(ctx.db);
    const custody = createIsolationCustody({ db: ctx.db, ops: world.ops, leases, cipher: vaultCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: randomBytes(32).toString("hex") }, { purpose: "enc:plan-artifacts" }) });
    const activities = createExecutionActivities({ ...world.deps, leases, managed, isolationCustody: custody, effects: createEffectLedger(ctx.db), clock: () => new Date(), drivers: (p, n) => findDriver(p, n) as never });
    const operationId = seeded.operation.id;
    await activities.markOperation({ operationId, status: "running" });
    await createOperationsPort(ctx.db).transition({ workspaceId: WS, operationId, to: "running" });
    const lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 300_000 });
    activeLease = lease;
    return { activities, operationId, lease, managed, custody, approve: () => { world.broker.approval = { approved: true, rejected: false, approvalId: "human-contract" }; } };
  }
  const writes = () => fake.writes().filter(r => r.query.dryRun !== "All");

  it("resolves no bootstrap credential when the planning capability grant is refused", async () => {
    const j = await start(); world.broker.refuseGrants = true;
    await expect(j.activities.planInfrastructure(j)).rejects.toThrow();
    expect(resolved).toEqual([]); expect(writes()).toEqual([]); expect(issued).toEqual([]);
  });

  it("requires the mutating grant before applying bootstrap isolation", async () => {
    const j = await start(); const plan = await j.activities.planInfrastructure(j); j.approve();
    const grant = world.broker.issueGrant.bind(world.broker);
    vi.spyOn(world.broker,"issueGrant").mockImplementation(async (id,audience,fence,options) => {
      if (!options?.capability) throw new Error("mutating grant refused");
      return grant(id,audience,fence,options);
    });
    await expect(j.activities.applyInfrastructure({ ...j,planDigest:plan.planDigest })).rejects.toThrow();
    expect(writes()).toEqual([]); expect(issued).toEqual([]); expect(records.size).toBe(0);
  });

  it("plans an absent tenant without writes, then provisions reviewed isolation, sealed credentials and workloads", async () => {
    const j = await start();
    expect((await j.activities.validateDesiredState({ operationId: j.operationId })).problems).toEqual([]);
    const plan = await j.activities.planInfrastructure(j);
    expect(writes()).toEqual([]); expect(records.size).toBe(0); expect(issued).toEqual([]);
    const evidence = world.evidence.rows.find(e => e.kind === "tofu_plan")!;
    expect(evidence.summary).toMatchObject({ isolationCustody: "zenith.isolation-artifact.v1", isolation: { objects: expect.arrayContaining([expect.objectContaining({ kind: "Namespace", action: "create" }), expect.objectContaining({ kind: "ClusterRole", action: "create" })]) } });
    j.approve();
    expect((await j.activities.finalPlan({ ...j, approvedPlanDigest: plan.planDigest })).planDigest).toBe(plan.planDigest);
    expect(writes()).toEqual([]);
    await j.activities.applyInfrastructure({ ...j, planDigest: plan.planDigest });
    expect(fake.get("Namespace", undefined, ns)).toBeDefined();
    expect(fake.get("Role", ns, "zenith-tenant-operator")).toBeDefined();
    expect(fake.get("Deployment", ns, "web")).toBeDefined();
    expect(issued).toHaveLength(1);
    const ref = `vault:zenith-managed/operators/${ns}`;
    const record = records.get(`${DEFAULT_PLATFORM_VAULT_SCOPE}|${ref}`)!;
    expect(vaultCipherFromEnv({ ZENITH_SECRET_KEY: key }).open(DEFAULT_PLATFORM_VAULT_SCOPE, ref, record).value).toBe(issued[0]);
    expect(resolved).toContain(ref);
    expect(JSON.stringify([...records.values()])).not.toContain(issued[0]);
    expect(world.stored()).not.toContain(issued[0]);
    const effects = await ctx.db.query<any>("select state from platform.external_effects where workspace_id=$1 and operation_id=$2 and family='isolation_apply'", [WS,j.operationId]);
    expect(effects).toEqual([expect.objectContaining({ state: "confirmed" })]);
  }, 120_000);

  it.each(["approval", "custody", "semantics", "changed bundle", "expired operation", "stale fence"])("refuses %s before any mutating bootstrap call or credential issuance", async reason => {
    const j = await start(); const plan = await j.activities.planInfrastructure(j); j.approve();
    if (reason === "approval") world.broker.approval = { approved: false, rejected: true };
    if (reason === "custody") vi.spyOn(j.custody, "inspect").mockRejectedValue(new Error("custody unavailable"));
    if (reason === "semantics") vi.spyOn(world.deps.semantics!, "get").mockResolvedValue(null);
    if (reason === "changed bundle") j.managed.substrate().isolation!.runtimeClass = "changed-runtime";
    if (reason === "expired operation") world.ops.ops.get(j.operationId)!.expiresAt = new Date(0).toISOString();
    if (reason === "stale fence") await createLeasesPort(ctx.db).release(j.lease);
    await expect(j.activities.applyInfrastructure({ ...j, planDigest: plan.planDigest })).rejects.toThrow();
    expect(writes()).toEqual([]); expect(issued).toEqual([]); expect(records.size).toBe(0);
  }, 120_000);

  it("discards a minted credential if human approval is revoked before vault storage", async () => {
    const j = await start(); const plan = await j.activities.planInfrastructure(j); j.approve(); revokeAfterMint = true;
    await expect(j.activities.applyInfrastructure({ ...j, planDigest: plan.planDigest })).rejects.toThrow();
    expect(issued).toHaveLength(1); expect(records.size).toBe(0);
    expect(fake.get("Deployment", ns, "web")).toBeUndefined();
  }, 120_000);
});
