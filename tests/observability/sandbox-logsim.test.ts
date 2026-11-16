/**
 * The sandbox source against the REAL logsim (deterministic generated data
 * over a temp product store), through the fabric. Everything returned here is
 * simulated and labeled so.
 *
 * `ZENITH_DATA` must be set before the store is imported (see
 * tests/_support/data-dir.ts), and nothing above the dynamic imports may pull
 * in application code that opens the store.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Deployment, Environment, Manifest, Revision } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";
import { ENV, graph, node, scope } from "./_fixtures";

tempDataDir("zenith-obs-logsim-");

const { resetDb } = await import("@/lib/db/store");
const { createObservabilityFabric } = await import("@/lib/observability/fabric");
const { createSandboxSource } = await import("@/lib/observability/sources/sandbox");
const { resourceHealth } = await import("@/lib/observability/health");

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const manifest = (chaos?: string): Manifest => ({
  version: 1,
  services: [
    {
      id: "svc-api",
      name: "api",
      kind: "web",
      source: { type: "image", image: "nginx" },
      size: "small",
      replicas: 2,
      port: 3000,
      env: chaos ? [{ key: "ZENITH_CHAOS", value: chaos }] : [],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [],
  bindings: [],
});

// fresh objects per resetDb: the store takes ownership of a revision's manifest and detaches it from the object
const revision = (id: string, number: number, chaos?: string) =>
  ({ id, projectId: "p1", number, manifest: manifest(chaos), message: `r${number}`, author: { type: "user", id: "u1", name: "Ada" }, createdAt: ago(60) }) as unknown as Revision;
const deployment = (revisionId: string, minutesAgo: number) =>
  ({ id: `dep-${revisionId}`, projectId: "p1", environmentId: ENV, revisionId, status: "succeeded", createdAt: ago(minutesAgo), endedAt: ago(minutesAgo), steps: [], outputs: [], approved: true, actor: { type: "user", id: "u1", name: "Ada" } }) as unknown as Deployment;
const environment = (deployedRevisionId: string) =>
  ({ id: ENV, projectId: "p1", name: "sandbox", class: "sandbox", connectionId: "c1", region: "local", deployedRevisionId, policies: { approvalRequired: false, allowStatefulDeletion: false }, baseDomain: "test", createdAt: ago(500) }) as unknown as Environment;

const api = node("service/api", "container_service", "sandbox", { origin: ["svc-api"] });
const g = graph([api]);

describe("sandbox source over the real logsim", () => {
  beforeAll(() => {
    resetDb({ environments: [environment("rev1")], revisions: [revision("rev1", 1)], deployments: [deployment("rev1", 20)] });
  });

  it("returns generated log lines, simulated, newest first, within the requested range", async () => {
    const fabric = createObservabilityFabric([createSandboxSource({ graph: g })]);
    const r = await fabric.searchLogs({ scope: scope(), range: { from: ago(5), to: new Date().toISOString() }, limit: 50 });
    expect(r.simulated).toBe(true);
    expect(r.sources).toEqual(["sandbox.logsim"]);
    expect(r.items.length).toBeGreaterThan(20);
    expect(r.items.length).toBeLessThanOrEqual(50);
    const times = r.items.map((l) => Date.parse(l.timestamp));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(times.every((t) => t >= Date.now() - 5 * 60_000 - 1000)).toBe(true);
    expect(r.items.every((l) => l.address === "service/api" && l.provider === "sandbox" && l.native.simulated === true)).toBe(true);
    expect(r.items.some((l) => l.severity === "info")).toBe(true);
  });

  it("is deterministic: the same window twice gives the same lines", async () => {
    const source = createSandboxSource({ graph: g });
    const range = { from: ago(3), to: ago(1) };
    const a = await source.searchLogs!({ scope: scope(), range, limit: 500 }, new AbortController().signal);
    const b = await source.searchLogs!({ scope: scope(), range, limit: 500 }, new AbortController().signal);
    expect(a.items.map((l) => l.message)).toEqual(b.items.map((l) => l.message));
    expect(a.items.length).toBeGreaterThan(0);
  });

  it("health is healthy for a clean deployment and reflects chaos, always simulated", async () => {
    const source = createSandboxSource({ graph: g });
    const [healthy] = await resourceHealth(scope(), g, { sandbox: source });
    expect(healthy).toMatchObject({ address: "service/api", health: "healthy", simulated: true, counts: { desired: 2, ready: 2, unhealthy: 0 } });

    resetDb({ environments: [environment("rev2")], revisions: [revision("rev1", 1), revision("rev2", 2, "degrade")], deployments: [deployment("rev1", 40), deployment("rev2", 10)] });
    const [degraded] = await resourceHealth(scope(), g, { sandbox: source });
    expect(degraded).toMatchObject({ health: "degraded", simulated: true, counts: { desired: 2, ready: 1, unhealthy: 1 }, signals: ["replicas_not_ready:1"] });
  });

  it("events come from the durable deployment history", async () => {
    const source = createSandboxSource({ graph: g });
    const r = await source.searchEvents!({ scope: scope(), range: { from: ago(120), to: new Date().toISOString() } }, new AbortController().signal);
    expect(r.simulated).toBe(true);
    expect(r.items.map((e) => e.type)).toContain("sandbox.health.degraded");
  });
});
