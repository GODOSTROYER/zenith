import { describe, expect, it } from "vitest";
import { ReconcileError, reconcileEnvironment, type ReconcileEvent } from "@/lib/reconcile";
import { ENV, MIN, SESSION_CANARY, graph, harness, persistedText } from "./_support";

const driftEvents = (events: ReconcileEvent[], type: ReconcileEvent["type"]) => events.filter((e) => e.type === type);

describe("reconcileEnvironment: persistence and the happy path", () => {
  it("observes every managed and referenced node, persists observations, runtime and a report, and reports nothing when in sync", async () => {
    const h = harness();
    const g = graph();
    const r = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });

    expect(r.status).toBe("reconciled");
    expect(r.report?.findings).toEqual([]);
    expect(r.openFindings).toBe(0);
    expect(r.changed).toBe(true); // first report ever
    const reconcilable = g.nodes.filter((n) => n.ownership !== "external");
    expect(r.observed).toBe(reconcilable.length);
    expect(r.unread).toBe(0);
    expect(h.backend.observations).toHaveLength(reconcilable.length);
    expect(h.backend.runtime.size).toBe(reconcilable.length);
    expect(h.backend.reportsOf(ENV.environmentId)).toHaveLength(1);
    expect(h.backend.events).toEqual([]);
    // Every driver call carried the environment's own tags, for tag-based lookup.
    for (const o of h.world.observed) {
      expect(o.tags["zenith:workspace"]).toBe("ws-1");
      expect(o.tags["zenith:environment"]).toBe("env-prod");
      expect(o.tags["zenith:resource"]).toBe(o.address);
    }
  });

  it("uses ONE credential session per provider, and only opens it when a driver can read something", async () => {
    const h = harness();
    await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toMatchObject({ workspaceId: "ws-1", environmentId: "env-prod", provider: "aws", connectionId: "conn-1" });
    expect(new Set(h.world.observed.map((o) => o.session)).size).toBe(1);

    const none = harness();
    for (const n of graph().nodes) none.world.noDriver.add(n.address);
    await reconcileEnvironment({ environment: ENV, graph: graph(), ports: none.ports });
    expect(none.sessions).toHaveLength(0); // nothing to read, so no credentials were requested
  });

  it("opens one session per provider when nodes span providers", async () => {
    const g = graph();
    const mixed = { ...g, nodes: g.nodes.map((n) => (n.address === "log_group/web" ? { ...n, provider: "gcp" as const } : n)) };
    const h = harness({ graph: mixed });
    await reconcileEnvironment({ environment: ENV, graph: mixed, ports: h.ports });
    expect(h.sessions.map((s) => s.provider).sort()).toEqual(["aws", "gcp"]);
  });

  it("reads runtime state for present nodes and records unknown (with a reason) for ones it could not read", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    h.world.patch("container_service/web", { runtime: { health: "degraded", counts: { desired: 2, running: 1 }, signals: ["task_stopped:OutOfMemory"] } });
    await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    const rt = (address: string) => h.backend.runtime.get(h.backend.resourceId("env-prod", address) ?? "");
    expect(rt("container_service/web")).toMatchObject({ health: "degraded", counts: { desired: 2, running: 1 } });
    expect(rt("log_group/web")).toMatchObject({ health: "unknown", signals: ["resource_missing"] });
  });

  it("a runtime read that fails becomes unknown health, not an absent row and not 'healthy'", async () => {
    const h = harness();
    h.world.patch("container_service/web", { runtime: "throw" });
    await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    expect(h.backend.runtime.get(h.backend.resourceId("env-prod", "container_service/web") ?? "")).toMatchObject({ health: "unknown", signals: ["runtime_failed"] });
  });

  it("a driver's expectedAttributes decide what is compared", async () => {
    const h = harness();
    h.world.patch("container_service/web", { attrs: { replicas: 3 }, expected: { replicas: 2 } });
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    const f = r.report?.findings.find((x) => x.address === "container_service/web");
    expect(f).toMatchObject({ class: "changed", fields: [{ attribute: "replicas", desired: 2, observed: 3 }] });
  });

  it("refuses a graph that belongs to another environment", async () => {
    const h = harness();
    await expect(reconcileEnvironment({ environment: { ...ENV, environmentId: "env-other" }, graph: graph(), ports: h.ports })).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.backend.observations).toEqual([]);
  });
});

describe("reconcileEnvironment: drift.detected / drift.cleared across passes", () => {
  it("emits drift.detected once for new drift, nothing while it is unchanged, and drift.cleared with the SAME correlation id when it resolves", async () => {
    const h = harness();
    const g = graph();
    await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });

    h.clock.advance(5 * MIN);
    h.world.patch("container_service/web", { attrs: { replicas: 3 }, expected: { replicas: 2 } });
    const second = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    expect(second.detected).toBe(1);
    expect(second.changed).toBe(true);
    const detected = driftEvents(h.backend.events, "drift.detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      workspaceId: "ws-1",
      environmentId: "env-prod",
      actor: { kind: "system", id: "reconciler" },
      data: { address: "container_service/web", class: "changed", severity: "medium", transition: "new", attributes: ["replicas"] },
    });
    expect(detected[0].resourceId).toBe(h.backend.resourceId("env-prod", "container_service/web"));
    expect(detected[0].correlationId).toMatch(/^drift-[0-9a-f]{24}$/);

    h.clock.advance(15 * MIN);
    const third = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    expect(third.detected).toBe(0);
    expect(third.changed).toBe(false);
    expect(third.openFindings).toBe(1);
    expect(driftEvents(h.backend.events, "drift.detected")).toHaveLength(1); // no duplicate detected event

    h.clock.advance(15 * MIN);
    h.world.patch("container_service/web", { attrs: { replicas: 2 } });
    const fourth = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    expect(fourth.cleared).toBe(1);
    expect(fourth.openFindings).toBe(0);
    const cleared = driftEvents(h.backend.events, "drift.cleared");
    expect(cleared).toHaveLength(1);
    expect(cleared[0].data).toMatchObject({ address: "container_service/web", class: "changed", reason: "resolved" });
    expect(cleared[0].correlationId).toBe(detected[0].correlationId);
    expect(h.backend.reportsOf("env-prod")).toHaveLength(4);
  });

  it("re-reports a persisting finding whose risk signature changed, on the same correlation id", async () => {
    const h = harness();
    const g = graph();
    h.world.patch("container_service/web", { attrs: { replicas: 3 }, expected: { replicas: 2 } });
    await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    h.clock.advance(5 * MIN);
    // the same node now also drifts on memory
    h.world.patch("container_service/web", { attrs: { replicas: 3, memory: 2048 }, expected: { replicas: 2, memory: 1024 } });
    const r = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    expect(r.detected).toBe(1);
    const events = driftEvents(h.backend.events, "drift.detected");
    expect(events).toHaveLength(2);
    expect(events[1].data).toMatchObject({ transition: "updated", attributes: ["memory", "replicas"] });
    expect(events[1].correlationId).toBe(events[0].correlationId);
  });

  it("a finding that changes class is one cleared and one detected, each with its own lifecycle", async () => {
    const h = harness();
    const g = graph();
    h.world.patch("log_group/web", { attrs: { retention: 30 }, expected: { retention: 14 } });
    await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    h.clock.advance(5 * MIN);
    h.world.patch("log_group/web", { presence: "missing" });
    const r = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    expect(r.detected).toBe(1);
    expect(r.cleared).toBe(1);
    const [d1, d2] = driftEvents(h.backend.events, "drift.detected");
    expect(d1.correlationId).not.toBe(d2.correlationId);
  });

  it("does not claim a finding was resolved when its node simply stopped being reconciled", async () => {
    const h = harness();
    const g = graph();
    h.world.patch("log_group/web", { presence: "missing" });
    await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    h.clock.advance(5 * MIN);
    h.backend.setResourceStatus("env-prod", "log_group/web", { status: "deleting" });
    const r = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    expect(r.skippedNodes).toContainEqual({ address: "log_group/web", reason: "being_deleted" });
    expect(driftEvents(h.backend.events, "drift.cleared")[0].data).toMatchObject({ reason: "no_longer_reconciled" });
  });

  it("the first-seen map survives a lost map: the clear still correlates to the previous report's time", async () => {
    const h = harness();
    const g = graph();
    h.world.patch("log_group/web", { presence: "missing" });
    await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    h.backend.findingSince.clear();
    h.clock.advance(5 * MIN);
    h.world.patch("log_group/web", { presence: "present", attrs: {} });
    const r = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    expect(r.cleared).toBe(1);
    expect(driftEvents(h.backend.events, "drift.cleared")[0].correlationId).toMatch(/^drift-/);
  });

  it("re-appending the same events is idempotent (deterministic ids)", async () => {
    const h = harness();
    const g = graph();
    h.world.patch("log_group/web", { presence: "missing" });
    const r = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    const before = h.backend.events.length;
    await h.ports.store.appendEvents(ENV, h.backend.events);
    expect(h.backend.events).toHaveLength(before);
    expect(r.detected).toBe(1);
  });

  it("the drift report's graph digest change alone marks the pass as changed", async () => {
    const h = harness();
    const g = graph();
    await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    h.clock.advance(5 * MIN);
    const stable = await reconcileEnvironment({ environment: ENV, graph: g, ports: h.ports });
    expect(stable.changed).toBe(false);
    h.clock.advance(5 * MIN);
    const moved = await reconcileEnvironment({ environment: ENV, graph: { ...g, graphDigest: "f".repeat(64) }, ports: h.ports });
    expect(moved.changed).toBe(true);
  });
});

describe("reconcileEnvironment: what could not be read is reported, never skipped", () => {
  it("a driver that throws becomes an unknown observation and an unknown finding", async () => {
    const h = harness();
    h.world.patch("log_group/web", { throws: new Error("socket hang up") });
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    const f = r.report?.findings.find((x) => x.address === "log_group/web");
    expect(f).toMatchObject({ class: "unknown", repairable: false });
    expect(f?.explanation).toContain("socket hang up");
    expect(r.unread).toBe(1);
    expect(r.report?.unobserved).toContain("log_group/web");
    const stored = h.backend.observations.find((o) => o.observation.address === "log_group/web");
    expect(stored?.observation).toMatchObject({ presence: "unknown", attributes: {} });
    expect(driftEvents(h.backend.events, "drift.detected")[0].data).toMatchObject({ class: "unknown" });
  });

  it("access denied becomes inaccessible, by error name, by HTTP status and by credential_denied", async () => {
    const h = harness();
    h.world.patch("log_group/web", { throws: Object.assign(new Error("not allowed"), { name: "AccessDeniedException" }) });
    h.world.patch("container_service/web", { throws: Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 403 } }) });
    h.world.patch("network/main", { throws: Object.assign(new Error("denied"), { code: "credential_denied" }) });
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    for (const a of ["log_group/web", "container_service/web", "network/main"]) expect(r.report?.findings.find((f) => f.address === a)?.class).toBe("inaccessible");
    expect(r.counts.inaccessible).toBe(3);
    expect(r.unread).toBe(3);
  });

  it("a hung driver is cut off by the per-node timeout and the rest of the environment still completes", async () => {
    const h = harness();
    h.world.patch("log_group/web", { hang: true });
    const t = Date.now();
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports, options: { nodeTimeoutMs: 40 } });
    expect(Date.now() - t).toBeLessThan(5_000);
    const f = r.report?.findings.find((x) => x.address === "log_group/web");
    expect(f).toMatchObject({ class: "unknown" });
    expect(f?.explanation).toMatch(/timed out/);
    // the abandoned call was told to stop
    expect(h.world.observed.find((o) => o.address === "log_group/web")?.signal.aborted).toBe(true);
    expect(r.observed).toBe(graph().nodes.filter((n) => n.ownership !== "external").length - 1);
  });

  it("a node with no registered driver is an unknown finding that says so", async () => {
    const h = harness();
    h.world.noDriver.add("network/main");
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    const f = r.report?.findings.find((x) => x.address === "network/main");
    expect(f).toMatchObject({ class: "unknown" });
    expect(f?.explanation).toMatch(/no resource driver is registered for aws aws:vpc/);
    expect(h.backend.observations.some((o) => o.observation.address === "network/main")).toBe(true);
  });

  it("when the credential session cannot be opened every node of that provider is reported, not skipped", async () => {
    const n = graph().nodes.filter((x) => x.ownership !== "external").length;
    const denied = harness();
    const r = await reconcileEnvironment({
      environment: ENV,
      graph: graph(),
      ports: { ...denied.ports, withObserveSession: async () => Promise.reject(Object.assign(new Error("connection revoked"), { code: "credential_denied" })) },
    });
    expect(r.counts.inaccessible).toBe(n);
    expect(r.unread).toBe(n);
    expect(denied.backend.observations).toHaveLength(n);
    expect(denied.world.observed).toHaveLength(0); // no driver was ever called without a session

    const flaky = harness();
    const r2 = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: { ...flaky.ports, withObserveSession: async () => Promise.reject(new Error("sts unreachable")) } });
    expect(r2.counts.unknown).toBe(n);
    expect(r2.counts.inaccessible).toBe(0);
  });

  it("a pass deadline that has already passed reports every node as unread, for that reason", async () => {
    const h = harness();
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports, options: { deadlineAt: Date.now() - 1 } });
    expect(r.unread).toBe(r.observed + r.unread);
    expect(r.observed).toBe(0);
    expect(r.report?.findings[0].explanation).toMatch(/deadline/);
  });

  it("an observation about a different resource, or with a bad presence, is rejected as unknown", async () => {
    const h = harness();
    h.world.patch("log_group/web", { wrongAddress: true });
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    expect(r.report?.findings.find((f) => f.address === "log_group/web")).toMatchObject({ class: "unknown" });
    expect(r.report?.findings.find((f) => f.address === "log_group/web")?.explanation).toMatch(/different resource/);
  });

  it("bounds concurrency", async () => {
    const h = harness();
    for (const n of graph().nodes) if (n.ownership !== "external") h.world.patch(n.address, { delayMs: 15 });
    await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports, options: { nodeConcurrency: 3 } });
    expect(h.world.maxInFlight).toBeGreaterThan(1);
    expect(h.world.maxInFlight).toBeLessThanOrEqual(3);

    const serial = harness();
    for (const n of graph().nodes) if (n.ownership !== "external") serial.world.patch(n.address, { delayMs: 5 });
    await reconcileEnvironment({ environment: ENV, graph: graph(), ports: serial.ports, options: { nodeConcurrency: 1 } });
    expect(serial.world.maxInFlight).toBe(1);
  });
});

describe("reconcileEnvironment: which nodes are reconciled", () => {
  it("does not call never-applied nodes 'missing': they are skipped with a reason and produce no drift", async () => {
    const h = harness({ status: "planned" });
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    expect(r.status).toBe("nothing_to_reconcile");
    expect(r.report).toBeUndefined();
    expect(r.skippedNodes.some((s) => s.reason === "not_applied")).toBe(true);
    expect(h.backend.reportsOf("env-prod")).toEqual([]);
    expect(h.sessions).toHaveLength(0);
    expect(h.backend.events).toEqual([]);
  });

  it("skips external nodes and nodes with no stored row, and says which", async () => {
    const h = harness();
    const g = graph();
    const external = { ...g.nodes[0], address: "external/thing", ownership: "external" as const };
    const orphan = { ...g.nodes[0], address: "log_group/orphan" };
    const r = await reconcileEnvironment({ environment: ENV, graph: { ...g, nodes: [...g.nodes, external, orphan] }, ports: h.ports });
    expect(r.skippedNodes).toContainEqual({ address: "external/thing", reason: "external" });
    expect(r.skippedNodes).toContainEqual({ address: "log_group/orphan", reason: "no_resource_row" });
    expect(r.report?.findings.some((f) => f.address === "log_group/orphan")).toBe(false);
  });

  it("reports referenced nodes' drift without ever treating them as owned", async () => {
    const h = harness();
    h.world.patch("dns_zone/atlas.zenith.test", { presence: "missing" });
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    const f = r.report?.findings.find((x) => x.address === "dns_zone/atlas.zenith.test");
    expect(f).toMatchObject({ class: "missing", repairable: false, autoRepairEligible: false });
  });
});

describe("reconcileEnvironment: tenancy and secrets", () => {
  it("a second workspace cannot reconcile, read or write an environment it does not own", async () => {
    const h = harness();
    await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    const before = persistedText(h.backend);
    const intruder = { ...ENV, workspaceId: "ws-2" };
    await expect(reconcileEnvironment({ environment: intruder, graph: graph(), ports: h.ports })).rejects.toBeInstanceOf(ReconcileError);
    await expect(reconcileEnvironment({ environment: intruder, graph: graph(), ports: h.ports })).rejects.toMatchObject({ code: "tenant_mismatch" });
    expect(persistedText(h.backend)).toBe(before);
  });

  it("no credential shape from a thrown error, a driver's error string, or the session reaches anything persisted", async () => {
    const h = harness();
    const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const URL_PW = "postgres://admin:hunter2-canary@db.internal:5432/app";
    h.world.patch("log_group/web", { throws: new Error(`denied for ${KEY_ID} with secret ${SECRET}; ${BEARER}; ${URL_PW}; password=hunter2-canary`) });
    h.world.patch("network/main", { presence: "unknown", error: `sts said aws_secret_access_key=${SECRET}` });
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    const all = persistedText(h.backend) + JSON.stringify(r);
    for (const canary of [KEY_ID, SECRET, "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "hunter2-canary", SESSION_CANARY]) expect(all).not.toContain(canary);
    expect(r.report?.findings.find((f) => f.address === "log_group/web")?.explanation).toContain("[redacted");
  });

  it("credential shapes a driver put in an attribute value or the native bag are scrubbed before they are compared or stored", async () => {
    const h = harness();
    const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    h.world.patch("container_service/web", { attrs: { note: `rotated ${KEY_ID}` }, expected: { note: "clean" }, native: { env: { BOOT: "url=postgres://admin:hunter2-canary@db:5432/app" }, tags: { "zenith:managed": "true" } } });
    const r = await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    const text = persistedText(h.backend) + JSON.stringify(r);
    expect(text).not.toContain(KEY_ID);
    expect(text).not.toContain("hunter2-canary");
    // the legitimate parts of the native bag survive, and the drift is still found
    const stored = h.backend.observations.find((o) => o.observation.address === "container_service/web");
    expect(stored?.observation.native).toMatchObject({ tags: { "zenith:managed": "true" } });
    expect(r.report?.findings.find((f) => f.address === "container_service/web")).toMatchObject({ class: "changed" });
  });

  it("events carry names and classes, never a desired or observed value", async () => {
    const h = harness();
    h.world.patch("container_service/web", { attrs: { image: "OBSERVED-VALUE-xyz" }, expected: { image: "DESIRED-VALUE-abc" } });
    await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    expect(driftEvents(h.backend.events, "drift.detected")).toHaveLength(1);
    const text = JSON.stringify(h.backend.events);
    expect(text).not.toContain("OBSERVED-VALUE-xyz");
    expect(text).not.toContain("DESIRED-VALUE-abc");
    expect(text).toContain("image");
  });
});

describe("the driver contract is honoured: the controller only reads", () => {
  it("never calls a driver operation, whatever the drift", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    h.world.patch("container_service/web", { attrs: { replicas: 9 }, expected: { replicas: 2 } });
    await reconcileEnvironment({ environment: ENV, graph: graph(), ports: h.ports });
    expect(h.world.operationCalls).toEqual([]);
  });
});
