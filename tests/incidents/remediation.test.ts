/**
 * Remediation options: exact capability requests, policy-derived approval,
 * catalog-floored risk, and the things that must never be proposed.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES, CapabilityRequestSchema, isCapability } from "@/lib/capabilities/catalog";
import { attachRemediations, investigate, requestFor, type Hypothesis, type Investigation, type RemediationContext } from "@/lib/incidents";
import { ADDR, ENV, PROJECT, WORKSPACE, buildGraph, change, deny, driftFinding, driftReport, healthyWorld, log, makePorts, newCalls, obs, removeDbIngress, requireApproval, rt, series, type World } from "./fixtures";
import type { ResourceGraph } from "@/lib/resources/types";

const env = { workspaceId: WORKSPACE, projectId: PROJECT, environmentId: ENV };
const go = (w: World, opts: { graph?: ResourceGraph; timeout?: number } = {}) =>
  investigate({ graph: opts.graph ?? buildGraph(), environment: env }, makePorts(w), opts.timeout ? { probeTimeoutMs: opts.timeout } : {});

/** every scenario that produces remediations, so invariants are checked across all of them */
async function allInvestigations(): Promise<Investigation[]> {
  const out: Investigation[] = [];
  out.push(await go(removeDbIngress(healthyWorld())));

  const deploy = healthyWorld();
  deploy.changes = [change("deployment", 12, "release", "op_1")];
  deploy.runtimes[ADDR.web] = rt(ADDR.web, "degraded", { desired: 2, running: 1 }, ["deployment_failed", "task_stopped:EssentialContainerExited"]);
  deploy.logs[ADDR.web] = [log(ADDR.web, "ok", 25, "info"), ...[8, 7, 6, 5, 4, 3].map((m) => log(ADDR.web, `"GET / HTTP/1.1" 500 1`, m))];
  out.push(await go(deploy));

  const oom = healthyWorld();
  oom.runtimes[ADDR.web] = rt(ADDR.web, "degraded", { desired: 2, running: 1 }, ["task_stopped:OutOfMemory"]);
  oom.logs[ADDR.web] = [log(ADDR.web, "JavaScript heap out of memory", 3)];
  out.push(await go(oom));

  const secret = healthyWorld();
  secret.observations[ADDR.secret] = obs(ADDR.secret, "missing");
  secret.logs[ADDR.web] = [log(ADDR.web, "Environment variable DATABASE_URL is not set", 3)];
  out.push(await go(secret));

  const iam = healthyWorld();
  iam.logs[ADDR.web] = [log(ADDR.web, "AccessDenied: is not authorized to perform: s3:GetObject", 3)];
  iam.drift = driftReport([driftFinding(ADDR.identity, "changed")]);
  out.push(await go(iam));

  const cap = healthyWorld();
  cap.metrics[ADDR.web] = [series("cpu.utilization", [95, 96, 97], "percent", ADDR.web), series("memory.utilization", [91, 92, 93], "percent", ADDR.web)];
  out.push(await go(cap));

  const dns = healthyWorld();
  dns.observations[ADDR.dns] = obs(ADDR.dns, "missing");
  out.push(await go(dns));
  return out;
}

describe("every proposed request, across scenarios", () => {
  it("is a schema-valid capability request for a known capability, in this workspace and environment", async () => {
    const all = (await allInvestigations()).flatMap((i) => i.hypotheses.flatMap((h) => h.remediations));
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const r of all) {
      const parsed = CapabilityRequestSchema.safeParse(r.request);
      expect(parsed.success, `${r.id}: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      expect(isCapability(r.request.capability)).toBe(true);
      expect(r.request.scope.workspaceId).toBe(WORKSPACE);
      expect(r.request.scope.environmentId).toBe(ENV);
      expect(r.request.scope.projectId).toBe(PROJECT);
      expect((r.request.reason ?? "").length).toBeLessThanOrEqual(2000);
      expect(r.request.reason).toContain("inv_test");
    }
  });

  it("never proposes a destructive, escape-hatch or unattended-forbidden capability", async () => {
    const all = (await allInvestigations()).flatMap((i) => i.hypotheses.flatMap((h) => h.remediations));
    for (const r of all) {
      const def = CAPABILITIES[r.request.capability];
      expect(def.mutates, r.id).toBe(true); // a remediation is a change, not another read
      expect("destructive" in def && def.destructive, r.id).toBeFalsy();
      expect("escapeHatch" in def && def.escapeHatch, r.id).toBeFalsy();
    }
    const names = new Set(all.map((r) => r.request.capability));
    for (const banned of ["database.restore", "database.delete", "infrastructure.destroy", "machine.exec", "container.exec", "provider.native", "file.write", "package.install"]) expect(names.has(banned as never)).toBe(false);
  });

  it("carries a risk at least the catalog floor, and never less than that even when the use is narrow", async () => {
    const order = ["low", "medium", "high", "critical"];
    const all = (await allInvestigations()).flatMap((i) => i.hypotheses.flatMap((h) => h.remediations));
    for (const r of all) expect(order.indexOf(r.risk), r.id).toBeGreaterThanOrEqual(order.indexOf(CAPABILITIES[r.request.capability].risk));
    const repair = all.find((r) => r.request.capability === "drift.repair")!;
    expect(repair.risk).toBe("high");
    expect(repair.blastRadius).toBe("low");
  });

  it("states reversibility and expected effect in words, and unique ids", async () => {
    const all = (await allInvestigations()).flatMap((i) => i.hypotheses.flatMap((h) => h.remediations));
    for (const r of all) {
      expect(r.reversibility.length, r.id).toBeGreaterThan(30);
      expect(r.expectedEffect.length, r.id).toBeGreaterThan(30);
      expect(r.title.length, r.id).toBeGreaterThan(10);
    }
    const perInvestigation = (await allInvestigations()).map((i) => i.hypotheses.flatMap((h) => h.remediations.map((r) => r.id)));
    for (const ids of perInvestigation) expect(new Set(ids).size).toBe(ids.length);
  });

  it("never asks for or carries a secret value", async () => {
    const all = (await allInvestigations()).flatMap((i) => i.hypotheses.flatMap((h) => h.remediations));
    const secretWrites = all.filter((r) => r.request.capability === "secret.write");
    expect(secretWrites.length).toBeGreaterThan(0);
    for (const r of secretWrites) {
      expect(r.humanInputRequired).toBe(true);
      const input = r.request.input as Record<string, unknown>;
      for (const k of ["value", "secret", "password", "token", "data"]) expect(Object.keys(input)).not.toContain(k);
    }
  });

  it("the drift report is not a precondition: each option's dry-run was of exactly that request", async () => {
    const w = removeDbIngress(healthyWorld());
    const calls = newCalls();
    const inv = await investigate({ graph: buildGraph(), environment: env }, makePorts(w, calls));
    const proposed = inv.hypotheses.flatMap((h) => h.remediations.map((r) => r.request));
    expect(calls.policy).toEqual(proposed);
  });
});

describe("approval comes from the policy dry-run, and fails closed", () => {
  it("allow → false, require_approval → true, deny → true with the denial recorded", async () => {
    const outcomes: [ReturnType<typeof deny>, boolean, string][] = [
      [{ outcome: "allow", reasons: [] }, false, "allow"],
      [requireApproval(), true, "require_approval"],
      [deny(), true, "deny"],
    ];
    for (const [decision, approval, outcome] of outcomes) {
      const w = removeDbIngress(healthyWorld());
      w.policy = () => decision;
      const r = (await go(w)).hypotheses[0].remediations[0];
      expect(r.approvalRequired).toBe(approval);
      expect(r.policy?.outcome).toBe(outcome);
    }
  });

  it("the same proposals can get different answers: policy is asked per request", async () => {
    const oom = healthyWorld();
    oom.runtimes[ADDR.web] = rt(ADDR.web, "degraded", { desired: 2, running: 1 }, ["task_stopped:OutOfMemory"]);
    oom.logs[ADDR.web] = [log(ADDR.web, "JavaScript heap out of memory", 3)];
    oom.policy = (req) => (req.capability === "service.restart" ? { outcome: "allow", reasons: [] } : requireApproval());
    const rem = (await go(oom)).hypotheses[0].remediations;
    expect(rem.map((r) => [r.request.capability, r.approvalRequired])).toEqual([["deployment.deploy", true], ["service.restart", false]]);
  });

  it("a dry-run that throws, hangs or returns garbage is 'unavailable' and approval is required", async () => {
    const throwing = removeDbIngress(healthyWorld());
    throwing.policy = () => new Error("down");
    expect((await go(throwing)).hypotheses[0].remediations[0]).toMatchObject({ approvalRequired: true, policy: { outcome: "unavailable", reasons: ["dry_run_failed"] } });

    const garbage = removeDbIngress(healthyWorld());
    garbage.policy = () => ({ outcome: "maybe", reasons: [] }) as never;
    expect((await go(garbage)).hypotheses[0].remediations[0]).toMatchObject({ approvalRequired: true, policy: { outcome: "unavailable", reasons: ["malformed_decision"] } });

    const hanging = removeDbIngress(healthyWorld());
    hanging.policy = () => new Promise(() => {}) as never;
    const started = Date.now();
    const r = (await go(hanging, { timeout: 50 })).hypotheses[0].remediations[0];
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r).toMatchObject({ approvalRequired: true, policy: { outcome: "unavailable" } });
  });

  it("policy reason codes are sanitized and bounded", async () => {
    const w = removeDbIngress(healthyWorld());
    w.policy = () => ({ outcome: "require_approval", reasons: Array.from({ length: 20 }, (_, i) => ({ code: `code_${i}_${"x".repeat(200)}`, message: "m" })) });
    const r = (await go(w)).hypotheses[0].remediations[0];
    expect(r.policy!.reasons.length).toBeLessThanOrEqual(8);
    for (const c of r.policy!.reasons) expect(c.length).toBeLessThanOrEqual(80);
  });
});

describe("what is proposed depends on who owns the resource", () => {
  it("a firewall Zenith does not manage gets a manual step, not a drift.repair", async () => {
    const g = buildGraph();
    g.nodes = g.nodes.map((n) => (n.address === ADDR.fwWebDb ? { ...n, ownership: "referenced" as const } : n));
    const inv = await go(removeDbIngress(healthyWorld()), { graph: g });
    const h = inv.hypotheses[0];
    expect(h.code).toBe("db_unreachable_security_group");
    expect(h.remediations).toEqual([]);
    expect(h.nextSteps?.join(" ")).toMatch(/not managed by Zenith/);
    expect(h.nextSteps?.join(" ")).toContain("tcp/5432 from container_service/web to postgres/db");
  });

  it("when the rule could not be read there is nothing to repair, and the next step says it is unverified", async () => {
    const w = removeDbIngress(healthyWorld());
    w.observations[ADDR.fwWebDb] = new Error("denied");
    const h = (await go(w)).hypotheses.find((x) => x.code === "db_unreachable_security_group")!;
    expect(h.remediations).toEqual([]);
    expect(h.nextSteps?.[0]).toMatch(/could not be read, so it is unverified/);
  });

  it("a rollback is only proposed for a deployment that is on record", async () => {
    const w = healthyWorld();
    w.runtimes[ADDR.web] = rt(ADDR.web, "unhealthy", { desired: 2, running: 0 }, ["deployment_failed", "image_pull_failed"]);
    const h = (await go(w)).hypotheses[0];
    expect(h.code).toBe("image_pull_failure");
    expect(h.remediations).toEqual([]);
    w.changes = [change("deployment", 5, "x", "op_2")];
    const again = (await go(w)).hypotheses[0];
    expect(again.remediations.map((r) => r.request.capability)).toEqual(["deployment.rollback"]);
  });
});

describe("attachRemediations directly", () => {
  const hyp = (code: string): Hypothesis => ({ id: `hyp:${code}`, code, title: "t", confidence: 0.9, category: "runtime", supportingEvidence: [], contradictingEvidence: [], remediations: [] });
  const ctx = (overrides: Partial<RemediationContext> = {}): RemediationContext => ({
    investigationId: "inv_x",
    workspaceId: WORKSPACE,
    environmentId: ENV,
    graph: buildGraph(),
    evidence: [],
    ports: { policyDryRun: async () => ({ outcome: "allow", reasons: [] }) },
    timeoutMs: 100,
    ...overrides,
  });

  it("leaves hypotheses with no known fix untouched, and an unknown code is not an error", async () => {
    const out = await attachRemediations([hyp("something_new")], ctx());
    expect(out[0].remediations).toEqual([]);
    expect(out[0].nextSteps).toBeUndefined();
  });

  it("omits projectId when the caller has none, and bounds the reason text", () => {
    const h = { ...hyp("db_unreachable_security_group"), supportingEvidence: Array.from({ length: 50 }, (_, i) => `ev:${"a".repeat(100)}:${i}`) };
    const req = requestFor({ key: "k", title: "t", capability: "drift.repair", resourceId: ADDR.fwWebDb, input: {}, reversibility: "r", expectedEffect: "e", blastRadius: "low" }, h, ctx());
    expect(req.scope).toEqual({ workspaceId: WORKSPACE, environmentId: ENV, resourceId: ADDR.fwWebDb });
    expect((req.reason ?? "").length).toBeLessThanOrEqual(2000);
    expect(CapabilityRequestSchema.safeParse(req).success).toBe(true);
  });
});
