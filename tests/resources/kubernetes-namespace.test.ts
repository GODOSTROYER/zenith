/**
 * Expansion must pin Kubernetes targets before hashing: graph-aware rendering
 * and graph-free reads/operations then agree. HTTP checks use a contract fake,
 * never live cluster evidence.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandManifest, graphDigestOf, specDigestOf, type ExpandEnv } from "@/lib/resources";
import type { ManifestV2 } from "@/lib/resources/manifest-v2";
import { serverSideApply } from "@/lib/providers/kubernetes/apply";
import { deploymentDriver } from "@/lib/providers/kubernetes/drivers/workload/deployment";
import { defaultNamespace } from "@/lib/providers/kubernetes/naming";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { targetFor } from "@/lib/providers/kubernetes/target";
import { ANNOTATION, isSupportedKind } from "@/lib/providers/kubernetes/types";
import { startFakeK8s, type FakeK8s } from "../providers/kubernetes/fake-api";
import { driverCtx, sessionFor } from "../providers/kubernetes/helpers";
import { PROD, fullManifest, manifest, res, svc, webDb } from "./_fixtures";

const env: ExpandEnv = { ...PROD, provider: "kubernetes", region: "contract-cluster" };
const tuned = (namespace: string): ManifestV2 => ({ ...fullManifest(), version: 2, providerConfig: { kubernetes: { namespace } } });
const kubernetesNodes = (graph: ReturnType<typeof expandManifest>) => graph.nodes.filter((n) => n.nativeType.startsWith("k8s:"));

describe("namespaces on expanded Kubernetes nodes", () => {
  it.each(["kubernetes", "zenith"] as const)("carries the network namespace on every Kubernetes-bound %s node", (provider) => {
    const input = tuned("tenant-workloads");
    const before = JSON.stringify(input);
    const graph = expandManifest(input, { ...env, provider });
    const namespace = graph.nodes.find((n) => n.address === "network/main")!.spec.namespace;
    expect(namespace).toBe("tenant-workloads");
    const bound = kubernetesNodes(graph);
    expect(new Set(bound.map((n) => n.kind))).toEqual(new Set([
      "network", "firewall", "load_balancer", "dns_record", "tls_certificate", "container_service", "scheduled_job", "static_site", "secret", "identity",
      ...(provider === "kubernetes" ? ["postgres", "redis"] : []),
    ]));
    for (const node of bound) expect(node.spec.namespace, node.address).toBe(namespace);
    for (const node of graph.nodes.filter((n) => !n.nativeType.startsWith("k8s:"))) expect(node.spec).not.toHaveProperty("namespace");
    for (const node of graph.nodes) expect(node.specDigest, node.address).toBe(specDigestOf(node));
    expect(graph.graphDigest).toBe(graphDigestOf(graph.nodes, graph.edges));
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(expandManifest(input, { ...env, provider }))).toBe(JSON.stringify(graph));
  });

  it("defaults from the environment name and updates digests when the namespace changes", () => {
    const graph = expandManifest(webDb(), env);
    for (const node of kubernetesNodes(graph)) expect(node.spec.namespace).toBe("zenith-production");
    const first = expandManifest(tuned("tenant-one"), env);
    const second = expandManifest(tuned("tenant-two"), env);
    for (const node of kubernetesNodes(first)) {
      const next = second.nodes.find((n) => n.address === node.address)!;
      expect(next.specDigest, node.address).not.toBe(node.specDigest);
      expect({ ...next.spec, namespace: node.spec.namespace }).toEqual(node.spec);
    }
    expect(first.graphDigest).not.toBe(second.graphDigest);
  });

  it("pins namespaces on static-only and referenced-only graphs without a derived network", () => {
    for (const service of [
      svc({ id: "site", name: "docs", kind: "static" }),
      svc({ id: "external", name: "legacy", kind: "web", ownership: "referenced", port: 8080 }),
    ]) {
      const graph = expandManifest({ ...manifest({ services: [service] }), version: 2, providerConfig: { kubernetes: { namespace: "no-network" } } }, env);
      expect(graph.nodes.some((n) => n.kind === "network")).toBe(false);
      expect(kubernetesNodes(graph)).toHaveLength(1);
      expect(kubernetesNodes(graph)[0].spec.namespace).toBe("no-network");
      const untuned = expandManifest(manifest({ services: [service] }), env);
      expect(kubernetesNodes(untuned)[0].spec.namespace).toBe("zenith-production");
    }
  });

  it("uses a remote Kubernetes place's namespace without adding it to AWS specs", () => {
    const input: ManifestV2 = {
      ...manifest({
        services: [svc({ id: "local", name: "local", kind: "web", port: 8080 }), svc({ id: "remote", name: "remote", kind: "worker" })],
        resources: [res({ id: "db", name: "remote-db", kind: "postgres" })],
      }),
      version: 2,
      providerConfig: { kubernetes: { namespace: "remote-ns" } },
      nodePlacement: {
        remote: { provider: "kubernetes", region: "cluster-one" },
        db: { provider: "kubernetes", region: "cluster-two" },
      },
    };
    const graph = expandManifest(input, PROD);
    expect(graph.nodes.filter((n) => n.kind === "network").map((n) => n.address)).toEqual([
      "network/kubernetes-cluster-one", "network/kubernetes-cluster-two", "network/main",
    ]);
    for (const node of kubernetesNodes(graph)) expect(node.spec.namespace, node.address).toBe("remote-ns");
    for (const node of graph.nodes.filter((n) => n.provider === "aws")) expect(node.spec).not.toHaveProperty("namespace");
  });

  it("makes graph-free primary targets agree with production rendering for every managed Kubernetes kind", () => {
    const graph = expandManifest(tuned("rendered-ns"), env);
    const nodes = kubernetesNodes(graph).filter((n) => n.ownership === "managed");
    const rendered = renderGraph(nodes, {
      environmentId: env.id,
      resolveImage: () => "registry.example.com/app@sha256:" + "a".repeat(64),
      resolveDnsTarget: () => "ingress.example.com",
    });
    for (const node of nodes) {
      const kind = node.nativeType.slice("k8s:".length);
      if (!isSupportedKind(kind)) throw new Error(`No Kubernetes kind for ${node.address}.`);
      const object = rendered.objects.find((o) => o.kind === kind && o.metadata.annotations?.[ANNOTATION.resource] === node.address);
      expect(object, node.address).toBeDefined();
      expect(targetFor(kind, node, env.id)).toEqual({ apiVersion: object!.apiVersion, kind, name: object!.metadata.name, ...(object!.metadata.namespace ? { namespace: object!.metadata.namespace } : {}) });
    }
  });
});

describe("expanded namespace through render, observe and restart", () => {
  let fake: FakeK8s;
  beforeEach(async () => { fake = await startFakeK8s(); });
  afterEach(async () => { await fake.close(); });

  it.each(["custom", "default"] as const)("reads and restarts the rendered deployment in the %s topology namespace", async (mode) => {
    const input = manifest({ services: [svc({ id: "web", name: "web", kind: "web", port: 8080 })] });
    const graph = expandManifest(mode === "custom" ? { ...input, version: 2, providerConfig: { kubernetes: { namespace: "custom-ns" } } } : input, env);
    const nodes = kubernetesNodes(graph);
    const workload = nodes.find((n) => n.kind === "container_service")!;
    const namespace = workload.spec.namespace as string;
    expect(namespace).not.toBe(defaultNamespace(env.id));
    const session = await sessionFor(fake, [namespace]);
    const rendered = renderGraph(nodes, { environmentId: env.id });
    const applied = await serverSideApply(rendered.objects, session, { environmentId: env.id });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    const ctx = driverCtx(session, { environmentId: env.id, operationId: "namespace-contract-restart" });
    const observed = await deploymentDriver.observe!(ctx, workload);
    expect(observed.presence).toBe("present");
    expect(observed.externalId).toBe(`${namespace}/web`);
    const restarted = await deploymentDriver.operations!["service.restart"](ctx, workload, {});
    expect(restarted.ok, JSON.stringify(restarted)).toBe(true);
    expect(restarted.data?.namespace).toBe(namespace);
    expect(fake.get("Deployment", namespace, "web")?.spec.template.metadata.annotations[ANNOTATION.restartedAt]).toBe(ctx.operationId);
    expect(fake.get("Deployment", defaultNamespace(env.id), "web")).toBeUndefined();
    const retried = await deploymentDriver.operations!["service.restart"](ctx, workload, {});
    expect(retried.data?.alreadyApplied).toBe(true);
  });
});
