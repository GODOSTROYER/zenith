import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { exportKubernetesBundle } from "@/lib/providers/zenith/export";
import { ZenithError } from "@/lib/providers/zenith/types";
import { DB_PASSWORD, FakeToolkit, NEON_KEY, NET, TYPICAL_GRAPH, WEB, WORKER, mkNode } from "./support";

const input = (over: Partial<Parameters<typeof exportKubernetesBundle>[0]> = {}, toolkit = new FakeToolkit()) =>
  exportKubernetesBundle({ environmentId: "env_b12e04", title: "Acme production", nodes: TYPICAL_GRAPH, toolkit, ...over });

const doc = (b: ReturnType<typeof exportKubernetesBundle>, pathRe: RegExp) => {
  const f = b.files.find((x) => pathRe.test(x.path));
  if (!f) throw new Error(`no file matching ${pathRe}`);
  return load(f.content) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe("exportKubernetesBundle", () => {
  const bundle = input();
  const text = (re: RegExp) => bundle.files.find((f) => re.test(f.path))!.content;

  it("produces a README, a kustomization and numbered manifests, sorted", () => {
    const paths = bundle.files.map((f) => f.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("kustomization.yaml");
    expect(paths.filter((p) => p.startsWith("manifests/")).length).toBeGreaterThan(5);
    expect([...paths].sort()).toEqual(paths);
    const kustomization = load(text(/kustomization/)) as { resources: string[]; kind: string };
    expect(kustomization.kind).toBe("Kustomization");
    expect(kustomization.resources.every((r) => paths.includes(r))).toBe(true);
    expect(kustomization.resources).toHaveLength(paths.filter((p) => p.startsWith("manifests/")).length);
  });

  it("is byte-identical for the same input, whatever the node order, and has a stable digest", () => {
    const again = input({ nodes: [...TYPICAL_GRAPH].reverse() });
    expect(again.files).toEqual(bundle.files);
    expect(again.digest).toBe(bundle.digest);
    expect(bundle.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes its digest when the app changes", () => {
    const changed = input({ nodes: TYPICAL_GRAPH.map((n) => (n.address === WEB.address ? mkNode(n.address, "container_service", { ...WEB.spec, replicas: 5 }) : n)) });
    expect(changed.digest).not.toBe(bundle.digest);
  });

  it("serves the ORIGINAL hostnames through a standard Ingress, not managed hostnames or HTTPRoutes", () => {
    expect(bundle.hosts).toEqual(["app.customer.com"]);
    const ing = doc(bundle, /ingress/);
    expect(ing.kind).toBe("Ingress");
    expect(ing.spec.rules[0].host).toBe("app.customer.com");
    expect(ing.spec.ingressClassName).toBe("nginx");
    const all = bundle.files.map((f) => f.content).join("\n");
    expect(all).not.toContain("apps.example.com");
    expect(all).not.toContain("HTTPRoute");
    expect(all).not.toContain("gateway.networking.k8s.io");
  });

  it("uses the namespace it was given and puts every namespaced object in it", () => {
    const custom = input({ namespace: "shop" });
    expect(custom.namespace).toBe("shop");
    for (const f of custom.files.filter((x) => x.path.startsWith("manifests/"))) {
      const o = load(f.content) as { kind: string; metadata: { name: string; namespace?: string } };
      if (o.kind === "Namespace") expect(o.metadata.name).toBe("shop");
      else expect(o.metadata.namespace, f.path).toBe("shop");
    }
    expect(() => input({ namespace: "Not A Label" })).toThrow(ZenithError);
  });

  it("strips Zenith's ownership annotations, so nothing claims to be Zenith-managed and Zenith will not adopt it", () => {
    for (const f of bundle.files.filter((x) => x.path.startsWith("manifests/"))) {
      expect(f.content, f.path).not.toContain("zenith.dev/");
    }
  });

  it("keeps the labels the selectors depend on", () => {
    const dep = doc(bundle, /deployment-web/);
    const selector = dep.spec.selector.matchLabels;
    expect(dep.spec.template.metadata.labels).toMatchObject(selector);
    const svc = doc(bundle, /service-web/);
    expect(svc.spec.selector).toEqual(selector);
  });

  it("contains no Secret objects and no secret values: it lists the Secrets to create instead", () => {
    expect(bundle.files.some((f) => /secret-/.test(f.path))).toBe(false);
    const all = bundle.files.map((f) => f.content).join("\n");
    expect(all).not.toMatch(/kind: Secret/);
    for (const canary of [DB_PASSWORD, NEON_KEY, "postgresql://"]) expect(all).not.toContain(canary);
    expect(bundle.secrets).toEqual([
      { name: "zs-database-url-1a2b3c", key: "value", reference: "vault:generated/env_b12e04/postgres/db/connection-uri", note: "the connection string of postgres/db; use YOUR Postgres' URL" },
    ]);
    const readme = text(/README/);
    expect(readme).toContain("kubectl -n app create secret generic zs-database-url-1a2b3c --from-literal=value=<VALUE>");
    expect(readme).toContain("use YOUR Postgres' URL");
  });

  it("leaves the managed database and DNS records out, says why, and keeps the rest", () => {
    expect(bundle.excluded.map((e) => e.address)).toEqual(["dns_record/app.customer.com", "firewall/web-to-db", "postgres/db"]);
    const all = bundle.files.map((f) => f.content).join("\n");
    expect(all).not.toContain("StatefulSet");
    expect(all).not.toContain("DNSEndpoint");
    expect(bundle.files.some((f) => /certificate/.test(f.path))).toBe(true);
    expect(bundle.files.some((f) => /networkpolicy/.test(f.path))).toBe(true);
    const readme = text(/README/);
    expect(readme).toContain("`postgres/db`");
    expect(readme).toContain("`dns_record/app.customer.com`");
  });

  it("states the database lock-in gap honestly rather than hiding it", () => {
    const readme = text(/README/);
    expect(readme).toMatch(/no way to export a value/);
    expect(readme).toMatch(/no database dump\/export operation yet/);
    expect(readme).toMatch(/not yet lock-in free/);
  });

  it("says what it does not reproduce and that it was never applied by Zenith", () => {
    const readme = text(/README/);
    expect(readme).toMatch(/tenant isolation/);
    expect(readme).toMatch(/generated, not applied/);
    expect(readme).toMatch(/NetworkPolicy/);
    expect(readme).toContain("kubectl apply -k .");
  });

  it("points certificates at the issuer name it was given", () => {
    const custom = input({ clusterIssuer: "my-issuer", ingressClass: "traefik" });
    const cert = doc(custom, /certificate/);
    expect(cert.spec.issuerRef.name).toBe("my-issuer");
    expect(doc(custom, /ingress/).spec.ingressClassName).toBe("traefik");
    expect(custom.files.find((f) => f.path === "README.md")!.content).toContain("`my-issuer`");
  });

  it("hands the renderer the original nodes' hosts and the chosen namespace, and never a postgres or DNS node", () => {
    const toolkit = new FakeToolkit();
    input({}, toolkit);
    const call = toolkit.renderCalls[0];
    expect(call.base.namespace).toBe("app");
    expect(call.base.ingressControllerNamespace).toBe("ingress-nginx");
    const seen = call.nodes.map((n) => n.address);
    for (const hidden of ["postgres/db", "dns_record/app.customer.com", "firewall/web-to-db"]) expect(seen).not.toContain(hidden);
    expect(JSON.stringify(call.nodes.find((n) => n.kind === "load_balancer")!.spec)).toContain("app.customer.com");
  });

  it("does not mutate the nodes it was given", () => {
    const frozen = structuredClone(TYPICAL_GRAPH);
    input({ nodes: frozen });
    expect(frozen).toEqual(TYPICAL_GRAPH);
  });

  it("renders a database-free app without any database section claims", () => {
    const small = input({ nodes: [NET, WEB, WORKER] });
    const readme = small.files.find((f) => f.path === "README.md")!.content;
    expect(readme).toContain("declares no Zenith-managed database");
    expect(readme).toContain("The app references no secrets.");
    expect(readme).toContain("The app has no public routes.");
    expect(small.excluded).toEqual([]);
  });

  it("ignores nodes that are not Zenith-managed on this provider", () => {
    const aws = mkNode("container_service/api", "container_service", WEB.spec, { provider: "aws", nativeType: "aws:ecs_service" });
    const ref = mkNode("container_service/ext", "container_service", WEB.spec, { ownership: "referenced" });
    const b = input({ nodes: [WEB, aws, ref] });
    expect(b.files.some((f) => /deployment-api/.test(f.path))).toBe(false);
    expect(b.files.some((f) => /deployment-web/.test(f.path))).toBe(true);
    expect(b.files.some((f) => /deployment-ext/.test(f.path))).toBe(false);
  });

  it("an exported object is plain Kubernetes: apiVersion, kind and a name", () => {
    for (const f of bundle.files.filter((x) => x.path.startsWith("manifests/"))) {
      const o = load(f.content) as { apiVersion?: string; kind?: string; metadata?: { name?: string } };
      expect(o.apiVersion, f.path).toBeTruthy();
      expect(o.kind, f.path).toBeTruthy();
      expect(o.metadata?.name, f.path).toBeTruthy();
    }
  });

  it("exports an empty app as just a README and a kustomization", () => {
    const empty = input({ nodes: [] });
    expect(empty.files.map((f) => f.path)).toEqual(["README.md", "kustomization.yaml"]);
    expect(empty.hosts).toEqual([]);
  });

  it("uses a built image reference the caller supplies, and refuses to export an app whose image is unknown", () => {
    const built = mkNode("container_service/web", "container_service", { ...WEB.spec, artifact: { type: "built", pipeline: "build_pipeline/web" } });
    expect(() => input({ nodes: [built] })).toThrow(/no image reference/);
    const ok = input({ nodes: [built], builtImages: { "build_pipeline/web": "ghcr.io/me/web@sha256:abc" } });
    expect(ok.files.map((f) => f.content).join("\n")).toContain("ghcr.io/me/web@sha256:abc");
  });
});
