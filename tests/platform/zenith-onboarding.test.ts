/** Contract test: local fake Kubernetes API and mocked authorization reviews, not cluster isolation evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import { assertManagedOperatorConfigured, assertManagedTenantReady } from "@/lib/platform/zenith-onboarding";
import { prepareIsolation } from "@/lib/execution/tenant-isolation";
import type { AccessAttributes } from "@/lib/providers/kubernetes/guest";
import { substrateConnectionConfig } from "@/lib/providers/zenith/substrate";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { startFakeK8s, type FakeK8s } from "../providers/kubernetes/fake-api";
import { sessionFor } from "../providers/kubernetes/helpers";
import { FULL_ENV, substrate, TENANT } from "../providers/zenith/support";

const probes = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock("@/lib/providers/kubernetes/guest", async (load) => ({
  ...await load<typeof import("@/lib/providers/kubernetes/guest")>(),
  createGuestClusterPort: () => ({ allowed: probes.allowed }),
}));

const env = { ...FULL_ENV, ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:zenith-managed/operators" };
const configured = () => substrate(env);
const namespace = tenantNamespace(TENANT.workspaceId, TENANT.environmentId);
const input = () => ({ tenant: TENANT, substrate: configured() });
const prepared = () => prepareIsolation({ ...input(), operationId: "op_readonly_contract", lease: { scope: "env:readiness", fenceToken: 1 } });

it("refuses an absent operator prefix before credential resolution", async () => {
  const createKubernetesSession = vi.fn();
  expect(() => assertManagedOperatorConfigured(substrate())).toThrow(/ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX/);
  await expect(assertManagedTenantReady({ tenant: TENANT, substrate: substrate() }, { createKubernetesSession })).rejects.toMatchObject({ code: "not_configured" });
  expect(createKubernetesSession).not.toHaveBeenCalled();
});

it("per-tenant operator references are deterministic and distinct from bootstrap", () => {
  const first = substrateConnectionConfig(configured(), namespace);
  const other = substrateConnectionConfig(configured(), tenantNamespace(TENANT.workspaceId, "another-environment"));
  expect(first.credentialRef).toBe(`${env.ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX}/${namespace}`);
  expect(first.credentialRef).not.toBe(configured().cluster.kubeconfigRef);
  expect(first.credentialRef).not.toBe(other.credentialRef);
});

it("never resolves the bootstrap credential when the tenant operator credential is unavailable", async () => {
  const createKubernetesSession = vi.fn().mockRejectedValue(new Error("vault unavailable"));
  await expect(assertManagedTenantReady(input(), { createKubernetesSession })).rejects.toMatchObject({ code: "session_refused" });
  expect(createKubernetesSession).toHaveBeenCalledTimes(1);
  expect(createKubernetesSession.mock.calls[0][0].credentialRef).toBe(`${env.ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX}/${namespace}`);
});

describe("managed readiness readback", () => {
  let fake: FakeK8s;
  beforeEach(async () => {
    fake = await startFakeK8s();
    for (const object of prepared().objects) fake.seed(object);
    probes.allowed.mockReset().mockImplementation(async (a: AccessAttributes) =>
      a.namespace === namespace && ((a.verb === "create" && a.resource === "deployments") || (a.verb === "get" && a.resource === "secrets")));
  });
  afterEach(async () => { await fake.close(); });
  const sessions = () => vi.fn(async (config: KubernetesConnectionConfig) => sessionFor(fake, config.namespaces ?? []));

  it("reads the complete isolation bundle and probes the tenant operator without applying or minting", async () => {
    const createKubernetesSession = sessions();
    await expect(assertManagedTenantReady(input(), { createKubernetesSession })).resolves.toMatchObject({ provider: "kubernetes", namespaces: [namespace] });
    expect(createKubernetesSession).toHaveBeenCalledTimes(2);
    expect(createKubernetesSession.mock.calls[0][0].namespaces).toEqual([namespace]);
    expect(createKubernetesSession.mock.calls[1][0]).toMatchObject({ credentialRef: configured().cluster.kubeconfigRef, namespaces: [namespace, "zenith-system"] });
    expect(probes.allowed).toHaveBeenCalledTimes(8);
    expect(fake.writes()).toEqual([]);
  });

  it.each([
    ["allow-all rules", { ingress: [{}], egress: [{}] }],
    ["a narrower pod selector", { podSelector: { matchLabels: { excluded: "true" } } }],
  ])("refuses a default-deny policy changed by %s", async (_label, changed) => {
    const policy = structuredClone(prepared().objects.find(o => o.kind === "NetworkPolicy" && o.metadata.name === "zenith-default-deny")!);
    policy.spec = { ...policy.spec, ...changed };
    fake.seed(policy);
    await expect(assertManagedTenantReady(input(), { createKubernetesSession: sessions() })).rejects.toMatchObject({ code: "session_refused" });
    expect(probes.allowed).not.toHaveBeenCalled();
    expect(fake.writes()).toEqual([]);
  });

  it("accepts explicit empty ingress and egress lists for a default-deny policy", async () => {
    const policy = structuredClone(prepared().objects.find(o => o.kind === "NetworkPolicy" && o.metadata.name === "zenith-default-deny")!);
    policy.spec = { ...policy.spec, ingress: [], egress: [] };
    fake.seed(policy);
    await expect(assertManagedTenantReady(input(), { createKubernetesSession: sessions() })).resolves.toMatchObject({ provider: "kubernetes", namespaces: [namespace] });
    expect(fake.writes()).toEqual([]);
  });

  it("refuses a bundle that no longer matches its least-authority operator role", async () => {
    const role = structuredClone(prepared().objects.find(o => o.kind === "Role")!);
    (role as unknown as { rules: unknown[] }).rules.push({ apiGroups: ["*"], resources: ["*"], verbs: ["*"] });
    fake.seed(role);
    await expect(assertManagedTenantReady(input(), { createKubernetesSession: sessions() })).rejects.toMatchObject({ code: "session_refused" });
    expect(probes.allowed).not.toHaveBeenCalled();
    expect(fake.writes()).toEqual([]);
  });

  it("refuses incomplete onboarding rather than writing the absent bundle", async () => {
    await fake.close();
    fake = await startFakeK8s();
    await expect(assertManagedTenantReady(input(), { createKubernetesSession: sessions() })).rejects.toMatchObject({ code: "session_refused" });
    expect(probes.allowed).not.toHaveBeenCalled();
    expect(fake.writes()).toEqual([]);
  });

  it("refuses an operator with privilege outside the tenant's namespace", async () => {
    probes.allowed.mockResolvedValue(true);
    await expect(assertManagedTenantReady(input(), { createKubernetesSession: sessions() })).rejects.toMatchObject({ code: "session_refused" });
    expect(probes.allowed).toHaveBeenCalledWith({ verb: "list", group: "", resource: "namespaces" });
    expect(fake.writes()).toEqual([]);
  });

  it("does not expose provider error text or turn an access-review failure into success", async () => {
    const sensitive = Buffer.from(`runtime-only-${Date.now()}`).toString("base64url");
    probes.allowed.mockRejectedValue(new Error(sensitive));
    const error = await assertManagedTenantReady(input(), { createKubernetesSession: sessions() }).catch(e => e as Error);
    expect(error).toMatchObject({ code: "session_refused" });
    expect(String(error)).not.toContain(sensitive);
    expect(fake.writes()).toEqual([]);
  });
});
