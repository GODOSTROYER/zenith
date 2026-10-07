import { describe, expect, it } from "vitest";
import {
  BOUNDARY_POLICY_BUDGET_CHARS, IAM_MANAGED_POLICY_MAX_CHARS, IAM_ROLE_MANAGED_POLICIES_DEFAULT_QUOTA, PolicyBudgetError,
  assertBoundaryFits, compactPolicySize, planManagedPolicySplit, readPolicyBudget,
} from "@/lib/credentials/aws/policy-budget";

const statement = (i: number, resources = 1, width = 60): Record<string, unknown> => ({
  Sid: `S${String(i).padStart(3, "0")}`, Effect: "Allow", Action: [`svc${i % 7}:Put${i}`],
  Resource: Array.from({ length: resources }, (_, r) => `arn:aws:svc:us-east-1:123456789012:thing/${"x".repeat(width)}${i}-${r}`),
});
const doc = (statements: readonly Record<string, unknown>[]) => ({ Version: "2012-10-17", Statement: statements });

describe("compactPolicySize", () => {
  it("ignores whitespace and accepts documents as JSON text", () => {
    const value = doc([statement(1)]);
    expect(compactPolicySize(JSON.stringify(value, null, 4))).toBe(compactPolicySize(value));
  });
});

describe("readPolicyBudget", () => {
  it("reports headroom, near-limit and over-budget at the boundaries", () => {
    const small = readPolicyBudget(doc([statement(1)]));
    expect(small).toMatchObject({ budget: IAM_MANAGED_POLICY_MAX_CHARS, overBudget: false, nearLimit: false });
    expect(small.headroom).toBe(IAM_MANAGED_POLICY_MAX_CHARS - small.size);
    const size = compactPolicySize(doc([statement(1)]));
    expect(readPolicyBudget(doc([statement(1)]), size)).toMatchObject({ overBudget: false, nearLimit: true, headroom: 0 });
    expect(readPolicyBudget(doc([statement(1)]), size - 1).overBudget).toBe(true);
  });
  it.each([0, -1, 6145, 1.5, Number.NaN])("refuses budget %s", (budget) => expect(() => readPolicyBudget(doc([statement(1)]), budget)).toThrow(PolicyBudgetError));
});

describe("assertBoundaryFits", () => {
  it("passes within the boundary budget and refuses above it with an explicit no-split message", () => {
    expect(() => assertBoundaryFits("B", doc([statement(1)]))).not.toThrow();
    const big = doc(Array.from({ length: 40 }, (_, i) => statement(i, 1, 120)));
    expect(compactPolicySize(big)).toBeGreaterThan(BOUNDARY_POLICY_BUDGET_CHARS);
    expect(() => assertBoundaryFits("ZenithAppBoundary", big)).toThrow(/cannot be split/);
  });
});

describe("planManagedPolicySplit", () => {
  it("does not split a document that fits", () => {
    const plan = planManagedPolicySplit([statement(1), statement(2)]);
    expect(plan.split).toBe(false);
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0].statements).toHaveLength(2);
  });

  const many = Array.from({ length: 70 }, (_, i) => statement(i, 2, 70));

  it("splits an oversized list into parts that each fit, keep whole statements and lose none", () => {
    expect(compactPolicySize(doc(many))).toBeGreaterThan(IAM_MANAGED_POLICY_MAX_CHARS);
    const plan = planManagedPolicySplit(many);
    expect(plan.split).toBe(true);
    expect(plan.parts.length).toBeGreaterThan(1);
    expect(plan.parts.length).toBeLessThanOrEqual(IAM_ROLE_MANAGED_POLICIES_DEFAULT_QUOTA);
    for (const part of plan.parts) {
      expect(compactPolicySize(doc(part.statements))).toBe(part.size);
      expect(part.size).toBeLessThanOrEqual(IAM_MANAGED_POLICY_MAX_CHARS);
    }
    const sids = plan.parts.flatMap((part) => part.statements.map((s) => s.Sid));
    expect([...sids].sort()).toEqual(many.map((s) => s.Sid).sort());
    expect(new Set(sids).size).toBe(many.length);
    // Each statement object is passed through unchanged (no trimming of actions or resources).
    for (const part of plan.parts) for (const s of part.statements) expect(many).toContain(s);
  });

  it("keeps statements in their original relative order inside each part and numbers parts from zero", () => {
    const plan = planManagedPolicySplit(many);
    plan.parts.forEach((part, index) => {
      expect(part.index).toBe(index);
      const positions = part.statements.map((s) => many.indexOf(s as Record<string, unknown>));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });
    expect(plan.parts[0].statements).toContain(many[0]);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(planManagedPolicySplit(many))).toBe(JSON.stringify(planManagedPolicySplit([...many])));
  });

  it("honours a smaller budget and refuses when more policies than the quota would be needed", () => {
    const tight = planManagedPolicySplit(many, { budget: 3000, maxPolicies: 20 });
    for (const part of tight.parts) expect(part.size).toBeLessThanOrEqual(3000);
    expect(() => planManagedPolicySplit(many, { budget: 1500, maxPolicies: 2 })).toThrow(/at most 2/);
  });

  it("refuses one statement that cannot fit any policy, naming it", () => {
    const huge = statement(99, 200, 60);
    expect(() => planManagedPolicySplit([statement(1), huge])).toThrow(/Statement S099/);
  });

  it.each([{ budget: 10 }, { budget: 7000 }, { maxPolicies: 0 }, { maxPolicies: 21 }, { budget: 3000.5 }])("refuses invalid options %j", (options) => {
    expect(() => planManagedPolicySplit(many, options)).toThrow(PolicyBudgetError);
  });
  it("refuses an empty statement list", () => expect(() => planManagedPolicySplit([])).toThrow(PolicyBudgetError));
});
