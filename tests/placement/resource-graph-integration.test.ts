/**
 * The cost engine must price the graphs `expandManifest()` actually emits —
 * not only hand-written fixtures. These specs come from
 * `src/lib/resources/specs.ts` (`highAvailability`, `backup: "daily"`,
 * `egress.natGateways`, `zones` as a count), which differ from the engine's
 * original key names.
 */
import { describe, expect, it } from "vitest";
import { expandManifest, upgradeManifest } from "@/lib/resources";
import { estimateGraphCost, loadDefaultCatalog } from "@/lib/placement";
import type { Manifest } from "@/lib/domain/types";

const manifest: Manifest = {
  version: 1,
  services: [
    {
      id: "svc_web",
      name: "web",
      kind: "web",
      source: { type: "image", image: "ghcr.io/example/web:1.0.0" },
      size: "small",
      replicas: 2,
      port: 3000,
      healthPath: "/health",
      env: [{ key: "DATABASE_URL", secretRef: "vault:DATABASE_URL" }],
      ownership: "managed",
    },
  ],
  resources: [{ id: "res_db", name: "db", kind: "postgres", config: {}, size: "small", ownership: "managed" }],
  routes: [{ id: "rt_app", host: "app.example.com", pathPrefix: "/", tls: true, managedDns: true }],
  bindings: [
    { id: "b1", from: "rt_app", to: "svc_web", capability: "http" },
    { id: "b2", from: "svc_web", to: "res_db", capability: "sql" },
  ],
};

const env = (klass: "sandbox" | "staging" | "production") => ({
  id: `env_${klass}`,
  name: klass,
  class: klass,
  provider: "aws" as const,
  region: "ap-south-1",
  baseDomain: "example.com",
});

describe("cost engine over expandManifest output", () => {
  it("prices a production AWS graph without throwing and sees HA, backups and NAT", () => {
    const v2 = upgradeManifest(manifest, { provider: "aws", region: "ap-south-1" });
    const graph = expandManifest(v2, env("production"));
    const estimate = estimateGraphCost(graph, { catalog: loadDefaultCatalog(), now: new Date("2026-09-30T00:00:00Z") });

    expect(estimate.kind).toBe("estimate");
    expect(estimate.monthlyUsd).toBeGreaterThan(0);

    const db = graph.nodes.find((n) => n.kind === "postgres");
    expect(db?.spec.backup).toBeTypeOf("string");
    const dbLines = estimate.lines.filter((l) => l.address === db?.address);
    expect(dbLines.length).toBeGreaterThan(0);
    if (db?.spec.highAvailability === true) {
      expect(dbLines.some((l) => l.description.includes("high availability"))).toBe(true);
    }
    expect(estimate.lines.some((l) => /backup/i.test(l.description))).toBe(true);
    expect(estimate.lines.some((l) => /NAT/i.test(l.description))).toBe(true);
  });

  it("respects the network's egress.natGateways mode", () => {
    const v2 = upgradeManifest(manifest, { provider: "aws", region: "ap-south-1" });
    const graph = expandManifest(v2, env("production"));
    const net = graph.nodes.find((n) => n.kind === "network");
    expect(net).toBeDefined();
    const withMode = (mode: "none" | "single" | "per_az") => ({
      ...graph,
      nodes: graph.nodes.map((n) => (n === net ? { ...n, spec: { ...n.spec, egress: { natGateways: mode } } } : n)),
    });
    const now = new Date("2026-09-30T00:00:00Z");
    const natHours = (mode: "none" | "single" | "per_az") =>
      estimateGraphCost(withMode(mode), { catalog: loadDefaultCatalog(), now })
        .lines.filter((l) => /NAT gateway hours/i.test(l.description))
        .reduce((s, l) => s + l.quantity, 0);
    expect(natHours("none")).toBe(0);
    expect(natHours("per_az")).toBeGreaterThan(natHours("single"));
  });
});
