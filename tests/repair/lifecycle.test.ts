/**
 * PROD-OBS-01: the one observation-to-repair lifecycle. Contract tests against
 * the in-memory reconcile backend and scripted broker (fakes, said so): they
 * prove the lifecycle's staging, typed refusals and verification handling, not
 * a provider. The real stability adapter is exercised in
 * tests/repair/lifecycle.platform.test.ts (PGlite or env-gated PostgreSQL).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileObserveOnce, type ReconcilePorts, type ReconcileStability, type RepairSkipReason, type RepairVerification, type StabilityFindingObservation } from "@/lib/reconcile";
import { lifecycleItem, refusal, refusalOf, runRepairLifecycle, summarizeRepairs, withDiagnosisRecording } from "@/lib/repair";
import type { Investigator } from "@/lib/agent-access/v3/ports";
import type { Investigation } from "@/lib/incidents/types";
import { ENV, graph, harness, type Harness } from "../reconcile/_support";

const ALL_SKIP_REASONS = Object.keys({
  auto_repair_disabled: 1, autonomy_observe_only: 1, simulated_observation: 1, not_repairable: 1, not_managed: 1, ownership_mismatch: 1, no_resource_row: 1,
  stateful_missing: 1, stateful: 1, identity: 1, firewall_opened: 1, high_severity: 1, not_auto_eligible: 1, repair_not_supported: 1, awaiting_confirmation: 1,
  repair_open: 1, repair_uncertain: 1, cooldown: 1, rate_limited: 1, stability_unconfirmed: 1, stability_blocked: 1, stability_unavailable: 1,
} satisfies Record<RepairSkipReason, 1>) as RepairSkipReason[];

const run = (h: Harness, ports: Partial<ReconcilePorts> = {}) => runRepairLifecycle({ entry: "manual", environment: ENV, graph: graph(), ports: { ...h.ports, ...ports } as ReconcilePorts });

function confirmedStability(over: Partial<ReconcileStability> = {}): ReconcileStability {
  let n = 0;
  return {
    async observe(_e, items) { return new Map(items.filter((i) => i.observation === "bad").map((i) => [`${i.address}|${i.class}`, { incidentId: `inc-${i.address}` }])); },
    async admit() { return { allowed: true, attemptId: `att-${++n}`, codes: [] }; },
    async attach() {},
    async release() {},
    ...over,
  };
}

describe("typed refusals", () => {
  it("every skip reason has a stage, a retryability and a human reason, and none says not implemented", () => {
    for (const code of ALL_SKIP_REASONS) {
      const r = refusal(code);
      expect(r.code).toBe(code);
      expect(r.reason.length).toBeGreaterThan(20);
      expect(r.reason.toLowerCase()).not.toContain("not implemented");
      expect(["observe", "diagnose", "propose"]).toContain(r.stage);
    }
  });
  it("maps broker, policy and dispatch failures to explicit refusals", () => {
    expect(refusalOf({ address: "a", class: "missing", status: "failed", reason: "broker_error" })).toMatchObject({ code: "broker_error", stage: "propose" });
    expect(refusalOf({ address: "a", class: "missing", status: "proposed", outcome: "deny" })).toMatchObject({ code: "policy_denied", stage: "policy", retryable: false });
    expect(refusalOf({ address: "a", class: "missing", status: "proposed", outcome: "allow", started: false, reason: "start_failed" })).toMatchObject({ code: "start_failed", stage: "remediate" });
    expect(refusalOf({ address: "a", class: "missing", status: "proposed", outcome: "require_approval" })).toBeUndefined();
    expect(refusalOf({ address: "a", class: "missing", status: "proposed", outcome: "allow", started: true })).toBeUndefined();
  });
  it("a stability block names the gate codes", () => {
    expect(refusalOf({ address: "a", class: "missing", status: "skipped", reason: "stability_blocked", error: "cooldown_active" })?.reason).toContain("cooldown_active");
  });
});

describe("runRepairLifecycle", () => {
  it("a repair kind without a handler is an explicit typed refusal, never a silent not-implemented", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const r = await run(h, { driverFor: () => ({ ...h.world.driver, operations: {} }) });
    const item = r.items.find((i) => i.address === "log_group/web");
    expect(item).toMatchObject({ stage: "propose", disposition: "refused", refusal: { code: "repair_not_supported", retryable: false } });
    expect(item?.refusal?.reason).toMatch(/no registered drift\.repair/i);
    expect(h.broker.proposals).toEqual([]);
  });

  it("proposals go through the broker: allow is dispatched, approval waits, deny is a typed policy refusal", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const allowed = await run(h, { stability: confirmedStability() });
    expect(allowed.items.find((i) => i.address === "log_group/web")).toMatchObject({ stage: "remediate", disposition: "dispatched" });
    expect(h.broker.proposals).toHaveLength(1);
    expect(h.broker.proposals[0]).toMatchObject({ origin: "reconciler", request: { capability: "drift.repair" } });
    expect(h.started).toHaveLength(1);

    const g = harness();
    g.world.patch("log_group/web", { presence: "missing" });
    g.broker.script = "require_approval";
    const waiting = await run(g, { stability: confirmedStability() });
    expect(waiting.items.find((i) => i.address === "log_group/web")).toMatchObject({ stage: "approval", disposition: "awaiting_approval" });
    expect(g.started).toEqual([]);

    const d = harness();
    d.world.patch("log_group/web", { presence: "missing" });
    d.broker.script = "deny";
    const denied = await run(d, { stability: confirmedStability() });
    expect(denied.items.find((i) => i.address === "log_group/web")).toMatchObject({ stage: "policy", disposition: "denied", refusal: { code: "policy_denied" } });
    expect(d.started).toEqual([]);
  });

  it("a lost dispatch is unconfirmed, not success", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    h.failStart(1);
    const r = await run(h, { stability: confirmedStability() });
    expect(r.items.find((i) => i.address === "log_group/web")).toMatchObject({ stage: "remediate", disposition: "dispatch_unconfirmed", refusal: { code: "start_failed" } });
  });

  it("auto repair stays off unless requested: the same entry observes and refuses with a typed reason", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const r = await runRepairLifecycle({ entry: "temporal", environment: ENV, graph: graph(), ports: h.ports as ReconcilePorts, options: { autoRepair: false } });
    expect(r.items.find((i) => i.address === "log_group/web")).toMatchObject({ disposition: "refused", refusal: { code: "auto_repair_disabled", stage: "observe" } });
    expect(h.broker.proposals).toEqual([]);
  });

  it("verification runs only when settled repairs await, after the stability observation, and reads postdate the listing", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const order: string[] = [];
    let seen: StabilityFindingObservation[] = [];
    const stability = confirmedStability({
      async observe(_e, items) { order.push("observe"); return new Map(items.filter((i) => i.observation === "bad").map((i) => [`${i.address}|${i.class}`, { incidentId: "inc-1" }])); },
      async awaitingVerification() { order.push("awaiting"); return [{ attemptId: "att-0", incidentId: "inc-1", address: "log_group/web", operationId: "op-0", attemptStatus: "succeeded", fingerprint: "f".repeat(64) }]; },
      async verifyRepairs(_e, awaiting, items, _now, opts) {
        order.push("verify");
        seen = [...items];
        expect(opts.simulated).toBe(false);
        return awaiting.map((a): RepairVerification => ({ incidentId: a.incidentId, attemptId: a.attemptId, operationId: a.operationId, address: a.address, attemptStatus: a.attemptStatus, outcome: "still_present", escalated: true, escalationReasons: ["verification_failed"] }));
      },
    });
    const r = await run(h, { stability });
    expect(order).toEqual(["awaiting", "observe", "verify"]);
    expect(seen.find((i) => i.address === "log_group/web")).toMatchObject({ observation: "bad", class: "missing" });
    expect(r.verifications).toEqual([expect.objectContaining({ outcome: "still_present", escalated: true, escalationReasons: ["verification_failed"] })]);
  });

  it("a failing verification store never blocks observation or proposals, and claims nothing", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const stability = confirmedStability({
      async awaitingVerification() { return [{ attemptId: "a", incidentId: "inc-1", address: "log_group/web", operationId: "op-0", attemptStatus: "succeeded", fingerprint: "f".repeat(64) }]; },
      async verifyRepairs() { throw new Error("db down"); },
    });
    const r = await run(h, { stability });
    expect(r.verifications).toEqual([]);
    expect(r.reconcile.status).toBe("reconciled");
    expect(h.broker.proposals).toHaveLength(1);
  });

  it("an awaiting-list failure verifies nothing but observation continues", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const r = await run(h, { stability: confirmedStability({ async awaitingVerification() { throw new Error("db down"); }, async verifyRepairs() { throw new Error("must not run"); } }) });
    expect(r.verifications).toEqual([]);
    expect(r.reconcile.status).toBe("reconciled");
  });

  it("summarizeRepairs keeps the counts-and-digest contract the workflow validates", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const r = await run(h, { stability: confirmedStability() });
    const summary = summarizeRepairs(r.reconcile);
    expect(summary).toMatchObject({ proposed: 1, started: 1, awaitingApproval: 0, denied: 0 });
    expect(summary.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleItem(r.reconcile.repairs[0]).address).toBe(r.reconcile.repairs[0].address);
  });
});

describe("entry points share the lifecycle", () => {
  it("the Temporal activity body and the pass reach the same door", () => {
    const root = path.resolve(__dirname, "../..");
    const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
    expect(read("src/lib/reconcile/activity.ts")).toContain("runRepairLifecycle");
    expect(read("src/lib/reconcile/pass.ts")).toContain("runRepairLifecycle");
    expect(read("src/lib/reconcile/activity.ts")).not.toMatch(/\breconcileEnvironment\(/);
    expect(read("src/lib/reconcile/pass.ts")).not.toMatch(/\breconcileEnvironment\(/);
    expect(read("src/lib/workflows/reconcile-schedule.ts")).toContain("reconcilePass(");
  });
  it("repair: not_implemented is gone from every source path", () => {
    const root = path.resolve(__dirname, "../../src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name) && /repair\s*:\s*["']not_implemented["']|["']not_implemented["']\s*\|\s*["']considered["']/.test(fs.readFileSync(full, "utf8"))) hits.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
  it("the Temporal activity returns the lifecycle summary through reconcileObserveOnce", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const ports = { ...h.ports, stability: confirmedStability() } as ReconcilePorts;
    const out = await reconcileObserveOnce({ workspaceId: ENV.workspaceId, environmentId: ENV.environmentId, autoRepair: true, includeRepairSummary: true }, { ports, loadEnvironment: async () => ENV, loadGraph: async () => graph() });
    expect(out.repairs).toMatchObject({ proposed: 1, started: 1 });
    expect(h.broker.proposals).toHaveLength(1);
  });
});

describe("diagnose stage records investigations", () => {
  const investigation = (over: Partial<Investigation> = {}): Investigation => ({ id: "inv-1", workspaceId: "ws-1", environmentId: "env-prod", incidentId: "inc-1", ...over }) as Investigation;
  const request = { workspaceId: "ws-1", projectId: "proj-1", environmentId: "env-prod", range: { from: "a", to: "b" }, grant: {} as never };
  const inner = (inv: Investigation): Investigator => ({ available: true, investigate: async () => inv });

  it("records an incident-bound investigation of the request's own scope", async () => {
    const recorded: Investigation[] = [];
    const out = await withDiagnosisRecording(inner(investigation()), async (i) => void recorded.push(i)).investigate(request);
    expect(out.id).toBe("inv-1");
    expect(recorded).toHaveLength(1);
  });
  it("never records a foreign scope or an incident-less read, and never hides the result when recording fails", async () => {
    const recorded: Investigation[] = [];
    const rec = async (i: Investigation) => void recorded.push(i);
    await withDiagnosisRecording(inner(investigation({ workspaceId: "ws-other" })), rec).investigate(request);
    await withDiagnosisRecording(inner(investigation({ environmentId: "env-other" })), rec).investigate(request);
    await withDiagnosisRecording(inner(investigation({ incidentId: undefined })), rec).investigate(request);
    expect(recorded).toEqual([]);
    const out = await withDiagnosisRecording(inner(investigation()), async () => { throw new Error("db down"); }).investigate(request);
    expect(out.id).toBe("inv-1");
  });
  it("mirrors availability of the wrapped investigator", () => {
    const wrapped = withDiagnosisRecording({ available: false, reason: "not connected", investigate: async () => { throw new Error("no"); } }, async () => {});
    expect(wrapped.available).toBe(false);
    expect(wrapped.reason).toBe("not connected");
  });
});
