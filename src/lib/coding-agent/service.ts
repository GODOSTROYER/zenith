/**
 * Create, resume, cancel and step bounded coding-agent runs (PROD-MACH-06).
 *
 * Two halves that share nothing but the run store:
 *
 *  - CONTROL (web, routes): `createRun` pins the source to an exact commit,
 *    writes the run row and asks the launcher (Temporal) to start the durable
 *    workflow. It does no model or repository work and returns at once.
 *    `resumeRun` and `cancelRun` are likewise state changes plus a launch or a
 *    cancellation request.
 *  - WORKER (Temporal activities): `executeRunStep` does ONE unit of the loop
 *    (a batch of pending tool calls, or one model turn) from the stored
 *    checkpoint and writes the new checkpoint with compare-and-set. Budgets are
 *    checked before every model or tool call inside the loop. Nothing is held
 *    in memory between steps, so a worker restart resumes from the last
 *    checkpoint.
 *
 * The caller (an authenticated human) supplies identity, scope and budgets;
 * nothing the model or the repository says can change them. A resume re-reads
 * the SAME commit and may raise budgets within the hard ceilings.
 */
import { randomUUID } from "node:crypto";
import type { Broker } from "@/lib/capabilities/platform";
import type { RepoSnapshot } from "@/lib/analysis";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { BudgetError, DEFAULT_AGENT_MODEL, priceFor, raiseLimits, resolveLimits } from "./budget";
import { createBrokerProposalSink } from "./proposal-sink";
import { runAgent, type ProposalSink } from "./runner";
import type { CodingAgentRunRow, RunStore } from "./store";
import type { AgentSourceRef, BudgetLimits, Checkpoint, ModelProvider, RunStatus } from "./types";
import { newCheckpoint } from "./types";

export const TASK_MAX = 2_000;
/** A `running` row untouched this long belongs to a dead worker and can be resumed. */
export const STALE_RUNNING_MS = 10 * 60_000;

export interface SourceRequest {
  workspaceId: string;
  /** `owner/repo` */
  repository: string;
  /** branch, tag or commit; resolved to an exact commit before any byte is read */
  ref: string;
  root?: string;
}

export type SourceReader = <T>(request: SourceRequest, use: (snapshot: RepoSnapshot, ref: AgentSourceRef) => Promise<T>) => Promise<T>;
export type SourceResolver = (request: SourceRequest) => Promise<AgentSourceRef>;

/** The durable execution substrate seen from the web side (production: Temporal). */
export interface RunLauncher {
  start(input: { workspaceId: string; runId: string; workflowId: string }): Promise<void>;
  /** Ask the workflow to stop. Best effort: the run row is the truth. */
  cancel(workflowId: string): Promise<void>;
}

export interface AgentCaller {
  workspaceId: string;
  userId: string;
}

export interface AgentControlDeps {
  store: RunStore;
  resolveSource: SourceResolver;
  launcher: RunLauncher;
  newId?: () => string;
  /** Whether a model is configured for runs. Absent means "assume yes" (tests). */
  modelConfigured?: () => boolean;
}

export interface AgentWorkerDeps {
  store: RunStore;
  provider: () => ModelProvider;
  readSource: SourceReader;
  /** The capability broker. Runs with a target submit their proposal through it. */
  broker?: () => Promise<Pick<Broker, "propose">>;
}

export interface CreateRunRequest {
  task: string;
  source: Omit<SourceRequest, "workspaceId">;
  /** Where the finished proposal is submitted. Without it the run analyses and proposes but submits nothing. */
  target?: { projectId: string; environmentId: string };
  model?: string;
  limits?: Partial<BudgetLimits>;
}

export class AgentServiceError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "invalid_state" | "unavailable" | "model_not_configured", message: string) {
    super(message);
    this.name = "AgentServiceError";
  }
}

/** Thrown by a worker provider factory when no model key is configured. The key is optional for the worker as a whole. */
export class ModelNotConfiguredError extends Error {
  constructor() {
    super("No model key is configured (ANTHROPIC_API_KEY), so coding-agent runs are unavailable.");
    this.name = "ModelNotConfiguredError";
  }
}

const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

function validate(req: CreateRunRequest): { model: string; limits: BudgetLimits } {
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

const firstWorkflowId = (runId: string): string => `car-${runId}`;
const resumeWorkflowId = (runId: string): string => `car-${runId}-${randomUUID().slice(0, 8)}`;

async function launchOrFail(deps: AgentControlDeps, row: CodingAgentRunRow): Promise<void> {
  try {
    await deps.launcher.start({ workspaceId: row.workspaceId, runId: row.id, workflowId: row.workflowId });
  } catch {
    // The run exists and is resumable; say the scheduler was the problem instead of leaving a phantom `running` row.
    await deps.store.fail({ workspaceId: row.workspaceId, id: row.id, stopReason: { kind: "provider_error", detail: "scheduler_unavailable" } }).catch(() => undefined);
    throw new AgentServiceError("unavailable", "The durable workflow engine could not be reached. The run was recorded and can be resumed.");
  }
}

/** Pin the source, record the run and start its workflow. Returns immediately; no model or repository work happens here. */
export async function createRun(deps: AgentControlDeps, caller: AgentCaller, req: CreateRunRequest): Promise<CodingAgentRunRow> {
  const { model, limits } = validate(req);
  if (deps.modelConfigured && !deps.modelConfigured()) throw new AgentServiceError("model_not_configured", "model_not_configured: no model key is configured on this deployment, so coding-agent runs are refused.");
  const ref = await deps.resolveSource({ workspaceId: caller.workspaceId, ...req.source });
  const id = deps.newId?.() ?? `car_${randomUUID()}`;
  const row = await deps.store.create({
    id,
    workspaceId: caller.workspaceId,
    ...(req.target ? { projectId: req.target.projectId, environmentId: req.target.environmentId } : {}),
    createdBy: caller.userId,
    model,
    task: req.task.trim(),
    source: ref,
    limits,
    usage: newCheckpoint().usage,
    checkpoint: newCheckpoint(),
    workflowId: firstWorkflowId(id),
  });
  await launchOrFail(deps, row);
  return row;
}

/** Continue a stopped run from its checkpoint with limits that may only go up. */
export async function resumeRun(deps: AgentControlDeps, caller: AgentCaller, runId: string, options: { limits?: Partial<BudgetLimits> } = {}): Promise<CodingAgentRunRow> {
  const existing = await deps.store.get(caller.workspaceId, runId);
  if (!existing) throw new AgentServiceError("not_found", "Run not found.");
  const crashed = existing.status === "running" && Date.now() - Date.parse(existing.updatedAt) > STALE_RUNNING_MS;
  if (existing.status !== "budget_exhausted" && existing.status !== "failed" && !crashed) throw new AgentServiceError("invalid_state", "Only a stopped run (budget, error or a crashed worker) can be resumed.");
  let limits: BudgetLimits;
  try {
    limits = raiseLimits(existing.limits as BudgetLimits, options.limits);
  } catch (error) {
    if (error instanceof BudgetError) throw new AgentServiceError("invalid_request", error.message);
    throw error;
  }
  const claimed = await deps.store.claimResume({ workspaceId: caller.workspaceId, id: runId, limits, workflowId: resumeWorkflowId(runId) });
  await launchOrFail(deps, claimed);
  return claimed;
}

/** Stop a run for good. The row is cancelled first (so a running worker's next checkpoint write conflicts and it stops), then the workflow is asked to cancel. */
export async function cancelRun(deps: AgentControlDeps, caller: AgentCaller, runId: string): Promise<CodingAgentRunRow> {
  let row: CodingAgentRunRow;
  try {
    row = await deps.store.cancel({ workspaceId: caller.workspaceId, id: runId });
  } catch (error) {
    if (error instanceof ControlStoreError && error.code === "not_found") throw new AgentServiceError("not_found", "Run not found.");
    if (error instanceof ControlStoreError && error.code === "invalid_state") throw new AgentServiceError("invalid_state", "The run already finished.");
    throw error;
  }
  await deps.launcher.cancel(row.workflowId).catch(() => undefined);
  return row;
}

/* --------------------------------- worker half -------------------------------- */

export class RunSuperseded extends Error {
  constructor() {
    super("The run changed under this worker.");
    this.name = "RunSuperseded";
  }
}

export interface StepOptions {
  workspaceId: string;
  runId: string;
  /** Temporal's activity cancellation signal. */
  signal?: AbortSignal;
  /** Called on every checkpoint so the activity can heartbeat. */
  beat?: () => void;
}

/**
 * One unit of work from the stored checkpoint. Returns the run status after the
 * step: `running` means call again. A cancelled or superseded run answers its
 * stored status and does nothing more.
 */
export async function executeRunStep(deps: AgentWorkerDeps, options: StepOptions): Promise<{ status: RunStatus }> {
  const record = await deps.store.get(options.workspaceId, options.runId);
  if (!record) throw new AgentServiceError("not_found", "Run not found.");
  if (record.status !== "running") return { status: record.status };
  const ref = record.source as AgentSourceRef;
  let version = record.version;
  const sink: ProposalSink | undefined =
    record.projectId && record.environmentId && deps.broker
      ? {
          submit: async (artifact, context) =>
            createBrokerProposalSink({
              broker: await deps.broker!(),
              // The creator, re-resolved by the broker against CURRENT workspace membership on every call.
              principal: { kind: "user", id: record.createdBy, name: record.createdBy },
              runId: record.id,
              scope: { workspaceId: record.workspaceId, projectId: record.projectId!, environmentId: record.environmentId! },
            }).submit(artifact, context),
        }
      : undefined;
  // Fail fast and explicitly when there is no model: no repository read, no retry loop, a resumable run.
  try {
    deps.provider();
  } catch (error) {
    if (!(error instanceof ModelNotConfiguredError)) throw error;
    await deps.store.fail({ workspaceId: record.workspaceId, id: record.id, stopReason: { kind: "provider_error", detail: "model_not_configured" } });
    return { status: "failed" };
  }
  try {
    return await deps.readSource({ workspaceId: record.workspaceId, repository: ref.repository, ref: ref.commit, ...(ref.root ? { root: ref.root } : {}) }, async (snapshot, readRef) => {
      // The pinned commit or nothing: a moved ref cannot smuggle different bytes into a resumed run.
      if (readRef.commit !== ref.commit) {
        await deps.store.fail({ workspaceId: record.workspaceId, id: record.id, stopReason: { kind: "provider_error", detail: "source_commit_moved" } });
        return { status: "failed" as RunStatus };
      }
      const outcome = await runAgent({
        task: record.task,
        source: ref,
        snapshot,
        provider: deps.provider(),
        model: record.model,
        limits: record.limits as BudgetLimits,
        checkpoint: record.checkpoint as Checkpoint,
        step: true,
        ...(sink ? { proposals: sink } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onCheckpoint: async (s) => {
          const result = s.status === "completed" ? { artifact: s.checkpoint.artifact ?? null, finalText: s.checkpoint.finalText ?? "", proposalError: s.proposalError ?? null, injectionSignals: s.checkpoint.injectionSignals, unsafeAttempts: s.checkpoint.unsafeAttempts.length } : undefined;
          try {
            const saved = await deps.store.save({
              workspaceId: record.workspaceId,
              id: record.id,
              expectedVersion: version,
              status: s.status,
              ...(s.stopReason ? { stopReason: s.stopReason } : {}),
              limits: s.limits,
              usage: s.checkpoint.usage,
              checkpoint: s.checkpoint,
              ...(result ? { result } : {}),
              ...(s.proposal ? { proposalOperationId: s.proposal.operationId } : {}),
            });
            version = saved.version;
          } catch (error) {
            if (error instanceof ControlStoreError && (error.code === "conflict" || error.code === "not_found")) throw new RunSuperseded();
            throw error;
          }
          options.beat?.();
        },
      });
      return { status: outcome.status };
    });
  } catch (error) {
    if (error instanceof RunSuperseded) {
      // Cancelled (or taken over) while this step ran: report what the row says and stop.
      const now = await deps.store.get(options.workspaceId, options.runId);
      return { status: now?.status ?? "cancelled" };
    }
    throw error;
  }
}

/** The workflow could not drive the run (retries exhausted): leave it failed and resumable, never `running`. */
export async function failRunStep(deps: Pick<AgentWorkerDeps, "store">, workspaceId: string, runId: string, detail: string): Promise<{ status: RunStatus }> {
  const failed = await deps.store.fail({ workspaceId, id: runId, stopReason: { kind: "provider_error", detail: detail.slice(0, 60) } });
  if (failed) return { status: failed.status };
  const row = await deps.store.get(workspaceId, runId);
  return { status: row?.status ?? "failed" };
}
