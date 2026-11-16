/**
 * Real planning activities, evidence schemas, policy WASM and review components,
 * wired to fake stores, credentials and OpenTofu. No live provider inspection
 * or apply is performed; deletion guards have their own contract tests.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "@/components/platform/approval-card";
import { PlanChangesTable } from "@/components/platform/plan-changes-table";
import { projectPlanReview, ReviewFactsSchema } from "@/lib/controlplane/db/repos/operation-review";
import { planEvidence, readPlanEvidence } from "@/lib/execution/plan-evidence";
import { extractPlanFacts, loadPolicyEngine, type PolicyEngine } from "@/lib/policy";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { StepFailedError } from "@/lib/execution/errors";
import { decision as reviewDecision, operation as reviewOperation } from "../screens/platform/fixtures";
import { policyInput } from "../policy/support";
import { createWorld, type World } from "./fakes/world";
import { bucketManifest, change, makePlan, OP, REVISION, webDbManifest } from "./fakes/fixtures";

const worlds: World[] = [];
const statefulAddress = "terraform_data.object_store_assets";
const dnsAddress = "terraform_data.dns_record_app_atlas_zenith_test";
const fields = ["statefulDeletes", "dnsDeletes"] as const;
let engine: PolicyEngine;
beforeAll(async () => { engine = await loadPolicyEngine(); });
afterEach(() => { worlds.splice(0).forEach((w) => w.dispose()); vi.restoreAllMocks(); });

function deletionWorld(field: typeof fields[number], action: "delete" | "replace" = "delete") {
  const w = createWorld(); worlds.push(w);
  w.product.base.environment.class = "sandbox";
  const before = upgradeManifest(field === "statefulDeletes" ? bucketManifest() : webDbManifest(), { provider: "aws", region: "us-east-1" });
  before.policies = { ...before.policies, backup: "daily", deletion: "allow" };
  w.product.setManifest(before, "rev-deployed");
  w.product.setManifest({ version: 1, services: [], resources: [], routes: [], bindings: [] }, REVISION);
  w.product.base.environment.deployedRevisionId = "rev-deployed";
  const address = field === "statefulDeletes" ? statefulAddress : dnsAddress;
  w.tofu.planFactory = (ws) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest, changes: [change({ address, type: "terraform_data", action, nodeAddress: Object.entries(ws.addressMap).find(([, addresses]) => addresses.includes(address))?.[0] })] });
  return w;
}

async function plan(w: World) {
  const lease = await w.lease();
  const result = await w.activities.planInfrastructure({ operationId: OP, lease });
  return { operationId: OP, lease, planDigest: result.planDigest };
}

describe("deletion facts reach policy and review", () => {
  it.each(fields.flatMap((field) => (["delete", "replace"] as const).map((action) => ({ field, action }))))("retains $field for $action in initial and final plan evidence", async ({ field, action }) => {
    const w = deletionWorld(field, action);
    const args = await plan(w);
    await w.activities.finalPlan({ operationId: OP, approvedPlanDigest: args.planDigest, lease: args.lease });
    expect(w.evidence.rows.map((row) => row.summary.stage)).toEqual(["plan", "final_plan"]);
    for (const row of w.evidence.rows) {
      const parsed = readPlanEvidence(row.summary)!;
      expect(parsed).toBeDefined();
      expect(parsed.facts[field]).toEqual([field === "statefulDeletes" ? statefulAddress : dnsAddress]);
      for (const name of fields) expect(parsed.facts[name]).toEqual(row.summary[name]);
    }
    const review = projectPlanReview(w.evidence.rows[0].summary, args.planDigest)!;
    expect(review).toBeDefined();
    expect(review.facts[field]).toEqual(readPlanEvidence(w.evidence.rows[0].summary)!.facts[field]);
    expect(review.view.resources).toEqual([expect.objectContaining({ address: field === "statefulDeletes" ? statefulAddress : dnsAddress, action })]);
  });

  it.each(fields)("an otherwise auto-allowed deployment enters human review at evaluatePolicy for %s", async (field) => {
    const w = deletionWorld(field);
    const base = policyInput("deployment.deploy", { environment: { class: "sandbox", autonomyLevel: 5 } });
    expect((await engine.evaluate(base)).decision.outcome).toBe("allow");
    const reevaluate = vi.spyOn(w.broker, "reevaluate").mockImplementation(async (operationId, facts) => {
      expect(operationId).toBe(OP);
      expect(facts?.[field]).toEqual([field === "statefulDeletes" ? statefulAddress : dnsAddress]);
      const { decision } = await engine.evaluate({ ...base, plan: facts });
      return { outcome: decision.outcome, decisionId: "deletion-review", reasons: decision.reasons.map((r) => r.code) };
    });
    const args = await plan(w);
    const result = await w.activities.evaluatePolicy(args);
    expect(reevaluate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: "require_approval", decisionId: "deletion-review" });
    expect(result.reasons).toContain(field === "statefulDeletes" ? "stateful_deletes_require_approval" : "dns_deletes_require_approval");
    expect(w.ops.policyDecisions).toEqual(["deletion-review"]);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });

  it.each(fields)("rejects malformed %s evidence before consulting the broker", async (field) => {
    const w = deletionWorld(field);
    const args = await plan(w);
    w.evidence.rows[0].summary.facts = { ...readPlanEvidence(w.evidence.rows[0].summary)!.facts, [field]: [42] };
    expect(readPlanEvidence(w.evidence.rows[0].summary)).toBeUndefined();
    expect(projectPlanReview(w.evidence.rows[0].summary, args.planDigest)).toBeUndefined();
    await expect(w.activities.evaluatePolicy(args)).rejects.toBeInstanceOf(StepFailedError);
    expect(w.broker.reevaluations).toHaveLength(0);
  });

  it.each(fields)("bounds %s in stored evidence and review without requiring it on legacy facts", async (field) => {
    const w = deletionWorld(field);
    const args = await plan(w);
    const row = w.evidence.rows[0];
    const facts = readPlanEvidence(row.summary)!.facts;
    for (const invalid of [null, "resource.deleted", [true], ["x".repeat(501)], Array.from({ length: 10_001 }, () => "resource.deleted")]) {
      const summary = { ...row.summary, facts: { ...facts, [field]: invalid } };
      expect(readPlanEvidence(summary)).toBeUndefined();
      expect(ReviewFactsSchema.safeParse(summary.facts).success).toBe(false);
      expect(projectPlanReview(summary, args.planDigest)).toBeUndefined();
    }
    const legacy = { ...facts }; delete legacy.statefulDeletes; delete legacy.dnsDeletes;
    const summary = { ...row.summary, facts: legacy };
    expect(readPlanEvidence(summary)?.facts).toEqual(legacy);
    expect(projectPlanReview(summary, args.planDigest)?.facts).toEqual(legacy);
  });

  it.each(["stateful", "dns"] as const)("keeps a %s deletion visible in the existing approval card and plan table", (kind) => {
    const address = kind === "stateful" ? "aws_s3_bucket.assets" : "aws_route53_record.www";
    const normalized = makePlan({ changes: [change({ address, type: kind === "stateful" ? "aws_s3_bucket" : "aws_route53_record", action: "delete", destroysData: kind === "stateful" })] });
    const facts = extractPlanFacts(normalized);
    const evidence = planEvidence({ plan: normalized, facts, cost: {}, graphDigest: "g".repeat(64), stage: "plan" });
    const review = projectPlanReview(evidence.summary, normalized.planDigest)!;
    expect(review).toBeDefined();
    expect(review.facts[kind === "stateful" ? "statefulDeletes" : "dnsDeletes"]).toEqual([address]);
    const card = renderToStaticMarkup(createElement(ApprovalCard, {
      operation: reviewOperation({ planDigest: normalized.planDigest }), decision: reviewDecision(), approvals: [],
      viewer: { id: "reviewer", role: "admin" }, plan: review.view,
      onApprove: () => undefined, onReject: () => undefined, now: "2026-09-30T12:00:00.000Z",
    }));
    expect(card).toContain("to delete");
    if (kind === "stateful") { expect(card).toContain("This plan destroys data"); expect(card).toContain(address); }
    const table = renderToStaticMarkup(createElement(PlanChangesTable, { plan: review.view }));
    expect(table).toContain(address);
    expect(table).toContain("Delete");
  });
});
