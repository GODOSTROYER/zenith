/**
 * Orrery deployment engine — durable state machine over the store.
 *
 *   planning → awaiting_approval? → applying → verifying → succeeded
 *                                       ↘ failed → rolling_back → rolled_back
 *
 * All state lives in `db()`. The 250ms ticker on `globalThis` only advances it,
 * one running step per deployment at a time, through the provider adapter. It
 * walks an active-deployment set, so a finished deployment costs nothing and an
 * idle server ticks on an empty set.
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
import { env } from "@/lib/env";
import {
  getProvider,
  registerProvider,
  type ProviderPlanStep,
  type StepRuntime,
} from "@/lib/providers/types";
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
  /** deployments the ticker still has work for; finished ones are dropped */
  __orreryActive?: Set<string>;
  /** abort handle for the provider step each deployment has in flight right now */
  __orreryAborts?: Map<string, AbortController>;
  __orreryProvidersReady?: boolean;
};

const g = () => globalThis as EngineGlobals;

/** Deployments the ticker must look at. Empty = the ticker costs one compare. */
const active = (): Set<string> => (g().__orreryActive ??= new Set());

/**
 * The abort handle of whatever provider call each deployment is inside, so a
 * takeover can tell the adapter to stop instead of only refusing its results.
 */
const aborts = (): Map<string, AbortController> => (g().__orreryAborts ??= new Map());

const TERMINAL: DeploymentStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "rolled_back",
];

const fast = () => env().ORRERY_FAST;
/** Fast mode collapses every estimate to ≤40ms so smoke tests finish instantly. */
const collapse = (ms: number) => (fast() ? Math.min(ms, 40) : ms);

const now = () => new Date().toISOString();

/**
 * How long one provider step may take before the engine stops waiting.
 * Without this a hung adapter pins a deployment in `applying` forever, with no
 * way out. The default and the validation live in `lib/env.ts` with every
 * other ORRERY_* variable.
 */
const stepTimeoutMs = (): number => env().ORRERY_STEP_TIMEOUT_MS;

/**
 * Providers that invent their infrastructure rather than calling one. Used as
 * the fallback when an adapter does not label its own Output — the flag is
 * always present on the wire, so the UI never has to guess.
 * The adapter setting `simulated` on the Output itself always wins.
 */
const SIMULATED_PROVIDERS = new Set<ProviderId>(["sandbox"]);

/** Deployments kept per environment. Older terminal ones are dropped. */
const KEEP_DEPLOYMENTS_PER_ENV = 200;

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
  if (TERMINAL.includes(status)) {
    d.endedAt = now();
    // The lease dies with its holder: an environment is never left leased to a
    // deployment that has finished.
    releaseLease(d);
  }
  // Only "applying"/"verifying" have steps for the ticker to advance.
  if (status === "applying" || status === "verifying") active().add(d.id);
  else active().delete(d.id);
  emit(d.id, { type: "status", status });
  save(d.projectId);
}

function stored(deploymentId: string): StoredDeployment | undefined {
  return q.deployment(deploymentId) as StoredDeployment | undefined;
}

function isTerminal(d: StoredDeployment | undefined): boolean {
  return !d || TERMINAL.includes(d.status);
}

/* ---------------------------- environment lease --------------------------- */

/**
 * One environment, one writer.
 *
 * `Environment.activeDeploymentId` is a durable lease: the deployment that
 * claimed it last is the only one allowed to move `deployedRevisionId` or to
 * keep calling the provider. Without it, a rollback and the deployment it
 * replaced both kept running — `rolling_back` is not a terminal status — and
 * whichever finished last decided what the environment was, which could
 * publish the very revision the operator had just abandoned.
 *
 * Claimed when a deployment starts applying, compared against the deployment's
 * own id before every write, released the moment its holder reaches a terminal
 * status. A lease left behind by a killed process is reconciled on the first
 * touch after a restart (`resumeInFlight`), so an environment is never leased
 * to a ghost.
 */
function claimLease(env: Environment, d: StoredDeployment): void {
  if (env.activeDeploymentId === d.id) return;
  const prior = env.activeDeploymentId ? stored(env.activeDeploymentId) : undefined;
  if (prior) recordSuperseded(prior, d.id);
  env.activeDeploymentId = d.id;
  save(d.projectId);
}

/** True while this deployment is still the environment's writer. */
function holdsLease(d: StoredDeployment): boolean {
  return q.environment(d.environmentId)?.activeDeploymentId === d.id;
}

/** Hand the environment back. Only the holder can, and only once it is done. */
function releaseLease(d: StoredDeployment): void {
  const env = q.environment(d.environmentId);
  if (env?.activeDeploymentId === d.id) delete env.activeDeploymentId;
}

/**
 * May this runner still write? False once it has finished, once it is being
 * rolled back, and — the case the lease exists for — once another deployment
 * has taken the environment. Every write a provider step leads to is behind
 * this check, including the ones that arrive long after the takeover.
 */
function mayCommit(d: StoredDeployment): boolean {
  const cur = stored(d.id);
  if (!cur || TERMINAL.includes(cur.status) || cur.status === "rolling_back") return false;
  return holdsLease(d);
}

/**
 * Take a running deployment off the board: stop the ticker advancing it, abort
 * the provider call it has in flight, skip whatever it never reached, and drop
 * its lease. It keeps its record and its logs — it simply may not write again.
 * The terminal status is the caller's to choose, because a rollback wants
 * `rolling_back` and a plain takeover wants `cancelled`.
 */
function stopRunner(d: StoredDeployment): void {
  active().delete(d.id);
  aborts().get(d.id)?.abort();
  for (const s of d.steps) {
    if (s.status === "pending" || s.status === "running") {
      s.status = "skipped";
      emit(d.id, { type: "step", stepId: s.id, status: "skipped" });
    }
  }
  releaseLease(d);
  save(d.projectId);
}

/**
 * A runner that lost the environment. It stops where it is and says so:
 * finishing quietly as `succeeded` would claim credit for an environment
 * somebody else now owns. One already in `rolling_back` keeps that status —
 * the rollback that displaced it marks it `rolled_back` when it lands.
 */
function recordSuperseded(d: StoredDeployment, byId: string | undefined): void {
  stopRunner(d);
  if (TERMINAL.includes(d.status) || d.status === "rolling_back") return;
  const env = q.environment(d.environmentId);
  if (!env) {
    d.error = MISSING_ENVIRONMENT;
    setStatus(d, "failed");
    return;
  }
  d.error =
    `${byId ? `Deployment ${byId}` : "Another deployment"} took over ${env.name} while this one was still running, ` +
    `so it stopped without publishing r${q.revision(d.revisionId)?.number ?? "?"}. ` +
    `Anything it had already created is still there — open the deployment that replaced it to see what ${env.name} runs now.`;
  setStatus(d, "cancelled");
}

const MISSING_ENVIRONMENT =
  "The environment this deployment targets no longer exists, so nothing was published. " +
  "Re-create it in Settings → Environments, then deploy again.";

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
  const running = active();
  if (running.size === 0) return; // nothing is deploying: the ticker costs nothing
  const inflight = g().__orreryInflight!;
  for (const deploymentId of running) {
    const d = stored(deploymentId);
    if (!d || (d.status !== "applying" && d.status !== "verifying")) {
      running.delete(deploymentId);
      continue;
    }
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
    // One writer per environment. If the lease moved while this step waited
    // its turn, this runner must not call the provider again.
    if (!mayCommit(d)) {
      recordSuperseded(d, env.activeDeploymentId);
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
      save(d.projectId);
    }

    // Deadline: a provider that never returns must not pin the deployment.
    // The adapter is handed the signal so it can abort its own I/O; one that
    // ignores it is simply abandoned, and its late writes are dropped below.
    // The same signal is how a rollback interrupts this step: `stopRunner`
    // aborts whatever handle is registered here.
    const budgetMs = stepTimeoutMs();
    const abort = new AbortController();
    aborts().set(d.id, abort);
    let abandoned = false;
    const timer = setTimeout(() => abort.abort(), budgetMs);

    const runtime: StepRuntime & { signal: AbortSignal } = {
      env,
      revision,
      deployment: d,
      step,
      signal: abort.signal,
      log: (line, stream = "info") => {
        if (!abandoned) emit(d.id, { type: "log", stepId: step.id, line, stream });
      },
      output: (o) => {
        if (abandoned) return;
        const output: Output = {
          ...o,
          simulated: o.simulated ?? SIMULATED_PROVIDERS.has(provider.id),
        };
        d.outputs = [...d.outputs.filter((x) => x.key !== output.key), output];
        emit(d.id, { type: "output", output });
        save(d.projectId);
      },
    };

    try {
      await Promise.race([
        provider.executeStep(runtime),
        deadline(abort.signal, provider.displayName, step.title, budgetMs),
      ]);
    } finally {
      clearTimeout(timer);
      aborts().delete(d.id);
      abandoned = abort.signal.aborted;
    }

    // Cancelled, rolled back or superseded while the step ran. A result nobody
    // is waiting for is not a result to publish.
    if (!mayCommit(d)) {
      recordSuperseded(d, q.environment(d.environmentId)?.activeDeploymentId);
      return;
    }
    step.status = "done";
    step.endedAt = now();
    emit(d.id, { type: "step", stepId: step.id, status: "done" });
    save(d.projectId);
    if (!d.steps.some((s) => s.status === "pending" || s.status === "running"))
      finish(d);
  } catch (err) {
    // A superseded runner's failure is the takeover's doing (its step was
    // aborted), so it is recorded as what it is, not as a provider fault.
    if (!mayCommit(d)) {
      recordSuperseded(d, q.environment(d.environmentId)?.activeDeploymentId);
      return;
    }
    failStep(d, step, err instanceof Error ? err.message : String(err));
  } finally {
    inflight.delete(d.id);
    // Don't idle until the next interval: the 250ms ticker is the safety net,
    // not the pacing. Real pacing comes from the provider's own step duration.
    setTimeout(tick, 0);
  }
}

/** Rejects when the step's budget runs out, naming the provider and the fix. */
function deadline(
  signal: AbortSignal,
  providerName: string,
  stepTitle: string,
  ms: number
): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () =>
        reject(
          new Error(
            `${providerName} did not finish "${stepTitle}" within ${Math.round(ms / 1000)}s, so Orrery stopped waiting. ` +
              `Anything ${providerName} already created is still there — check it for a half-finished resource, then deploy again. ` +
              `If this provider is legitimately slower than that, raise ORRERY_STEP_TIMEOUT_MS (currently ${ms}) and restart the server.`
          )
        ),
      { once: true }
    );
  });
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
  if (!env) {
    d.error = MISSING_ENVIRONMENT;
    setStatus(d, "failed");
    return;
  }
  // Compare and swap on the lease. A superseded runner reaches this line too —
  // the provider call it still had outstanding finally returned — and must not
  // overwrite the deployment that replaced it.
  if (env.activeDeploymentId !== d.id) {
    recordSuperseded(d, env.activeDeploymentId);
    return;
  }
  env.deployedRevisionId = d.revisionId;
  // Record where this revision ran, at the moment it ran. Reconstructing it
  // later by matching environment names is a guess; this is evidence.
  const revision = q.revision(d.revisionId);
  if (revision && !revision.deployedTo?.includes(env.id))
    revision.deployedTo = [...(revision.deployedTo ?? []), env.id];
  setStatus(d, "succeeded"); // terminal: releases the lease
  if (d.rollbackOf) {
    const origin = stored(d.rollbackOf);
    if (origin && !TERMINAL.includes(origin.status)) setStatus(origin, "rolled_back");
  }
  save(d.projectId);
}

/**
 * Retention: a deployment record is a step list plus a log of what happened,
 * and the whole database is re-serialized on every save. Keep the last 200 per
 * environment (the Deploys page pages far below that) and drop older finished
 * ones. A deployment that has not finished is never dropped, whatever its age.
 * The event log is append-only and untouched — history stays on disk.
 */
function pruneDeployments(environmentId: string): void {
  const all = db().deployments;
  const mine = all.filter((d) => d.environmentId === environmentId);
  if (mine.length <= KEEP_DEPLOYMENTS_PER_ENV) return;
  const doomed = new Set(
    mine
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(KEEP_DEPLOYMENTS_PER_ENV)
      .filter((d) => TERMINAL.includes(d.status))
      .map((d) => d.id)
  );
  if (doomed.size) db().deployments = all.filter((d) => !doomed.has(d.id));
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

  // Planning is the provider's code too, and it can throw (the Planned
  // adapters do). Fail here, before any record exists, with a message that
  // names the provider and the way out.
  let plan: ProviderPlanStep[];
  try {
    plan = provider.planSteps(env, revision.manifest, previous?.manifest);
  } catch (err) {
    throw new Error(
      `${provider.displayName} could not plan a deployment for ${env.name}: ${err instanceof Error ? err.message : String(err)} ` +
        `Point ${env.name} at a Sandbox connection in Settings → Environments to deploy now, or at AWS to export runnable Terraform.`
    );
  }

  const actor: Actor = {
    type: input.actorType,
    // The caller's real id. "you" was fine for one local demo user and wrong
    // the moment a second person signs in — a deployment has to say who ran it.
    id: input.actorType === "navigator" ? "navigator" : input.actorId,
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
  pruneDeployments(env.id);
  save(d.projectId);
  emit(d.id, { type: "status", status: "planning" });

  if (!input.approved && env.policies.approvalRequired) {
    // Nothing is in flight yet, so it takes no lease: a deployment parked at
    // the approval gate must not stop the environment being deployed to.
    setStatus(d, "awaiting_approval");
  } else {
    d.startedAt = now();
    claimLease(env, d); // from here on, this deployment owns the environment
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
  // Approval is where a gated deployment actually starts, so the lease is
  // claimed here rather than when it was parked.
  const env = q.environment(d.environmentId);
  if (env) claimLease(env, d);
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
  // Aborts the step it is inside, skips the rest and gives the environment
  // back, so a late provider callback cannot publish a cancelled deployment.
  stopRunner(d);
  setStatus(d, "cancelled");
  return d;
}

async function rollback(
  environmentId: string,
  toRevisionId?: string,
  actor: { id: string; name: string } = { id: "local", name: "You" }
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
    // An in-flight deployment is aborted and taken off the board *before* the
    // replacement starts, not merely relabelled: `rolling_back` is not a
    // terminal status, so without this its runner kept going and the two of
    // them raced to commit the environment. `stopRunner` aborts the provider
    // call it is inside, skips its remaining steps, drops it from the ticker's
    // active set and releases its lease — so whatever it does return is
    // refused by the compare-and-swap in `finish`.
    stopRunner(last);
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
    actorName: actor.name,
    actorId: actor.id,
    actorType: "user",
    // A rollback is a deployment. An environment that gates deploys gates this
    // one too — an approval policy that a rollback can walk around is not a
    // policy. It waits at awaiting_approval exactly like start() does.
    approved: !env.policies.approvalRequired,
  })) as StoredDeployment;

  if (last) {
    d.rollbackOf = last.id;
    save(d.projectId);
  }
  return d;
}

/**
 * Called on the first server touch after a restart. Deployments stuck mid-step
 * are simply left `running` — the ticker re-executes that step, and provider
 * steps are idempotent. `planning` / `awaiting_approval` need no repair.
 *
 * Leases are reconciled first. A killed process leaves `activeDeploymentId`
 * pointing at a runner that no longer exists, and a lease nobody can release
 * would lock that environment out of deploying forever. So: a lease naming a
 * deployment that has finished, or that is no longer in the store at all, is
 * dropped, and a deployment that really is still mid-flight takes the lease
 * back. The environment ends up leased to the one runner about to resume, or
 * to nobody.
 */
function resumeInFlight(): void {
  ensureEngine();
  let dirty = false;

  for (const env of db().environments) {
    if (!env.activeDeploymentId) continue;
    const holder = stored(env.activeDeploymentId);
    // Gone, or finished without ever releasing it: the lease is stale.
    if (isTerminal(holder)) {
      delete env.activeDeploymentId;
      dirty = true;
    }
  }

  for (const raw of db().deployments) {
    const d = raw as StoredDeployment;
    if (d.status !== "applying" && d.status !== "verifying") continue;
    const env = q.environment(d.environmentId);
    if (env && !env.activeDeploymentId) {
      // Nothing holds the environment and this deployment is still running it:
      // it is the rightful holder (also the migration path for deployments
      // that predate the lease).
      env.activeDeploymentId = d.id;
      dirty = true;
    }
    if (env && env.activeDeploymentId !== d.id) {
      // Two runners for one environment across a restart. The lease decides,
      // exactly as it does at runtime.
      recordSuperseded(d, env.activeDeploymentId);
      continue;
    }
    active().add(d.id); // the only full scan: once, at boot
    const running = d.steps.find((s) => s.status === "running");
    if (running)
      emit(d.id, {
        type: "log",
        stepId: running.id,
        line: `Server restarted while "${running.title}" was in flight — re-running it.`,
        stream: "info",
      });
  }
  if (dirty) save();
}

export const engine: EngineApi = {
  start,
  approve,
  cancel,
  rollback,
  resumeInFlight,
};
