/**
 * Orrery deployment engine — durable state machine over the store.
 *
 *   planning → awaiting_approval? → applying → verifying → succeeded
 *                                       ↘ failed → rolling_back → rolled_back
 *
 * All state lives in `db()`. The 250ms ticker on `globalThis` only advances it,
 * one running step per deployment at a time, through the provider adapter.
 * Every transition is appended to the JSONL event log with a per-deployment
 * monotonic `seq`, so SSE clients replay from any cursor after a refresh.
 *
 * Workstream A. Import `engine` (EngineApi) and `ensureEngine()`.
 */
import {
  appendEvent,
  db,
  q,
  readEvents,
  save,
} from "@/lib/db/store";
import {
  id,
  type Actor,
  type Deployment,
  type DeploymentEvent,
  type DeploymentStatus,
  type DeploymentStep,
  type Environment,
  type Output,
  type ProviderId,
  type StepStatus,
} from "@/lib/domain/types";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { getProvider, registerProvider } from "@/lib/providers/types";
import type { EngineApi, StartDeploymentInput } from "@/lib/engine/types";
import { sandboxProvider } from "@/lib/providers/sandbox";
import { localstackProvider } from "@/lib/providers/localstack";
import { awsProvider } from "@/lib/providers/aws";
import { plannedProviders } from "@/lib/providers/planned";

/* ------------------------------ stored shape ------------------------------ */

/**
 * Private engine bookkeeping persisted alongside the deployment so a restart
 * can resume exactly where it left off. Not part of the public Deployment
 * contract; nothing outside the engine reads these.
 */
type StoredDeployment = Deployment & {
  /** collapsed (fast-mode aware) duration budget per step id */
  estMs?: Record<string, number>;
  /** deployment this one rolls back, marked rolled_back on success */
  rollbackOf?: string;
};

type EventBody =
  | { type: "status"; status: DeploymentStatus }
  | { type: "step"; stepId: string; status: StepStatus; error?: string }
  | { type: "log"; stepId: string; line: string; stream: "info" | "provider" }
  | { type: "output"; output: Output };

type EngineGlobals = typeof globalThis & {
  __orreryTicker?: ReturnType<typeof setInterval>;
  __orrerySeq?: Map<string, number>;
  __orreryInflight?: Set<string>;
  __orreryProvidersReady?: boolean;
};

const g = () => globalThis as EngineGlobals;

const TERMINAL: DeploymentStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "rolled_back",
];

const fast = () => process.env.ORRERY_FAST === "1";
/** Fast mode collapses every estimate to ≤40ms so smoke tests finish instantly. */
const collapse = (ms: number) => (fast() ? Math.min(ms, 40) : ms);

const now = () => new Date().toISOString();

/* ------------------------------ event stream ------------------------------ */

function seqFor(deploymentId: string): number {
  const gl = g();
  if (!gl.__orrerySeq) gl.__orrerySeq = new Map();
  let next = gl.__orrerySeq.get(deploymentId);
  if (next === undefined) {
    // Resume: continue after whatever is already on disk.
    const prior = readEvents(deploymentId);
    next = prior.reduce((m, e) => Math.max(m, e.seq + 1), 0);
  }
  gl.__orrerySeq.set(deploymentId, next + 1);
  return next;
}

function emit(deploymentId: string, body: EventBody): void {
  appendEvent({
    ts: now(),
    deploymentId,
    seq: seqFor(deploymentId),
    ...body,
  } as DeploymentEvent);
}

/* -------------------------------- helpers -------------------------------- */

function providerIdFor(env: Environment): ProviderId {
  return q.connection(env.connectionId)?.provider ?? "sandbox";
}

function setStatus(d: StoredDeployment, status: DeploymentStatus): void {
  d.status = status;
  if (TERMINAL.includes(status)) d.endedAt = now();
  emit(d.id, { type: "status", status });
  save();
}

function stored(deploymentId: string): StoredDeployment | undefined {
  return q.deployment(deploymentId) as StoredDeployment | undefined;
}

function isTerminal(d: StoredDeployment | undefined): boolean {
  return !d || TERMINAL.includes(d.status);
}

/* ------------------------------ provider setup ---------------------------- */

/**
 * Register every provider adapter and start the ticker. Idempotent — API
 * routes, actions and tests all call it on first touch.
 */
export function ensureEngine(): void {
  const gl = g();
  if (!gl.__orreryProvidersReady) {
    registerProvider(sandboxProvider);
    registerProvider(localstackProvider);
    registerProvider(awsProvider);
    for (const p of plannedProviders) registerProvider(p);
    gl.__orreryProvidersReady = true;
  }
  if (!gl.__orreryInflight) gl.__orreryInflight = new Set();
  if (!gl.__orreryTicker) {
    gl.__orreryTicker = setInterval(tick, 250);
    // Never hold the process open just to tick (matters for tests + scripts).
    (gl.__orreryTicker as { unref?: () => void }).unref?.();
  }
}

/* --------------------------------- ticker --------------------------------- */

function tick(): void {
  const inflight = g().__orreryInflight!;
  for (const raw of db().deployments) {
    const d = raw as StoredDeployment;
    if (d.status !== "applying" && d.status !== "verifying") continue;
    if (inflight.has(d.id)) continue;
    const step = d.steps.find(
      (s) => s.status === "pending" || s.status === "running"
    );
    if (!step) {
      finish(d);
      continue;
    }
    void runStep(d, step);
  }
}

async function runStep(d: StoredDeployment, step: DeploymentStep): Promise<void> {
  const inflight = g().__orreryInflight!;
  inflight.add(d.id);
  try {
    const env = q.environment(d.environmentId);
    const revision = q.revision(d.revisionId);
    if (!env || !revision) {
      failStep(
        d,
        step,
        "The environment or revision this deployment targets no longer exists. Re-create it, then deploy again."
      );
      return;
    }
    const provider = getProvider(providerIdFor(env));

    const phaseStatus: DeploymentStatus =
      step.phase === "verify" ? "verifying" : "applying";
    if (d.status !== phaseStatus) setStatus(d, phaseStatus);

    if (step.status === "running") {
      // Orphaned by a restart. Provider steps are idempotent — run it again.
      emit(d.id, {
        type: "log",
        stepId: step.id,
        line: "Resuming this step after a restart (provider steps are idempotent).",
        stream: "info",
      });
    } else {
      step.status = "running";
      step.startedAt = now();
      emit(d.id, { type: "step", stepId: step.id, status: "running" });
      save();
    }

    await provider.executeStep({
      env,
      revision,
      deployment: d,
      step,
      log: (line, stream = "info") =>
        emit(d.id, { type: "log", stepId: step.id, line, stream }),
      output: (o) => {
        d.outputs = [...d.outputs.filter((x) => x.key !== o.key), o];
        emit(d.id, { type: "output", output: o });
        save();
      },
    });

    if (isTerminal(stored(d.id))) return; // cancelled while the step ran
    step.status = "done";
    step.endedAt = now();
    emit(d.id, { type: "step", stepId: step.id, status: "done" });
    save();
    if (!d.steps.some((s) => s.status === "pending" || s.status === "running"))
      finish(d);
  } catch (err) {
    if (isTerminal(stored(d.id))) return;
    failStep(d, step, err instanceof Error ? err.message : String(err));
  } finally {
    inflight.delete(d.id);
    // Don't idle until the next interval: the 250ms ticker is the safety net,
    // not the pacing. Real pacing comes from the provider's own step duration.
    setTimeout(tick, 0);
  }
}

function failStep(d: StoredDeployment, step: DeploymentStep, message: string): void {
  step.status = "failed";
  step.endedAt = now();
  step.error = message;
  emit(d.id, { type: "step", stepId: step.id, status: "failed", error: message });
  for (const s of d.steps) {
    if (s.status === "pending") {
      s.status = "skipped";
      emit(d.id, { type: "step", stepId: s.id, status: "skipped" });
    }
  }
  d.error = message;
  setStatus(d, "failed");
  // A rollback deployment that fails leaves its target where it was.
  if (d.rollbackOf) {
    const origin = stored(d.rollbackOf);
    if (origin && origin.status === "rolling_back") setStatus(origin, "failed");
  }
}

function finish(d: StoredDeployment): void {
  const env = q.environment(d.environmentId);
  if (env) {
    env.deployedRevisionId = d.revisionId;
  }
  setStatus(d, "succeeded");
  if (d.rollbackOf) {
    const origin = stored(d.rollbackOf);
    if (origin && !TERMINAL.includes(origin.status)) setStatus(origin, "rolled_back");
  }
  save();
}

/* ------------------------------- engine api ------------------------------- */

async function start(input: StartDeploymentInput): Promise<Deployment> {
  ensureEngine();
  const env = q.environment(input.environmentId);
  if (!env)
    throw new Error(
      `Environment "${input.environmentId}" no longer exists. Create it in Settings → Environments, then deploy again.`
    );
  const revision = q.revision(input.revisionId);
  if (!revision)
    throw new Error(
      `Revision "${input.revisionId}" no longer exists. Pick a revision from the Revisions page and deploy that.`
    );

  const previous = env.deployedRevisionId
    ? q.revision(env.deployedRevisionId)
    : undefined;
  const provider = getProvider(providerIdFor(env));
  const plan = provider.planSteps(env, revision.manifest, previous?.manifest);

  const actor: Actor = {
    type: input.actorType,
    id: input.actorType === "navigator" ? "navigator" : "you",
    name: input.actorName,
  };

  const createdAt = now();
  const d: StoredDeployment = {
    id: id(),
    projectId: input.projectId,
    environmentId: input.environmentId,
    revisionId: input.revisionId,
    status: "planning",
    steps: plan.map((p, i) => ({
      id: `s${i}`,
      seq: i,
      phase: p.phase,
      title: p.title,
      targetId: p.targetId,
      status: "pending" as StepStatus,
      detail: p.detail,
    })),
    outputs: [],
    changeSummary: input.changeSummary,
    estCostDeltaUsd: input.estCostDeltaUsd,
    actor,
    createdAt,
    previousRevisionId: env.deployedRevisionId,
    estMs: Object.fromEntries(plan.map((p, i) => [`s${i}`, collapse(p.estMs)])),
  };

  db().deployments.push(d);
  save();
  emit(d.id, { type: "status", status: "planning" });

  if (!input.approved && env.policies.approvalRequired) {
    setStatus(d, "awaiting_approval");
  } else {
    d.startedAt = now();
    setStatus(d, "applying");
  }
  return d;
}

async function approve(deploymentId: string): Promise<Deployment> {
  ensureEngine();
  const d = stored(deploymentId);
  if (!d)
    throw new Error(
      `Deployment "${deploymentId}" was not found. Open the Deploys page and pick a deployment from the list.`
    );
  if (d.status !== "awaiting_approval")
    throw new Error(
      `This deployment is ${d.status}, not awaiting approval. Start a new deployment from the Changes drawer instead.`
    );
  d.startedAt = d.startedAt ?? now();
  setStatus(d, "applying");
  return d;
}

async function cancel(deploymentId: string): Promise<Deployment> {
  ensureEngine();
  const d = stored(deploymentId);
  if (!d)
    throw new Error(
      `Deployment "${deploymentId}" was not found. Open the Deploys page and pick a deployment from the list.`
    );
  if (TERMINAL.includes(d.status))
    throw new Error(
      `This deployment already finished as ${d.status}; there is nothing to cancel. Deploy again to change the environment.`
    );
  for (const s of d.steps) {
    if (s.status === "pending" || s.status === "running") {
      s.status = "skipped";
      emit(d.id, { type: "step", stepId: s.id, status: "skipped" });
    }
  }
  setStatus(d, "cancelled");
  return d;
}

async function rollback(
  environmentId: string,
  toRevisionId?: string,
  actorName = "you"
): Promise<Deployment> {
  ensureEngine();
  const env = q.environment(environmentId);
  if (!env)
    throw new Error(
      `Environment "${environmentId}" no longer exists. Create it in Settings → Environments, then deploy again.`
    );

  const history = q.deploymentsOf(environmentId) as StoredDeployment[];
  const last = history[0];
  const targetId = toRevisionId ?? last?.previousRevisionId;
  if (!targetId)
    throw new Error(
      `${env.name} has no earlier revision to roll back to. Deploy at least one more revision, or pick a specific revision on the Revisions page.`
    );

  const target = q.revision(targetId);
  if (!target)
    throw new Error(
      `Revision "${targetId}" no longer exists. Pick another revision on the Revisions page.`
    );

  const current = env.deployedRevisionId
    ? q.revision(env.deployedRevisionId)
    : undefined;
  const costDelta =
    Math.round(
      (monthlyCostUsd(target.manifest) -
        (current ? monthlyCostUsd(current.manifest) : 0)) *
        100
    ) / 100;

  if (last && !TERMINAL.includes(last.status)) {
    // in-flight deployment: stop it before replacing it
    for (const s of last.steps)
      if (s.status === "pending" || s.status === "running") s.status = "skipped";
    setStatus(last, "rolling_back");
  } else if (last && (last.status === "failed" || last.status === "succeeded")) {
    setStatus(last, "rolling_back");
  }

  const d = (await start({
    projectId: env.projectId,
    environmentId,
    revisionId: target.id,
    changeSummary: `Roll back to r${target.number}`,
    estCostDeltaUsd: costDelta,
    actorName,
    actorType: "user",
    approved: true,
  })) as StoredDeployment;

  if (last) {
    d.rollbackOf = last.id;
    save();
  }
  return d;
}

/**
 * Called on the first server touch after a restart. Deployments stuck mid-step
 * are simply left `running` — the ticker re-executes that step, and provider
 * steps are idempotent. `planning` / `awaiting_approval` need no repair.
 */
function resumeInFlight(): void {
  ensureEngine();
  for (const raw of db().deployments) {
    const d = raw as StoredDeployment;
    if (d.status !== "applying" && d.status !== "verifying") continue;
    const running = d.steps.find((s) => s.status === "running");
    if (running)
      emit(d.id, {
        type: "log",
        stepId: running.id,
        line: `Server restarted while "${running.title}" was in flight — re-running it.`,
        stream: "info",
      });
  }
}

export const engine: EngineApi = {
  start,
  approve,
  cancel,
  rollback,
  resumeInFlight,
};
