/**
 * Start and resume bounded coding-agent runs (PROD-MACH-06).
 *
 * This is the one place the pieces meet: a source reader (the workspace's
 * bound GitHub repository or a public one, pinned to an exact commit), the
 * budgeted loop, durable checkpoints, and the capability broker as the only
 * exit for model output. The caller (an authenticated human in the browser)
 * supplies identity, scope and budgets; nothing the model or the repository
 * says can change them.
 *
 * A resume re-reads the SAME commit (never a moving ref), may raise budgets
 * within the hard ceilings, and continues from the stored checkpoint.
 */
import { randomUUID } from "node:crypto";
import type { Broker } from "@/lib/capabilities/platform";
import type { Principal } from "@/lib/controlplane/types";
import type { RepoSnapshot } from "@/lib/analysis";
import { BudgetError, DEFAULT_AGENT_MODEL, priceFor, raiseLimits, resolveLimits } from "./budget";
import { createBrokerProposalSink } from "./proposal-sink";
import { runAgent, type RunOutcome } from "./runner";
import type { CodingAgentRunRow, RunStore } from "./store";
import type { AgentSourceRef, BudgetLimits, Checkpoint, ModelProvider } from "./types";
import { newCheckpoint } from "./types";

export const TASK_MAX = 2_000;

export interface SourceRequest {
  workspaceId: string;
  /** `owner/repo` */
  repository: string;
  /** branch, tag or commit; resolved to an exact commit before any byte is read */
  ref: string;
  root?: string;
}

export type SourceReader = <T>(request: SourceRequest, use: (snapshot: RepoSnapshot, ref: AgentSourceRef) => Promise<T>) => Promise<T>;

export interface AgentCaller {
  workspaceId: string;
  userId: string;
  principal: Principal;
}

export interface AgentServiceDeps {
  store: RunStore;
  provider: ModelProvider;
  readSource: SourceReader;
  /** The capability broker. Required only for runs that name a target. */
  broker?: () => Promise<Pick<Broker, "propose">>;
  newId?: () => string;
}

export interface StartRunRequest {
  task: string;
  source: Omit<SourceRequest, "workspaceId">;
  /** Where the finished proposal is submitted. Without it the run analyses and proposes but submits nothing. */
  target?: { projectId: string; environmentId: string };
  model?: string;
  limits?: Partial<BudgetLimits>;
  signal?: AbortSignal;
}

export class AgentServiceError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "invalid_state" | "unavailable", message: string) {
    super(message);
    this.name = "AgentServiceError";
  }
}

export interface RunResult {
  run: CodingAgentRunRow;
  outcome: RunOutcome;
}

const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

function validate(req: StartRunRequest): { model: string; limits: BudgetLimits } {
  if (typeof req.task !== "string" || req.task.trim().length === 0 || req.task.length > TASK_MAX) throw new AgentServiceError("invalid_request", `The task must be 1 to ${TASK_MAX} characters.`);
  if (!SAFE_REPO.test(req.source.repository)) throw new AgentServiceError("invalid_request", "The repository must be owner/name.");
  const model = req.model ?? DEFAULT_AGENT_MODEL;
  try {
    priceFor(model);
    return { model, limits: resolveLimits(req.limits) };
  } catch (error) {
    if (error instanceof BudgetError) throw new AgentServiceError("invalid_request", error.message);
    throw error;
  }
}

async function drive(deps: AgentServiceDeps, caller: AgentCaller, record: CodingAgentRunRow, snapshot: RepoSnapshot, ref: AgentSourceRef, signal?: AbortSignal): Promise<RunResult> {
  let version = record.version;
  const broker = deps.broker;
  const sink =
    record.projectId && record.environmentId && broker
      ? { submit: async (...a: Parameters<ReturnType<typeof createBrokerProposalSink>["submit"]>) => createBrokerProposalSink({ broker: await broker(), principal: caller.principal, runId: record.id, scope: { workspaceId: record.workspaceId, projectId: record.projectId!, environmentId: record.environmentId! } }).submit(...a) }
      : undefined;
  const outcome = await runAgent({
    task: record.task,
    source: ref,
    snapshot,
    provider: deps.provider,
    model: record.model,
    limits: record.limits as BudgetLimits,
    checkpoint: record.checkpoint as Checkpoint,
    ...(sink ? { proposals: sink } : {}),
    ...(signal ? { signal } : {}),
    onCheckpoint: async (s) => {
      const saved = await deps.store.save({ workspaceId: record.workspaceId, id: record.id, expectedVersion: version, status: s.status, ...(s.stopReason ? { stopReason: s.stopReason } : {}), limits: s.limits, usage: s.checkpoint.usage, checkpoint: s.checkpoint });
      version = saved.version;
    },
  });
  const result =
    outcome.status === "completed"
      ? { artifact: outcome.checkpoint.artifact ?? null, finalText: outcome.checkpoint.finalText ?? "", proposalError: outcome.proposalError ?? null, injectionSignals: outcome.checkpoint.injectionSignals, unsafeAttempts: outcome.checkpoint.unsafeAttempts.length }
      : undefined;
  const run = await deps.store.attachOutcome({ workspaceId: record.workspaceId, id: record.id, ...(result ? { result } : {}), ...(outcome.proposal ? { proposalOperationId: outcome.proposal.operationId } : {}) });
  return { run, outcome };
}

export async function startRun(deps: AgentServiceDeps, caller: AgentCaller, req: StartRunRequest): Promise<RunResult> {
  const { model, limits } = validate(req);
  if (req.target && !deps.broker) throw new AgentServiceError("unavailable", "A proposal target needs the capability broker.");
  return deps.readSource({ workspaceId: caller.workspaceId, ...req.source }, async (snapshot, ref) => {
    const record = await deps.store.create({
      id: deps.newId?.() ?? `car_${randomUUID()}`,
      workspaceId: caller.workspaceId,
      ...(req.target ? { projectId: req.target.projectId, environmentId: req.target.environmentId } : {}),
      createdBy: caller.userId,
      model,
      task: req.task.trim(),
      source: ref,
      limits,
      usage: newCheckpoint().usage,
      checkpoint: newCheckpoint(),
    });
    return drive(deps, caller, record, snapshot, ref, req.signal);
  });
}

export async function resumeRun(deps: AgentServiceDeps, caller: AgentCaller, runId: string, options: { limits?: Partial<BudgetLimits>; signal?: AbortSignal } = {}): Promise<RunResult> {
  const existing = await deps.store.get(caller.workspaceId, runId);
  if (!existing) throw new AgentServiceError("not_found", "Run not found.");
  const crashed = existing.status === "running" && Date.now() - Date.parse(existing.updatedAt) > 10 * 60_000;
  if (existing.status !== "budget_exhausted" && existing.status !== "failed" && !crashed) throw new AgentServiceError("invalid_state", "Only a stopped run (budget, error or a crashed worker) can be resumed.");
  const ref = existing.source as AgentSourceRef;
  let limits: BudgetLimits;
  try {
    limits = raiseLimits(existing.limits as BudgetLimits, options.limits);
  } catch (error) {
    if (error instanceof BudgetError) throw new AgentServiceError("invalid_request", error.message);
    throw error;
  }
  const claimed = await deps.store.claimResume({ workspaceId: caller.workspaceId, id: runId, limits });
  let entered = false;
  try {
    return await deps.readSource({ workspaceId: caller.workspaceId, repository: ref.repository, ref: ref.commit, ...(ref.root ? { root: ref.root } : {}) }, (snapshot, readRef) => {
      entered = true;
      // The same commit or nothing: a moved ref cannot smuggle different bytes into a resumed run.
      if (readRef.commit !== ref.commit) throw new AgentServiceError("invalid_state", "The source no longer matches the run's commit.");
      return drive(deps, caller, claimed, snapshot, ref, options.signal);
    });
  } catch (error) {
    // The claim moved the row to running; if the loop never started, put it back so it can be resumed again.
    if (!entered || error instanceof AgentServiceError) {
      await deps.store
        .save({ workspaceId: caller.workspaceId, id: runId, expectedVersion: claimed.version, status: "failed", stopReason: { kind: "provider_error", detail: "source_unavailable" }, limits, usage: claimed.usage, checkpoint: claimed.checkpoint })
        .catch(() => undefined);
    }
    throw error;
  }
}
