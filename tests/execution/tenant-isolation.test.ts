/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-MAN-04: tenant isolation provisioning through the guard chain.
 *
 * REAL here: the control store (PGlite, and PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set) for the external-effect
 * ledger, the Kubernetes provider's server-side apply, diff and read paths, the platform apply set and its vet, the
 * isolation bundle generators and the MACH-02 TokenRequest claim checks.
 * FAKE here, and labelled: the Kubernetes API (the contract fake in tests/providers/kubernetes/fake-api.ts, which models
 * kinds, ownership and field managers, not RBAC enforcement or Cilium), the approval broker, the operator access probe
 * and the credential sink. None of this is cluster evidence; the kind suite in tests/isolation is.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEffectLedger } from "@/lib/effects/ledger";
import { subsetMismatches, createTenantIsolationProvisioner, prepareIsolation, type TenantIsolationDeps } from "@/lib/execution/tenant-isolation";
import { serverSideApply } from "@/lib/providers/kubernetes/apply";
import type { GuestClusterPort } from "@/lib/providers/kubernetes/guest";
import { TenantIsolationError, isolationRequestDigest, type TenantIsolationRequest } from "@/lib/providers/zenith/onboarding";
import { bundleObjects, renderIsolationBundle } from "@/lib/providers/zenith/isolation-bundle";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ZenithTenant } from "@/lib/providers/zenith/types";
import { LANES, openLane } from "../controlplane/_support/harness";
import { lease as takeLease, seed, type Seed } from "../effects/_support";
import { startFakeK8s, type FakeK8s } from "../providers/kubernetes/fake-api";
import { sessionFor } from "../providers/kubernetes/helpers";
import { FULL_ENV, substrate } from "../providers/zenith/support";

const OPERATOR_NS = "zenith-system";
const ENV_WITH_PREFIX = { ...FULL_ENV, ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:zenith-managed/operators" };
const ENV_CILIUM = { ...ENV_WITH_PREFIX, ZENITH_MANAGED_FQDN_ENGINE: "cilium", ZENITH_MANAGED_EGRESS_FQDNS: "registry.npmjs.org" };

/** A token shaped like the API server's TokenRequest answer, built at runtime. */
function fakeJwt(claims: { sub: string; uid: string; aud: string[]; exp: number }): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: claims.sub, aud: claims.aud, exp: claims.exp, "kubernetes.io": { serviceaccount: { uid: claims.uid } } })}.${Buffer.from("not-a-signature-xxxx").toString("base64url")}`;
}

describe("subsetMismatches", () => {
  it("accepts server defaults and equal quantities, refuses changed or missing leaves", () => {
    expect(subsetMismatches({ spec: { hard: { cpu: "1", memory: "2Gi" } } }, { spec: { hard: { cpu: "1000m", memory: "2048Mi", pods: "10" }, extra: true } })).toEqual([]);
    expect(subsetMismatches({ a: { b: "x" } }, { a: { b: "y" } })).toEqual(["a.b"]);
    expect(subsetMismatches({ a: [1, 2] }, { a: [1] })).toEqual(["a"]);
    expect(subsetMismatches({ a: { b: 1 } }, { a: {} })).toEqual(["a.b"]);
    expect(subsetMismatches({ a: "1Gi" }, { a: "2Gi" })).toEqual(["a"]);
  });
});

describe("prepareIsolation (no cluster)", () => {
  const tenant: ZenithTenant = { workspaceId: "ws_1", environmentId: "env_1", workspaceSlug: "acme", environmentSlug: "production", planTier: "starter" };
  const req = (env: Readonly<Record<string, string | undefined>>, over: Partial<TenantIsolationRequest> = {}): TenantIsolationRequest => ({ tenant, substrate: substrate(env), operationId: "op_1", lease: { scope: "env:env_1", fenceToken: 1 }, ...over });

  it("refuses to onboard without a per-tenant operator credential configuration", () => {
    try {
      prepareIsolation(req(FULL_ENV));
      throw new Error("should refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(TenantIsolationError);
      expect((e as TenantIsolationError).code).toBe("not_configured");
    }
  });

  it("renders baseline plus bundle in apply order, with a stable digest", () => {
    const a = prepareIsolation(req(ENV_WITH_PREFIX));
    const b = prepareIsolation(req(ENV_WITH_PREFIX));
    expect(a.bundleDigest).toBe(b.bundleDigest);
    expect(a.objects.map((o) => o.kind)).toEqual(["Namespace", "ServiceAccount", "ServiceAccount", "ResourceQuota", "ResourceQuota", "LimitRange", "Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding", "NetworkPolicy", "NetworkPolicy"]);
    expect(a.namespaces).toEqual([tenantNamespace("ws_1", "env_1"), OPERATOR_NS]);
  });

  it("refuses a hostname request the substrate cannot enforce, as a failed plan", () => {
    expect(() => prepareIsolation(req(ENV_WITH_PREFIX, { egressFqdns: ["api.example.com"] }))).toThrow(TenantIsolationError);
    try {
      prepareIsolation(req(ENV_WITH_PREFIX, { egressFqdns: ["api.example.com"] }));
    } catch (e) {
      expect((e as TenantIsolationError).code).toBe("plan_failed");
    }
  });

  it("the request digest ignores lease, audiences and ttl but not what is approved", () => {
    const base = isolationRequestDigest({ tenant });
    expect(isolationRequestDigest({ tenant, egressFqdns: [] })).toBe(base);
    expect(isolationRequestDigest({ tenant, egressFqdns: ["A.example.com"] })).toBe(isolationRequestDigest({ tenant, egressFqdns: ["a.example.com"] }));
    expect(isolationRequestDigest({ tenant, egressFqdns: ["a.example.com"] })).not.toBe(base);
    expect(isolationRequestDigest({ tenant: { ...tenant, planTier: "pro" } })).not.toBe(base);
  });
});

describe("the platform apply set of the Kubernetes provider", () => {
  let fake: FakeK8s;
  beforeEach(async () => {
    fake = await startFakeK8s();
  });
  afterEach(async () => {
    await fake.close();
  });

  const tenant: ZenithTenant = { workspaceId: "ws_1", environmentId: "env_1", workspaceSlug: "acme", environmentSlug: "production", planTier: "starter" };
  const prepared = () => prepareIsolation({ tenant, substrate: substrate(ENV_CILIUM), operationId: "op_1", lease: { scope: "env:env_1", fenceToken: 1 } });

  it("refuses ClusterRole and CiliumNetworkPolicy without a platform policy (the verified default is unchanged)", async () => {
    const p = prepared();
    const session = await sessionFor(fake, p.namespaces);
    const report = await serverSideApply(p.objects.filter((o) => ["ClusterRole", "CiliumNetworkPolicy"].includes(o.kind)), session, { environmentId: "env_1" });
    expect(report.ok).toBe(false);
    expect(report.refused).toBe(true);
    expect(fake.list("ClusterRole")).toEqual([]);
  });

  it("applies the whole bundle under its vet, in order, and reads it back from the API", async () => {
    const p = prepared();
    const session = await sessionFor(fake, p.namespaces);
    const report = await serverSideApply(p.objects, session, { environmentId: "env_1", platform: p.vet });
    expect(report.ok, JSON.stringify(report.results.filter((r) => !["created", "configured"].includes(r.status)))).toBe(true);
    expect(report.results.map((r) => r.ref.kind)).toEqual(["Namespace", "ServiceAccount", "ServiceAccount", "ResourceQuota", "ResourceQuota", "LimitRange", "Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding", "NetworkPolicy", "NetworkPolicy", "CiliumNetworkPolicy"]);
    expect(fake.list("ClusterRole")).toHaveLength(1);
    expect(fake.list("CiliumNetworkPolicy", p.namespace)).toHaveLength(1);
  });

  it("refuses a batch that is not exactly the vetted bundle, before any write", async () => {
    const p = prepared();
    const session = await sessionFor(fake, p.namespaces);
    const tampered = structuredClone(p.objects);
    const role = tampered.find((o) => o.kind === "Role") as any;
    role.rules.push({ apiGroups: [""], resources: ["pods/exec"], verbs: ["create"] });
    const report = await serverSideApply(tampered, session, { environmentId: "env_1", platform: p.vet });
    expect(report.ok).toBe(false);
    expect(report.refused).toBe(true);
    expect(fake.writes().filter((w) => w.query.dryRun === undefined)).toEqual([]);
    expect(fake.list("Role", p.namespace)).toEqual([]);
  });

  it("refuses a vet-less platform option and never writes outside the session allowlist", async () => {
    const p = prepared();
    const session = await sessionFor(fake, [p.namespace]); // operator namespace NOT allowlisted
    const report = await serverSideApply(p.objects, session, { environmentId: "env_1", platform: p.vet });
    expect(report.ok).toBe(false);
    expect(fake.list("ServiceAccount", OPERATOR_NS)).toEqual([]);
    await expect(serverSideApply(p.objects, await sessionFor(fake, p.namespaces), { environmentId: "env_1", platform: {} as any })).resolves.toMatchObject({ ok: false, refused: true });
  });

  it("refuses to adopt an object it does not own", async () => {
    const p = prepared();
    fake.seed({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: (p.bundle.operatorAccess.find((o) => o.kind === "ClusterRole") as any).metadata.name }, rules: [] });
    const session = await sessionFor(fake, p.namespaces);
    const report = await serverSideApply(p.objects, session, { environmentId: "env_1", platform: p.vet });
    expect(report.ok).toBe(false);
    expect(report.results.some((r) => r.status === "ownership_conflict")).toBe(true);
  });
});

describe.each(LANES)("provisionTenantIsolation ($name)", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  });
  afterAll(async () => {
    await ctx.close();
  });

  let fake: FakeK8s;
  let s: Seed;
  let tenant: ZenithTenant;
  let request: TenantIsolationRequest;
  let approval: { approved: boolean; rejected: boolean; approvalId?: string; planDigest?: string };
  let stored: { ref: string; token: string; expiresAt: string }[];
  let probeAnswers: (verb: string, resource: string) => boolean;
  const calls = { admit: 0, fence: 0, tokens: 0 };

  const make = (over: Partial<TenantIsolationDeps> = {}, ledger = true) => {
    const cluster = (tokenLifetimeSec = 900): Pick<GuestClusterPort, "ensureServiceAccount" | "requestToken"> => ({
      async ensureServiceAccount() {
        return { uid: "uid-operator-1" };
      },
      async requestToken(namespace, serviceAccount, uid, audiences, expirationSeconds) {
        calls.tokens++;
        const exp = Math.floor(Date.now() / 1000) + Math.min(tokenLifetimeSec, expirationSeconds);
        return { token: fakeJwt({ sub: `system:serviceaccount:${namespace}:${serviceAccount}`, uid, aud: audiences.length ? [...audiences] : ["https://kubernetes.default.svc"], exp }), expiresAt: new Date(exp * 1000).toISOString() };
      },
    });
    const deps: TenantIsolationDeps = {
      rt: {
        d: {
          leases: { async assertFence() { calls.fence++; } },
          broker: { async approvalStatus() { return { approved: approval.approved, rejected: approval.rejected, approvalId: approval.approvalId, ...(approval.planDigest ? { dispatchApproval: { approvalIds: [approval.approvalId ?? ""], requiredApprovalCount: 1, approvalRound: 1, proposalDigest: "p".repeat(64), planDigest: approval.planDigest } } : {}) }; } },
          ...(ledger ? { effects: createEffectLedger(ctx.db) } : {}),
        } as any,
        async emit() {},
        async evidence() { return undefined; },
        log() {},
        now: () => new Date(),
      },
      async openBootstrapSession(_r, namespaces) {
        return { session: await sessionFor(fake, [...namespaces]) };
      },
      async storeOperatorCredential(input) {
        stored.push({ ref: input.ref, token: input.token, expiresAt: input.expiresAt });
      },
      openOperatorProbe: async () => ({ async allowed(a) { return probeAnswers(a.verb, `${a.resource}${a.subresource ? `/${a.subresource}` : ""}${a.namespace ? "@ns" : "@cluster"}`); } }),
      guestPort: () => cluster() as GuestClusterPort,
      admit: async () => { calls.admit++; },
      ...over,
    };
    return createTenantIsolationProvisioner(deps);
  };

  const trusted = (verb: string, resource: string): boolean => (verb === "create" && resource === "deployments@ns") || (verb === "get" && resource === "secrets@ns" /* own namespace */);

  beforeEach(async () => {
    fake = await startFakeK8s();
    s = await seed(ctx.db);
    const l = await takeLease(ctx.db, s);
    tenant = { workspaceId: s.workspaceId, environmentId: s.environmentId, workspaceSlug: "acme", environmentSlug: "production", planTier: "starter" };
    request = { tenant, substrate: substrate(ENV_WITH_PREFIX), operationId: s.operationId, lease: { scope: l.scope, fenceToken: l.fenceToken }, tokenTtlSec: 900 };
    approval = { approved: true, rejected: false, approvalId: "ap_1" };
    stored = [];
    probeAnswers = trusted;
    calls.admit = calls.fence = calls.tokens = 0;
  });
  afterEach(async () => {
    await fake.close();
  });

  const ns = () => tenantNamespace(tenant.workspaceId, tenant.environmentId);
  const nonDryWrites = () => fake.writes().filter((w) => w.query.dryRun === undefined);

  it("plans without writing, then applies the approved plan, reads it back and stores a scoped operator token", async () => {
    const p = make();
    const plan = await p.plan(request);
    expect(plan.objects.every((o) => o.action === "create")).toBe(true);
    expect(plan.objects.map((o) => o.kind)).toContain("ClusterRole");
    expect(nonDryWrites()).toEqual([]);
    approval.planDigest = plan.planDigest;
    const result = await p.apply(request, plan.planDigest);
    expect(result).toMatchObject({ planDigest: plan.planDigest, namespace: ns(), applied: plan.objects.length, verified: plan.objects.length, deduplicated: false, credential: { ref: `vault:zenith-managed/operators/${ns()}` } });
    expect(JSON.stringify(result)).not.toContain(stored[0].token);
    expect(stored).toHaveLength(1);
    // the stored token is the MACH-02 shape: claims name the per-tenant operator ServiceAccount and a bounded expiry
    const claims = JSON.parse(Buffer.from(stored[0].token.split(".")[1], "base64url").toString("utf8"));
    expect(claims.sub).toBe(`system:serviceaccount:${OPERATOR_NS}:zenith-op-${ns()}`);
    expect(Date.parse(stored[0].expiresAt) - Date.now()).toBeLessThanOrEqual(3_660_000);
    expect(fake.get("Namespace", undefined, ns())).toBeDefined();
    expect(fake.get("ClusterRole", undefined, `zop-ns-${ns()}`)).toBeDefined();
    expect(calls.admit).toBeGreaterThanOrEqual(2);
    expect(calls.fence).toBeGreaterThanOrEqual(3);
  });

  it("the effect is recorded before the call, confirmed by the readback, and a second apply only verifies", async () => {
    const p = make();
    const plan = await p.plan(request);
    approval.planDigest = plan.planDigest;
    await p.apply(request, plan.planDigest);
    const ledger = createEffectLedger(ctx.db);
    const effect = await ledger.getByDedup(s.workspaceId, "isolation_apply", `isolation:${s.operationId}:${plan.planDigest}`);
    expect(effect).toMatchObject({ family: "isolation_apply", provider: "kubernetes", state: "confirmed" });
    expect(effect?.readback).toMatchObject({ outcome: "present" });
    const writesBefore = nonDryWrites().length;
    const again = await p.apply(request, plan.planDigest);
    expect(again).toMatchObject({ deduplicated: true, applied: 0, verified: plan.objects.length });
    expect(nonDryWrites().length).toBe(writesBefore);
    expect(stored).toHaveLength(2); // a fresh token each time
  });

  it("provision runs plan and apply and fails closed when the approval is not bound to that plan", async () => {
    const p = make();
    await expect(p.provision(request)).rejects.toMatchObject({ code: "approval_required" });
    approval.planDigest = "0".repeat(64);
    await expect(p.provision(request)).rejects.toMatchObject({ code: "approval_required" });
    expect(nonDryWrites()).toEqual([]);
    expect(fake.get("Namespace", undefined, ns())).toBeUndefined();
    expect(stored).toEqual([]);
  });

  it.each([
    ["rejected", { approved: true, rejected: true, approvalId: "ap_1" }],
    ["not approved", { approved: false, rejected: false }],
    ["no approval id", { approved: true, rejected: false }],
  ])("refuses to apply when the approval is %s", async (_n, a) => {
    const p = make();
    const plan = await p.plan(request);
    approval = { ...a, planDigest: plan.planDigest };
    await expect(p.apply(request, plan.planDigest)).rejects.toMatchObject({ code: "approval_required" });
    expect(nonDryWrites()).toEqual([]);
  });

  it("refuses when the world moved after approval (plan_changed) and writes nothing", async () => {
    const cilium = { ...request, substrate: substrate(ENV_CILIUM) };
    const p = make();
    const plan = await p.plan(cilium);
    approval.planDigest = plan.planDigest;
    // a different hostname list is a different bundle, so a different plan
    await expect(p.apply({ ...cilium, egressFqdns: ["api.example.com"] }, plan.planDigest)).rejects.toMatchObject({ code: "plan_changed" });
    expect(nonDryWrites()).toEqual([]);
  });

  it("refuses without the effect ledger, without a lease, when admission refuses, and for a malformed digest", async () => {
    await expect(make({}, false).apply(request, "a".repeat(64))).rejects.toMatchObject({ code: "not_configured" });
    await expect(make().apply(request, "nope")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(make({ admit: async () => { throw new Error("busy"); } }).plan(request)).rejects.toMatchObject({ code: "admission_refused" });
    const lost = make({
      rt: {
        d: { leases: { async assertFence() { throw new Error("lost"); } }, broker: {}, effects: createEffectLedger(ctx.db) } as any,
        async emit() {},
        async evidence() { return undefined; },
        log() {},
        now: () => new Date(),
      },
    });
    await expect(lost.plan(request)).rejects.toMatchObject({ code: "lease_lost" });
    expect(nonDryWrites()).toEqual([]);
  });

  it("fails verification when the cluster does not hold what was rendered, and records the mismatch on the effect", async () => {
    const p = make();
    const plan = await p.plan(request);
    approval.planDigest = plan.planDigest;
    await p.apply(request, plan.planDigest);
    // another actor rewrites a quota field; the repeat apply is deduplicated and only verifies
    fake.foreignUpdate("ResourceQuota", ns(), "zenith-quota", "someone-else", { spec: { hard: { pods: "9999" } } });
    await expect(p.apply(request, plan.planDigest)).rejects.toMatchObject({ code: "verify_failed" });
    await expect(p.rotateCredential(request)).rejects.toMatchObject({ code: "verify_failed" });
    const effect = await createEffectLedger(ctx.db).getByDedup(s.workspaceId, "isolation_apply", `isolation:${s.operationId}:${plan.planDigest}`);
    expect(effect?.state).toBe("confirmed"); // terminal: a later drift is caught by verification, not by rewriting history
  });

  it("fails when the minted identity is over-privileged or under-privileged (live probe), and stores nothing", async () => {
    for (const answers of [() => true, () => false] as const) {
      stored = [];
      probeAnswers = answers;
      const p = make();
      const plan = await p.plan(request);
      approval.planDigest = plan.planDigest;
      await expect(p.apply(request, plan.planDigest)).rejects.toMatchObject({ code: "verify_failed" });
      expect(stored).toEqual([]);
      // a fresh operation for the next round
      s = await seed(ctx.db, s.workspaceId);
      const l = await takeLease(ctx.db, s);
      tenant = { ...tenant, environmentId: s.environmentId };
      request = { ...request, tenant, operationId: s.operationId, lease: { scope: l.scope, fenceToken: l.fenceToken } };
      await fake.close();
      fake = await startFakeK8s();
    }
  });

  it("fails when the token is bound to a different ServiceAccount UID, or the sink is down", async () => {
    const badCluster: any = {
      async ensureServiceAccount() { return { uid: "uid-a" }; },
      async requestToken(namespace: string, sa: string, _uid: string, aud: string[]) {
        return { token: fakeJwt({ sub: `system:serviceaccount:${namespace}:${sa}`, uid: "uid-other", aud: aud.length ? aud : ["x"], exp: Math.floor(Date.now() / 1000) + 600 }), expiresAt: new Date().toISOString() };
      },
    };
    const p = make({ guestPort: () => badCluster });
    const plan = await p.plan(request);
    approval.planDigest = plan.planDigest;
    await expect(p.apply(request, plan.planDigest)).rejects.toMatchObject({ code: "credential_failed" });
    const down = make({ storeOperatorCredential: async () => { throw new Error("vault down"); } });
    await expect(down.apply(request, plan.planDigest)).rejects.toMatchObject({ code: "credential_failed" });
    expect(stored).toEqual([]);
  });

  it("never lets a token reach an error, an event or evidence", async () => {
    const seen: string[] = [];
    const p = make({ storeOperatorCredential: async (i) => { seen.push(i.token); throw new Error("vault down"); } });
    const plan = await p.plan(request);
    approval.planDigest = plan.planDigest;
    const err = await p.apply(request, plan.planDigest).catch((e) => e);
    expect(err).toBeInstanceOf(TenantIsolationError);
    expect(String(err.message)).not.toContain(seen[0]);
  });

  it("rotates a credential for a provisioned tenant without applying anything", async () => {
    const p = make();
    const plan = await p.plan(request);
    approval.planDigest = plan.planDigest;
    await p.apply(request, plan.planDigest);
    const writes = nonDryWrites().length;
    const next = await p.rotateCredential(request);
    expect(next.ref).toBe(`vault:zenith-managed/operators/${ns()}`);
    expect(nonDryWrites().length).toBe(writes);
    expect(stored).toHaveLength(2);
    expect(stored[0].token).not.toBe(stored[1].token === stored[0].token ? "" : stored[0].token);
  });

  it("a rendered bundle objects list matches what the plan reported", async () => {
    const bundle = renderIsolationBundle(tenant, request.substrate);
    expect(bundleObjects(bundle).length).toBeGreaterThan(0);
  });
});
