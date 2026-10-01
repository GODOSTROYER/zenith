import { describe, expect, it } from "vitest";
import { assertTenantObjects, validateTenantObjects } from "@/lib/providers/zenith/isolation";
import type { K8sObject } from "@/lib/providers/zenith/k8s-port";
import { renderTenancy } from "@/lib/providers/zenith/tenancy";
import { ZenithError } from "@/lib/providers/zenith/types";
import { environmentGatewayParent } from "@/lib/providers/zenith/tls";
import { FULL_ENV, NS, TENANT, substrate } from "./support";

const sub = substrate();
const ctx = { tenant: TENANT, substrate: sub };

const marks = (name: string, ns: string | undefined = NS) => ({
  name,
  ...(ns ? { namespace: ns } : {}),
  labels: { "app.kubernetes.io/managed-by": "zenith" },
  annotations: { "zenith.dev/environment": TENANT.environmentId, "zenith.dev/resource": `container_service/${name}` },
});

function deployment(over: { pod?: Record<string, unknown>; container?: Record<string, unknown>; namespace?: string } = {}): K8sObject {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: marks("web", over.namespace ?? NS),
    spec: {
      template: {
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "app",
              image: "ghcr.io/acme/web:1",
              securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ["ALL"] } },
              ...(over.container ?? {}),
            },
          ],
          volumes: [{ name: "tmp", emptyDir: {} }],
          ...(over.pod ?? {}),
        },
      },
    },
  };
}

const rules = (objs: K8sObject[]) => validateTenantObjects(objs, ctx).map((v) => v.rule);

describe("validateTenantObjects: the clean cases", () => {
  it("accepts the tenancy baseline and a restricted workload", () => {
    const baseline = renderTenancy(TENANT, sub, { withManagedDatabase: true }).objects;
    expect(validateTenantObjects([...baseline, deployment()], ctx)).toEqual([]);
  });

  it("assertTenantObjects returns quietly when clean and throws one named error when not", () => {
    expect(() => assertTenantObjects([deployment()], ctx)).not.toThrow();
    expect(() => assertTenantObjects([deployment({ pod: { hostNetwork: true } })], ctx)).toThrow(ZenithError);
    try {
      assertTenantObjects([deployment({ pod: { hostNetwork: true } })], ctx);
    } catch (e) {
      expect((e as ZenithError).code).toBe("isolation_violation");
      expect((e as ZenithError).message).toContain("host_namespace");
    }
  });
});

describe("validateTenantObjects: pods", () => {
  it.each<[string, Parameters<typeof deployment>[0], string]>([
    ["hostNetwork", { pod: { hostNetwork: true } }, "host_namespace"],
    ["hostPID", { pod: { hostPID: true } }, "host_namespace"],
    ["hostIPC", { pod: { hostIPC: true } }, "host_namespace"],
    ["shared process namespace", { pod: { shareProcessNamespace: true } }, "host_namespace"],
    ["hostPath volume", { pod: { volumes: [{ name: "h", hostPath: { path: "/" } }] } }, "volume_type"],
    ["nfs volume", { pod: { volumes: [{ name: "n", nfs: { server: "x", path: "/" } }] } }, "volume_type"],
    ["csi volume", { pod: { volumes: [{ name: "c", csi: { driver: "x" } }] } }, "volume_type"],
    ["privileged container", { container: { securityContext: { privileged: true, allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ["ALL"] } } } }, "privileged"],
    ["privilege escalation left on", { container: { securityContext: { runAsNonRoot: true, capabilities: { drop: ["ALL"] } } } }, "privilege_escalation"],
    ["capabilities not dropped", { container: { securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true } } }, "capabilities"],
    ["capability added", { container: { securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ["ALL"], add: ["NET_BIND_SERVICE"] } } } }, "capabilities"],
    ["root user", { pod: { securityContext: { runAsNonRoot: true, runAsUser: 0, seccompProfile: { type: "RuntimeDefault" } } } }, "run_as_root"],
    ["runAsNonRoot missing", { pod: { securityContext: { seccompProfile: { type: "RuntimeDefault" } } }, container: { securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } } } }, "run_as_non_root"],
    ["no seccomp", { pod: { securityContext: { runAsNonRoot: true } } }, "seccomp"],
    ["unconfined seccomp", { pod: { securityContext: { runAsNonRoot: true, seccompProfile: { type: "Unconfined" } } } }, "seccomp"],
    ["host port", { container: { ports: [{ containerPort: 80, hostPort: 80 }], securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ["ALL"] } } } }, "host_port"],
    ["service account token mounted", { pod: { automountServiceAccountToken: true } }, "service_account_token"],
    ["sysctls", { pod: { securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" }, sysctls: [{ name: "net.core.somaxconn", value: "1" }] } } }, "sysctls"],
  ])("rejects %s", (_name, over, rule) => {
    expect(rules([deployment(over)])).toContain(rule);
  });

  it("rejects a token-mounting pod even when the field is simply absent", () => {
    const d = deployment();
    delete (d.spec as { template: { spec: Record<string, unknown> } }).template.spec.automountServiceAccountToken;
    expect(rules([d])).toContain("service_account_token");
  });

  it("checks init containers too", () => {
    const d = deployment({ pod: { initContainers: [{ name: "init", image: "x", securityContext: { privileged: true } }] } });
    expect(rules([d])).toContain("privileged");
  });

  it("checks CronJob pod templates", () => {
    const cron: K8sObject = {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: marks("job"),
      spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "j", image: "x" }], hostNetwork: true } } } } },
    };
    expect(rules([cron])).toContain("host_namespace");
  });
});

describe("validateTenantObjects: scope and kinds", () => {
  it("refuses a StatefulSet outright: databases are not run in the cluster", () => {
    const sts = { ...deployment(), kind: "StatefulSet", apiVersion: "apps/v1" };
    const v = validateTenantObjects([sts], ctx);
    expect(v.map((x) => x.rule)).toEqual(["kind_not_allowed"]);
    expect(v[0].detail).toMatch(/managed service/);
  });

  it.each(["DaemonSet", "Pod", "Job", "ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding", "Node", "PersistentVolume", "CustomResourceDefinition", "MutatingWebhookConfiguration", "Certificate", "Gateway", "DNSEndpoint"])("refuses %s", (kind) => {
    const o: K8sObject = { apiVersion: "v1", kind, metadata: marks("x") };
    expect(rules([o])).toContain("kind_not_allowed");
  });

  it("refuses an object in another namespace, including a platform namespace", () => {
    expect(rules([deployment({ namespace: "kube-system" })])).toContain("namespace_scope");
    expect(rules([deployment({ namespace: "zt-other-tenant-0123456789" })])).toContain("namespace_scope");
    expect(rules([deployment({ namespace: "default" })])).toContain("namespace_scope");
  });

  it("refuses a Namespace that is not the tenant's, or one that does not enforce restricted", () => {
    const other: K8sObject = { apiVersion: "v1", kind: "Namespace", metadata: { ...marks("other-ns", undefined), labels: { "app.kubernetes.io/managed-by": "zenith", "pod-security.kubernetes.io/enforce": "restricted" } } };
    expect(rules([other])).toContain("namespace_scope");
    const lax: K8sObject = { apiVersion: "v1", kind: "Namespace", metadata: { ...marks(NS, undefined), labels: { "app.kubernetes.io/managed-by": "zenith", "pod-security.kubernetes.io/enforce": "baseline" } } };
    expect(rules([lax])).toContain("pod_security");
  });

  it("requires this environment's ownership marks", () => {
    const d = deployment();
    d.metadata.annotations = { "zenith.dev/environment": "env_someone_else", "zenith.dev/resource": "x" };
    expect(rules([d])).toContain("ownership");
    const nolabel = deployment();
    nolabel.metadata.labels = {};
    expect(rules([nolabel])).toContain("ownership");
  });

  it("refuses a Secret that carries data", () => {
    const s: K8sObject = { apiVersion: "v1", kind: "Secret", metadata: marks("s"), data: { value: "eA==" } };
    expect(rules([s])).toContain("secret_value");
    expect(rules([{ ...s, data: undefined, stringData: { value: "x" } }])).toContain("secret_value");
  });
});

describe("validateTenantObjects: services and policies", () => {
  const svc = (spec: Record<string, unknown>): K8sObject => ({ apiVersion: "v1", kind: "Service", metadata: marks("web"), spec });

  it("allows ClusterIP and refuses every route to the internet that is not the gateway", () => {
    expect(rules([svc({ type: "ClusterIP" })])).toEqual([]);
    expect(rules([svc({})])).toEqual([]);
    for (const type of ["LoadBalancer", "NodePort", "ExternalName"]) expect(rules([svc({ type })])).toContain("service_type");
    expect(rules([svc({ externalIPs: ["1.2.3.4"] })])).toContain("service_type");
    expect(rules([svc({ loadBalancerIP: "1.2.3.4" })])).toContain("service_type");
  });

  const np = (spec: Record<string, unknown>): K8sObject => ({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: marks("fw-web"), spec });

  it("lets a binding-derived policy select pods in the tenant namespace", () => {
    expect(rules([np({ podSelector: {}, policyTypes: ["Ingress"], ingress: [{ from: [{ podSelector: { matchLabels: { a: "b" } } }] }] })])).toEqual([]);
  });

  it("refuses ipBlock peers, foreign namespace selectors and any egress in a binding-derived policy", () => {
    expect(rules([np({ policyTypes: ["Ingress"], ingress: [{ from: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }] })])).toContain("network_policy");
    expect(rules([np({ policyTypes: ["Ingress"], ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "zt-victim" } } }] }] })])).toContain("network_policy");
    expect(rules([np({ policyTypes: ["Ingress"], ingress: [{ from: [{ namespaceSelector: {} }] }] })])).toContain("network_policy");
    expect(rules([np({ policyTypes: ["Ingress", "Egress"], egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }] })])).toContain("network_policy");
  });

  it("allows a binding-derived policy to name the gateway namespace or its own", () => {
    expect(rules([np({ policyTypes: ["Ingress"], ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": sub.gateway.namespace } } }] }] })])).toEqual([]);
    expect(rules([np({ policyTypes: ["Ingress"], ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NS } } }] }] })])).toEqual([]);
  });
});

describe("validateTenantObjects: routes", () => {
  const route = (over: { parent?: Record<string, unknown>; hostnames?: unknown[] } = {}): K8sObject => ({
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: marks("route-web"),
    spec: {
      parentRefs: [over.parent ?? environmentGatewayParent(TENANT, sub)],
      hostnames: over.hostnames ?? ["web.production.acme.apps.example.com"],
      rules: [{ backendRefs: [{ name: "web", port: 8080 }] }],
    },
  });

  it("accepts a route to the platform gateway for a managed hostname", () => {
    expect(rules([route()])).toEqual([]);
  });

  it("refuses a route attached to any other gateway", () => {
    expect(rules([route({ parent: { kind: "Gateway", name: "evil", namespace: "kube-system" } })])).toContain("route_parent");
    expect(rules([route({ parent: { kind: "Gateway", name: sub.gateway.name, namespace: "other" } })])).toContain("route_parent");
  });

  it("refuses unscoped parents, other listeners, API groups and ports", () => {
    const expected = environmentGatewayParent(TENANT, sub);
    for (const parent of [{ ...expected, sectionName: undefined }, { ...expected, sectionName: "http" }, { ...expected, group: "evil.io" }, { ...expected, port: 80 }]) {
      expect(rules([route({ parent })])).toContain("route_parent");
    }
    const duplicate = route();
    duplicate.spec!.parentRefs = [expected, expected];
    expect(rules([duplicate])).toContain("route_parent");
  });

  it("refuses hostnames outside the tenant's managed suffix, wildcards, another tenant's names and an empty list", () => {
    for (const host of ["app.customer.com", "*.production.acme.apps.example.com", "web.production.victim.apps.example.com", "a.b.production.acme.apps.example.com", "apps.example.com"]) {
      expect(rules([route({ hostnames: [host] })]), host).toContain("route_hostname");
    }
    expect(rules([route({ hostnames: [] })])).toContain("route_hostname");
    expect(rules([route({ hostnames: [42] })])).toContain("route_hostname");
  });

  it("only allows HTTPRoute in gateway mode and Ingress in ingress mode", () => {
    const ingressSub = substrate({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx" });
    const ing: K8sObject = { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: marks("lb"), spec: {} };
    expect(validateTenantObjects([ing], { tenant: TENANT, substrate: sub }).map((v) => v.rule)).toContain("kind_not_allowed");
    expect(validateTenantObjects([ing], { tenant: TENANT, substrate: ingressSub })).toEqual([]);
    expect(validateTenantObjects([route()], { tenant: TENANT, substrate: ingressSub }).map((v) => v.rule)).toContain("kind_not_allowed");
  });
});

describe("validateTenantObjects: malformed input", () => {
  it("reports an object without kind or name instead of throwing", () => {
    const v = validateTenantObjects([{ apiVersion: "v1" } as unknown as K8sObject], ctx);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("object_shape");
  });
});
