/**
 * A healthy environment: every check passes, nothing reaches the hypothesis
 * threshold, and the engine does not invent a problem.
 */
import { describe, expect, it } from "vitest";
import { HYPOTHESIS_THRESHOLD, investigate, summarizeForModel } from "@/lib/incidents";
import { ENV, PROJECT, WORKSPACE, buildGraph, change, healthyWorld, makePorts, newCalls } from "./fixtures";

const env = { workspaceId: WORKSPACE, projectId: PROJECT, environmentId: ENV };

describe("healthy environment", () => {
  it("reports every hop on the path as healthy and raises no hypothesis", async () => {
    const inv = await investigate({ graph: buildGraph(), environment: env }, makePorts(healthyWorld()));
    expect(inv.path.map((p) => p.hop)).toEqual([
      "dns", "tls", "firewall", "firewall", "load_balancer", "firewall", "container", "application", "firewall", "database", "secret", "identity", "deployment", "drift",
    ]);
    expect(inv.path.every((p) => p.status === "healthy")).toBe(true);
    expect(inv.evidence.length).toBeGreaterThan(20);
    expect(inv.evidence.every((e) => e.outcome === "pass")).toBe(true);
    expect(inv.hypotheses).toEqual([]);
    expect(inv.simulated).toBe(false);
  });

  it("with a reported symptom it says nothing on the path explains it, below the threshold", async () => {
    const inv = await investigate({ graph: buildGraph(), environment: env, symptom: "some users see errors" }, makePorts(healthyWorld()));
    expect(inv.hypotheses).toHaveLength(1);
    const h = inv.hypotheses[0];
    expect(h.code).toBe("unknown");
    expect(h.confidence).toBeLessThan(HYPOTHESIS_THRESHOLD);
    expect(h.title).toMatch(/no fault/i);
    expect(h.remediations).toEqual([]);
    expect(h.nextSteps?.[0]).toMatch(/every check on the request path passed/i);
    expect(inv.symptom).toBe("some users see errors");
  });

  it("a recent deployment alone is information, not a hypothesis", async () => {
    const world = healthyWorld();
    world.changes = [change("deployment", 10, "release 1.4.2", "op_1")];
    const inv = await investigate({ graph: buildGraph(), environment: env }, makePorts(world));
    expect(inv.hypotheses).toEqual([]);
    expect(inv.recentChanges).toEqual([expect.objectContaining({ kind: "deployment", operationId: "op_1" })]);
    const recent = inv.evidence.find((e) => e.check === "changes.recent");
    expect(recent?.outcome).toBe("pass");
    expect(recent?.data.recentDeployment).toBe(true);
    // it is also not an error that started after the deploy: nothing is logging errors
    expect(inv.evidence.find((e) => e.check === "changes.errors_after_deploy")?.outcome).toBe("pass");
  });

  it("makes no mutating call and only read calls through the ports", async () => {
    const calls = newCalls();
    await investigate({ graph: buildGraph(), environment: env }, makePorts(healthyWorld(), calls));
    expect(calls.policy).toEqual([]); // nothing to propose, so nothing to dry-run
    expect(calls.searchLogs.every((q) => q.scope.workspaceId === WORKSPACE && q.scope.environmentId === ENV)).toBe(true);
    expect(calls.searchLogs.every((q) => (q.limit ?? 0) <= 500)).toBe(true);
  });

  it("asks for logs over a 30 minute window scoped to the service only", async () => {
    const calls = newCalls();
    await investigate({ graph: buildGraph(), environment: env }, makePorts(healthyWorld(), calls));
    const q = calls.searchLogs[0];
    expect(q.scope.addresses).toEqual(["container_service/web"]);
    expect(new Date(q.range.to ?? "").getTime() - new Date(q.range.from).getTime()).toBe(30 * 60_000);
  });

  it("the model summary of a healthy run says there is nothing to explain", async () => {
    const inv = await investigate({ graph: buildGraph(), environment: env }, makePorts(healthyWorld()));
    const text = summarizeForModel(inv);
    expect(text).toContain("none: nothing on the path reached the confidence threshold");
    expect(text).not.toContain("[fail]");
  });

  it("runs an end-to-end probe per public host when a prober exists, and a healthy answer adds passing DNS/TLS/endpoint evidence", async () => {
    const world = healthyWorld();
    world.http = { "app.example.com": { status: 200, latencyMs: 41 } };
    const calls = newCalls();
    const inv = await investigate({ graph: buildGraph(), environment: env }, makePorts(world, calls));
    expect(calls.httpProbe).toEqual(["https://app.example.com/"]);
    const get = (c: string) => inv.evidence.find((e) => e.check === c);
    expect(get("http.dns_resolution")?.outcome).toBe("pass");
    expect(get("http.tls_handshake")?.outcome).toBe("pass");
    expect(get("http.endpoint")?.outcome).toBe("pass");
    expect(get("http.endpoint")?.address).toBe("load_balancer/public");
    expect(inv.path.every((p) => p.status === "healthy")).toBe(true);
    expect(inv.notes?.join(" ")).not.toMatch(/No end-to-end HTTP probe/);
  });
});
