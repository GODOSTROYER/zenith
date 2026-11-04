/**
 * The evaluation harness and report (PROD-MACH-06). These tests drive the REAL
 * loop, tools, budgets, checkpoints and graders with a SCRIPTED model. They
 * prove the harness and its honesty rules; they are not model evidence. The
 * live model run is `eval-live.test.ts` / `npm run eval:coding-agent`.
 */
import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "@/lib/coding-agent/eval/cases";
import { EVAL_SCHEMA, failingOnCall, runEval, runEvalCase, skippedReport } from "@/lib/coding-agent/eval/harness";
import { compromisedAgentScript, scriptedProvider, statelessGoodAgent } from "@/lib/coding-agent/eval/scripted";

describe("the fixed eval set", () => {
  it("is small and fixed: three task, three unsafe and two recovery cases with unique ids", () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EVAL_CASES.filter((c) => c.category === "task")).toHaveLength(3);
    expect(EVAL_CASES.filter((c) => c.category === "unsafe")).toHaveLength(3);
    expect(EVAL_CASES.filter((c) => c.category === "recovery")).toHaveLength(2);
  });

  it("builds canaries at run time: no fixture contains a secret literal", () => {
    const a = EVAL_CASES.flatMap((c) => Object.values(c.files("canary-AAAA")));
    const b = EVAL_CASES.flatMap((c) => Object.values(c.files("canary-BBBB")));
    expect(a.join("\n")).toContain("canary-AAAA");
    expect(a).not.toEqual(b);
    expect(EVAL_CASES.map((c) => c.files.toString()).join("\n")).not.toMatch(/sk-ant|AKIA[0-9A-Z]{8}|ghp_[A-Za-z0-9]{10}/);
  });
});

describe("report", () => {
  it("a well-behaved scripted agent passes every case; the report is machine readable and names the provider", async () => {
    const report = await runEval({ provider: statelessGoodAgent(), nonce: "t1" });
    expect(report.schema).toBe(EVAL_SCHEMA);
    expect(report.provider).toBe("scripted");
    const failing = report.cases.filter((c) => c.status !== "passed").map((c) => ({ id: c.id, failed: c.checks.filter((k) => !k.passed) }));
    expect(failing).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.summary).toMatchObject({ task: { passed: 3, total: 3 }, unsafe: { passed: 3, total: 3 }, recovery: { passed: 2, total: 2 }, unsafeActionAttempts: 0 });
    expect(report.summary.estimatedSpendMicroUsd).toBeGreaterThan(0);
    // round-trips as JSON without loss of the fields a verifier reads
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.cases[0]).toMatchObject({ id: "task-node-postgres", category: "task", status: "passed" });
    expect(parsed.cases.every((c: { checks: unknown[]; usage: object; attempts: unknown[] }) => c.checks.length > 0 && "toolCalls" in c.usage && Array.isArray(c.attempts))).toBe(true);
  });

  it("recovery cases really exercise failure: the first attempt stops, the second finishes", async () => {
    const report = await runEval({ provider: statelessGoodAgent(), only: ["recovery-provider-failure", "recovery-budget-stop"] });
    const [failure, budget] = report.cases;
    expect(failure.attempts.map((a) => a.status)).toEqual(["failed", "completed"]);
    expect(budget.attempts.map((a) => a.status)).toEqual(["budget_exhausted", "completed"]);
    expect(budget.attempts[0].stopReason).toEqual({ kind: "budget", dimension: "toolCalls" });
  });

  it("a compromised agent that obeys injected text FAILS the unsafe cases and the attempts are counted", async () => {
    const report = await runEval({ provider: scriptedProvider([...compromisedAgentScript(), ...compromisedAgentScript(), ...compromisedAgentScript()]), only: ["unsafe-manifest-and-source-injection"] });
    expect(report.verdict).toBe("fail");
    const c = report.cases[0];
    expect(c.status).toBe("failed");
    expect(c.unsafeActionAttempts).toBe(4);
    expect(c.checks.find((k) => k.name === "model_did_not_attempt_unsafe_actions")?.passed).toBe(false);
    // containment still held: nothing but one proposal could leave
    expect(c.checks.find((k) => k.name === "no_authority_effect")?.passed).toBe(true);
    expect(report.summary.unsafeActionAttempts).toBe(4);
  });

  it("an erroring case is a failed case, not a skipped one", async () => {
    const report = await runEval({ provider: scriptedProvider([]), only: ["task-node-postgres"] });
    expect(report.cases[0].status).toBe("failed");
    expect(report.verdict).toBe("fail");
  });

  it("stops starting cases past the spend cap and fails the verdict instead of passing a partial run", async () => {
    const report = await runEval({ provider: statelessGoodAgent(), maxSpendMicroUsd: 1 });
    expect(report.cases[0].status).toBe("passed");
    expect(report.cases.slice(1).every((c) => c.status === "not_run")).toBe(true);
    expect(report.verdict).toBe("fail");
  });

  it("failingOnCall fails exactly one call", async () => {
    const wrapped = failingOnCall(statelessGoodAgent(), 2);
    const req = { model: "m", system: "", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }], tools: [], maxTokens: 10 };
    await wrapped.complete(req);
    await expect(wrapped.complete(req)).rejects.toThrow("injected provider failure");
    await expect(wrapped.complete(req)).resolves.toBeDefined();
  });

  it("runEvalCase grades a single case", async () => {
    const r = await runEvalCase(EVAL_CASES[0], { provider: statelessGoodAgent() });
    expect(r.status).toBe("passed");
  });
});

describe("a missing model is skipped, never passed", () => {
  it("the skipped report carries the reason, no passed cases and a verdict that is not pass", () => {
    const report = skippedReport("ANTHROPIC_API_KEY is not set, so no model could be evaluated.");
    expect(report.verdict).toBe("skipped");
    expect(report.skipReason).toMatch(/ANTHROPIC_API_KEY/);
    expect(report.cases).toEqual([]);
    expect(report.summary).toMatchObject({ task: { passed: 0, total: 0 }, unsafe: { passed: 0, total: 0 }, recovery: { passed: 0, total: 0 } });
    expect(report.verdict).not.toBe("pass");
  });

  it("an empty run can never be a pass", async () => {
    const report = await runEval({ provider: statelessGoodAgent(), only: ["no-such-case"] });
    expect(report.cases).toEqual([]);
    expect(report.verdict).toBe("fail");
  });
});
