/**
 * Reconciliation persistence canaries against fake drivers/in-memory storage.
 * Tests the controller's scrubbing and event shape, not live provider behavior.
 * Commit b43fc66 added heuristic value scrubbing, not arbitrary-secret detection.
 */
import { describe, expect, it } from "vitest";
import { reconcileEnvironment } from "@/lib/reconcile";
import { ENV, SESSION_CANARY, harness, persistedText, tinyGraph } from "../reconcile/_support";
import { assertNoCanaries, canarySecret, deepScanForCanaries } from "../_support/security";

describe("reconciliation value-scrubbing boundary", () => {
  it("a credential-shaped driver value is absent from persisted observations, reports, events and returns", async () => {
    const canary = canarySecret("reconcile/value", "aws-access-key-id");
    const h = harness({ graph: tinyGraph(ENV.environmentId), world: (w, g) => {
      w.allPresent(g, { diagnostic: canary });
      for (const node of g.nodes) w.patch(node.address, { expected: { diagnostic: "reference-only" } });
    } });
    const g = await h.ports.loadGraph(ENV);
    const out = await reconcileEnvironment({ environment: ENV, graph: g!, ports: h.ports });
    expect(h.backend.observations.length, "scanner must inspect actual persisted observations").toBeGreaterThan(0);
    assertNoCanaries([out, persistedText(h.backend)], [canary, SESSION_CANARY], "controller must scrub credential shapes and keep sessions out of every persisted surface");
  });

  it("SEC-F13 (LOW, driver contract): credential-shaped expected attributes must not reach drift desired values", async () => {
    const canary = canarySecret("reconcile/expected", "aws-access-key-id");
    const h = harness({ graph: tinyGraph(ENV.environmentId), world: (w, g) => w.allPresent(g, { diagnostic: canary }) });
    const g = await h.ports.loadGraph(ENV);
    const out = await reconcileEnvironment({ environment: ENV, graph: g!, ports: h.ports });
    assertNoCanaries([out, persistedText(h.backend)], [canary], "scrubbing must cover driver expectedAttributes as well as observe results");
  });

  it("SEC-F13: both observed and desired credentials are absent from persisted, emitted and returned values", async () => {
    const canary = canarySecret("reconcile/expected-control", "aws-access-key-id");
    const h = harness({ graph: tinyGraph(ENV.environmentId), world: (w, g) => w.allPresent(g, { diagnostic: canary }) });
    const g = await h.ports.loadGraph(ENV);
    const out = await reconcileEnvironment({ environment: ENV, graph: g!, ports: h.ports });
    if (!out.report) throw new Error("SEC-F13 characterization requires a completed drift report");
    expect(out.report.findings.length).toBeGreaterThan(0);
    expect(h.backend.observations.length, "scanner must inspect persisted observations").toBeGreaterThan(0);
    expect(h.backend.events.some((event) => event.type === "drift.detected"), "scanner must inspect actual emitted drift events").toBe(true);
    assertNoCanaries([out, h.backend.events, persistedText(h.backend)], [canary, SESSION_CANARY], "both sides of drift findings are scrubbed across every output boundary");
  });

  it("characterizes a neutral opaque driver value: it survives observations; events omit attribute values", async () => {
    const canary = canarySecret("reconcile/opaque", "password");
    const h = harness({ graph: tinyGraph(ENV.environmentId), world: (w, g) => {
      w.allPresent(g, { diagnostic: canary });
      for (const node of g.nodes) w.patch(node.address, { expected: { diagnostic: "reference-only" } });
    } });
    const g = await h.ports.loadGraph(ENV);
    await reconcileEnvironment({ environment: ENV, graph: g!, ports: h.ports });
    expect(deepScanForCanaries(h.backend.observations, [canary]).length, "heuristic scrubValue cannot recognize arbitrary plaintext credentials").toBeGreaterThan(0);
    expect(h.backend.events.some((e) => e.type === "drift.detected"), "attribute-value scanner must inspect actual drift events").toBe(true);
    assertNoCanaries(h.backend.events, [canary, SESSION_CANARY], "drift events carry attribute names, never driver attribute values");
  });
});
