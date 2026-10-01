/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { applyOrder, renderGraph, renderNode, renderObjects } from "@/lib/providers/kubernetes/render";
import { credentialsSecretName, generatedCredentialRef } from "@/lib/providers/kubernetes/renderers/data";
import { secretObjectName, tlsSecretName } from "@/lib/providers/kubernetes/naming";
import { targetFor } from "@/lib/providers/kubernetes/target";
import { ANNOTATION, K8sError, LABEL, type K8sObject } from "@/lib/providers/kubernetes/types";
import {
  ENV_ID,
  NS,
  SECRET_CANARY,
  cacheNode,
  certNode,
  cronNode,
  ctxFor,
  dbNode,
  dnsNode,
  firewallToDb,
  fullCtx,
  fullGraph,
  identityNode,
  lbNode,
  networkNode,
  node,
  publicFirewall,
  secretNode,
  serviceNode,
  siteNode,
  volumeNode,
} from "./helpers";

const render = (n: ReturnType<typeof serviceNode>, graph = fullGraph(), over = {}) => renderNode(n, fullCtx(graph, over));
const of = (objects: K8sObject[], kind: string): K8sObject => objects.find((o) => o.kind === kind) as K8sObject;
const podSpec = (d: K8sObject) => (d.spec as any).template.spec;
const container = (d: K8sObject) => podSpec(d).containers[0];

describe("container_service", () => {
  const { objects } = render(serviceNode());
  const dep = of(objects, "Deployment");
  const svc = of(objects, "Service");

  it("renders a Deployment and a Service in the network's namespace", () => {
    expect(objects.map((o) => o.kind).sort()).toEqual(["Deployment", "Service"]);
    expect(dep.metadata.namespace).toBe(NS);
    expect(svc.metadata.namespace).toBe(NS);
    expect(dep.metadata.name).toBe("web");
    expect((svc.spec as any).ports).toEqual([{ name: "http", port: 8080, targetPort: "http", protocol: "TCP" }]);
    expect((svc.spec as any).selector).toEqual((dep.spec as any).selector.matchLabels);
  });

  it("carries the ownership labels and annotations on every object", () => {
    for (const o of objects) {
      expect(o.metadata.labels?.[LABEL.managedBy]).toBe("zenith");
      expect(o.metadata.labels?.[LABEL.partOf]).toBe(ENV_ID);
      expect(o.metadata.annotations?.[ANNOTATION.resource]).toBe("service/web");
      expect(o.metadata.annotations?.[ANNOTATION.environment]).toBe(ENV_ID);
      expect(o.metadata.annotations?.[ANNOTATION.specDigest]).toBe(serviceNode().specDigest);
    }
  });

  it("hardens the pod: non-root, seccomp, no escalation, drop ALL, read-only root with a bounded /tmp", () => {
    expect(podSpec(dep).securityContext).toEqual({ runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } });
    expect(container(dep).securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(podSpec(dep).automountServiceAccountToken).toBe(false);
    expect(podSpec(dep).enableServiceLinks).toBe(false);
    expect(podSpec(dep).volumes).toEqual([{ name: "tmp", emptyDir: { sizeLimit: "256Mi" } }]);
    expect(container(dep).volumeMounts).toEqual([{ name: "tmp", mountPath: "/tmp" }]);
  });

  it("derives resources, replicas and probes from the spec", () => {
    expect(container(dep).resources).toEqual({ requests: { cpu: "500m", memory: "512Mi" }, limits: { cpu: "500m", memory: "512Mi" } });
    expect((dep.spec as any).replicas).toBe(2);
    expect(container(dep).readinessProbe.httpGet).toEqual({ path: "/healthz", port: "http" });
    expect(container(dep).livenessProbe.httpGet).toEqual({ path: "/healthz", port: "http" });
    expect(container(dep).startupProbe.httpGet).toEqual({ path: "/healthz", port: "http" });
    expect(container(dep).ports).toEqual([{ name: "http", containerPort: 8080, protocol: "TCP" }]);
    expect(container(dep).image).toBe("ghcr.io/acme/web:1.2.3");
    expect((dep.spec as any).strategy.rollingUpdate).toEqual({ maxUnavailable: 0, maxSurge: 1 });
    expect((dep.spec as any).revisionHistoryLimit).toBe(10);
  });

  it("references secrets by secretKeyRef to a name derived from the ref, never by value", () => {
    const env = container(dep).env;
    expect(env[0]).toEqual({ name: "LOG_LEVEL", value: "info" });
    expect(env[1]).toEqual({ name: "STRIPE_KEY", valueFrom: { secretKeyRef: { name: secretObjectName("vault:proj1/svc1/STRIPE_KEY"), key: "value" } } });
    expect(JSON.stringify(objects)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(env[1])).not.toContain('"value":"');
  });

  it("refuses an env entry that carries both a value and a secretRef, and malformed names", () => {
    expect(() => render(serviceNode({ env: [{ key: "X", value: "a", secretRef: "vault:p/s/X" }] }))).toThrow(/both value and secretRef/);
    expect(() => render(serviceNode({ env: [{ key: "1BAD KEY", value: "a" }] }))).toThrow(/valid variable name/);
    expect(() => render(serviceNode({ env: [{ key: "A", value: "1" }, { key: "A", value: "2" }] }))).toThrow(/more than once/);
    expect(() => render(serviceNode({ env: [{ key: "TOKEN", secretRef: "hunter2-not-a-reference" }] }))).toThrow(/not a reference/);
  });

  it("uses the identity node's ServiceAccount and honors render options", () => {
    const withIdentity = render(serviceNode()).objects;
    expect(podSpec(of(withIdentity, "Deployment")).serviceAccountName).toBe("web");
    const rw = render(serviceNode(), fullGraph(), { readOnlyRootFilesystem: false, runAsUser: 10001, automountServiceAccountToken: true }).objects;
    const d = of(rw, "Deployment");
    expect(container(d).securityContext.readOnlyRootFilesystem).toBe(false);
    expect(container(d).volumeMounts).toBeUndefined();
    expect(podSpec(d).securityContext.runAsUser).toBe(10001);
    expect(podSpec(d).automountServiceAccountToken).toBe(true);
  });

  it("spreads replicas across zones only when there are several of each", () => {
    const spread = podSpec(of(render(serviceNode({ zones: 2, replicas: 3 })).objects, "Deployment")).topologySpreadConstraints;
    expect(spread).toHaveLength(1);
    expect(spread[0].topologyKey).toBe("topology.kubernetes.io/zone");
    expect(podSpec(of(render(serviceNode({ zones: 2, replicas: 1 })).objects, "Deployment")).topologySpreadConstraints).toBeUndefined();
  });

  it("renders an HPA only when autoscaling is on and replicas > 1, and then leaves replicas to it", () => {
    const on = render(serviceNode({ replicas: 3 }), fullGraph(), { autoscale: true });
    const hpa = of(on.objects, "HorizontalPodAutoscaler");
    expect((hpa.spec as any).minReplicas).toBe(3);
    expect((hpa.spec as any).maxReplicas).toBe(6);
    expect((hpa.spec as any).scaleTargetRef).toEqual({ apiVersion: "apps/v1", kind: "Deployment", name: "web" });
    expect((of(on.objects, "Deployment").spec as any).replicas).toBeUndefined();
    expect(on.notes.join("\n")).toMatch(/HorizontalPodAutoscaler/);
    expect(render(serviceNode({ replicas: 1 }), fullGraph(), { autoscale: true }).objects.map((o) => o.kind)).not.toContain("HorizontalPodAutoscaler");
    expect(render(serviceNode({ replicas: 3 })).objects.map((o) => o.kind)).not.toContain("HorizontalPodAutoscaler");
  });

  it("renders a worker with no port as a Deployment without a Service or HTTP probes", () => {
    const r = render(serviceNode({ workload: "worker", port: undefined, healthPath: undefined }));
    expect(r.objects.map((o) => o.kind)).toEqual(["Deployment"]);
    expect(container(of(r.objects, "Deployment")).readinessProbe).toBeUndefined();
    const noPort = render(serviceNode({ port: undefined }));
    expect(noPort.notes.join("\n")).toMatch(/no port is declared/);
  });

  it("uses a TCP readiness probe when there is a port but no health path", () => {
    const c = container(of(render(serviceNode({ healthPath: undefined })).objects, "Deployment"));
    expect(c.readinessProbe).toEqual({ tcpSocket: { port: "http" }, periodSeconds: 10, failureThreshold: 3 });
    expect(c.livenessProbe).toBeUndefined();
  });

  it("refuses unusable specs instead of guessing", () => {
    expect(() => render(serviceNode({ healthPath: "healthz" }))).toThrow(/must start with "\/"/);
    expect(() => render(serviceNode({ healthPath: "/a b" }))).toThrow(/whitespace/);
    expect(() => render(serviceNode({ vcpu: 0 }))).toThrow(/vcpu/);
    expect(() => render(serviceNode({ memoryMb: -4 }))).toThrow(/memoryMb/);
    expect(() => render(serviceNode({ replicas: 1.5 }))).toThrow(/integer/);
    expect(() => render(serviceNode({ port: 70000 }))).toThrow(/port/);
    expect(() => render(serviceNode({ artifact: { type: "image", ref: "bad image ref" } }))).toThrow(/not well-formed/);
  });

  it("needs a resolved image for built and blueprint artifacts", () => {
    const built = serviceNode({ artifact: { type: "built", pipeline: "build_pipeline/web" } });
    expect(() => render(built)).toThrow(/no image reference yet/);
    const r = render(built, fullGraph(), { resolveImage: () => "123.dkr.ecr.eu-west-1.amazonaws.com/web@sha256:abc" });
    expect(container(of(r.objects, "Deployment")).image).toContain("sha256:abc");
  });
});

describe("static_site, scheduled_job, identity, secret, volume", () => {
  it("renders a prebuilt-image static site on 8080 and says so", () => {
    const r = render(siteNode());
    const d = of(r.objects, "Deployment");
    expect(container(d).ports[0].containerPort).toBe(8080);
    expect(r.notes.join("\n")).toMatch(/prebuilt image/);
    expect(() => render({ ...siteNode(), spec: { size: "nano", artifact: { type: "built", pipeline: "build_pipeline/docs" } } })).toThrow(/no image reference yet/);
  });

  it("renders a CronJob with a hardened pod and Never restarts", () => {
    const r = render(cronNode());
    const cj = of(r.objects, "CronJob");
    expect((cj.spec as any).schedule).toBe("0 3 * * *");
    expect((cj.spec as any).concurrencyPolicy).toBe("Forbid");
    const pod = (cj.spec as any).jobTemplate.spec.template.spec;
    expect(pod.restartPolicy).toBe("Never");
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(pod.containers[0].securityContext.capabilities.drop).toEqual(["ALL"]);
  });

  it("suspends a CronJob that has no schedule, and rejects a non-cron schedule", () => {
    const r = render(cronNode({ schedule: undefined }));
    expect((of(r.objects, "CronJob").spec as any).suspend).toBe(true);
    expect(r.notes.join("\n")).toMatch(/suspended/);
    expect(render(cronNode({ schedule: "@daily" })).objects).toHaveLength(1);
    expect(() => render(cronNode({ schedule: "every tuesday" }))).toThrow(/not a cron expression/);
  });

  it("renders a ServiceAccount that does not mount a token, and notes that grants are not translated", () => {
    const r = render(identityNode());
    const sa = of(r.objects, "ServiceAccount");
    expect(sa.automountServiceAccountToken).toBe(false);
    expect(r.notes.join("\n")).toMatch(/does not translate grants/);
  });

  it("renders a Secret with a reference and NO data; the name matches the env secretKeyRef", () => {
    const r = render(secretNode());
    const s = of(r.objects, "Secret");
    expect(s.data).toBeUndefined();
    expect(s.stringData).toBeUndefined();
    expect(s.metadata.annotations?.[ANNOTATION.secretRef]).toBe("vault:proj1/svc1/STRIPE_KEY");
    expect(s.metadata.name).toBe(secretObjectName("vault:proj1/svc1/STRIPE_KEY"));
    expect(() => render(secretNode("hunter2hunter2"))).toThrow(/reference/);
  });

  it("renders a PVC for a volume", () => {
    const pvc = of(render(volumeNode()).objects, "PersistentVolumeClaim");
    expect((pvc.spec as any).resources.requests.storage).toBe("10Gi");
    expect((pvc.spec as any).storageClassName).toBe("fast");
    expect(() => render({ ...volumeNode(), spec: {} })).toThrow(/sizeGb/);
  });
});

describe("postgres and redis (dev tier)", () => {
  const pg = render(dbNode());
  const sts = of(pg.objects, "StatefulSet");

  it("renders StatefulSet + headless Service + PVC + credentials Secret, all labeled dev-only with a note", () => {
    expect(pg.objects.map((o) => o.kind).sort()).toEqual(["PersistentVolumeClaim", "Secret", "Service", "StatefulSet"]);
    for (const o of pg.objects) {
      expect(o.metadata.labels?.[LABEL.tier]).toBe("dev-only");
      expect(o.metadata.annotations?.[ANNOTATION.honestyNote]).toMatch(/not a production-grade managed database/);
    }
    expect((of(pg.objects, "Service").spec as any).clusterIP).toBe("None");
    expect(pg.notes.join("\n")).toMatch(/Not production-grade/);
  });

  it("is single-replica, non-root, and reads the password from the credentials Secret", () => {
    expect((sts.spec as any).replicas).toBe(1);
    expect(podSpec(sts).securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 999, fsGroup: 999 });
    const c = container(sts);
    expect(c.image).toBe("postgres:16");
    expect(c.env[0]).toEqual({ name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: credentialsSecretName(dbNode()), key: "value" } } });
    expect(c.securityContext.capabilities.drop).toEqual(["ALL"]);
  });

  it("gives the credentials Secret no data and a generated-credential reference", () => {
    const s = of(pg.objects, "Secret");
    expect(s.data).toBeUndefined();
    expect(s.metadata.annotations?.[ANNOTATION.secretRef]).toBe(generatedCredentialRef(ENV_ID, "resource/db"));
    expect(s.metadata.name).toBe("db-credentials");
  });

  it("sizes storage from the size profile or config.storageGb and notes unsupported requests", () => {
    const pvc = of(pg.objects, "PersistentVolumeClaim");
    expect((pvc.spec as any).resources.requests.storage).toBe("5Gi");
    const big = render(dbNode({ config: { storageGb: 50 }, highAvailability: true, backup: "daily" }));
    expect((of(big.objects, "PersistentVolumeClaim").spec as any).resources.requests.storage).toBe("50Gi");
    expect(big.notes.join("\n")).toMatch(/highAvailability was requested/);
    expect(big.notes.join("\n")).toMatch(/takes no backups/);
    expect(() => render(dbNode({ config: { storageGb: 0 } }))).toThrow(/storageGb/);
    expect(() => render(dbNode({ size: "gigantic" }))).toThrow(/unknown size/);
    expect(() => render(dbNode({ version: "16; rm -rf /" }))).toThrow(/version/);
  });

  it("renders redis with the password by reference (argument expansion), never inline", () => {
    const r = render(cacheNode());
    const c = container(of(r.objects, "StatefulSet"));
    expect(c.image).toBe("redis:7-alpine");
    expect(c.args).toContain("$(REDIS_PASSWORD)");
    expect(c.env[0].valueFrom.secretKeyRef.key).toBe("value");
    expect(r.objects.every((o) => o.metadata.labels?.[LABEL.tier] === "dev-only")).toBe(true);
  });

  it("does not realize mysql", () => {
    expect(() => render({ ...dbNode({ engine: "mysql" }), kind: "mysql" })).toThrow(/mysql is not supported/);
  });
});

describe("network, firewall, load balancer, certificate, DNS", () => {
  it("renders a Namespace with Pod Security labels and a default-deny ingress policy", () => {
    const r = render(networkNode());
    const ns = of(r.objects, "Namespace");
    expect(ns.metadata.name).toBe(NS);
    expect(ns.metadata.namespace).toBeUndefined();
    expect(ns.metadata.labels?.["pod-security.kubernetes.io/enforce"]).toBe("baseline");
    const np = of(r.objects, "NetworkPolicy");
    expect(np.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress"] });
    expect(np.metadata.namespace).toBe(NS);
  });

  it("defaults the namespace to zenith-<environment> and ignores a requested CIDR with a note", () => {
    const n = node({ address: "network/main", kind: "network", spec: { zones: 1, cidr: "10.0.0.0/16" } });
    const r = renderNode(n, ctxFor([n]));
    expect(of(r.objects, "Namespace").metadata.name).toBe("zenith-env-prod-1");
    expect(r.notes.join("\n")).toMatch(/no address range/);
  });

  it("renders a service-to-database rule with explicit peers and the firewall's port", () => {
    const np = of(render(firewallToDb()).objects, "NetworkPolicy");
    const spec = np.spec as any;
    expect(spec.policyTypes).toEqual(["Ingress"]);
    expect(spec.podSelector.matchLabels).toEqual({ [LABEL.name]: "db", [LABEL.partOf]: ENV_ID });
    expect(spec.ingress).toEqual([{ from: [{ podSelector: { matchLabels: { [LABEL.name]: "web", [LABEL.partOf]: ENV_ID } } }], ports: [{ protocol: "TCP", port: 5432 }] }]);
    expect(np.metadata.name).toBe("fw-web-to-db");
  });

  it("adds a namespace selector for a source in another namespace", () => {
    const otherNs = serviceNode({ namespace: "edge" });
    const graph = fullGraph().map((n) => (n.address === "service/web" ? otherNs : n));
    const np = of(render(firewallToDb(), graph).objects, "NetworkPolicy");
    const peer = (np.spec as any).ingress[0].from[0];
    expect(peer.namespaceSelector).toEqual({ matchLabels: { "kubernetes.io/metadata.name": "edge" } });
    expect(peer.podSelector.matchLabels[LABEL.name]).toBe("web");
  });

  it("renders a public rule for a load balancer target: the CIDR, the controller namespace, the backend ports", () => {
    const np = of(render(publicFirewall()).objects, "NetworkPolicy");
    const spec = np.spec as any;
    expect(spec.ingress[0].from).toEqual([{ ipBlock: { cidr: "0.0.0.0/0" } }, { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } } }]);
    expect(spec.ingress[0].ports).toEqual([{ protocol: "TCP", port: 8080 }]);
    expect(spec.podSelector.matchExpressions).toEqual([{ key: LABEL.name, operator: "In", values: ["web"] }]);
  });

  it("never renders an allow rule without explicit peers (an empty `from` would mean anywhere)", () => {
    const graph = fullGraph();
    const aws = node({ address: "service/remote", kind: "container_service", provider: "aws", nativeType: "aws:ecs_service", spec: {} });
    const cross = { ...firewallToDb(), spec: { ...firewallToDb().spec, source: { address: "service/remote" }, crossBoundary: "cross_cloud" } };
    const r = renderNode(cross, fullCtx([...graph, aws]));
    const np = of(r.objects, "NetworkPolicy");
    expect((np.spec as any).ingress).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/cannot select/);
    const missing = { ...firewallToDb(), spec: { ...firewallToDb().spec, source: { address: "service/ghost" } } };
    expect((of(renderNode(missing, fullCtx()).objects, "NetworkPolicy").spec as any).ingress).toEqual([]);
    for (const o of renderGraph(fullGraph(), { environmentId: ENV_ID, resolveDnsTarget: () => "x.example.com" }).objects) {
      if (o.kind !== "NetworkPolicy") continue;
      for (const rule of (o.spec as any).ingress ?? []) expect(rule.from?.length).toBeGreaterThan(0);
    }
  });

  it("rejects a firewall whose target is missing, foreign or unprotectable", () => {
    const ghost = { ...firewallToDb(), spec: { ...firewallToDb().spec, target: "resource/ghost" } };
    expect(() => render(ghost)).toThrow(/not in the graph/);
    const aws = node({ address: "resource/db", kind: "postgres", provider: "aws", nativeType: "aws:rds_instance", spec: {} });
    expect(() => renderNode(firewallToDb(), fullCtx([...fullGraph().filter((n) => n.address !== "resource/db"), aws]))).toThrow(/not a Kubernetes node/);
    expect(() => render({ ...firewallToDb(), spec: { ...firewallToDb().spec, source: {} } })).toThrow(/address or a cidr/);
    expect(() => render({ ...publicFirewall(), spec: { ...publicFirewall().spec, source: { cidr: "not-a-cidr" } } })).toThrow(/not a CIDR/);
  });

  it("renders an Ingress with grouped rules, class, TLS secret from the certificate node, and redirect", () => {
    const ing = of(render(lbNode()).objects, "Ingress");
    const spec = ing.spec as any;
    expect(spec.ingressClassName).toBe("nginx");
    expect(spec.rules).toEqual([{ host: "app.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "web", port: { number: 8080 } } } }] } }]);
    expect(spec.tls).toEqual([{ hosts: ["app.example.com"], secretName: tlsSecretName("app.example.com") }]);
    expect(ing.metadata.annotations?.["nginx.ingress.kubernetes.io/ssl-redirect"]).toBe("true");
  });

  it("matches a wildcard certificate and orders paths most-specific first", () => {
    const wildcard = node({ address: "tls_certificate/wild", kind: "tls_certificate", spec: { domain: "*.example.com", validation: "dns_automatic" } });
    const lb = lbNode();
    const two = {
      ...lb,
      spec: {
        ...lb.spec,
        routes: [
          { host: "app.example.com", pathPrefix: "/", tls: true, target: "service/web", port: 8080 },
          { host: "app.example.com", pathPrefix: "/api", tls: true, target: "service/web", port: 8080 },
        ],
      },
    };
    const graph = [...fullGraph().filter((n) => n.kind !== "tls_certificate" && n.address !== "load_balancer/public"), wildcard, two];
    const ing = of(renderNode(two, fullCtx(graph)).objects, "Ingress");
    expect((ing.spec as any).tls[0].secretName).toBe(tlsSecretName("*.example.com"));
    expect((ing.spec as any).rules[0].http.paths.map((p: any) => p.path)).toEqual(["/api", "/"]);
  });

  it("rejects routes the Ingress cannot honor", () => {
    const lb = lbNode();
    const bad = (routes: unknown[]) => ({ ...lb, spec: { ...lb.spec, routes } });
    expect(() => render(bad([]))).toThrow(/at least one route/);
    expect(() => render(bad([{ host: "a b", pathPrefix: "/", tls: false, target: "service/web", port: 80 }]))).toThrow(/valid hostname/);
    expect(() => render(bad([{ host: "a.example.com", pathPrefix: "x", tls: false, target: "service/web", port: 80 }]))).toThrow(/must start with/);
    const noPort = serviceNode({ port: undefined, healthPath: undefined });
    const graph = fullGraph().map((n) => (n.address === "service/web" ? noPort : n));
    expect(() => renderNode(bad([{ host: "a.example.com", pathPrefix: "/", tls: false, target: "service/web" }]), fullCtx(graph))).toThrow(/no known port/);
    const elsewhere = serviceNode({ namespace: "edge" });
    const graph2 = fullGraph().map((n) => (n.address === "service/web" ? elsewhere : n));
    expect(() => renderNode(lb, fullCtx(graph2))).toThrow(/own namespace/);
  });

  it("renders a cert-manager Certificate whose secret the Ingress references", () => {
    const r = render(certNode());
    const c = of(r.objects, "Certificate");
    expect((c.spec as any).secretName).toBe(tlsSecretName("app.example.com"));
    expect((c.spec as any).dnsNames).toEqual(["app.example.com"]);
    expect((c.spec as any).issuerRef).toEqual({ name: "zenith-letsencrypt-dns01", kind: "ClusterIssuer", group: "cert-manager.io" });
    expect(r.notes.join("\n")).toMatch(/prerequisites/);
    const manual = renderNode({ ...certNode(), spec: { domain: "app.example.com", validation: "dns_manual" } }, fullCtx(undefined, { clusterIssuers: { http01: "my-http" } }));
    expect((of(manual.objects, "Certificate").spec as any).issuerRef.name).toBe("my-http");
    expect(manual.notes.join("\n")).toMatch(/not a cert-manager flow/);
    expect(() => render({ ...certNode(), spec: { domain: "not a domain", validation: "dns_automatic" } })).toThrow(/valid domain/);
  });

  it("renders a DNSEndpoint only once the target address is known", () => {
    const r = render(dnsNode());
    const ep = (of(r.objects, "DNSEndpoint").spec as any).endpoints[0];
    expect(ep).toEqual({ dnsName: "app.example.com", recordType: "CNAME", recordTTL: 300, targets: ["lb.example.elb.amazonaws.com"] });
    const a = renderNode(dnsNode(), fullCtx(undefined, { resolveDnsTarget: () => "203.0.113.7" }));
    expect((of(a.objects, "DNSEndpoint").spec as any).endpoints[0].recordType).toBe("A");
    expect(() => renderNode(dnsNode(), ctxFor(fullGraph()))).toThrow(/not known yet/);
    expect(() => renderNode(dnsNode(), fullCtx(undefined, { resolveDnsTarget: () => "bad host!" }))).toThrow(/hostname or IP/);
  });
});

describe("whole-graph properties", () => {
  const graph = fullGraph();
  const ctx = { environmentId: ENV_ID, resolveDnsTarget: () => "lb.example.elb.amazonaws.com" };

  it("renders deterministically and independent of input order", () => {
    const a = renderGraph(graph, ctx);
    const b = renderGraph(graph, ctx);
    const c = renderGraph([...graph].reverse(), ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.objects)).toBe(JSON.stringify(c.objects));
  });

  it("orders a namespace before what lives in it and secrets before workloads", () => {
    const kinds = renderGraph(graph, ctx).objects.map((o) => o.kind);
    expect(kinds[0]).toBe("Namespace");
    expect(kinds.indexOf("Secret")).toBeLessThan(kinds.indexOf("Deployment"));
    expect(kinds.indexOf("Deployment")).toBeLessThan(kinds.indexOf("Ingress"));
    expect(kinds.indexOf("Ingress")).toBeLessThan(kinds.indexOf("DNSEndpoint"));
  });

  it("puts ownership marks on every object, and never a Secret value anywhere", () => {
    const { objects } = renderGraph(graph, ctx);
    expect(objects.length).toBeGreaterThan(20);
    for (const o of objects) {
      expect(o.metadata.labels?.[LABEL.managedBy]).toBe("zenith");
      expect(o.metadata.annotations?.[ANNOTATION.environment]).toBe(ENV_ID);
      expect(typeof o.metadata.annotations?.[ANNOTATION.resource]).toBe("string");
      if (o.kind === "Secret") {
        expect(o.data).toBeUndefined();
        expect(o.stringData).toBeUndefined();
      }
    }
    expect(JSON.stringify(objects)).not.toContain(SECRET_CANARY);
  });

  it("refuses two nodes that would render the same object", () => {
    const dup = node({ address: "resource/web", kind: "redis", dependsOn: ["network/main"], spec: { size: "nano", engine: "redis", highAvailability: false, backup: "none", subnetTier: "private", zones: 1, deletionPolicy: "allow", encryption: true } });
    expect(() => renderGraph([...graph, dup], ctx)).toThrow(/would both render Service "web"/);
  });

  it("renders only managed Kubernetes nodes", () => {
    const ref = { ...serviceNode(), ownership: "referenced" as const };
    const other = { ...serviceNode(), provider: "aws" as const, nativeType: "aws:ecs_service" };
    expect(renderObjects(ref, fullCtx())).toEqual([]);
    expect(renderObjects(other, fullCtx())).toEqual([]);
    expect(() => renderObjects({ ...serviceNode(), nativeType: "aws:ecs_service" }, fullCtx())).toThrow(K8sError);
    expect(() => renderObjects(node({ address: "queue/jobs", kind: "queue", spec: {} }), fullCtx())).toThrow(/cannot be realized on Kubernetes/);
  });

  it("targetFor names each node's primary object exactly as the renderer does", () => {
    const { objects } = renderGraph(graph, ctx);
    const primary: Record<string, string> = {
      "k8s:Namespace": "Namespace",
      "k8s:NetworkPolicy": "NetworkPolicy",
      "k8s:Ingress": "Ingress",
      "k8s:DNSEndpoint": "DNSEndpoint",
      "k8s:Certificate": "Certificate",
      "k8s:Deployment": "Deployment",
      "k8s:CronJob": "CronJob",
      "k8s:StatefulSet": "StatefulSet",
      "k8s:Secret": "Secret",
      "k8s:ServiceAccount": "ServiceAccount",
      "k8s:PersistentVolumeClaim": "PersistentVolumeClaim",
    };
    for (const n of graph) {
      const kind = primary[n.nativeType] as Parameters<typeof targetFor>[0];
      const expected = objects.find((o) => o.kind === kind && o.metadata.annotations?.[ANNOTATION.resource] === n.address);
      expect(expected, `${n.address} renders a ${kind}`).toBeDefined();
      // the derived target uses the environment default namespace unless the node names one; give it the graph's
      const t = targetFor(kind, { ...n, spec: { ...(n.spec as object), namespace: NS } }, ENV_ID);
      expect(t.name, n.address).toBe(expected!.metadata.name);
      if (expected!.metadata.namespace) expect(t.namespace).toBe(expected!.metadata.namespace);
    }
  });

  it("applyOrder is stable and total", () => {
    const { objects } = renderGraph(graph, ctx);
    const shuffled = [...objects].sort(() => 0).reverse();
    expect(applyOrder(shuffled).map((o) => `${o.kind}/${o.metadata.name}`)).toEqual(objects.map((o) => `${o.kind}/${o.metadata.name}`));
  });
});
