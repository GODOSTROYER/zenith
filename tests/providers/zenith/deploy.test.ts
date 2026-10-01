import fs from "node:fs";
import path from "node:path";
import { loadAll, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderZenithEnvironment } from "@/lib/providers/zenith/render";
import { TENANT_LABEL } from "@/lib/providers/zenith/types";
import { FakeToolkit, TENANT, TYPICAL_GRAPH, substrate } from "./support";

const DIR = path.resolve(__dirname, "../../../deploy/zenith-managed");
type Doc = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: any; rules?: any[]; plugins?: any[]; resources?: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any

const read = (file: string): Doc[] => loadAll(fs.readFileSync(path.join(DIR, file), "utf8")).filter((d): d is Doc => d !== null && typeof d === "object");
const sub = substrate();

describe("deploy/zenith-managed", () => {
  const kustomization = load(fs.readFileSync(path.join(DIR, "kustomization.yaml"), "utf8")) as Doc;

  it("every file parses and the kustomization lists exactly the cluster objects, not the API-server config", () => {
    expect(kustomization.kind).toBe("Kustomization");
    for (const f of kustomization.resources!) expect(fs.existsSync(path.join(DIR, f)), f).toBe(true);
    expect(kustomization.resources).toEqual(["00-namespaces.yaml", "10-gateway.yaml", "20-clusterissuer.yaml", "30-networkpolicy-baseline.yaml", "40-operator-rbac.yaml"]);
    expect(JSON.stringify(kustomization)).not.toContain("apiserver");
    const stray = fs.readdirSync(DIR).filter((f) => /^\d\d-.*\.yaml$/.test(f));
    expect([...stray].sort()).toEqual(kustomization.resources);
  });

  it("creates the platform namespaces the substrate defaults name, with Pod Security labels", () => {
    const ns = read("00-namespaces.yaml");
    expect(ns.map((n) => n.metadata.name).sort()).toEqual(["cert-manager", "zenith-gateway", "zenith-system"]);
    expect(ns.find((n) => n.metadata.name === sub.gateway.namespace)).toBeDefined();
    for (const n of ns) expect(n.metadata.labels?.["pod-security.kubernetes.io/enforce"], n.metadata.name).toMatch(/^(baseline|restricted)$/);
    expect(ns.find((n) => n.metadata.name === "zenith-system")!.metadata.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(ns.find((n) => n.metadata.name === "cert-manager")!.metadata.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");
  });

  it("the Gateway is the one routes attach to, and it admits routes only from tenant namespaces", () => {
    const docs = read("10-gateway.yaml");
    const gw = docs.find((d) => d.kind === "Gateway")!;
    const cls = docs.find((d) => d.kind === "GatewayClass")!;
    expect(gw.metadata.name).toBe(sub.gateway.name);
    expect(gw.metadata.namespace).toBe(sub.gateway.namespace);
    expect(cls.metadata.name).toBe(sub.gateway.className);
    expect(gw.spec.gatewayClassName).toBe(cls.metadata.name);
    for (const l of gw.spec.listeners) {
      expect(l.allowedRoutes.namespaces.from).toBe("Selector");
      expect(l.allowedRoutes.namespaces.selector.matchLabels).toEqual({ [TENANT_LABEL.tenant]: "true" });
    }
  });

  it("flags every placeholder as one", () => {
    for (const [file, kind] of [["10-gateway.yaml", "GatewayClass"], ["10-gateway.yaml", "Gateway"], ["20-clusterissuer.yaml", "ClusterIssuer"]] as const) {
      expect(read(file).find((d) => d.kind === kind)!.metadata.annotations?.["zenith.dev/placeholder"], `${file} ${kind}`).toBe("true");
    }
    const text = fs.readFileSync(path.join(DIR, "20-clusterissuer.yaml"), "utf8");
    expect(text).toMatch(/REPLACE/);
    expect(read("20-clusterissuer.yaml")[0].spec.acme.server).toMatch(/staging/);
  });

  it("the ClusterIssuer carries the name the substrate defaults to", () => {
    expect(read("20-clusterissuer.yaml")[0].metadata.name).toBe(sub.certManager.clusterIssuer);
  });

  it("holds no credential: no keys, tokens or passwords as values", () => {
    for (const f of fs.readdirSync(DIR, { recursive: true }) as string[]) {
      if (!/\.ya?ml$/.test(f)) continue;
      const text = fs.readFileSync(path.join(DIR, f), "utf8");
      expect(text, f).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
      expect(text, f).not.toMatch(/\b(eyJ[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{20,})\b/);
    }
  });

  it("denies by default in the platform namespaces", () => {
    const np = read("30-networkpolicy-baseline.yaml");
    for (const ns of ["zenith-system", "zenith-gateway"]) {
      const deny = np.find((d) => d.metadata.namespace === ns && JSON.stringify(d.spec.policyTypes) === JSON.stringify(["Ingress", "Egress"]) && Object.keys(d.spec.podSelector).length === 0 && d.spec.ingress === undefined && d.spec.egress === undefined);
      expect(deny, ns).toBeDefined();
    }
    const gw = np.find((d) => d.metadata.name === "zenith-gateway-allow")!;
    expect(JSON.stringify(gw.spec.egress)).toContain(`"${TENANT_LABEL.tenant}":"true"`);
  });

  describe("operator RBAC", () => {
    const [sa, role, binding] = read("40-operator-rbac.yaml");
    const rules = role.rules!;

    it("is bound to a token-less service account in zenith-system", () => {
      expect(sa.kind).toBe("ServiceAccount");
      expect((sa as unknown as { automountServiceAccountToken: boolean }).automountServiceAccountToken).toBe(false);
      expect(JSON.stringify(binding)).toContain("zenith-system");
    });

    it("has no wildcards and none of the dangerous grants", () => {
      const text = JSON.stringify(rules);
      expect(text).not.toContain('"*"');
      for (const bad of ["pods/exec", "pods/attach", "pods/portforward", "nodes", "persistentvolumes", "clusterroles", "rolebindings", "customresourcedefinitions", "webhook", "escalate", "bind", "impersonate"]) expect(text, bad).not.toContain(bad);
      expect(rules.some((r) => r.apiGroups.includes("rbac.authorization.k8s.io"))).toBe(false);
    });

    it("grants create, patch and get on every kind the managed render emits, so server-side apply can work", () => {
      const out = renderZenithEnvironment({ tenant: TENANT, substrate: sub, nodes: TYPICAL_GRAPH, toolkit: new FakeToolkit() });
      const emitted = new Set([...out.baseline, ...out.workloads].map((o) => `${o.apiVersion.includes("/") ? o.apiVersion.split("/")[0] : ""}|${o.kind}`));
      const resourceOf: Record<string, string> = {
        Namespace: "namespaces",
        ServiceAccount: "serviceaccounts",
        Secret: "secrets",
        Service: "services",
        PersistentVolumeClaim: "persistentvolumeclaims",
        ResourceQuota: "resourcequotas",
        LimitRange: "limitranges",
        NetworkPolicy: "networkpolicies",
        Deployment: "deployments",
        CronJob: "cronjobs",
        HorizontalPodAutoscaler: "horizontalpodautoscalers",
        HTTPRoute: "httproutes",
        Ingress: "ingresses",
      };
      for (const key of emitted) {
        const [group, kind] = key.split("|");
        const resource = resourceOf[kind];
        expect(resource, `no resource mapping for ${kind}`).toBeDefined();
        const rule = rules.find((r) => r.apiGroups.includes(group) && r.resources.includes(resource));
        expect(rule, `${group}/${resource}`).toBeDefined();
        for (const verb of ["get", "create", "patch"]) expect(rule!.verbs, `${resource} ${verb}`).toContain(verb);
      }
    });

    it("is read-only on pods, logs and events", () => {
      const rule = rules.find((r) => r.resources.includes("pods"))!;
      expect(rule.verbs.sort()).toEqual(["get", "list", "watch"]);
      expect(rule.resources.sort()).toEqual(["events", "pods", "pods/log"]);
    });
  });

  it("the API-server example makes restricted the default and is not a cluster object", () => {
    const [cfg] = read("apiserver/podsecurity-admission.example.yaml");
    expect(cfg.kind).toBe("AdmissionConfiguration");
    expect(cfg.plugins![0].configuration.defaults.enforce).toBe("restricted");
    expect(fs.readFileSync(path.join(DIR, "apiserver/podsecurity-admission.example.yaml"), "utf8")).toMatch(/do not kubectl apply/);
  });

  it("the README states that nothing here has been applied", () => {
    const readme = fs.readFileSync(path.join(DIR, "README.md"), "utf8");
    expect(readme).toMatch(/nobody operates this cluster/i);
    expect(readme).toMatch(/never been applied/);
  });
});
