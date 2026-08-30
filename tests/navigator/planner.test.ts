import { describe, expect, it } from "vitest";
import { registerAllActions } from "@/lib/actions/defs";
import {
  emptyManifest,
  type Environment,
  type Manifest,
  type Project,
  type SecurityFinding,
} from "@/lib/domain/types";
import { parseGoal } from "@/lib/navigator/planner";
import { BLOCKED, CLARIFY, INVESTIGATE } from "@/lib/navigator/shared";

registerAllActions();

const manifest = (): Manifest => ({
  ...emptyManifest(),
  services: [
    {
      id: "svc-web",
      name: "web",
      kind: "web",
      source: { type: "image", image: "ghcr.io/demo/web:1" },
      size: "small",
      replicas: 2,
      port: 3000,
      env: [],
      ownership: "managed",
    },
  ],
});

const project = (): Project => ({
  id: "proj-1",
  workspaceId: "ws-1",
  name: "Atlas",
  slug: "atlas",
  workingManifest: manifest(),
  createdAt: new Date().toISOString(),
  origin: { type: "blank" },
});

const env = (name: string, klass: Environment["class"], approvalRequired = false): Environment => ({
  id: `env-${name}`,
  projectId: "proj-1",
  name,
  class: klass,
  connectionId: "conn-1",
  region: "local",
  policies: { approvalRequired, allowStatefulDeletion: false },
  baseDomain: `${name}.atlas.orrery.app`,
  createdAt: new Date().toISOString(),
});

const envs = [env("staging", "staging"), env("production", "production", true)];

const actionIds = (goal: string, findings: SecurityFinding[] = []) =>
  parseGoal(goal, project(), envs, findings).map((s) => s.actionId);

describe("parseGoal", () => {
  it("plans the representative multi-clause goal", () => {
    const steps = parseGoal(
      "add a worker and a queue, bind worker to queue, set a $100 budget, deploy to staging",
      project(),
      envs
    );
    expect(steps.map((s) => s.actionId)).toEqual([
      "system.addService",
      "system.addResource",
      "system.bind",
      "env.setBudget",
      "deploy.plan",
      "deploy.apply",
    ]);
    // the verbless "a queue" clause inherited "add", and the bind resolved
    // against nodes this same plan will create
    expect(steps[1].input).toMatchObject({ kind: "queue" });
    expect(steps[2].input).toMatchObject({ from: "worker", to: "queue" });
    expect(steps[3].input).toMatchObject({ environmentId: "env-staging", budgetUsdMonthly: 100 });
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("resolves 'it' to the node the previous step adds", () => {
    const steps = parseGoal(
      "Add a redis cache and bind it to web, then deploy to staging",
      project(),
      envs
    );
    expect(steps.map((s) => s.actionId)).toEqual([
      "system.addResource",
      "system.bind",
      "deploy.plan",
      "deploy.apply",
    ]);
    // "bind it to web" names the same edge as "bind web to it" — Orrery records
    // bindings consumer → provider, so the planner orients it that way
    expect(steps[1].input).toMatchObject({ from: "web", to: "cache" });
  });

  it("expands 'fix the security findings' into one step per fixable finding", () => {
    const findings: SecurityFinding[] = [
      {
        id: "f1",
        projectId: "proj-1",
        severity: "high",
        title: "web is reachable without TLS",
        detail: "The route serves plain HTTP.",
        status: "open",
        createdAt: new Date().toISOString(),
        fix: { actionId: "system.addRoute", input: {}, label: "Enable TLS" },
      },
      {
        id: "f2",
        projectId: "proj-1",
        severity: "low",
        title: "already handled",
        detail: "-",
        status: "resolved",
        createdAt: new Date().toISOString(),
        fix: { actionId: "system.addRoute", input: {}, label: "Enable TLS" },
      },
    ];
    const steps = parseGoal("Set a $100 budget on staging and fix the security findings", project(), envs, findings);
    expect(steps.map((s) => s.actionId)).toEqual(["env.setBudget", "security.resolveFinding"]);
    expect(steps[1].input).toMatchObject({ findingId: "f1" });
  });

  it("makes production steps need approval, and read-only steps not", () => {
    const steps = parseGoal("Investigate the failed deployment, then deploy to production", project(), envs);
    expect(steps.map((s) => s.actionId)).toEqual([INVESTIGATE, "deploy.plan", "deploy.apply"]);
    expect(steps[0].needsApproval).toBe(false);
    expect(steps[1].needsApproval).toBe(true); // production, even for the read-only plan step
    expect(steps[2].needsApproval).toBe(true);
    expect(steps[2].risk).toBe("high");
  });

  it("surfaces unresolved references and unparsed clauses instead of dropping them", () => {
    expect(actionIds("connect web to nowhere-db")).toEqual([BLOCKED]);
    expect(actionIds("scale web to 4 replicas, then juggle the flux capacitor")).toEqual([
      "ops.scaleService",
      CLARIFY,
    ]);
  });
});
