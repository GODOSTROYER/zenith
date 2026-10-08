import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Scope, contentDigest, parseManifest } from "../../scripts/release/scope";
import { template } from "../../scripts/acceptance/live/managed/cli";
import { buildPlan, at, assertionsPass, scenarios, type Recipe } from "../../scripts/acceptance/live/managed/plan";
import { runPlan, reserveBudget, type Approval, type Journal, type RunDeps, type Transport } from "../../scripts/acceptance/live/managed/runner";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const COMMIT = "a".repeat(40);
function fixture(): Recipe {
  const r = template("managed", COMMIT, NOW);
  r.estimate.basis = "Owner-reviewed sandbox list price for cluster window and teardown reserve, provisional";
  const first = r.steps[0]!;
  r.steps = scenarios("managed").map((scenario, i) => ({ ...first, id: `observe-${i}`, scenario, attempts: 1 }));
  return r;
}
function setup(recipe = fixture(), clock: () => Date = () => NOW) {
  const plan = buildPlan(recipe);
  const raw = JSON.parse(readFileSync("docs/build/production/permissions.json", "utf8"));
  raw.harnesses["managed-acceptance-live"] = { description: "Offline test of the exact-plan guarded runner", providers: ["kubernetes", "control_plane"], actions: ["read", "create_disposable", "mutate_run_tagged", "teardown_run_tagged", "inject_fault"], maxRunUsd: 5 };
  const unapproved = parseManifest(raw);
  const scope = new Scope(parseManifest({ ...unapproved, approval: { status: "approved", approvedBy: "Offline Person", approvedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 86400000).toISOString(), approvedDigest: contentDigest(unapproved) } }), clock);
  const approval: Approval = { schema: 1, decision: "DEC-CLOUD", approvedBy: "Offline Person", approvedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 7200000).toISOString(), planSha256: plan.sha256, scopeDigest: scope.digest, sourceCommit: COMMIT };
  let saved: Journal | undefined;
  const send = vi.fn<Transport["send"]>(async q => {
    if (q.kind === "http") return { status: 200, body: { operation: { status: "succeeded" } } };
    if (q.kind === "inventory") return { status: 200, body: [] };
    if (q.kind === "delete_namespace") return { status: 202, body: null };
    return { status: 200, body: { metadata: { name: recipe.resources[0]!.name, uid: "owned-uid", resourceVersion: "1", annotations: { "zenith:live-run": recipe.runId, "zenith:ttl-expires": new Date(NOW.getTime() + 3600000).toISOString() } } } };
  });
  const transport = vi.fn(() => ({ send }));
  const reserve = vi.fn();
  const deps: RunDeps = { scope, approval, sourceCommit: COMMIT, env: { ZENITH_LIVE_MANAGED: "1" }, transport, reserve, journal: { load: () => saved, save: j => { saved = structuredClone(j); } }, now: clock, sleep: async () => undefined };
  return { plan, deps, send, transport, reserve, journal: () => saved };
}

describe("L3 offline contract, never cloud verification", () => {
  it("observes real transport results, tears down and independently scans, without storing response bodies", async () => {
    const x = setup(); const report = await runPlan(x.plan, x.deps);
    expect(report.ok).toBe(true); expect(report.counts).toEqual({ passed: 9, failed: 0, notRun: 0 });
    expect(x.journal()?.attempted).toEqual(["remove-tenant-a"]);
    expect(JSON.stringify(report)).not.toContain("owned-uid"); expect(report.statement).toContain("not requirement verification");
  });
  it.each(["gate", "scope", "digest", "commit", "expired", "future", "budget", "provider-budget", "ttl", "missing-grant"])("refuses %s before constructing transport or reserving spend", async kind => {
    const x = setup();
    if (kind === "gate") x.deps.env = {};
    if (kind === "scope") x.deps.scope.manifest.approval.status = "not_approved";
    if (kind === "digest") x.deps.approval.planSha256 = "b".repeat(64);
    if (kind === "commit") x.deps.sourceCommit = "b".repeat(40);
    if (kind === "expired") x.deps.approval.expiresAt = NOW.toISOString();
    if (kind === "future") x.deps.approval.approvedAt = new Date(NOW.getTime() + 1).toISOString();
    if (["budget", "provider-budget", "ttl", "missing-grant"].includes(kind)) {
      const raw = structuredClone(x.deps.scope.manifest);
      if (kind === "budget") raw.harnesses["managed-acceptance-live"]!.maxRunUsd = 1;
      if (kind === "provider-budget") raw.budgets.perProviderPerRunUsd.kubernetes = 1.5;
      if (kind === "ttl") raw.budgets.maxRunTtlMinutes = 30;
      if (kind === "missing-grant") delete raw.harnesses["managed-acceptance-live"];
      raw.approval.approvedDigest = contentDigest(raw); x.deps.scope = new Scope(parseManifest(raw), () => NOW); x.deps.approval.scopeDigest = x.deps.scope.digest;
    }
    await expect(runPlan(x.plan, x.deps)).rejects.toThrow(); expect(x.transport).not.toHaveBeenCalled(); expect(x.reserve).not.toHaveBeenCalled();
  });
  it("rejects tampering with a plan after its approval", async () => {
    const x = setup(); x.plan.steps[0]!.request = { ...x.plan.steps[0]!.request, target: "cluster" };
    await expect(runPlan(x.plan, x.deps)).rejects.toThrow(); expect(x.transport).not.toHaveBeenCalled();
  });
  it("stops after a failed observation and always attempts cleanup and leak scan", async () => {
    const x = setup(); const original = x.send.getMockImplementation()!;
    x.send.mockImplementation(async (...args) => args[0].kind === "http" ? { status: 503, body: {} } : original(...args));
    const report = await runPlan(x.plan, x.deps);
    expect(report.counts).toEqual({ passed: 2, failed: 1, notRun: 6 });
    expect(report.results.slice(-2).map(r => r.phase)).toEqual(["cleanup", "leak_scan"]); expect(report.ok).toBe(false);
  });
  it("runs every cleanup even after one fails, then scans independently", async () => {
    const r = fixture(); r.cleanup.push({ ...r.cleanup[0]!, id: "cleanup-second" }); const x = setup(r);
    const original = x.send.getMockImplementation()!;
    x.send.mockImplementation(async (...args) => { if (args[0].kind === "delete_namespace") throw new Error("private provider error"); return original(...args); });
    const report = await runPlan(x.plan, x.deps);
    expect(report.results.filter(r => r.phase === "cleanup")).toHaveLength(2); expect(report.counts.failed).toBe(2);
    expect(report.results.at(-1)?.phase).toBe("leak_scan"); expect(JSON.stringify(report)).not.toContain("private provider error");
  });
  it.each(["tag", "ttl", "unreadable"])("refuses deletion after %s ownership changes", async kind => {
    const x = setup(); const original = x.send.getMockImplementation()!;
    x.send.mockImplementation(async (...args) => {
      if (args[0].kind !== "kubernetes") return original(...args);
      return { status: kind === "unreadable" ? 404 : 200, body: { metadata: { annotations: { "zenith:live-run": kind === "tag" ? "another-run" : x.plan.runId, "zenith:ttl-expires": kind === "ttl" ? "changed" : new Date(NOW.getTime() + 3600000).toISOString() } } } };
    });
    const report = await runPlan(x.plan, x.deps); expect(report.ok).toBe(false);
    expect(x.send.mock.calls.some(([q]) => q.kind === "delete_namespace")).toBe(false); expect(report.results.at(-1)?.phase).toBe("leak_scan");
  });
  it("a nonempty or malformed independent inventory cannot pass", async () => {
    for (const body of [[{ leaked: true }], null, { items: [] }]) {
      const r = fixture(); r.scans[0]!.attempts = 1; const x = setup(r); const original = x.send.getMockImplementation()!;
      x.send.mockImplementation(async (...args) => args[0].kind === "inventory" ? { status: 200, body } : original(...args));
      const report = await runPlan(x.plan, x.deps); expect(report.ok).toBe(false); expect(x.journal()?.closed).toBe(false);
    }
  });
  it("bounded polling has a call journal and never turns empty observations into a pass", async () => {
    const r = fixture(); r.steps[0]!.attempts = 2; const x = setup(r); const original = x.send.getMockImplementation()!;
    x.send.mockImplementation(async (...args) => args[0].kind === "http" ? { status: 200, body: {} } : original(...args));
    const report = await runPlan(x.plan, x.deps); expect(report.results[0]!.attempts).toBe(2); expect(x.journal()?.counts["observe-0"]).toBe(2);
  });
  it("cleanup-only resume never reruns forward effects or reserves another budget", async () => {
    const x = setup(); await runPlan(x.plan, x.deps); x.send.mockClear(); x.reserve.mockClear();
    await expect(runPlan(x.plan, x.deps)).rejects.toThrow("resume --cleanup-only");
    x.deps.cleanupOnly = true; const report = await runPlan(x.plan, x.deps);
    expect(x.send.mock.calls.some(([q]) => q.kind === "http")).toBe(false); expect(x.reserve).not.toHaveBeenCalled();
    expect(report.ok).toBe(false); expect(report.counts.notRun).toBe(7);
  });
  it("a cleanup journal with the wrong scope is refused before transport", async () => {
    const x = setup(); x.deps.journal.load = () => ({ ...x.journal(), schema: 1, planSha256: x.plan.sha256, sourceCommit: COMMIT, scopeDigest: "different", counts: {}, attempted: [], closed: false }); x.deps.cleanupOnly = true;
    await expect(runPlan(x.plan, x.deps)).rejects.toThrow(); expect(x.transport).not.toHaveBeenCalled();
  });
  it("SIGINT-style cancellation stops new scenario calls but cleanup ignores the cancelled forward signal", async () => {
    const x = setup(); const stop = new AbortController(); x.deps.signal = stop.signal; const original = x.send.getMockImplementation()!;
    x.send.mockImplementation(async (...args) => { const response = await original(...args); if (args[0].kind === "http") stop.abort(); return response; });
    const report = await runPlan(x.plan, x.deps); expect(report.results.some(r => r.phase === "cleanup" && r.status === "passed")).toBe(true); expect(report.ok).toBe(false);
  });
  it("missing scenarios remain pending even if all performed checks passed", async () => {
    const r = fixture(); r.steps = r.steps.slice(0, 1); const x = setup(r); const report = await runPlan(x.plan, x.deps);
    expect(report.pendingScenarios).toHaveLength(6); expect(report.ok).toBe(false);
  });
  it("does not coerce missing fields to null or follow inherited JSON properties", () => {
    expect(assertionsPass({}, [{ pointer: "/missing", equals: null }])).toBe(false);
    expect(at(Object.create({ inherited: true }), "/inherited")).toBeUndefined(); expect(at({ "a/b": { "~": 1 } }, "/a~1b/~0")).toBe(1);
  });
  it("numeric operational bounds reject missing, nonfinite and coerced observations", () => {
    const bound = [{ pointer: "/p95Ms", min: 0, max: 500 }];
    expect(assertionsPass({ p95Ms: 499.2 }, bound)).toBe(true);
    for (const p95Ms of [501, -1, "200", null, undefined, Infinity, NaN]) expect(assertionsPass({ p95Ms }, bound)).toBe(false);
  });
  it("accepts a real-shaped OCI tenancy identifier for a managed OKE cluster binding", () => {
    const r = fixture(); r.targets[1]!.account = ["ocid1", "tenancy", "oc1", "", Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")].join(".");
    expect(buildPlan(r).targets[1]!.account).toBe(r.targets[1]!.account);
  });
  it.each(["secret", "approval", "cross-origin", "local-cluster", "no-scan", "unknown-target", "replayed-mutation", "unbound-delete", "unknown-scenario", "no-cleanup"])("refuses unsafe recipe %s offline", kind => {
    const r = fixture();
    if (kind === "secret") { const q = r.steps[0]!.request; if (q.kind === "http") q.body = { password: Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex") }; }
    if (kind === "approval" && r.steps[0]!.request.kind === "http") r.steps[0]!.request.path = "/api/platform/v1/operations/o/approve";
    if (kind === "cross-origin" && r.steps[0]!.request.kind === "http") r.steps[0]!.request.path = "//other.invalid/api";
    if (kind === "local-cluster") r.targets[1]!.context = "kind-local";
    if (kind === "no-scan") r.scans[0]!.request.target = "product";
    if (kind === "unknown-target") r.steps[0]!.request.target = "unknown";
    if (kind === "replayed-mutation") r.cleanup[0]!.attempts = 2;
    if (kind === "unbound-delete" && r.cleanup[0]!.request.kind === "delete_namespace") r.cleanup[0]!.request.name = "unrelated";
    if (kind === "unknown-scenario") r.steps[0]!.scenario = "fictional";
    if (kind === "no-cleanup") { r.steps.push(r.cleanup[0]!); r.cleanup = []; }
    expect(() => buildPlan(r)).toThrow();
  });
  it("persists conservative cumulative budgets and refuses duplicate or excessive reservations", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zenith-l3-budget-"));
    try {
      const x = setup(); const file = path.join(dir, "budget.json"); reserveBudget(file, x.plan, x.deps.scope);
      expect(() => reserveBudget(file, x.plan, x.deps.scope)).toThrow("already reserved");
      const r = fixture(); r.estimate.cleanupReserveUsd = 100; const excessive = buildPlan(r);
      expect(() => reserveBudget(file, excessive, x.deps.scope)).toThrow("total budget");
      expect(JSON.parse(readFileSync(file, "utf8")).reservations).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true }); }
  });
});
