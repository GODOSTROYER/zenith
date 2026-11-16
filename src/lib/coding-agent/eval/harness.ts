/**
 * The evaluation harness (PROD-MACH-06): drives the fixed case set through the
 * real bounded loop with a given model provider and produces a machine-readable
 * report.
 *
 * Honesty rules:
 *  - A report is `pass` only if every case ran and every check passed.
 *  - With no model available the result is `skipped` with an explicit reason;
 *    a skipped report is never `pass` and carries zero passed cases.
 *  - A scripted provider is allowed (it tests the harness and the loop) but the
 *    report names the provider, so it cannot be mistaken for a model evaluation.
 *  - Grading is deterministic code over the run's checkpoint; no model grades.
 */
import { snapshotFromFiles } from "@/lib/analysis";
import { DEFAULT_AGENT_MODEL, raiseLimits, resolveLimits } from "../budget";
import { runAgent, type ProposalSink, type RunOutcome } from "../runner";
import type { AgentSourceRef, BudgetLimits, Checkpoint, ModelProvider } from "../types";
import { EVAL_CASES, type EvalCase, type EvalCheck } from "./cases";

export const EVAL_SCHEMA = "zenith.coding-agent-eval/1";

export type CaseStatus = "passed" | "failed" | "error" | "not_run";

export interface CaseReport {
  id: string;
  category: EvalCase["category"];
  title: string;
  status: CaseStatus;
  checks: EvalCheck[];
  attempts: { status: string; stopReason: unknown; steps: number }[];
  usage: BudgetLimits;
  unsafeActionAttempts: number;
  injectionSignals: string[];
  durationMs: number;
  error?: string;
}

export interface CategorySummary {
  passed: number;
  total: number;
}

export interface EvalReport {
  schema: typeof EVAL_SCHEMA;
  generatedAt: string;
  verdict: "pass" | "fail" | "skipped";
  skipReason?: string;
  provider: string;
  model: string;
  limits: BudgetLimits;
  cases: CaseReport[];
  summary: {
    task: CategorySummary;
    unsafe: CategorySummary;
    recovery: CategorySummary;
    unsafeActionAttempts: number;
    estimatedSpendMicroUsd: number;
  };
}

const emptySummary = (): EvalReport["summary"] => ({ task: { passed: 0, total: 0 }, unsafe: { passed: 0, total: 0 }, recovery: { passed: 0, total: 0 }, unsafeActionAttempts: 0, estimatedSpendMicroUsd: 0 });

/** The report written when no model is available: never `pass`, always says why. */
export function skippedReport(reason: string, model: string = DEFAULT_AGENT_MODEL, limits: Partial<BudgetLimits> = {}): EvalReport {
  return { schema: EVAL_SCHEMA, generatedAt: new Date().toISOString(), verdict: "skipped", skipReason: reason, provider: "none", model, limits: resolveLimits(limits), cases: [], summary: emptySummary() };
}

/** Fail the Nth model call once (recovery evaluation), then behave like the wrapped provider. */
export function failingOnCall(provider: ModelProvider, onCall: number): ModelProvider {
  let calls = 0;
  let failed = false;
  return {
    id: provider.id,
    async complete(request) {
      calls += 1;
      if (!failed && calls === onCall) {
        failed = true;
        throw new Error("injected provider failure");
      }
      return provider.complete(request);
    },
  };
}

export interface EvalOptions {
  provider: ModelProvider;
  model?: string;
  limits?: Partial<BudgetLimits>;
  /** run only these case ids */
  only?: string[];
  /** stop starting new cases once this much estimated spend has been used */
  maxSpendMicroUsd?: number;
  now?: () => number;
  nonce?: string;
}

const FIXTURE_COMMIT = "0000000000000000000000000000000000000000";

export async function runEvalCase(c: EvalCase, options: EvalOptions): Promise<CaseReport> {
  const started = (options.now ?? Date.now)();
  const model = options.model ?? DEFAULT_AGENT_MODEL;
  const canary = `canary-${options.nonce ?? Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2, 10)}`;
  const snapshot = snapshotFromFiles(c.files(canary), { source: { kind: "fixture" } });
  const source: AgentSourceRef = { repository: `fixture/${c.id}`, commit: FIXTURE_COMMIT };
  const submissions: { manifestDigest: string; summary: string }[] = [];
  const sink: ProposalSink = {
    async submit(artifact, context) {
      submissions.push({ manifestDigest: artifact.manifestDigest, summary: context.summary });
      return { operationId: `eval-${submissions.length}`, status: "recorded" };
    },
  };
  const baseLimits = resolveLimits({ ...(options.limits ?? {}), ...(c.limits ?? {}), ...(c.disturbance?.kind === "tight_budget" ? c.disturbance.limits : {}) });
  const provider = c.disturbance?.kind === "fail_model_call" ? failingOnCall(options.provider, c.disturbance.onCall) : options.provider;

  const attempts: RunOutcome[] = [];
  let checkpoint: Checkpoint | undefined;
  let limits = baseLimits;
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await runAgent({ task: c.task, source, snapshot, provider, model, limits, ...(checkpoint ? { checkpoint } : {}), proposals: sink, ...(options.now ? { now: options.now } : {}) });
    attempts.push(outcome);
    if (outcome.status === "completed" || !c.disturbance) break;
    checkpoint = outcome.checkpoint;
    limits = c.disturbance.kind === "tight_budget" ? raiseLimits(limits, c.disturbance.raiseTo) : limits;
  }
  const last = attempts[attempts.length - 1];
  const checks = c.grade({ outcome: last, submissions, attempts, canary });
  return {
    id: c.id,
    category: c.category,
    title: c.title,
    status: checks.every((k) => k.passed) ? "passed" : "failed",
    checks,
    attempts: attempts.map((a) => ({ status: a.status, stopReason: a.stopReason ?? null, steps: a.checkpoint.steps })),
    usage: last.checkpoint.usage,
    unsafeActionAttempts: last.checkpoint.unsafeAttempts.length,
    injectionSignals: last.checkpoint.injectionSignals,
    durationMs: Math.max(0, (options.now ?? Date.now)() - started),
  };
}

export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const model = options.model ?? DEFAULT_AGENT_MODEL;
  const cases = EVAL_CASES.filter((c) => !options.only || options.only.includes(c.id));
  const reports: CaseReport[] = [];
  let spend = 0;
  for (const c of cases) {
    if (options.maxSpendMicroUsd !== undefined && spend >= options.maxSpendMicroUsd) {
      reports.push({ id: c.id, category: c.category, title: c.title, status: "not_run", checks: [{ name: "spend_cap_reached_before_start", passed: false }], attempts: [], usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0, spendMicroUsd: 0 }, unsafeActionAttempts: 0, injectionSignals: [], durationMs: 0 });
      continue;
    }
    try {
      const r = await runEvalCase(c, options);
      spend += r.usage.spendMicroUsd;
      reports.push(r);
    } catch (error) {
      reports.push({ id: c.id, category: c.category, title: c.title, status: "error", checks: [{ name: "case_ran", passed: false, detail: error instanceof Error ? error.name : "error" }], attempts: [], usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0, spendMicroUsd: 0 }, unsafeActionAttempts: 0, injectionSignals: [], durationMs: 0, error: error instanceof Error ? error.message.slice(0, 300) : "error" });
    }
  }
  const summary = emptySummary();
  for (const r of reports) {
    const bucket = summary[r.category];
    bucket.total += 1;
    if (r.status === "passed") bucket.passed += 1;
    summary.unsafeActionAttempts += r.unsafeActionAttempts;
    summary.estimatedSpendMicroUsd += r.usage.spendMicroUsd;
  }
  const verdict = reports.length > 0 && reports.every((r) => r.status === "passed") ? "pass" : "fail";
  return { schema: EVAL_SCHEMA, generatedAt: new Date().toISOString(), verdict, provider: options.provider.id, model, limits: resolveLimits(options.limits), cases: reports, summary };
}
