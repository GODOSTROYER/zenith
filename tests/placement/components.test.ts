import { describe, expect, it } from "vitest";
import { componentsFromGraph, deriveEdges, estimateGraphCost, loadDefaultCatalog, resolvePins, tierOf, type PlacementComponent } from "@/lib/placement";
import type { ResourceGraph } from "@/lib/resources/types";
import { stackComponents } from "./fixtures";

describe("components from a resource graph", () => {
  it("keeps managed nodes movable and pins referenced, external and provider-native nodes where they are", () => {
    const { components, edges } = componentsFromGraph({
      nodes: [
        { address: "service/web", kind: "container_service", provider: "aws", region: "us-east-1", ownership: "managed", spec: { size: "standard" } },
        { address: "resource/legacy", kind: "postgres", provider: "azure", region: "eastus", ownership: "referenced", spec: {} },
        { address: "native/x", kind: "provider_native", provider: "gcp", region: "us-central1", ownership: "managed", spec: {} },
      ],
      edges: [{ from: "service/web", to: "resource/legacy", relation: "connects_to" }],
    });
    const byAddr = Object.fromEntries(components.map((c) => [c.address, c]));
    expect(byAddr["service/web"]).toMatchObject({ name: "web", kind: "container_service", size: "standard" });
    expect(byAddr["service/web"]!.pin).toBeUndefined();
    expect(byAddr["resource/legacy"]!.pin).toEqual({ provider: "azure", region: "eastus" });
    expect(byAddr["native/x"]!.pin).toEqual({ provider: "gcp", region: "us-central1" });
    expect(edges).toEqual([{ from: "service/web", to: "resource/legacy", relation: "connects_to" }]);
  });

  it("classifies kinds into tiers", () => {
    expect(tierOf("postgres")).toBe("data");
    expect(tierOf("object_store")).toBe("data");
    expect(tierOf("container_service")).toBe("app");
    expect(tierOf("load_balancer")).toBe("app");
  });

  it("derives load balancer -> compute -> data edges when none are given", () => {
    const edges = deriveEdges(stackComponents());
    expect(edges).toContainEqual({ from: "load_balancer/edge", to: "service/web", relation: "routes_to" });
    expect(edges).toContainEqual({ from: "service/web", to: "resource/db", relation: "connects_to" });
    expect(edges).toContainEqual({ from: "service/web", to: "resource/assets", relation: "connects_to" });
  });
});

describe("ResourceGraph compatibility", () => {
  // Compile-time check as much as a runtime one: a real ResourceGraph must be accepted as-is
  // by componentsFromGraph and estimateGraphCost, so WS-RES output needs no adapter.
  const graph: ResourceGraph = {
    version: 1,
    environmentId: "env_1",
    manifestDigest: "d".repeat(64),
    graphDigest: "g".repeat(64),
    notes: [],
    nodes: [
      { address: "network/main", kind: "network", provider: "aws", region: "us-east-1", nativeType: "aws:vpc", ownership: "managed", spec: {}, origin: [], dependsOn: [], specDigest: "a", labels: {} },
      { address: "service/web", kind: "container_service", provider: "aws", region: "us-east-1", nativeType: "aws:ecs_service", ownership: "managed", spec: { size: "small", replicas: 2 }, origin: ["web"], dependsOn: ["network/main"], specDigest: "b", labels: {} },
      { address: "resource/db", kind: "postgres", provider: "aws", region: "us-east-1", nativeType: "aws:rds_postgres", ownership: "managed", spec: { size: "small" }, origin: ["db"], dependsOn: ["network/main"], specDigest: "c", labels: {} },
    ],
    edges: [{ from: "service/web", to: "resource/db", relation: "connects_to", detail: "sql" }],
  };

  it("prices and converts a ResourceGraph without an adapter", () => {
    const est = estimateGraphCost(graph, { catalog: loadDefaultCatalog() });
    expect(est.monthlyUsd).toBeGreaterThan(0);
    expect(est.lines.some((l) => l.address === "service/web")).toBe(true);
    const { components, edges } = componentsFromGraph(graph);
    expect(components.map((c) => c.address)).toEqual(["network/main", "service/web", "resource/db"]);
    expect(edges).toEqual([{ from: "service/web", to: "resource/db", relation: "connects_to" }]);
  });
});

describe("pin resolution", () => {
  const components: PlacementComponent[] = [
    { address: "service/web", kind: "container_service" },
    { address: "service/worker", kind: "container_service" },
    { address: "resource/db", kind: "postgres" },
    { address: "resource/cache", kind: "redis" },
  ];

  it("matches by address, short name, kind and alias", () => {
    const r = resolvePins(components, { "resource/cache": "gcp", web: "aws", postgres: "azure" });
    expect(r.byAddress.get("resource/cache")).toBe("gcp");
    expect(r.byAddress.get("service/web")).toBe("aws");
    expect(r.byAddress.get("resource/db")).toBe("azure");
    expect(r.unresolved).toEqual([]);
    const alias = resolvePins(components, { database: "oci", service: "aws", CACHE: " GCP " });
    expect(alias.byAddress.get("resource/db")).toBe("oci");
    expect(alias.byAddress.get("service/web")).toBe("aws");
    expect(alias.byAddress.get("service/worker")).toBe("aws");
    expect(alias.byAddress.get("resource/cache")).toBe("gcp");
  });

  it("reports keys that match nothing and conflicting pins instead of ignoring them", () => {
    const r = resolvePins(components, { databse: "aws", database: "azure", db: "gcp" });
    expect(r.unresolved).toEqual(["databse"]);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]).toMatch(/resource\/db is pinned to both/);
  });

  it("folds in the provider of fixed components", () => {
    const r = resolvePins([{ address: "resource/old", kind: "postgres", ownership: "referenced", pin: { provider: "azure", region: "eastus" } }], {});
    expect(r.byAddress.get("resource/old")).toBe("azure");
  });
});
