/**
 * REAL kind API/RBAC readiness checks. No cloud, fake API or fake access reviews.
 * Requires ZENITH_TEST_MANAGED_ONBOARDING=1 and KUBECONFIG for a disposable
 * kind-zenith-life07* context. Creates two unique tenants and removes only their objects.
 */
import { KubeConfig } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertManagedTenantReady } from "@/lib/platform/zenith-onboarding";
import { prepareIsolation } from "@/lib/execution/tenant-isolation";
import { createKubernetesSession } from "@/lib/providers/kubernetes/session";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import { operatorSubjectOf } from "@/lib/providers/zenith/isolation-bundle";
import { readSubstrateConfig, type ZenithSubstrate } from "@/lib/providers/zenith/substrate";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ZenithTenant } from "@/lib/providers/zenith/types";
import { Kube, randomSuffix } from "./support";

const enabled = process.env.ZENITH_TEST_MANAGED_ONBOARDING === "1" && !!process.env.KUBECONFIG;

describe.skipIf(!enabled)("managed onboarding readiness [kind: needs ZENITH_TEST_MANAGED_ONBOARDING=1 and KUBECONFIG]", () => {
  const suffix = randomSuffix();
  const tenant: ZenithTenant = { workspaceId: `ws-ready-${suffix}`, environmentId: `env-ready-${suffix}`, workspaceSlug: "readiness", environmentSlug: "prod", planTier: "starter" };
  const absent: ZenithTenant = { ...tenant, environmentId: `env-absent-${suffix}` };
  const namespace = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  const absentNamespace = tenantNamespace(absent.workspaceId, absent.environmentId);
  const kube = new Kube(process.env.KUBECONFIG as string);
  const credentials = new Map<string, string>();
  let substrate: ZenithSubstrate;
  let bootstrapText = "";
  let configured = false;

  const sessions = (config: KubernetesConnectionConfig, signal?: AbortSignal) => createKubernetesSession(config, {
    resolveCredential: async ref => {
      if (ref === substrate.cluster.kubeconfigRef) return bootstrapText;
      const token = credentials.get(ref);
      if (!token) throw new Error("Missing test tenant token");
      return token;
    },
  }, signal);

  beforeAll(async () => {
    expect(kube.contextName(), "refusing any cluster outside the disposable acceptance naming boundary").toMatch(/^kind-zenith-life07(-[a-z0-9]{1,20})?$/);
    bootstrapText = kube.must(["config", "view", "--raw", "--minify", "--flatten", "-o", "yaml"]);
    const kc = new KubeConfig();
    kc.loadFromString(bootstrapText);
    const cluster = kc.getCurrentCluster();
    if (!cluster?.server || !cluster.caData) throw new Error("The private kind kubeconfig must include a server and CA data");
    const result = readSubstrateConfig({
      ZENITH_MANAGED_CLUSTER_SERVER: cluster.server,
      ZENITH_MANAGED_CLUSTER_CA_DATA: cluster.caData,
      ZENITH_MANAGED_KUBECONFIG_REF: "vault:readiness/bootstrap",
      ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:readiness/operators",
      ZENITH_MANAGED_APP_DOMAIN: "apps.readiness.test",
    });
    if (!result.configured) throw new Error("Test substrate configuration was rejected");
    substrate = result.substrate;
    configured = true;
    const operatorNamespace = operatorSubjectOf(namespace).namespace;
    if (kube.run(["get", "namespace", operatorNamespace]).code !== 0) {
      expect(kube.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: operatorNamespace } }).code).toBe(0);
    }
    const prepared = prepareIsolation({ tenant, substrate, operationId: `op-${suffix}`, lease: { scope: `env:${tenant.environmentId}`, fenceToken: 1 } });
    // Unique names prevent adopting or force-updating another test's objects.
    const apply = kube.run(["apply", "--server-side", "--field-manager=zenith-readiness-acceptance", "-f", "-"], { input: JSON.stringify({ apiVersion: "v1", kind: "List", items: prepared.objects }) });
    expect(apply.code, "the prepared isolation bundle must be accepted by the real API").toBe(0);
    const absentSubject = operatorSubjectOf(absentNamespace);
    expect(kube.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: absentSubject.name, namespace: absentSubject.namespace } }).code).toBe(0);
    for (const ns of [namespace, absentNamespace]) {
      const subject = operatorSubjectOf(ns);
      const token = kube.must(["create", "token", subject.name, "-n", subject.namespace, "--duration=15m"]).trim();
      credentials.set(`${substrate.isolation!.operatorCredentialPrefix}/${ns}`, token);
    }
  }, 120_000);

  afterAll(() => {
    credentials.clear();
    bootstrapText = "";
    if (!configured) return;
    // Only exact names derived from this run; the disposable cluster teardown owns zenith-system.
    kube.run(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"]);
    for (const ns of [namespace, absentNamespace]) {
      const subject = operatorSubjectOf(ns);
      kube.run(["delete", "serviceaccount", subject.name, "-n", subject.namespace, "--ignore-not-found"]);
      kube.run(["delete", "clusterrole", `zop-ns-${ns}`, "--ignore-not-found"]);
      kube.run(["delete", "clusterrolebinding", `zop-ns-${ns}`, "--ignore-not-found"]);
    }
  }, 120_000);

  it("refuses an absent tenant namespace without creating it", async () => {
    expect(kube.run(["get", "namespace", absentNamespace]).code).not.toBe(0);
    await expect(assertManagedTenantReady({ tenant: absent, substrate }, { createKubernetesSession: sessions })).rejects.toMatchObject({ code: "session_refused" });
    expect(kube.run(["get", "namespace", absentNamespace]).code).not.toBe(0);
  }, 60_000);

  it("accepts a complete read-back bundle only with the real least-authority tenant identity", async () => {
    await expect(assertManagedTenantReady({ tenant, substrate }, { createKubernetesSession: sessions })).resolves.toMatchObject({ provider: "kubernetes", namespaces: [namespace] });
  }, 60_000);
});
