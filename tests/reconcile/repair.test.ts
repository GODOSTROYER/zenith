import { describe, expect, it } from "vitest";
import { CapabilityRequestSchema } from "@/lib/capabilities/catalog";
import { DEFAULT_RECONCILE_OPTIONS, reconcileEnvironment, selectRepairCandidates, type ReconcileOptions, type ReconcilePorts, type RepairInput } from "@/lib/reconcile";
import type { DriftReport } from "@/lib/resources";
import { ENV, HOUR, MIN, World, graph, harness, known, persistedText, type Harness } from "./_support";

const run = (h: Harness, options?: ReconcileOptions, env = ENV) => reconcileEnvironment({ environment: env, graph: graph(), ports: h.ports as ReconcilePorts, options });
const decision = (r: Awaited<ReturnType<typeof run>>, address: string) => r.repairs.find((d) => d.address === address);

/** The repairable, non-stateful managed nodes of the fixture graph that a test can make go missing. */
const MISSING = ["log_group/web", "subnet/private-a", "subnet/private-b", "subnet/public-a", "subnet/public-b"];
const missing = (h: Harness, addresses: string[]) => addresses.forEach((a) => h.world.patch(a, { presence: "missing" }));

describe("repair candidates: only what policy could ever allow is proposed", () => {
  it("proposes a drift.repair for a managed, non-stateful missing node, scoped to the resource, with origin reconciler", async () => {
    const h = harness();
    missing(h, ["log_group/web"]);
    const r = await run(h);

    expect(h.broker.proposals).toHaveLength(1);
    const p = h.broker.proposals[0];
    expect(p.origin).toBe("reconciler");
    expect(p.principal).toMatchObject({ kind: "system", id: "reconciler" });
    expect(p.correlationId).toMatch(/^drift-/);
    // a valid catalog request, exactly as the broker's own schema sees it
    expect(() => CapabilityRequestSchema.parse(p.request)).not.toThrow();
    expect(p.request).toMatchObject({
      capability: "drift.repair",
      scope: { workspaceId: "ws-1", projectId: "proj-1", environmentId: "env-prod", resourceId: h.backend.resourceId("env-prod", "log_group/web") },
    });
    const input = p.request.input as RepairInput;
    expect(input).toMatchObject({ action: "reapply_desired_state", address: "log_group/web", kind: "log_group", findingClass: "missing", attributes: [] });
    expect(p.request.reason).toContain("log_group/web");
    expect(p.request.idempotencyKey).toMatch(/^reconcile-repair-[0-9a-f]{32}$/);

    expect(decision(r, "log_group/web")).toMatchObject({ status: "proposed", outcome: "allow", started: true, operationId: "op-1" });
    // the proposal joins the finding's lifecycle
    const detected = h.backend.events.find((e) => e.type === "drift.detected");
    expect(p.correlationId).toBe(detected?.correlationId);
    expect(h.backend.events.find((e) => e.type === "remediation.proposed")).toMatchObject({ operationId: "op-1", correlationId: detected?.correlationId, data: { source: "reconciler", outcome: "allow" } });
  });

  it("proposes for a changed managed node and names the drifted attributes, never their values", async () => {
    const h = harness();
    h.world.patch("container_service/web", { attrs: { image: "OBSERVED-IMAGE-xyz", replicas: 3 }, expected: { image: "DESIRED-IMAGE-abc", replicas: 2 } });
    await run(h);
    const input = h.broker.proposals[0].request.input as RepairInput;
    expect(input).toMatchObject({ findingClass: "changed", attributes: ["image", "replicas"], severity: "medium" });
    expect(JSON.stringify(h.broker.proposals[0])).not.toMatch(/OBSERVED-IMAGE|DESIRED-IMAGE/);
  });

  it("NEVER proposes for a stateful resource that is missing (recreating it makes an empty one)", async () => {
    const h = harness();
    missing(h, ["postgres/postgres"]);
    const r = await run(h);
    expect(r.report?.findings.find((f) => f.address === "postgres/postgres")).toMatchObject({ class: "missing", severity: "high", autoRepairEligible: false });
    expect(h.broker.proposals).toEqual([]);
    expect(decision(r, "postgres/postgres")).toMatchObject({ status: "skipped", reason: "stateful_missing" });
  });

  it("never proposes for a stateful resource that merely changed", async () => {
    const h = harness();
    h.world.patch("postgres/postgres", { attrs: { instanceClass: "db.m5.large" }, expected: { instanceClass: "db.t3.medium" } });
    const r = await run(h);
    expect(h.broker.proposals).toEqual([]);
    expect(decision(r, "postgres/postgres")).toMatchObject({ status: "skipped", reason: "stateful" });
  });

  it("never auto-repairs a firewall that now admits more than desired", async () => {
    const h = harness();
    h.world.patch("firewall/lb-to-web", { attrs: { cidr: "0.0.0.0/0" }, expected: { cidr: "10.0.0.0/16" } });
    const r = await run(h);
    expect(r.report?.findings.find((f) => f.address === "firewall/lb-to-web")).toMatchObject({ class: "changed", severity: "high", autoRepairEligible: false });
    expect(h.broker.proposals).toEqual([]);
    expect(decision(r, "firewall/lb-to-web")).toMatchObject({ status: "skipped", reason: "firewall_opened" });
  });

  it("a firewall that drifted in a harmless way is still a normal candidate", async () => {
    const h = harness();
    h.world.patch("firewall/lb-to-web", { attrs: { description: "changed by hand" }, expected: { description: "lb to web" } });
    await run(h);
    expect(h.broker.proposals).toHaveLength(1);
  });

  it("never proposes for an identity", async () => {
    const h = harness();
    h.world.patch("identity/web", { attrs: { policyDigest: "b" }, expected: { policyDigest: "a" } });
    const r = await run(h);
    expect(h.broker.proposals).toEqual([]);
    expect(decision(r, "identity/web")).toMatchObject({ status: "skipped", reason: "identity" });
  });

  it("never proposes for a referenced resource, however badly it drifted", async () => {
    const h = harness();
    h.world.patch("dns_zone/atlas.zenith.test", { presence: "missing" });
    const r = await run(h);
    expect(r.report?.findings.find((f) => f.address === "dns_zone/atlas.zenith.test")).toMatchObject({ class: "missing", repairable: false });
    expect(h.broker.proposals).toEqual([]);
    expect(decision(r, "dns_zone/atlas.zenith.test")).toMatchObject({ status: "skipped", reason: "not_managed" });
  });

  it("never proposes for unknown or inaccessible findings", async () => {
    const h = harness();
    h.world.patch("log_group/web", { throws: new Error("socket hang up") });
    h.world.patch("network/main", { throws: Object.assign(new Error("denied"), { name: "AccessDenied" }) });
    const r = await run(h);
    expect(h.broker.proposals).toEqual([]);
    expect(decision(r, "log_group/web")).toMatchObject({ status: "skipped", reason: "not_repairable" });
    expect(decision(r, "network/main")).toMatchObject({ status: "skipped", reason: "not_repairable" });
  });

  it("does not propose from a simulated observation, in an observe-only environment, or when auto repair is off", async () => {
    const sim = harness();
    sim.world.patch("log_group/web", { presence: "missing", simulated: true });
    expect(decision(await run(sim), "log_group/web")).toMatchObject({ reason: "simulated_observation" });
    expect(sim.broker.proposals).toEqual([]);

    const observeOnly = harness();
    missing(observeOnly, ["log_group/web"]);
    expect(decision(await run(observeOnly, undefined, { ...ENV, autonomyLevel: 0 }), "log_group/web")).toMatchObject({ reason: "autonomy_observe_only" });
    expect(observeOnly.broker.proposals).toEqual([]);

    const off = harness();
    missing(off, ["log_group/web"]);
    expect(decision(await run(off, { autoRepair: false }), "log_group/web")).toMatchObject({ reason: "auto_repair_disabled" });
    expect(off.broker.proposals).toEqual([]);
    // the drift was still reported and persisted
    expect(off.backend.reportsOf("env-prod")[0].findings.map((f) => f.address)).toContain("log_group/web");
  });

  it("requires a stored managed row: a graph that says managed but a row that says referenced is not repaired", async () => {
    const h = harness();
    h.backend.setResourceStatus("env-prod", "log_group/web", { ownership: "referenced" });
    missing(h, ["log_group/web"]);
    const r = await run(h);
    expect(h.broker.proposals).toEqual([]);
    expect(decision(r, "log_group/web")).toMatchObject({ reason: "ownership_mismatch" });
  });

  it("minConfirmations: a finding must persist across reports before it is proposed", async () => {
    const h = harness();
    missing(h, ["log_group/web"]);
    const first = await run(h, { minConfirmations: 2 });
    expect(decision(first, "log_group/web")).toMatchObject({ reason: "awaiting_confirmation" });
    expect(h.broker.proposals).toEqual([]);
    h.clock.advance(5 * MIN);
    const second = await run(h, { minConfirmations: 2 });
    expect(decision(second, "log_group/web")).toMatchObject({ status: "proposed" });
    expect(h.broker.proposals).toHaveLength(1);
  });
});

describe("selectRepairCandidates is independent of what the drift module claimed", () => {
  const g = graph();
  const nodes = new Map(g.nodes.map((n) => [n.address, n]));
  const resources = new Map(g.nodes.map((n) => [n.address, { id: `res-${n.address}`, address: n.address, ownership: n.ownership, status: "active" as const }]));
  const report = (findings: DriftReport["findings"], simulated = false): DriftReport => ({ environmentId: "env-prod", graphDigest: g.graphDigest, computedAt: "2026-10-01T12:00:00.000Z", findings, unobserved: [], simulated });
  const select = (findings: DriftReport["findings"], over: Partial<Parameters<typeof selectRepairCandidates>[0]> = {}) =>
    selectRepairCandidates({ report: report(findings), nodes, resources, environment: ENV, options: DEFAULT_RECONCILE_OPTIONS, previousKeys: new Set(), ...over });
  const claim = (address: string, over = {}) => ({ address, class: "missing" as const, severity: "medium" as const, repairable: true, autoRepairEligible: true, explanation: "x", ...over });

  it("a report that lies 'auto-repair eligible' for a stateful missing node, an identity, an opened firewall or a high-severity finding still yields no candidate", () => {
    const out = select([
      claim("postgres/postgres"),
      claim("identity/web", { class: "changed", fields: [{ attribute: "policy", desired: "a", observed: "b" }] }),
      claim("firewall/lb-to-web", { class: "changed", fields: [{ attribute: "cidr", desired: "10.0.0.0/16", observed: "0.0.0.0/0" }] }),
      claim("log_group/web", { severity: "high" }),
    ]);
    expect(out.candidates).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual(["stateful_missing", "identity", "firewall_opened", "high_severity"]);
  });

  it("a referenced node is never a candidate even if its finding says repairable", () => {
    const out = select([claim("dns_zone/atlas.zenith.test", { repairable: true, autoRepairEligible: true })]);
    expect(out.candidates).toEqual([]);
    expect(out.skipped[0].reason).toBe("not_managed");
  });

  it("an address that is not in the graph is never a candidate (extra)", () => {
    expect(select([claim("log_group/ghost", { class: "extra" })]).candidates).toEqual([]);
  });

  it("a plain managed missing node is a candidate", () => {
    expect(select([claim("log_group/web")]).candidates.map((c) => c.node.address)).toEqual(["log_group/web"]);
  });
});

describe("broker outcomes: allow, approval, deny, failure", () => {
  it("allow starts the workflow exactly once, for that operation, with the tenant scope", async () => {
    const h = harness();
    missing(h, ["log_group/web"]);
    await run(h);
    expect(h.started).toEqual([{ operationId: "op-1", workspaceId: "ws-1", projectId: "proj-1", environmentId: "env-prod", correlationId: h.broker.proposals[0].correlationId }]);
  });

  it("require_approval is reported and NOT started", async () => {
    const h = harness();
    h.broker.script = "require_approval";
    missing(h, ["log_group/web"]);
    const r = await run(h);
    expect(decision(r, "log_group/web")).toMatchObject({ status: "proposed", outcome: "require_approval", operationId: "op-1" });
    expect(decision(r, "log_group/web")?.started).toBeUndefined();
    expect(h.started).toEqual([]);
  });

  it("deny is reported and NOT started", async () => {
    const h = harness();
    h.broker.script = "deny";
    missing(h, ["log_group/web"]);
    const r = await run(h);
    expect(decision(r, "log_group/web")).toMatchObject({ status: "proposed", outcome: "deny" });
    expect(h.started).toEqual([]);
  });

  it("a broker failure fails that candidate only, with a scrubbed reason, and the pass completes and commits", async () => {
    const h = harness();
    h.broker.script = (_p, n) => (n === 1 ? "throw" : { outcome: "allow", operationId: `op-x${n}` });
    missing(h, ["log_group/web", "subnet/private-a"]);
    const r = await run(h);
    const failed = r.repairs.filter((d) => d.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ reason: "broker_error" });
    expect(failed[0].error).not.toMatch(/abcdefghijklmnop/); // the Bearer token in the thrown message
    expect(r.repairs.filter((d) => d.status === "proposed")).toHaveLength(1);
    expect(h.backend.reportsOf("env-prod")).toHaveLength(1);
  });

  it("a workflow start failure is recorded and retried on the next pass without a second proposal", async () => {
    const h = harness();
    missing(h, ["log_group/web"]);
    h.failStart(1);
    const first = await run(h);
    expect(decision(first, "log_group/web")).toMatchObject({ status: "proposed", outcome: "allow", started: false, reason: "start_failed" });
    expect(h.started).toEqual([]);

    h.clock.advance(5 * MIN);
    const second = await run(h);
    expect(h.broker.proposals).toHaveLength(1); // no new proposal
    expect(decision(second, "log_group/web")).toMatchObject({ status: "skipped", reason: "repair_open", started: true });
    expect(h.started.map((s) => s.operationId)).toEqual(["op-1"]);
  });

  it("does not resume an operation whose finding has cleared", async () => {
    const h = harness();
    missing(h, ["log_group/web"]);
    h.failStart(1);
    await run(h);
    h.clock.advance(5 * MIN);
    h.world.patch("log_group/web", { presence: "present", attrs: {} });
    await run(h);
    expect(h.started).toEqual([]);
  });
});

describe("pacing: rate limit, open operations, cooldown", () => {
  it("proposes at most 3 per environment per hour, deterministically, and says what it held back", async () => {
    const h = harness();
    missing(h, MISSING);
    const r = await run(h);
    expect(h.broker.proposals).toHaveLength(3);
    expect(r.repairs.filter((d) => d.status === "proposed").map((d) => d.address)).toEqual(["log_group/web", "subnet/private-a", "subnet/private-b"]);
    expect(r.repairs.filter((d) => d.reason === "rate_limited").map((d) => d.address)).toEqual(["subnet/public-a", "subnet/public-b"]);

    // a second pass with the same drift: the three are open, the window is spent
    h.clock.advance(10 * MIN);
    const again = await run(h);
    expect(h.broker.proposals).toHaveLength(3);
    expect(again.repairs.filter((d) => d.reason === "repair_open")).toHaveLength(3);
    expect(again.repairs.filter((d) => d.reason === "rate_limited")).toHaveLength(2);
  });

  it("the window slides: after an hour, with the earlier operations finished, the next ones are proposed", async () => {
    const h = harness();
    missing(h, MISSING);
    await run(h);
    for (const op of h.backend.operations) op.status = "succeeded";
    h.clock.advance(HOUR + MIN);
    // the first three are still missing (the repair did not hold); their cooldown has also passed
    const r = await run(h);
    expect(r.repairs.filter((d) => d.status === "proposed")).toHaveLength(3);
    expect(h.broker.proposals.length).toBe(6);
  });

  it("the limit is configurable, and a limit of 0 proposes nothing", async () => {
    const h = harness();
    missing(h, MISSING);
    await run(h, { maxRepairProposals: 1 });
    expect(h.broker.proposals).toHaveLength(1);
    const z = harness();
    missing(z, MISSING);
    await run(z, { maxRepairProposals: 0 });
    expect(z.broker.proposals).toEqual([]);
  });

  it("human and agent proposals do not use up the reconciler's budget, but do block a duplicate", async () => {
    const h = harness();
    missing(h, ["log_group/web", "subnet/private-a", "subnet/private-b", "subnet/public-a"]);
    for (const a of ["log_group/web"]) h.backend.operations.push({ operationId: "op-human", workspaceId: "ws-1", environmentId: "env-prod", resourceId: h.backend.resourceId("env-prod", a), status: "awaiting_approval", createdAt: h.clock.now().toISOString(), byReconciler: false });
    const r = await run(h);
    expect(decision(r, "log_group/web")).toMatchObject({ reason: "repair_open", operationId: "op-human" });
    expect(h.broker.proposals.map((p) => (p.request.input as RepairInput).address)).toEqual(["subnet/private-a", "subnet/private-b", "subnet/public-a"]);
  });

  it("never re-proposes while an operation for the resource is open, in any non-terminal status", async () => {
    for (const status of ["proposed", "awaiting_approval", "approved", "queued", "running"] as const) {
      const h = harness();
      missing(h, ["log_group/web"]);
      h.backend.operations.push({ operationId: "op-open", workspaceId: "ws-1", environmentId: "env-prod", resourceId: h.backend.resourceId("env-prod", "log_group/web"), status, createdAt: new Date(h.clock.now().getTime() - 3 * HOUR).toISOString(), byReconciler: false });
      const r = await run(h);
      expect(h.broker.proposals, status).toEqual([]);
      expect(decision(r, "log_group/web"), status).toMatchObject({ reason: "repair_open" });
    }
  });

  it("cooldown: a finished repair is not re-proposed for an hour; a rejected or denied one not for a day", async () => {
    const cases: [string, number, boolean][] = [
      ["succeeded", 10 * MIN, false],
      ["succeeded", 2 * HOUR, true],
      ["failed", 30 * MIN, false],
      ["rejected", 2 * HOUR, false],
      ["rejected", 25 * HOUR, true],
      ["denied", 23 * HOUR, false],
    ];
    for (const [status, ageMs, expectProposal] of cases) {
      const h = harness();
      missing(h, ["log_group/web"]);
      h.backend.operations.push({ operationId: "op-old", workspaceId: "ws-1", environmentId: "env-prod", resourceId: h.backend.resourceId("env-prod", "log_group/web"), status: status as "succeeded", createdAt: new Date(h.clock.now().getTime() - ageMs).toISOString(), byReconciler: false });
      const r = await run(h);
      expect(h.broker.proposals.length > 0, `${status} ${ageMs / MIN}min`).toBe(expectProposal);
      if (!expectProposal) expect(decision(r, "log_group/web")).toMatchObject({ reason: "cooldown" });
    }
  });

  it("the idempotency key is stable inside a cooldown window and different in the next, per resource", async () => {
    const a = harness();
    missing(a, ["log_group/web", "subnet/private-a"]);
    await run(a);
    const [k1, k2] = a.broker.proposals.map((p) => p.request.idempotencyKey);
    expect(k1).not.toBe(k2);

    const b = harness();
    missing(b, ["log_group/web"]);
    await run(b);
    expect(b.broker.proposals[0].request.idempotencyKey).toBe(k1); // same env, resource and window
    for (const op of b.backend.operations) op.status = "succeeded";
    b.clock.advance(HOUR + MIN);
    await run(b);
    expect(b.broker.proposals[1].request.idempotencyKey).not.toBe(k1);
  });
});

describe("the controller never executes a repair, and leaks nothing", () => {
  it("drives no driver operation and starts nothing the broker did not allow", async () => {
    const h = harness();
    h.broker.script = (p, n) => (n % 2 ? { outcome: "allow", operationId: `op-a${n}` } : { outcome: "require_approval", operationId: `op-r${n}` });
    missing(h, MISSING);
    await run(h);
    expect(h.world.operationCalls).toEqual([]);
    expect(h.started.every((s) => s.operationId.startsWith("op-a"))).toBe(true);
    expect(h.started).toHaveLength(2);
  });

  it("proposals, events and the ledger carry no secret canary", async () => {
    const h = harness();
    const w: World = h.world;
    w.patch("log_group/web", { presence: "missing", error: "AKIAIOSFODNN7EXAMPLE was denied" });
    w.patch("container_service/web", { attrs: { passwordSecretRef: "vault:abc", image: known("x") }, expected: { passwordSecretRef: "vault:def", image: known("x") } });
    await run(h);
    const text = persistedText(h.backend) + JSON.stringify(h.broker.proposals);
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
