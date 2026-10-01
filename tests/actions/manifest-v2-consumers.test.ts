/** Product readers and Navigator over an actual temp store; all provider data is simulated. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertRule, AnyManifest } from "@/lib/domain/types";
import type { Credential, SelectedScope } from "@/lib/agent-access/security";
import type { ExportBundle } from "@/lib/providers/types";
import { tempDataDir } from "../_support/data-dir";
import { AT, ctx, productSeed, v1, v2 } from "./manifest-v2-fixture";

tempDataDir("zenith-v2-consumers-", { fast: true });
vi.stubEnv("ANTHROPIC_API_KEY", "");
const { db, resetDb } = await import("@/lib/db/store");
const { analyze } = await import("@/lib/security/rules");
const { evaluateRule } = await import("@/lib/alerts");
const { health, getServiceLogs } = await import("@/lib/logsim");
const { callReader } = await import("@/lib/agent-access/zenith-reader");
const { productScopeResolver } = await import("@/lib/capabilities/product-adapters");
const { parseGoal } = await import("@/lib/navigator/planner");
const { createRun, executeRun } = await import("@/lib/navigator/run");
const { monthlyCostUsd } = await import("@/lib/cost/pricing");

const grant: Credential = { id: "reader", subject: "editor", workspaceId: "ws", projectIds: ["proj"],
  scopes: ["read", "export"], tokenHash: "0".repeat(64), issuedAt: AT, expiresAt: "2099-01-01T00:00:00.000Z" };
const selected: SelectedScope = { workspaceId: "ws", projectId: "proj", environmentId: "env" };
const budgetRule: AlertRule = { id: "budget", projectId: "proj", environmentId: "env", kind: "budget_exceeded",
  enabled: true, threshold: 100, createdBy: ctx.actor, createdAt: AT };

function seed(manifest: AnyManifest, deployed = false) {
  const data = productSeed(manifest);
  data.settings = { autonomy: "autonomous" };
  data.environments![0].policies.budgetUsdMonthly = 1;
  if (deployed) {
    data.environments![0].deployedRevisionId = "rev";
    data.revisions = [{ id: "rev", projectId: "proj", number: 1, manifest: structuredClone(manifest),
      author: ctx.actor, createdAt: AT, message: "Saved document" }];
    data.deployments = [{ id: "deploy", projectId: "proj", environmentId: "env", revisionId: "rev",
      status: "succeeded", steps: [], outputs: [], actor: ctx.actor, createdAt: AT, endedAt: AT,
      changeSummary: "Simulated", estCostDeltaUsd: 0 }];
  }
  resetDb(data);
}

beforeEach(() => seed(v2()));
afterEach(() => vi.restoreAllMocks());
const documents = () => JSON.stringify([db().projects[0].workingManifest, ...db().revisions.map((r) => r.manifest)]);

describe("Manifest V2 legacy consumers", () => {
  it.each([false, true])("reads V2 costs and scoped resource facts without rewriting documents (deployed=%s)", async (deployed) => {
    seed(v2(), deployed);
    const before = documents();
    const project = db().projects[0];
    expect(analyze(project, db().environments, v2()).map((f) => f.id))
      .toEqual(analyze({ ...project, workingManifest: v1() }, db().environments, v1()).map((f) => f.id));
    expect(await callReader("zenith_get_project", {}, grant, selected))
      .toMatchObject({ workingMonthlyUsd: monthlyCostUsd(v1()), costIsEstimate: true });
    expect(await callReader("zenith_get_manifest", { view: deployed ? "deployed" : "working" }, grant, selected))
      .toMatchObject({ manifest: v2() });
    expect(await productScopeResolver().resolve({ ...selected, resourceId: "svc-web" }))
      .toMatchObject({ resource: { address: "service/web", kind: "container_service", ownership: "managed" } });
    expect(evaluateRule(budgetRule)).toMatchObject({ firing: true, simulated: true });
    expect(evaluateRule(budgetRule).detail).toContain(`$${monthlyCostUsd(v1()).toFixed(2)}`);
    expect(documents()).toBe(before);
  });

  it("reads simulated drift, health and deterministic logs from a V2 revision", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(AT) + 600_000);
    seed(v2(), true);
    const before = documents();
    const observation = await callReader("zenith_get_drift", {}, grant, selected);
    expect(observation).toMatchObject({ simulated: true, provider: "sandbox", revisionId: "rev" });
    const v2Health = health("env", "svc-web");
    const v2Logs = getServiceLogs("env", "svc-web");
    expect(v2Health).toMatchObject({ status: "ok", replicasReady: 1 });
    expect(v2Logs.length).toBeGreaterThan(0);
    expect(documents()).toBe(before);
    seed(v1(), true);
    expect(health("env", "svc-web")).toEqual(v2Health);
    expect(getServiceLogs("env", "svc-web")).toEqual(v2Logs);
  });

  it("reports every V2 section omitted from the provider export, including release", async () => {
    const before = documents();
    const bundle = await callReader("zenith_export_project", {}, grant, selected) as ExportBundle & { v2OnlySections: string[]; notice: string };
    expect(bundle.v2OnlySections).toEqual(["placement", "constraints", "policies", "nodePlacement", "providerConfig", "native", "release"]);
    expect(bundle.readme).toContain("V1 provider export omits V2 sections:");
    expect(bundle.notice).toContain("release");
    expect(documents()).toBe(before);
    seed(v1());
    const legacy = await callReader("zenith_export_project", {}, grant, selected);
    expect(legacy).not.toHaveProperty("v2OnlySections");
    expect(legacy).toMatchObject({ notice: "Supply environment values separately. Exporting does not apply infrastructure or write a local file." });
  });

  it("plans and executes a Navigator service edit while retaining all V2 sections", async () => {
    const before = documents();
    const goal = "scale web to 2 replicas";
    const steps = parseGoal(goal, db().projects[0], db().environments);
    expect(steps.map((s) => s.actionId)).toEqual(["ops.scaleService"]);
    expect(documents()).toBe(before);
    const { run } = await createRun("proj", goal);
    const result = await executeRun(run.id, { human: ctx.actor, stepApprovals: run.steps.map((s) => s.id) });
    expect(result.status).toBe("done");
    const expected = v2();
    expected.services[0].replicas = 2;
    expect(db().projects[0].workingManifest).toEqual(expected);
  });
});
