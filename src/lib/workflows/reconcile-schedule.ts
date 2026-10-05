/** Server-only durable scheduling. No imports of workflow implementations. */
import { createHash, randomUUID } from "node:crypto";
import { Context, ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import { ScheduleAlreadyRunning, ScheduleNotFoundError, ScheduleOverlapPolicy, type Client, type ScheduleDescription, type ScheduleHandle, type ScheduleOptions } from "@temporalio/client";
import { defineSearchAttributeKey, SearchAttributeType } from "@temporalio/common";
import { assertPlatformSchemaCurrent, type PlatformDbHandle } from "@/lib/controlplane/db";
import { withLease, LeaseUnavailableError } from "@/lib/controlplane/leases";
import type { Sql } from "@/lib/controlplane/types";
import { createBroker, isMemoryStoreEnabled, type Broker } from "@/lib/capabilities/platform";
import { PlatformBrokerStore } from "@/lib/capabilities/platform-store";
import { currentProductRoleResolver } from "@/lib/capabilities/current-product-roles";
import { systemClock } from "@/lib/capabilities/ports";
import { CredentialGrantSigner } from "@/lib/capabilities/credential-signer";
import { loadPolicyEngine } from "@/lib/policy";
import { platformCredentialBroker } from "@/lib/platform/credentials";
import { composeReconcilePorts } from "@/lib/platform/reconcile";
import { platformScopeResolver } from "@/lib/platform/scopes";
import { reconcilePass } from "@/lib/reconcile/pass";
import type { ReconcilePassPorts, ReconcilePassResult } from "@/lib/reconcile/pass-types";
import { composeOptimizerPorts } from "@/lib/platform/optimizer";
import { runOptimizerPass, type OptimizerPassPorts } from "@/lib/platform/optimizer-pass";
import { recordLeasedRun } from "@/lib/platform/critical-jobs";
import { TASK_QUEUE } from "./types";
import type { ReconcileSweepActivities, ReconcileSweepActivityInput, ReconcileSweepInput, ReconcileSweepResult } from "./definitions/reconcileSweep";

export const RECONCILE_SCHEDULE_ID = "zenith-reconcile-sweep-v1";
export const RECONCILE_SWEEP_TYPE = "reconcileSweepWorkflow";
export const RECONCILE_SWEEP_CONTRACT = "zenith.reconcile-sweep.v1";
// Disjoint from every per-environment `reconcile:<environmentId>` scope.
export const RECONCILE_SWEEP_LEASE = "reconcile-sweep:v1";
export const RECONCILE_SCHEDULE_OWNER = defineSearchAttributeKey("ZenithScheduleOwner", SearchAttributeType.KEYWORD);
const CADENCE_MS = 60_000;
const CREATE_NOTE = "Zenith reconciliation awaiting verified prerequisites.";
const ACTIVE_NOTE = "Zenith durable reconciliation active.";
const RPC_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNT_KEYS = ["claimed", "reconciled", "nothingToReconcile", "busy", "ineligible", "failed", "deferred", "nudged", "driftDetected", "driftCleared", "openFindings", "unreadNodes", "repairsProposed", "repairsStarted", "repairsAwaitingApproval", "repairsDenied", "ms"] as const;

export class ReconcileScheduleError extends Error {
  constructor(readonly code: "prerequisites_unavailable" | "incompatible_schedule" | "transport_unconfirmed" | "invalid_configuration") {
    super({ prerequisites_unavailable: "Durable reconciliation prerequisites are unavailable.", incompatible_schedule: "The existing reconciliation schedule is incompatible; operator review is required.", transport_unconfirmed: "The reconciliation schedule response is unconfirmed; inspect its fixed identity before retrying.", invalid_configuration: "Durable reconciliation configuration is invalid." }[code]);
    this.name = "ReconcileScheduleError";
  }
}

/** Exact scalar boundary. Accessors, extra fields and coercion never enter history. */
export function reconcileSweepInput(input: unknown = { contract: RECONCILE_SWEEP_CONTRACT, maxEnvironments: 25, environmentConcurrency: 3 }): ReconcileSweepInput {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 3) throw new ReconcileScheduleError("invalid_configuration");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (!["contract", "maxEnvironments", "environmentConcurrency"].every((key) => descriptors[key] && "value" in descriptors[key])) throw new ReconcileScheduleError("invalid_configuration");
  const { contract, maxEnvironments, environmentConcurrency } = Object.fromEntries(Object.entries(descriptors).map(([key, desc]) => [key, desc.value]));
  if (contract !== RECONCILE_SWEEP_CONTRACT || !Number.isInteger(maxEnvironments) || maxEnvironments < 1 || maxEnvironments > 25 || !Number.isInteger(environmentConcurrency) || environmentConcurrency < 1 || environmentConcurrency > 3) throw new ReconcileScheduleError("invalid_configuration");
  return Object.freeze({ contract: RECONCILE_SWEEP_CONTRACT, maxEnvironments, environmentConcurrency });
}

function configDigest(input: ReconcileSweepInput): string {
  return createHash("sha256").update(JSON.stringify([input.contract, input.maxEnvironments, input.environmentConcurrency])).digest("hex");
}
function memo(input: ReconcileSweepInput): Record<string, unknown> {
  return { zenithOwner: "zenith", zenithContract: RECONCILE_SWEEP_CONTRACT, zenithConfigSha256: configDigest(input) };
}
export function reconcileScheduleOptions(input?: unknown): ScheduleOptions {
  const args = reconcileSweepInput(input);
  return {
    scheduleId: RECONCILE_SCHEDULE_ID,
    spec: { intervals: [{ every: CADENCE_MS, offset: 0 }], timezone: "UTC" },
    action: { type: "startWorkflow", workflowType: RECONCILE_SWEEP_TYPE, workflowId: RECONCILE_SCHEDULE_ID, taskQueue: TASK_QUEUE, args: [args], workflowExecutionTimeout: 180_000, workflowRunTimeout: 180_000, workflowTaskTimeout: 10_000, retry: { maximumAttempts: 1 } },
    policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: CADENCE_MS, pauseOnFailure: false },
    memo: memo(args),
    typedSearchAttributes: [{ key: RECONCILE_SCHEDULE_OWNER, value: RECONCILE_SWEEP_CONTRACT }],
    state: { paused: true, note: CREATE_NOTE },
  };
}

const empty = (value: unknown): boolean => value === undefined || value === null || (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value).length === 0);
/** SDK 1.24 decodes absent priority into three undefined fields. No routing override. */
function noPriorityOverride(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !["priorityKey", "fairnessKey", "fairnessWeight"].includes(key) || !("value" in descriptors[key]))) return false;
  const fields = value as Record<string, unknown>;
  return [undefined, null, 0].includes(fields.priorityKey as undefined | null | number)
    && [undefined, null, ""].includes(fields.fairnessKey as undefined | null | string)
    && [undefined, null, 0, 1].includes(fields.fairnessWeight as undefined | null | number);
}
function sameMemo(actual: Record<string, unknown> | undefined, expected: Record<string, unknown>): boolean {
  return !!actual && Object.keys(actual).sort().join(",") === Object.keys(expected).sort().join(",") && Object.keys(expected).every((key) => actual[key] === expected[key]);
}
/** No override selection; tolerate protobuf's absent/null and inert scalar defaults. */
function noVersioningOverride(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !["behavior", "deployment", "pinnedVersion", "pinned", "autoUpgrade", "oneTime", "override"].includes(key))) return false;
  // A oneof selection has routing meaning even if its scalar value is false.
  return [undefined, null, 0].includes(fields.behavior as undefined | null | number)
    && [undefined, null, ""].includes(fields.pinnedVersion as undefined | null | string)
    && ["deployment", "pinned", "autoUpgrade", "oneTime", "override"].every((key) => fields[key] === undefined || fields[key] === null);
}
/** State.paused/note are operator state, never reconciled away during adoption. */
export function assertCompatibleReconcileSchedule(actual: ScheduleDescription, input?: unknown): void {
  const args = reconcileSweepInput(input);
  const { action, policies, spec } = actual;
  function incompatible(): never { throw new ReconcileScheduleError("incompatible_schedule"); }
  if (actual.scheduleId !== RECONCILE_SCHEDULE_ID || !sameMemo(actual.memo, memo(args))) incompatible();
  const ownership = actual.typedSearchAttributes?.getAll();
  // Server-added Temporal system fields are allowed; every custom attribute is owned here.
  if (!ownership || actual.typedSearchAttributes.get(RECONCILE_SCHEDULE_OWNER) !== RECONCILE_SWEEP_CONTRACT || ownership.some(({ key, value }) => key.name === RECONCILE_SCHEDULE_OWNER.name ? key.type !== SearchAttributeType.KEYWORD || value !== RECONCILE_SWEEP_CONTRACT : !(key.name === "TemporalNamespaceDivision" && key.type === SearchAttributeType.KEYWORD && value === "TemporalSchedule"))) incompatible();
  const actionArgs = action.args;
  if (action.type !== "startWorkflow" || action.workflowType !== RECONCILE_SWEEP_TYPE || action.workflowId !== RECONCILE_SCHEDULE_ID || action.taskQueue !== TASK_QUEUE || !Array.isArray(actionArgs) || actionArgs.length !== 1) incompatible();
  const raw = actual.raw.schedule;
  const rawAction = raw?.action?.startWorkflow;
  // SDK 1.24 drops these routing/identity fields when decoding a Schedule.
  // Activation preserves raw bytes, so validate them before adoption or CAS.
  if (!rawAction || rawAction.taskQueue?.name !== TASK_QUEUE
    || ![undefined, null, 0, 1].includes(rawAction.taskQueue.kind)
    || ![undefined, null, ""].includes(rawAction.taskQueue.normalName)
    || !noPriorityOverride(rawAction.priority)
    || !noVersioningOverride(rawAction.versioningOverride)
    || ![undefined, null, false].includes(raw?.policies?.keepOriginalWorkflowId)
    || !empty(rawAction.header?.fields)) incompatible();
  let existing: ReconcileSweepInput;
  try { existing = reconcileSweepInput(actionArgs[0]); } catch { return incompatible(); }
  const actionAttributes = action.typedSearchAttributes;
  const actionOwnership = Array.isArray(actionAttributes) ? actionAttributes : actionAttributes?.getAll();
  if (configDigest(existing) !== configDigest(args) || action.workflowExecutionTimeout !== 180_000 || action.workflowRunTimeout !== 180_000 || action.workflowTaskTimeout !== 10_000 || action.retry?.maximumAttempts !== 1 || !empty(action.memo) || !empty(actionOwnership) || !empty(action.searchAttributes) || action.staticSummary !== undefined || action.staticDetails !== undefined || !noPriorityOverride(action.priority)) incompatible();
  // Backoff is inert at one attempt; reject extra error selectors and noncanonical retry values.
  if (action.retry && (!empty(action.retry.nonRetryableErrorTypes) || (action.retry.initialInterval !== undefined && action.retry.initialInterval !== 1_000) || ![undefined, 0, 2].includes(action.retry.backoffCoefficient) || (action.retry.maximumInterval !== undefined && action.retry.maximumInterval !== 100_000))) incompatible();
  if (policies.overlap !== ScheduleOverlapPolicy.SKIP || policies.catchupWindow !== CADENCE_MS || policies.pauseOnFailure !== false || actual.state.remainingActions !== undefined) incompatible();
  if (spec.intervals?.length !== 1 || spec.intervals[0].every !== CADENCE_MS || (spec.intervals[0].offset ?? 0) !== 0 || !empty(spec.calendars) || !empty(spec.skip) || spec.startAt !== undefined || spec.endAt !== undefined || (spec.jitter ?? 0) !== 0 || ![undefined, "", "UTC"].includes(spec.timezone)) incompatible();
}

export interface ReconcileSchedulePrerequisites { assertReady(): Promise<void> }
/** The factory-issued capability is local to this module; a caller's ready flag is not authority. */
const readiness = new WeakSet<object>();

async function ready(prerequisites: ReconcileSchedulePrerequisites): Promise<void> {
  if (!prerequisites || !readiness.has(prerequisites)) throw new ReconcileScheduleError("prerequisites_unavailable");
  try { await boundedReadiness(prerequisites.assertReady()); } catch { throw new ReconcileScheduleError("prerequisites_unavailable"); }
}
async function boundedReadiness<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ReconcileScheduleError("prerequisites_unavailable")), RPC_MS); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function rpc<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  try { return await client.schedule.withDeadline(Date.now() + RPC_MS, fn); }
  catch (error) { if (error instanceof ReconcileScheduleError || error instanceof ScheduleAlreadyRunning || error instanceof ScheduleNotFoundError) throw error; throw new ReconcileScheduleError("transport_unconfirmed"); }
}

/** Creates paused, then activates only our exact fresh schedule. Existing pauses remain paused. */
export async function ensureReconcileSchedule(client: Client, prerequisites: ReconcileSchedulePrerequisites, input?: unknown): Promise<{ created: boolean; paused: boolean; handle: ScheduleHandle }> {
  const args = reconcileSweepInput(input);
  await ready(prerequisites);
  const handle = client.schedule.getHandle(RECONCILE_SCHEDULE_ID);
  let created = false;
  try {
    const existing = await rpc(client, () => handle.describe());
    assertCompatibleReconcileSchedule(existing, args);
    return { created: false, paused: existing.state.paused, handle };
  } catch (error) { if (!(error instanceof ScheduleNotFoundError)) throw error; }
  try { await rpc(client, () => client.schedule.create(reconcileScheduleOptions(args))); created = true; }
  catch (error) { if (!(error instanceof ScheduleAlreadyRunning)) throw error; }
  const description = await rpc(client, () => handle.describe());
  assertCompatibleReconcileSchedule(description, args);
  if (!created) return { created: false, paused: description.state.paused, handle };
  await ready(prerequisites);
  const current = await rpc(client, () => handle.describe());
  assertCompatibleReconcileSchedule(current, args);
  if (!current.state.paused || current.state.note !== CREATE_NOTE || !current.raw.schedule || !current.raw.conflictToken?.length) throw new ReconcileScheduleError("incompatible_schedule");
  // SDK 1.24 ScheduleHandle.update omits this token and can overwrite concurrent changes.
  // Preserve the exact encoded action, policies, spec and state; change only our fresh pause.
  try {
    await rpc(client, () => client.schedule.workflowService.updateSchedule({
      namespace: client.schedule.options.namespace, scheduleId: RECONCILE_SCHEDULE_ID,
      schedule: { ...current.raw.schedule!, state: { ...current.raw.schedule!.state, paused: false, notes: ACTIVE_NOTE } },
      conflictToken: current.raw.conflictToken, requestId: randomUUID(), identity: client.schedule.options.identity,
    }));
  } catch (error) {
    // Read the actual outcome for compatibility, then refuse. Never repeat the update.
    const observed = await rpc(client, () => handle.describe());
    assertCompatibleReconcileSchedule(observed, args);
    if (observed.state.paused && observed.state.note !== CREATE_NOTE) throw new ReconcileScheduleError("incompatible_schedule");
    throw error;
  }
  const active = await rpc(client, () => handle.describe());
  assertCompatibleReconcileSchedule(active, args);
  // An accepted update does not prove that a concurrent human pause was removed.
  // Confirm only our exact activation; never repeat an update to override operator state.
  if (active.state.paused !== false || active.state.note !== ACTIVE_NOTE) throw new ReconcileScheduleError("incompatible_schedule");
  return { created: true, paused: false, handle };
}

/** Log-safe maintenance projection; no provider payloads, arguments or memo. */
export async function inspectReconcileSchedule(client: Client, input?: unknown): Promise<{ paused: boolean; running: number; actions: number; skippedOverlap: number; missedCatchup: number }> {
  const current = await rpc(client, () => client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe());
  assertCompatibleReconcileSchedule(current, input);
  return { paused: current.state.paused, running: current.info.runningActions.length, actions: current.info.numActionsTaken, skippedOverlap: current.info.numActionsSkippedOverlap, missedCatchup: current.info.numActionsMissedCatchupWindow };
}

/** Every SQL statement and lock wait in our lease/controller ports has a local bound. */
function boundedStore(db: Sql): Sql {
  return {
    query: <T>(text: string, values?: readonly unknown[]) => db.tx(async (tx) => {
      await tx.query("set local statement_timeout='10s'");
      await tx.query("set local lock_timeout='5s'");
      return tx.query<T>(text, values);
    }),
    tx: <T>(fn: (tx: Sql) => Promise<T>) => db.tx(async (tx) => {
      await tx.query("set local statement_timeout='10s'");
      await tx.query("set local lock_timeout='5s'");
      return fn(tx);
    }),
  };
}

/** The canonical broker each composed port set was built with, so the optimizer step proposes through the same authority. */
const composedBrokers = new WeakMap<ReconcilePassPorts, Broker>();

async function canonicalPorts(db: PlatformDbHandle, signal: AbortSignal): Promise<ReconcilePassPorts> {
  signal.throwIfAborted();
  if (db.kind !== "postgres" || isMemoryStoreEnabled() || process.env.ZENITH_RECONCILE_MEMORY === "1") throw new ReconcileScheduleError("prerequisites_unavailable");
  await assertPlatformSchemaCurrent(boundedStore(db));
  const canonical = await loadPolicyEngine();
  if (!/^[a-f0-9]{64}$/.test(canonical.version)) throw new ReconcileScheduleError("prerequisites_unavailable");
  const signer = new CredentialGrantSigner();
  await signer.ready();
  const store = boundedStore(db);
  // This composition cannot inherit a process-global broker/store/port override.
  // The shared authority helper reads current human membership and retains
  // canonical system/integration attenuation; the activity owns its signal.
  const broker = createBroker({ store: new PlatformBrokerStore(store), scopes: platformScopeResolver(store),
    roles: currentProductRoleResolver({ signal }), signer, clock: systemClock, policy: () => loadPolicyEngine() });
  signal.throwIfAborted();
  const composed = composeReconcilePorts(store, platformCredentialBroker(store), async () => broker);
  composedBrokers.set(composed, broker);
  return composed;
}

function cancellablePorts(ports: ReconcilePassPorts, signal: AbortSignal): ReconcilePassPorts {
  const assert = () => signal.throwIfAborted();
  return {
    ...ports,
    async loadGraph(environment) { assert(); const graph = await ports.loadGraph(environment); assert(); return graph; },
    state: {
      async claimDue(input) { assert(); const result = await ports.state.claimDue(input); assert(); return result; },
      async complete(input) { assert(); await ports.state.complete(input); assert(); },
      async release(input) { await ports.state.release(input); },
      async nudge(input) { assert(); await ports.state.nudge(input); assert(); },
    },
    guard: { run: (environment, fn) => { assert(); return ports.guard.run(environment, (held) => fn({ ...held, signal: AbortSignal.any([signal, ...(held.signal ? [held.signal] : [])]) })); } },
  };
}

function countsOnly(value: ReconcilePassResult): ReconcilePassResult {
  if (!COUNT_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) || typeof value.saturated !== "boolean" || typeof value.timedOut !== "boolean") throw new Error("Invalid reconciliation counts.");
  return Object.fromEntries([...COUNT_KEYS.map((key) => [key, value[key]]), ["saturated", value.saturated], ["timedOut", value.timedOut]]) as unknown as ReconcilePassResult;
}
export interface ReconcileSweepRuntime extends ReconcileSchedulePrerequisites { activities: ReconcileSweepActivities }
/** Optional step run in the same lease after the reconcile pass; PROD-COST-03 scheduled optimizer. */
type OptimizerStep = (composed: ReconcilePassPorts) => OptimizerPassPorts | undefined;
function runtime(db: Sql, ports: (signal: AbortSignal) => Promise<ReconcilePassPorts>, optimizer?: OptimizerStep): ReconcileSweepRuntime {
  const capability: ReconcileSweepRuntime = {
    async assertReady() { await boundedReadiness(ports(AbortSignal.timeout(RPC_MS))); },
    activities: {
      async sweepReconcilePass(input: ReconcileSweepActivityInput): Promise<ReconcileSweepResult> {
        let args: ReconcileSweepInput;
        let passId: string;
        try {
          if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 4) throw new Error();
          const descriptors = Object.getOwnPropertyDescriptors(input);
          if (!["contract", "maxEnvironments", "environmentConcurrency", "passId"].every((key) => descriptors[key] && "value" in descriptors[key])) throw new Error();
          args = reconcileSweepInput({ contract: descriptors.contract.value, maxEnvironments: descriptors.maxEnvironments.value, environmentConcurrency: descriptors.environmentConcurrency.value });
          const capturedPassId = descriptors.passId.value;
          if (typeof capturedPassId !== "string" || !UUID.test(capturedPassId)) throw new Error();
          passId = capturedPassId;
        }
        catch { throw ApplicationFailure.nonRetryable("Reconciliation sweep activity input is invalid.", "ReconcileSweepContractInvalid"); }
        const context = Context.current();
        context.cancellationSignal.throwIfAborted();
        const signal = AbortSignal.any([context.cancellationSignal, AbortSignal.timeout(70_000)]);
        // Cancellation is delivered through heartbeats even before prerequisite SQL returns.
        // Emit below the bounded store's five-second lock wait; Worker throttling still applies.
        const beat = setInterval(() => context.heartbeat({ phase: "sweeping" }), 1_000);
        beat.unref();
        try {
          context.heartbeat({ phase: "sweeping" });
          let composed: ReconcilePassPorts;
          try { composed = await boundedReadiness(ports(signal)); } catch { if (context.cancellationSignal.aborted) throw new CancelledFailure(undefined); return { status: "deferred", reason: "prerequisites_unavailable" }; }
          context.cancellationSignal.throwIfAborted();
          signal.throwIfAborted();
          return await withLease(boundedStore(db), { scope: RECONCILE_SWEEP_LEASE, holder: `reconcile-sweep:${passId}`, ttlMs: 90_000, signal }, async (lease, heldSignal) => {
            // Health record (PROD-OBS-04): fenced by the sweep lease; a bookkeeping failure never fails the pass.
            const { outcome } = await recordLeasedRun(boundedStore(db), "reconcile", "temporal", lease.fenceToken, async () => {
            const result = await reconcilePass({ ports: cancellablePorts(composed, heldSignal), holder: `reconcile-sweep:${passId}`, maxEnvironments: args.maxEnvironments, environmentConcurrency: args.environmentConcurrency, budgetMs: 20_000, includeSandbox: false, reconcile: { autoRepair: true, deadlineAt: Date.now() + 50_000 } });
            heldSignal.throwIfAborted();
            // Per-environment opt-in (default off) and proposal-only. Its failure never turns a completed reconcile pass into a failure.
            const optimizerPorts = optimizer?.(composed);
            if (optimizerPorts) {
              try { await runOptimizerPass(optimizerPorts, { maxEnvironments: args.maxEnvironments, signal: heldSignal }); }
              catch { heldSignal.throwIfAborted(); }
            }
            const completed: ReconcileSweepResult = { status: "completed", counts: countsOnly(result) };
            return { value: completed, performed: true, counts: { claimed: result.claimed, reconciled: result.reconciled, failed: result.failed, deferred: result.deferred, unreadNodes: result.unreadNodes, repairsProposed: result.repairsProposed } };
            });
            return outcome.value;
          });
        } catch (error) {
          if (context.cancellationSignal.aborted) throw new CancelledFailure(undefined);
          if (error instanceof LeaseUnavailableError) return { status: "busy" };
          // Do not convert incomplete work to zero counts or retry an uncertain dispatch.
          return { status: "deferred", reason: "pass_unconfirmed" };
        } finally { clearInterval(beat); }
      },
    },
  };
  readiness.add(capability);
  return Object.freeze(capability);
}

/** Production only: actual PostgreSQL, canonical policy/store/signer, existing broker ports. */
export function createReconcileSweepRuntime(db: PlatformDbHandle): ReconcileSweepRuntime {
  return runtime(db, (signal) => canonicalPorts(db, signal), (composed) => {
    const broker = composedBrokers.get(composed);
    return broker ? composeOptimizerPorts(boundedStore(db), composed, broker) : undefined;
  });
}
/** Explicit contract fixture. Never a production fallback or a caller-supplied ready flag. */
export function createIsolatedReconcileSweepRuntime(db: PlatformDbHandle, ports: () => Promise<ReconcilePassPorts>): ReconcileSweepRuntime {
  if (process.env.NODE_ENV !== "test" || !["postgres", "pglite"].includes(db.kind)) throw new ReconcileScheduleError("prerequisites_unavailable");
  return runtime(db, async () => { await assertPlatformSchemaCurrent(db); return ports(); });
}

export type ReconcileObservationPhase = "missing" | "incompatible" | "paused" | "waiting" | "running" | "completed" | "busy" | "deferred" | "unknown" | "stale";
export interface ReconcileObservation {
  phase: ReconcileObservationPhase;
  observationCurrent: boolean;
  running: number;
  completedAtUnixMs?: number;
  counts?: ReconcilePassResult;
}
const STALE_PASS_MS = 180_000;

/** Read only our verified schedule's actual result. An action count is never proof of observation. */
export async function inspectReconcileObservation(client: Client, input?: unknown): Promise<ReconcileObservation> {
  let current: ScheduleDescription;
  try {
    current = await rpc(client, () => client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe());
    assertCompatibleReconcileSchedule(current, input);
  } catch (error) {
    return { phase: error instanceof ScheduleNotFoundError ? "missing" : error instanceof ReconcileScheduleError && error.code === "incompatible_schedule" ? "incompatible" : "unknown", observationCurrent: false, running: 0 };
  }
  const running = current.info.runningActions.length;
  if (current.state.paused) return { phase: "paused", observationCurrent: false, running };
  // At most three recent executions; a running pass may use the immediately prior
  // confirmed observation, but a newer closed deferred/failed pass cannot do so.
  const actions = current.info.recentActions.slice(-3).reverse();
  if (!actions.length) return { phase: "waiting", observationCurrent: false, running };
  try {
    return await client.workflow.withDeadline(Date.now() + RPC_MS, async () => {
      for (const entry of actions) {
        const action = entry.action;
        if (action.type !== "startWorkflow" || !action.workflow.workflowId.startsWith(`${RECONCILE_SCHEDULE_ID}-`)
          || !UUID.test(action.workflow.firstExecutionRunId)) throw new Error();
        const handle = client.workflow.getHandle(action.workflow.workflowId, action.workflow.firstExecutionRunId, { followRuns: false });
        const described = await handle.describe();
        if (described.runId !== action.workflow.firstExecutionRunId || described.type !== RECONCILE_SWEEP_TYPE || described.taskQueue !== TASK_QUEUE) throw new Error();
        if (described.status.name === "RUNNING") continue;
        if (described.status.name !== "COMPLETED" || !described.closeTime) return { phase: "unknown", observationCurrent: false, running };
        const completedAtUnixMs = described.closeTime.getTime();
        const age = Date.now() - completedAtUnixMs;
        if (!Number.isFinite(age) || age < -5_000 || age > STALE_PASS_MS) return { phase: "stale", observationCurrent: false, running };
        const result: unknown = await handle.result();
        if (!result || typeof result !== "object") throw new Error();
        const pass = result as ReconcileSweepResult;
        if (pass.status === "busy" || pass.status === "deferred") return { phase: pass.status, observationCurrent: false, running, completedAtUnixMs };
        if (pass.status !== "completed") throw new Error();
        const counts = Object.freeze(countsOnly(pass.counts));
        const observationCurrent = counts.failed === 0 && counts.deferred === 0 && counts.unreadNodes === 0
          && counts.busy === 0 && !counts.saturated && !counts.timedOut;
        // Reading the result can cross the freshness boundary. Confirm again
        // immediately before returning successful observation readiness.
        if (observationCurrent) {
          const currentAge = Date.now() - completedAtUnixMs;
          if (!Number.isFinite(currentAge) || currentAge < -5_000 || currentAge > STALE_PASS_MS) return { phase: "stale", observationCurrent: false, running, completedAtUnixMs, counts };
        }
        return { phase: observationCurrent ? running ? "running" : "completed" : "unknown", observationCurrent, running, completedAtUnixMs, counts };
      }
      return { phase: "running", observationCurrent: false, running };
    });
  } catch { return { phase: "unknown", observationCurrent: false, running }; }
}
