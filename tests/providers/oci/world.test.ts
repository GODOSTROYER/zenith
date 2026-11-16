/**
 * Every OCI driver against a scripted healthy world: observe finds each node
 * by its Zenith tags, reads exactly the attributes `expectedAttributes` names,
 * and drift v2 reports nothing. This is the like-with-like check: desired and
 * observed attributes are in the same units.
 */
import { describe, expect, it } from "vitest";
import { computeDriftV2 } from "@/lib/resources";
import { driverContext, driverFor, expandOci, OCI_PROD } from "./_support";
import { healthyWorld } from "./_world";
import type { Observation, ResourceNode } from "@/lib/resources";

const observable = (n: ResourceNode): boolean => !(n.nativeType === "oci:vault_secret" && n.ownership !== "managed");

async function observeAll(graph = expandOci()) {
  const world = healthyWorld(graph);
  const ctx = driverContext(world.oci);
  const observations: Observation[] = [];
  for (const node of graph.nodes.filter(observable)) observations.push(await driverFor(node).observe!(ctx, node));
  return { graph, world, ctx, observations };
}

describe("healthy OCI world", () => {
  it("observes every node as present", async () => {
    const { observations } = await observeAll();
    const notPresent = observations.filter((o) => o.presence !== "present").map((o) => `${o.address}: ${o.presence} ${o.error ?? ""}`);
    expect(notPresent).toEqual([]);
    for (const o of observations) {
      expect(o.simulated).toBe(false);
      expect(o.source).toMatch(/^oci\.[a-z_]+@1$/);
    }
  });

  it("reads every attribute expectedAttributes names, as known values", async () => {
    const { graph, observations } = await observeAll();
    for (const node of graph.nodes.filter(observable)) {
      const obs = observations.find((o) => o.address === node.address)!;
      for (const key of Object.keys(driverFor(node).expectedAttributes!(node))) {
        const seen = obs.attributes[key];
        expect(seen, `${node.address}.${key} was not observed`).toBeDefined();
        expect(seen.state, `${node.address}.${key} is ${JSON.stringify(seen)}`).toBe("known");
      }
    }
  });

  it("drift v2 finds nothing: desired and observed agree", async () => {
    const { graph, observations } = await observeAll();
    const report = computeDriftV2(graph, observations, { expectedAttributes: (n) => (observable(n) ? driverFor(n).expectedAttributes!(n) : {}), computedAt: "2026-09-30T12:00:00Z" });
    // the referenced non-OCI secret is deliberately not observed; everything else must be clean
    expect(report.findings.filter((f) => f.address !== "secret/stripe-52b080c1")).toEqual([]);
  });

  it("is also clean for the two-zone production graph", async () => {
    const { graph, observations } = await observeAll(expandOci(undefined, OCI_PROD));
    const report = computeDriftV2(graph, observations, { expectedAttributes: (n) => (observable(n) ? driverFor(n).expectedAttributes!(n) : {}), computedAt: "2026-09-30T12:00:00Z" });
    expect(report.findings.filter((f) => f.address !== "secret/stripe-52b080c1")).toEqual([]);
  });

  it("native bags are bounded, tagged for drift, and never carry secret-looking keys", async () => {
    const { observations } = await observeAll();
    for (const o of observations) {
      if (!o.native) continue;
      expect(Buffer.byteLength(JSON.stringify(o.native))).toBeLessThanOrEqual(4096);
      expect(Object.keys(o.native).filter((k) => /password|token|privatekey/i.test(k))).toEqual([]);
      const tags = o.native.tags as Record<string, string> | undefined;
      if (tags) expect(Object.keys(tags).every((k) => k.startsWith("zenith:"))).toBe(true);
    }
  });

  it("verify passes for a healthy stack and runtime reports healthy where it exists", async () => {
    const { graph, observations, ctx } = await observeAll();
    for (const node of graph.nodes.filter(observable)) {
      const d = driverFor(node);
      const obs = observations.find((o) => o.address === node.address)!;
      const runtime = d.runtime ? await d.runtime(ctx, node) : undefined;
      if (runtime) expect(runtime.health, `${node.address} runtime`).toBe("healthy");
      const v = await d.verify!(ctx, node, obs, runtime);
      expect(v.checks.filter((c) => c.passed === false), `${node.address} failed checks`).toEqual([]);
      expect(v.status === "passed" || v.status === "unknown", `${node.address} status ${v.status}`).toBe(true);
      expect(v.simulated).toBe(false);
    }
  });
});
