/**
 * Runbook run executor (PROD-MACH-03).
 *
 * One run = one pinned, signed runbook version applied to a bounded list of
 * targets, step by step, inside a deadline. Before ANY step the executor
 *   - re-verifies the version signature against pinned keys and re-derives the
 *     definition digest (a row edited after signing never runs),
 *   - re-evaluates the run-level gate against the approval bound to this exact
 *     run (an expired or foreign approval fails the run),
 *   - checks cancellation, the deadline and the caller's abort signal.
 * Each step is dispatched through `executeStep`, which in production is
 * `createMachineStepExecutor` over `executeMachineOperation`: it requires a
 * broker-issued capability grant per step, so policy, per-step approvals for
 * critical capabilities and evidence all still apply. A step's custody row is
 * inserted BEFORE dispatch; a crashed or replayed run that finds a started row
 * marks it `uncertain` and never re-dispatches it.
 */
import { createHash } from "node:crypto";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { PublicJwk } from "@/lib/credentials/signing/types";
import { MachineOperationError, isMachineOperationError } from "../errors";
import { executeMachineOperation, type MachineExecutionContext } from "../service";
import type { MachineDrivers, MachineEvidenceSink, MachineRequest, MachineResult, MachineSessionProvider } from "../types";
import { RunbookError, classifyRunbook, machineTargetFor, type RunbookStep } from "./definition";
import { evaluateRunbookGate } from "./policy";
import type { RunbookRunRecord, RunbookStepRecord, RunbookStore } from "./ports";
import { verifyRunbookVersion } from "./signing";

export interface RunbookStepContext {
  run: RunbookRunRecord;
  targetIndex: number;
  stepId: string;
  signal: AbortSignal;
}
export type RunbookStepExecutor = (req: MachineRequest, ctx: RunbookStepContext) => Promise<MachineResult>;

export interface RunbookRunnerDeps {
  store: RunbookStore;
  verificationKeys: () => Promise<readonly PublicJwk[]>;
  executeStep: RunbookStepExecutor;
  now?: () => Date;
  /** how long a claim lasts without progress; another worker may reclaim after this */
  leaseMs?: number;
  /** how often a running run looks for a cancel request */
  pollMs?: number;
  actor?: string;
  /**
   * A caller-supplied abort (a pass budget, a shutdown) releases the run instead of finishing it:
   * the lease expires, another pass reclaims it, and the in-flight step is then marked uncertain
   * rather than re-dispatched. Cancellation and the run deadline are unaffected.
   */
  releaseOnAbort?: boolean;
}

/** Deterministic and alphabet-safe: the same (run, target, step) always maps to the same machine operation id. */
export function stepOperationId(runId: string, targetIndex: number, stepId: string): string {
  return `rbs_${createHash("sha256").update(`${runId}\0${targetIndex}\0${stepId}`).digest("hex").slice(0, 48)}`;
}

type StopReason = "cancelled" | "deadline" | "aborted";

export async function executeRunbookRun(deps: RunbookRunnerDeps, input: { workspaceId: string; runId: string; signal?: AbortSignal }): Promise<RunbookRunRecord> {
  const { store } = deps;
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const leaseMs = deps.leaseMs ?? 120_000;
  const actor = deps.actor ?? "system:runbook-runner";
  const ws = input.workspaceId;

  const claimed = await store.claimRun(ws, input.runId, now(), leaseMs);
  if (!claimed) {
    const existing = await store.getRun(ws, input.runId);
    if (!existing) throw new RunbookError("not_found", "That run does not exist.");
    return existing;
  }
  const run = claimed;
  const subject = `run:${run.id}`;
  // audit appends are serialised per run so the hash chain has one writer
  let auditTail: Promise<unknown> = Promise.resolve();
  const audit = (event: string, detail: Record<string, unknown>): Promise<unknown> => {
    auditTail = auditTail.then(() => store.appendAudit(ws, subject, event, actor, detail, now()));
    return auditTail;
  };
  const finish = async (status: Parameters<RunbookStore["finishRun"]>[2], code: string | undefined, detail: Record<string, unknown> = {}): Promise<RunbookRunRecord> => {
    await store.finishRun(ws, run.id, status, code, now());
    await audit("run.finished", { status, ...(code ? { code } : {}), ...detail });
    await auditTail;
    return (await store.getRun(ws, run.id)) ?? { ...run, status };
  };
  await audit("run.started", { binding: run.bindingDigest, version: run.version, targets: run.targets.length });

  /* ---- pre-flight: signature, digest pin, approval gate ---- */
  const rec = await store.getVersion(ws, run.runbookId, run.version);
  if (!rec || rec.definitionDigest !== run.definitionDigest) return finish("failed", "version_mismatch");
  try {
    await verifyRunbookVersion({ workspaceId: ws, runbookId: run.runbookId, version: rec.version, definition: rec.definition, signature: rec.signature }, await deps.verificationKeys());
  } catch {
    return finish("failed", "signature_invalid");
  }
  const classification = classifyRunbook(rec.definition);
  const approval = await store.findValidApproval(ws, run.bindingDigest, now());
  if (evaluateRunbookGate({ classification, approval, requestedBy: run.requestedBy, now: now() }).outcome !== "allow") return finish("failed", "approval_invalid");

  /* ---- cancellation and deadline ---- */
  const controller = new AbortController();
  let stopReason: StopReason | undefined;
  const stop = (reason: StopReason): void => {
    stopReason ??= reason;
    controller.abort();
  };
  const deadlineMs = Date.parse(run.deadlineAt);
  const onExternalAbort = (): void => stop("aborted");
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (input.signal?.aborted) stop("aborted");
  const deadlineTimer = setTimeout(() => stop("deadline"), Math.max(0, Math.min(deadlineMs - now().getTime(), 2 ** 31 - 1)));
  let polling = false;
  const poll = setInterval(() => {
    if (polling) return;
    polling = true;
    void store
      .getRun(ws, run.id)
      .then((r) => {
        if (r?.cancelRequestedAt) stop("cancelled");
        return store.touchLease(ws, run.id, now(), leaseMs);
      })
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, deps.pollMs ?? 2000);
  const shouldStop = async (): Promise<StopReason | undefined> => {
    if (stopReason) return stopReason;
    if (now().getTime() >= deadlineMs) stop("deadline");
    else if (input.signal?.aborted) stop("aborted");
    else if ((await store.getRun(ws, run.id))?.cancelRequestedAt) stop("cancelled");
    return stopReason;
  };

  const counts = { succeeded: 0, failed: 0, uncertain: 0, skipped: 0 };

  const skipRemaining = async (targetIndex: number, from: number, code: string): Promise<void> => {
    for (const step of rec.definition.steps.slice(from)) {
      const at = now().toISOString();
      const op = stepOperationId(run.id, targetIndex, step.id);
      const { inserted } = await store.beginStep({ workspaceId: ws, runId: run.id, targetIndex, stepId: step.id, operationId: op, status: "skipped", errorCode: code, startedAt: at, finishedAt: at });
      if (inserted) counts.skipped += 1;
    }
  };

  const runStep = async (targetIndex: number, step: RunbookStep): Promise<"ok" | "failed" | "uncertain"> => {
    const operationId = stepOperationId(run.id, targetIndex, step.id);
    const started = now().toISOString();
    const begun = await store.beginStep({ workspaceId: ws, runId: run.id, targetIndex, stepId: step.id, operationId, status: "started", startedAt: started });
    if (!begun.inserted) {
      // replay: never dispatch twice
      const prior: RunbookStepRecord = begun.step;
      if (prior.status === "started") {
        await store.finishStep(ws, run.id, targetIndex, step.id, { status: "uncertain", errorCode: "interrupted_in_flight", finishedAt: now().toISOString() });
        counts.uncertain += 1;
        await audit("run.step", { target: targetIndex, step: step.id, status: "uncertain", code: "interrupted_in_flight" });
        return "uncertain";
      }
      return prior.status === "succeeded" || prior.status === "skipped" ? "ok" : prior.status === "uncertain" ? "uncertain" : "failed";
    }
    const req: MachineRequest = {
      operationId,
      target: machineTargetFor(ws, run.targets[targetIndex]),
      operation: step.operation,
      args: step.args,
      timeoutSec: step.timeoutSec,
      maxOutputBytes: step.maxOutputBytes,
    };
    let status: "succeeded" | "failed" | "uncertain" = "failed";
    let errorCode: string | undefined;
    let evidenceId: string | undefined;
    try {
      const result = await deps.executeStep(req, { run, targetIndex, stepId: step.id, signal: controller.signal });
      evidenceId = result.evidenceId;
      if (result.ok) status = "succeeded";
      else errorCode = "step_failed";
    } catch (e) {
      if (isMachineOperationError(e)) {
        errorCode = e.code;
        if (e.code === "uncertain" || e.code === "evidence_failed") status = "uncertain";
      } else errorCode = "executor_error";
    }
    await store.finishStep(ws, run.id, targetIndex, step.id, { status, ...(errorCode ? { errorCode } : {}), ...(evidenceId ? { evidenceId } : {}), finishedAt: now().toISOString() });
    counts[status] += 1;
    await audit("run.step", { target: targetIndex, step: step.id, status, ...(errorCode ? { code: errorCode } : {}), ...(evidenceId ? { evidence: evidenceId } : {}) });
    return status === "succeeded" ? "ok" : status;
  };

  const runTarget = async (targetIndex: number): Promise<void> => {
    const steps = rec.definition.steps;
    for (let i = 0; i < steps.length; i += 1) {
      const why = await shouldStop();
      if (why) return skipRemaining(targetIndex, i, why);
      const outcome = await runStep(targetIndex, steps[i]);
      if (outcome === "uncertain") return skipRemaining(targetIndex, i + 1, "target_uncertain");
      if (outcome === "failed" && steps[i].onFailure === "abort") return skipRemaining(targetIndex, i + 1, "previous_step_failed");
    }
  };

  try {
    let next = 0;
    const workers = Array.from({ length: Math.min(run.maxParallelTargets, run.targets.length) }, async () => {
      while (next < run.targets.length) {
        const idx = next;
        next += 1;
        await runTarget(idx);
      }
    });
    await Promise.all(workers);
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(poll);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }

  if (stopReason === "aborted" && deps.releaseOnAbort) {
    await audit("run.released", { reason: "caller_abort" });
    await auditTail;
    return (await store.getRun(ws, run.id)) ?? run;
  }
  const summary = { ...counts };
  if (stopReason === "cancelled") return finish("cancelled", "cancel_requested", summary);
  if (counts.uncertain > 0) return finish("uncertain", "uncertain_step", summary);
  if (counts.failed > 0) return finish("failed", "step_failed", summary);
  if (stopReason === "deadline" || counts.skipped > 0) return finish("expired", stopReason === "aborted" ? "aborted" : "deadline", summary);
  return finish("succeeded", undefined, summary);
}

/* ---------------------- production step executor ---------------------- */

/** A broker-issued grant for exactly one step, plus the hook that settles its ledger operation. */
export interface StepGrant {
  claims: CapabilityGrantClaims;
  /** compact JWS the transport may need to forward (zenithd); never logged or stored */
  jws: string;
  settle(outcome: "succeeded" | "failed" | "uncertain", detail: { code?: string }): Promise<void>;
}

export interface MachineStepExecutorDeps {
  drivers: MachineDrivers;
  evidence: MachineEvidenceSink;
  sessionsFor: (jws: string, req: MachineRequest, ctx: RunbookStepContext) => MachineSessionProvider;
  /**
   * Obtain the broker-issued, signature-verified capability grant for exactly this machine request
   * (policy evaluation, per-step approval and single-use consumption happen inside the broker).
   * Throw to refuse; a refusal fails the step, never falls back to an ungranted execution.
   */
  grantFor: (req: MachineRequest, ctx: RunbookStepContext) => Promise<StepGrant>;
  now?: () => Date;
}

/** `RunbookStepExecutor` over the one machine entry point; there is no privileged alternate path. */
export function createMachineStepExecutor(deps: MachineStepExecutorDeps): RunbookStepExecutor {
  return async (req, ctx) => {
    let step: StepGrant;
    try {
      step = await deps.grantFor(req, ctx);
    } catch (cause) {
      throw new MachineOperationError("denied", "no capability grant was issued for this runbook step", { cause });
    }
    // the grant is bound to the broker's operation id, which is the id the machine layer must see
    const effective: MachineRequest = step.claims.op === req.operationId ? req : { ...req, operationId: step.claims.op };
    const exec: MachineExecutionContext = { grant: step.claims, drivers: deps.drivers, sessions: deps.sessionsFor(step.jws, effective, ctx), evidence: deps.evidence, signal: ctx.signal, ...(deps.now ? { now: deps.now } : {}) };
    const settle = async (outcome: "succeeded" | "failed" | "uncertain", code?: string): Promise<void> => {
      try { await step.settle(outcome, { code }); } catch { /* a ledger outage must not mask the machine outcome */ }
    };
    try {
      const result = await executeMachineOperation(effective, exec);
      await settle(result.ok ? "succeeded" : "failed", result.ok ? undefined : "step_failed");
      return result;
    } catch (e) {
      if (isMachineOperationError(e)) await settle(e.code === "uncertain" || e.code === "evidence_failed" ? "uncertain" : "failed", e.code);
      else await settle("failed", "executor_error");
      throw e;
    }
  };
}
