/**
 * Alert rules: one test per kind, plus the three properties that make an alert
 * a record rather than a notification that flashed past — it fires once, it
 * closes when the condition clears, and it is still there after a restart.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Deployment,
  Environment,
  Manifest,
  Project,
  Revision,
} from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-alerts-"));

const { db, flush, resetDb } = await import("@/lib/db/store");
const { evaluateAll, evaluateRule, eventPage, openEventFor, rulesOf } = await import(
  "@/lib/alerts"
);
const { monthlyCostUsd } = await import("@/lib/cost/pricing");
const { runAction } = await import("@/lib/actions/core");
const { registerAllActions } = await import("@/lib/actions/defs");

registerAllActions();

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const ctx = {
  workspaceId: "ws1",
  projectId: "p1",
  environmentId: "env1",
  actor: { type: "user" as const, id: "local", name: "You" },
};

const service = (chaos?: string) => ({
  id: "svc-api",
  name: "api",
  kind: "web" as const,
  source: { type: "image" as const, image: "nginx" },
  size: "small" as const,
  replicas: 2,
  port: 3000,
  env: chaos ? [{ key: "ORRERY_CHAOS", value: chaos }] : [],
  ownership: "managed" as const,
});

const manifest = (chaos?: string): Manifest => ({
  version: 1,
  services: [service(chaos)],
  resources: [],
  routes: [],
  bindings: [],
});

const revision = (m: Manifest): Revision => ({
  id: "rev1",
  projectId: "p1",
  number: 1,
  manifest: m,
  message: "r1",
  author: ctx.actor,
  createdAt: ago(30),
});

const deployment = (over: Partial<Deployment> = {}): Deployment =>
  ({
    id: "dep1",
    projectId: "p1",
    environmentId: "env1",
    revisionId: "rev1",
    status: "succeeded",
    steps: [],
    outputs: [],
    changeSummary: "first deploy",
    estCostDeltaUsd: 0,
    actor: ctx.actor,
    createdAt: ago(20),
    endedAt: ago(20),
    ...over,
  }) as Deployment;

/** A healthy, deployed, comfortably-under-budget baseline. */
function seed(opts: { chaos?: string; budget?: number } = {}) {
  const m = manifest(opts.chaos);
  const project = {
    id: "p1",
    workspaceId: "ws1",
    name: "atlas",
    slug: "atlas",
    workingManifest: m,
    createdAt: ago(500),
    origin: { type: "blank" },
  } as Project;
  const environment = {
    id: "env1",
    projectId: "p1",
    name: "sandbox",
    class: "sandbox",
    connectionId: "c1",
    region: "local",
    deployedRevisionId: "rev1",
    policies: {
      approvalRequired: false,
      allowStatefulDeletion: false,
      budgetUsdMonthly: opts.budget ?? monthlyCostUsd(m) * 10,
    },
    baseDomain: "test",
    createdAt: ago(500),
  } as unknown as Environment;

  resetDb({
    projects: [project],
    environments: [environment],
    revisions: [revision(m)],
    deployments: [deployment()],
  });
}

/** Create a rule straight in the store — the action path is tested separately. */
function rule(kind: string, threshold?: number): string {
  const id = `rule-${kind}-${threshold ?? "x"}`;
  db().alertRules.push({
    id,
    projectId: "p1",
    environmentId: "env1",
    kind: kind as "health_degraded",
    threshold,
    enabled: true,
    createdBy: ctx.actor,
    createdAt: ago(10),
  });
  return id;
}

beforeEach(() => seed());

describe("evaluateRule — one per kind", () => {
  it("health_degraded fires only when a managed service is degraded", () => {
    const id = rule("health_degraded");
    expect(evaluateRule(db().alertRules[0]).firing).toBe(false);

    seed({ chaos: "degrade" });
    rule("health_degraded");
    const cond = evaluateRule(db().alertRules[0]);
    expect(cond.firing).toBe(true);
    expect(cond.summary).toContain("api");
    // Health is generated, and the record has to keep saying so.
    expect(cond.simulated).toBe(true);
    expect(cond.detail).toContain("simulator");
    expect(id).toBe("rule-health_degraded-x");
  });

  it("deploy_failed follows the newest deployment that finished", () => {
    rule("deploy_failed");
    expect(evaluateRule(db().alertRules[0]).firing).toBe(false);

    db().deployments.push(
      deployment({
        id: "dep2",
        status: "failed",
        error: "release step timed out",
        createdAt: ago(5),
        endedAt: ago(5),
      })
    );
    const cond = evaluateRule(db().alertRules[0]);
    expect(cond.firing).toBe(true);
    expect(cond.detail).toContain("release step timed out");

    // A later deployment that succeeds is the recovery.
    db().deployments.push(
      deployment({ id: "dep3", status: "succeeded", createdAt: ago(1), endedAt: ago(1) })
    );
    expect(evaluateRule(db().alertRules[0]).firing).toBe(false);
  });

  it("budget_exceeded compares the running revision against the budget", () => {
    const cost = monthlyCostUsd(manifest());
    seed({ budget: cost * 2 }); // 50% of budget
    rule("budget_exceeded", 100);
    expect(evaluateRule(db().alertRules[0]).firing).toBe(false);
    // The same environment is over an 40% threshold, and says by how much.
    db().alertRules[0].threshold = 40;
    const cond = evaluateRule(db().alertRules[0]);
    expect(cond.firing).toBe(true);
    expect(cond.summary).toContain("50%");
    expect(cond.detail).toContain("estimate");
  });

  it("budget_exceeded cannot fire on an environment with no budget", () => {
    delete db().environments[0].policies.budgetUsdMonthly;
    rule("budget_exceeded", 1);
    const cond = evaluateRule(db().alertRules[0]);
    expect(cond.firing).toBe(false);
    expect(cond.summary).toContain("no budget");
  });

  it("replicas_below counts ready replicas against the floor", () => {
    seed({ chaos: "degrade" }); // 1 of 2 replicas ready
    rule("replicas_below", 1);
    expect(evaluateRule(db().alertRules[0]).firing).toBe(false);
    db().alertRules[0].threshold = 2;
    expect(evaluateRule(db().alertRules[0]).firing).toBe(true);
  });
});

describe("recording", () => {
  it("fires once and stays open — a flapping condition is one record", () => {
    seed({ chaos: "degrade" });
    const id = rule("health_degraded");
    expect(evaluateAll(NOW)).toBe(1);
    expect(evaluateAll(NOW + 1000)).toBe(0);
    expect(evaluateAll(NOW + 2000)).toBe(0);
    expect(db().alertEvents.filter((e) => e.ruleId === id)).toHaveLength(1);
    expect(openEventFor(id)?.firedAt).toBe(new Date(NOW).toISOString());
  });

  it("resolves when the condition clears, and says why", () => {
    seed({ chaos: "degrade" });
    const id = rule("health_degraded");
    evaluateAll(NOW);

    // Redeploy the same system without the chaos flag: health recovers.
    db().revisions[0].manifest = manifest();
    expect(evaluateAll(NOW + 60_000)).toBe(1);
    const [event] = db().alertEvents;
    expect(event.resolvedAt).toBe(new Date(NOW + 60_000).toISOString());
    expect(event.resolvedReason).toContain("healthy");
    expect(openEventFor(id)).toBeUndefined();

    // Recovered, then broken again: a second incident, not a reopened one.
    db().revisions[0].manifest = manifest("degrade");
    evaluateAll(NOW + 120_000);
    expect(db().alertEvents).toHaveLength(2);
  });

  it("a disabled rule closes its open alert and stops evaluating", () => {
    seed({ chaos: "degrade" });
    const id = rule("health_degraded");
    evaluateAll(NOW);
    db().alertRules[0].enabled = false;
    expect(evaluateAll(NOW + 1000)).toBe(1);
    expect(openEventFor(id)).toBeUndefined();
    expect(db().alertEvents[0].resolvedReason).toContain("turned off");
    expect(evaluateAll(NOW + 2000)).toBe(0);
  });
});

describe("actions", () => {
  it("creates, updates and deletes a rule, keeping the history", async () => {
    seed({ chaos: "degrade" });
    const created = await runAction(
      "alerts.createRule",
      ctx,
      { environmentId: "env1", kind: "health_degraded" },
      { mode: "execute" }
    );
    expect(created.result?.ok).toBe(true);
    const ruleId = (created.result?.data as { ruleId: string }).ruleId;
    expect(rulesOf("p1", "env1")).toHaveLength(1);

    // The plan for a second identical rule refuses, and names the way out.
    const { plan } = await runAction(
      "alerts.createRule",
      ctx,
      { environmentId: "env1", kind: "health_degraded" },
      { mode: "plan" }
    );
    expect(plan?.blocked).toContain("already has this exact rule");

    evaluateAll(NOW);
    expect(openEventFor(ruleId)).toBeDefined();

    // Turning it off through the action closes the alert.
    await runAction("alerts.updateRule", ctx, { ruleId, enabled: false }, { mode: "execute" });
    expect(openEventFor(ruleId)).toBeUndefined();

    await runAction("alerts.deleteRule", ctx, { ruleId }, { mode: "execute" });
    expect(rulesOf("p1", "env1")).toHaveLength(0);
    // The record outlives the rule that noticed.
    expect(db().alertEvents).toHaveLength(1);
    expect(eventPage({ projectId: "p1", limit: 10 }).events).toHaveLength(1);
  });

  it("every mutation plans first, with what is watched and where it shows", async () => {
    const { plan } = await runAction(
      "alerts.createRule",
      ctx,
      { environmentId: "env1", kind: "budget_exceeded", threshold: 90 },
      { mode: "plan" }
    );
    expect(plan?.blocked).toBeUndefined();
    const details = plan!.details.join(" ");
    expect(details).toContain("Watches");
    expect(details).toContain("Checked every 15 seconds");
    expect(details).toMatch(/no email, Slack or webhook delivery/i);
  });

  it("refuses a threshold outside the useful range, naming the range", async () => {
    const { plan } = await runAction(
      "alerts.createRule",
      ctx,
      { environmentId: "env1", kind: "replicas_below", threshold: 99 },
      { mode: "plan" }
    );
    expect(plan?.blocked).toContain("between 1");
  });

  it("acknowledge records who saw it without closing the alert", async () => {
    seed({ chaos: "degrade" });
    const ruleId = rule("health_degraded");
    evaluateAll(NOW);
    const eventId = openEventFor(ruleId)!.id;

    const { result } = await runAction(
      "alerts.acknowledge",
      ctx,
      { eventId, note: "scaling api back up" },
      { mode: "execute" }
    );
    expect(result?.ok).toBe(true);

    const event = db().alertEvents.find((e) => e.id === eventId)!;
    expect(event.acknowledgedBy?.name).toBe("You");
    expect(event.acknowledgedNote).toBe("scaling api back up");
    // Acknowledging is not resolving: the condition is still true.
    expect(event.resolvedAt).toBeUndefined();
    expect(openEventFor(ruleId)).toBeDefined();

    // A second acknowledgement is refused rather than silently overwriting.
    const { plan } = await runAction("alerts.acknowledge", ctx, { eventId }, { mode: "plan" });
    expect(plan?.blocked).toContain("already acknowledged");
  });
});

describe("durability", () => {
  it("events survive a store reload", () => {
    seed({ chaos: "degrade" });
    const ruleId = rule("health_degraded");
    evaluateAll(NOW);
    const before = structuredClone(db().alertEvents);
    expect(before).toHaveLength(1);

    flush();
    // Drop the in-process cache: the next db() reads state.json from disk.
    delete (globalThis as { __orreryDb?: unknown }).__orreryDb;

    expect(db().alertEvents).toEqual(before);
    expect(db().alertRules.map((r) => r.id)).toEqual([ruleId]);
    // And the re-derived condition agrees with the record it comes back to.
    expect(openEventFor(ruleId)).toBeDefined();
    expect(evaluateAll(NOW + 1000)).toBe(0);
  });
});
