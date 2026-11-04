/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-MAN-02/03 on a REAL disposable cluster. GATED: skipped, with the reason, unless
 *   ZENITH_TEST_MANAGED_SERVING_KIND=1
 *   KUBECONFIG                     a private kubeconfig whose current context is a kind cluster named kind-zenith-*
 *   ZENITH_TEST_K8S_IMAGE          a digest-pinned image (used only for pods the API server is expected to REFUSE)
 * The managed-substrate worker (PROD-MAN-01) builds the Zenith-operated kind cluster this is meant to run against; any kind
 * cluster named kind-zenith-* works for the parts below.
 *
 * What it proves that the contract fake cannot, using ingress mode so no Gateway API or cert-manager CRDs are needed:
 *   - the production renderer's baseline (namespace, restricted Pod Security, quota, limit range) and workloads are ADMITTED by
 *     a real API server, including a HorizontalPodAutoscaler clamped by the tier;
 *   - a secret resolved from a vault reference lands in a real Secret object while the rendered manifests carry the reference;
 *   - the real API server REFUSES a privileged pod and a container above the tier's LimitRange ceiling in the tenant namespace.
 *
 * Not proven even when this passes: gateway routing, certificate issuance, DNS, an IAM provider, metrics-server driven scaling,
 * NetworkPolicy enforcement (kind's default CNI does not enforce; PROD-LIFE-07 owns the Calico profile). Live hosted acceptance
 * is deferred. A skipped test is never counted as a pass. Only the one namespace this run creates is touched and deleted.
 */
import { randomBytes } from "node:crypto";
import { KubeConfig } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverSideApply } from "@/lib/providers/kubernetes/apply";
import { createK8sClient, listObjects, readObject } from "@/lib/providers/kubernetes/client";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { sessionFromKubeConfig } from "@/lib/providers/kubernetes/session";
import { isSupportedKind } from "@/lib/providers/kubernetes/types";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { unavailableDatabaseProvider } from "@/lib/providers/zenith/database";
import type { KubernetesToolkit } from "@/lib/providers/zenith/k8s-port";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ZenithTenant } from "@/lib/providers/zenith/types";
import { FULL_ENV, SECRET, WEB, mkNode, session } from "../providers/zenith/support";

const image = process.env.ZENITH_TEST_K8S_IMAGE ?? "";
const enabled = process.env.ZENITH_TEST_MANAGED_SERVING_KIND === "1" && !!process.env.KUBECONFIG && /@sha256:[a-f0-9]{64}$/.test(image);

const toolkit: KubernetesToolkit = {
  renderGraph,
  apply: serverSideApply,
  read: (s, ref, signal) => readObject(createK8sClient(s, { signal }), ref),
  list: (s, q, signal) => {
    if (!isSupportedKind(q.kind)) throw new Error("Test toolkit only lists supported Kubernetes kinds.");
    return listObjects(createK8sClient(s, { signal }), q.kind, q.namespace, q);
  },
};

describe.skipIf(!enabled)("managed serving on a real kind cluster", () => {
  const suffix = randomBytes(4).toString("hex");
  const tenant: ZenithTenant = { workspaceId: `ws-man-${suffix}`, environmentId: `env-man-${suffix}`, workspaceSlug: `man${suffix}`, environmentSlug: "production", planTier: "starter" };
  const ns = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  const CANARY = `kind-canary-${randomBytes(6).toString("hex")}`;
  const ref = `vault:generated/${tenant.environmentId}/postgres/db/connection-uri`;
  const env = { ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx" };
  const web = mkNode(WEB.address, "container_service", { ...(WEB.spec as Record<string, unknown>), env: [{ key: "DATABASE_URL", secretRef: ref }], artifact: { type: "image", ref: image } });
  const secret = mkNode(SECRET.address, "secret", { secretRef: ref, store: "zenith_vault", purpose: "environment" });

  let kc: KubeConfig;
  let client: ReturnType<typeof createK8sClient>;

  beforeAll(() => {
    kc = new KubeConfig();
    kc.loadFromFile(process.env.KUBECONFIG as string);
    // Refuse a target that was not chosen for this run.
    expect(kc.getCurrentContext(), "this suite only runs against a kind cluster named kind-zenith-*").toMatch(/^kind-zenith-[a-z0-9-]{1,30}$/);
  });

  afterAll(async () => {
    if (!client) return;
    await client.core.deleteNamespace({ name: ns }).catch(() => undefined);
  });

  it("admits the managed baseline and workloads, including the autoscaler, and delivers the secret from the vault reference", async () => {
    const kubernetes = sessionFromKubeConfig(kc, { namespaces: [ns], ttlSec: 3600 });
    client = createK8sClient(kubernetes, { signal: AbortSignal.timeout(300_000) });
    const managed = session(unavailableDatabaseProvider("No database in this run."), { tenant, kubernetes, expiresAt: kubernetes.expiresAt }, env);
    const report = await applyZenithEnvironment({
      session: managed, expect: tenant, toolkit, nodes: [web, secret], autoscaling: true, resolveSecret: async (r) => (r === ref ? CANARY : undefined),
      signal: AbortSignal.timeout(300_000),
    });
    expect(report.ok, JSON.stringify(report.workloads?.results ?? report)).toBe(true);

    const hpa: any = await readObject(client, { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", namespace: ns, name: "web" });
    expect(hpa.spec).toMatchObject({ scaleTargetRef: { kind: "Deployment", name: "web" }, minReplicas: 2, maxReplicas: 4 });
    const quota: any = await readObject(client, { apiVersion: "v1", kind: "ResourceQuota", namespace: ns, name: "zenith-quota" });
    expect(quota.spec.hard["services.loadbalancers"]).toBe("0");
    const namespace: any = await readObject(client, { apiVersion: "v1", kind: "Namespace", name: ns });
    expect(namespace.metadata.labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");

    const secrets = (await client.core.listNamespacedSecret({ namespace: ns })).items.filter((s: any) => s.metadata?.annotations?.["zenith.dev/secret-ref"] === ref);
    expect(secrets.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(String(Object.values((secrets[0] as any).data ?? {})[0]), "base64").toString()).toBe(CANARY);
    expect(JSON.stringify(report)).not.toContain(CANARY);
  }, 600_000);

  it("refuses a privileged pod in the tenant namespace", async () => {
    await expect(client.core.createNamespacedPod({
      namespace: ns,
      body: { metadata: { name: `refuse-priv-${suffix}` }, spec: { containers: [{ name: "x", image, securityContext: { privileged: true } }] } },
    })).rejects.toBeDefined();
  });

  it("refuses a container above the tier's LimitRange ceiling", async () => {
    await expect(client.core.createNamespacedPod({
      namespace: ns,
      body: {
        metadata: { name: `refuse-cpu-${suffix}` },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 65534, seccompProfile: { type: "RuntimeDefault" } },
          containers: [{ name: "x", image, resources: { requests: { cpu: "64" }, limits: { cpu: "64" } }, securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } } }],
        },
      },
    })).rejects.toBeDefined();
  });
});

describe.skipIf(enabled)("managed serving kind lane", () => {
  it.skip("skipped: set ZENITH_TEST_MANAGED_SERVING_KIND=1, KUBECONFIG (a kind-zenith-* context) and ZENITH_TEST_K8S_IMAGE (digest-pinned)", () => undefined);
});
