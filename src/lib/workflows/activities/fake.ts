/**
 * An in-memory, scriptable implementation of every workflow activity, for
 * tests. NOT a simulation of any cloud: it proves how the workflows behave
 * when activities succeed, fail, stall or are cancelled, and nothing else.
 * Nothing here calls a driver, OpenTofu, the credential broker or a store, and
 * its results are canned values, not observed state.
 *
 * What it gives a test:
 *  - `calls`: every activity call in order (input and result, deep-copied);
 *  - `failOn(name, failure)`: make an activity throw a typed `ApplicationFailure`
 *    (LeaseLost, plan_changed, StepFailed, ...) or a plain retryable `Error`;
 *  - `delay(name, ms)` / `hold(name)`: keep an activity running (heartbeating,
 *    and therefore cancellable) until time passes or the test releases it;
 *    `hold(name, { heartbeat: false })` stalls it silently, like a crashed worker;
 *  - `setResult(name, value | fn)`: override what an activity returns;
 *  - `approve()` / `reject()`: what `checkApproval` reports;
 *  - a tiny lease table with fence tokens (busy / lost / released tracking);
 *  - `steps` / `statuses`: what `recordStep` / `markOperation` were told.
 *
 * Node-side module (uses `@temporalio/activity` for heartbeats); never imported
 * from `definitions/`.
 */

import { ApplicationFailure, Context } from "@temporalio/activity";
import type { LeaseRef, StepName, StepProgress, WorkerActivities, WorkflowOperationStatus } from "../types";
import { leaseBusy, leaseLost } from "./failures";

export type ActivityKey = keyof WorkerActivities;
type Input<K extends ActivityKey> = Parameters<WorkerActivities[K]>[0];
type Output<K extends ActivityKey> = Awaited<ReturnType<WorkerActivities[K]>>;

export interface FakeCall {
  activity: ActivityKey;
  /** 0-based position across all activities */
  seq: number;
  /** Temporal attempt number when run inside an activity context, else 1 */
  attempt: number;
  input: unknown;
  /** set once the activity returned */
  result?: unknown;
  /** set when the activity threw */
  failure?: { type?: string; message: string };
}

export interface FakeFailure {
  /** `ApplicationFailure.type`; omit for a plain `Error` (retryable, unclassified) */
  type?: string;
  message?: string;
  /** default: true when `type` is given, else false */
  nonRetryable?: boolean;
  /** fail only the first N calls (default: every call) */
  times?: number;
}

export interface Hold {
  /** resolves when the held activity has been called */
  started: Promise<void>;
  /** let the held activity continue and return normally */
  release(): void;
}

export interface RecordedStep {
  operationId: string;
  deploymentId?: string;
  step: StepName;
  status: StepProgress["status"];
  detail?: string;
}

export interface RecordedStatus {
  operationId: string;
  status: WorkflowOperationStatus;
  error?: string;
}

export interface FakeLeaseState {
  /** the lease currently held, if any */
  held: LeaseRef | undefined;
  /** every lease handed out, in order */
  acquired: LeaseRef[];
  /** every lease released, in order */
  released: LeaseRef[];
  /** last fence token issued */
  fence: number;
}

export interface FakeActivities {
  /** register these with `Worker.create({ activities })` */
  activities: WorkerActivities;
  readonly calls: FakeCall[];
  readonly steps: RecordedStep[];
  readonly statuses: RecordedStatus[];
  readonly lease: FakeLeaseState;
  /** activity names in call order */
  names(): ActivityKey[];
  callsTo(name: ActivityKey): FakeCall[];
  failOn(name: ActivityKey, failure: FakeFailure): void;
  /** stop failing `name` */
  clearFailure(name: ActivityKey): void;
  /** keep `name` running for `ms` of real time (heartbeating) before it returns */
  delay(name: ActivityKey, ms: number): void;
  /**
   * Keep `name` running until `release()`. By default it heartbeats, so a
   * cancellation reaches it; with `{ heartbeat: false }` it goes silent, which
   * the server sees as a dead worker (heartbeat timeout).
   */
  hold(name: ActivityKey, opts?: { heartbeat?: boolean }): Hold;
  setResult<K extends ActivityKey>(name: K, result: Output<K> | ((input: Input<K>, callNumber: number) => Output<K>)): void;
  /** `checkApproval` reports approved from now on */
  approve(): void;
  /** `checkApproval` reports rejected from now on */
  reject(): void;
  /** the held lease expires: the next renew throws LeaseLost */
  expireLease(): void;
}

/* -------------------------------- defaults -------------------------------- */

const PLAN_DIGEST = "sha256:fake-plan-digest";

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function currentContext(): Context | undefined {
  try {
    return Context.current();
  } catch {
    return undefined;
  }
}

/** Sleep in slices, heartbeating so cancellation is delivered; rejects when cancelled. */
async function pause(ms: number): Promise<void> {
  const ctx = currentContext();
  if (!ctx) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  let left = ms;
  while (left > 0) {
    ctx.heartbeat();
    const slice = Math.min(200, left);
    await ctx.sleep(slice);
    left -= slice;
  }
}

async function waitReleased(released: Promise<void>, heartbeat: boolean): Promise<void> {
  const ctx = currentContext();
  if (!ctx || !heartbeat) {
    await released;
    return;
  }
  let done = false;
  void released.then(() => {
    done = true;
  });
  while (!done) {
    ctx.heartbeat();
    const nap = ctx.sleep(200);
    nap.catch(() => undefined); // a nap outliving the release must not become an unhandled rejection
    await Promise.race([nap, released]);
  }
}

export function createFakeActivities(): FakeActivities {
  const calls: FakeCall[] = [];
  const steps: RecordedStep[] = [];
  const statuses: RecordedStatus[] = [];
  const lease: FakeLeaseState = { held: undefined, acquired: [], released: [], fence: 0 };
  const failures = new Map<ActivityKey, FakeFailure & { used: number }>();
  const delays = new Map<ActivityKey, number>();
  const holds = new Map<ActivityKey, { started: () => void; released: Promise<void>; heartbeat: boolean }>();
  const results = new Map<ActivityKey, (input: never, callNumber: number) => unknown>();
  let approval: "pending" | "approved" | "rejected" = "pending";
  let leaseExpired = false;

  const throwScripted = (name: ActivityKey): void => {
    const script = failures.get(name);
    if (!script) return;
    if (script.times !== undefined && script.used >= script.times) return;
    script.used += 1;
    const message = script.message ?? `scripted failure of ${name}`;
    if (script.type === undefined) throw new Error(message);
    throw ApplicationFailure.create({ message, type: script.type, nonRetryable: script.nonRetryable ?? true });
  };

  const wrap = <K extends ActivityKey>(name: K, impl: (input: Input<K>) => Output<K> | Promise<Output<K>>): WorkerActivities[K] => {
    const fn = async (input: Input<K>): Promise<Output<K>> => {
      const call: FakeCall = { activity: name, seq: calls.length, attempt: currentContext()?.info.attempt ?? 1, input: clone(input) };
      calls.push(call);
      const callNumber = calls.filter((c) => c.activity === name).length;
      try {
        const hold = holds.get(name);
        if (hold) {
          hold.started();
          await waitReleased(hold.released, hold.heartbeat);
        }
        const delayMs = delays.get(name);
        if (delayMs) await pause(delayMs);
        throwScripted(name);
        const override = results.get(name);
        const result = override ? (override as (i: Input<K>, n: number) => Output<K>)(input, callNumber) : await impl(input);
        call.result = clone(result);
        return result;
      } catch (err) {
        call.failure = {
          type: err instanceof ApplicationFailure ? (err.type ?? undefined) : undefined,
          message: err instanceof Error ? err.message : String(err),
        };
        throw err;
      }
    };
    return fn as unknown as WorkerActivities[K];
  };

  const activities: WorkerActivities = {
    recordStep: wrap("recordStep", async (input) => {
      steps.push(clone(input));
    }),
    markOperation: wrap("markOperation", async (input) => {
      statuses.push(clone(input));
    }),

    acquireLease: wrap("acquireLease", async (input) => {
      if (lease.held) throw leaseBusy(`${input.scope} is held by ${lease.held.holder}`);
      lease.fence += 1;
      leaseExpired = false;
      const acquired: LeaseRef = { scope: input.scope, holder: input.operationId, fenceToken: lease.fence };
      lease.held = acquired;
      lease.acquired.push(acquired);
      return { ...acquired };
    }),
    renewLease: wrap("renewLease", async (input) => {
      if (!lease.held || leaseExpired || lease.held.fenceToken !== input.lease.fenceToken) {
        throw leaseLost(`${input.lease.scope} fence ${input.lease.fenceToken} is no longer held`);
      }
    }),
    releaseLease: wrap("releaseLease", async (input) => {
      lease.released.push({ ...input.lease });
      if (lease.held && lease.held.fenceToken === input.lease.fenceToken) lease.held = undefined;
    }),

    validateDesiredState: wrap("validateDesiredState", async () => ({ graphDigest: "sha256:fake-graph-digest", nodes: 3, problems: [] })),
    planInfrastructure: wrap("planInfrastructure", async () => ({
      planDigest: PLAN_DIGEST,
      create: 2,
      update: 1,
      delete: 0,
      replace: 0,
      destroysData: false,
      empty: false,
    })),
    evaluatePolicy: wrap("evaluatePolicy", async () => ({ outcome: "allow" as const, decisionId: "decision-1", reasons: [] })),
    checkApproval: wrap("checkApproval", async () => ({
      approved: approval === "approved",
      rejected: approval === "rejected",
      ...(approval === "pending" ? {} : { approvalId: "approval-1" }),
    })),
    finalPlan: wrap("finalPlan", async (input) => ({
      planDigest: input.approvedPlanDigest,
      create: 2,
      update: 1,
      delete: 0,
      replace: 0,
      destroysData: false,
      empty: false,
    })),
    applyInfrastructure: wrap("applyInfrastructure", async () => ({ applied: 3, outputsDigest: "sha256:fake-outputs-digest" })),
    buildArtifacts: wrap("buildArtifacts", async () => ({
      images: [{ service: "web", imageUri: "registry.example.test/web@sha256:fake-image", digest: "sha256:fake-image" }],
    })),
    deployWorkloads: wrap("deployWorkloads", async () => ({ services: 1 })),
    runMigrations: wrap("runMigrations", async () => ({ ran: true, detail: "2 migration(s) applied" })),
    verifyInfrastructure: wrap("verifyInfrastructure", async () => ({ status: "passed" as const, checks: 3, failed: 0 })),
    verifyApplication: wrap("verifyApplication", async () => ({ status: "passed" as const, checks: 2, failed: 0, url: "https://app.example.test" })),
    observeEnvironment: wrap("observeEnvironment", async () => ({ drift: 0, unknown: 0 })),
    executeCapability: wrap("executeCapability", async () => ({ ok: true, summary: "restarted 2 tasks" })),
    reconcileObserve: wrap("reconcileObserve", async (input) => ({ drift: 1, unknown: 0, ...(input.allowAutoRepair !== undefined ? { repairs: { proposed: 0, started: 0, awaitingApproval: 0, denied: 0, blockedUncertain: 0, unsupported: 0, failed: 0, skipped: 0, digest: "0".repeat(64) } } : {}) })),
  };

  return {
    activities,
    calls,
    steps,
    statuses,
    lease,
    names: () => calls.map((c) => c.activity),
    callsTo: (name) => calls.filter((c) => c.activity === name),
    failOn: (name, failure) => {
      failures.set(name, { ...failure, used: 0 });
    },
    clearFailure: (name) => {
      failures.delete(name);
    },
    delay: (name, ms) => {
      delays.set(name, ms);
    },
    hold: (name, opts) => {
      let release!: () => void;
      let started!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      holds.set(name, { started, released, heartbeat: opts?.heartbeat ?? true });
      return { started: startedPromise, release };
    },
    setResult: (name, result) => {
      results.set(name, typeof result === "function" ? (result as (i: never, n: number) => unknown) : () => result);
    },
    approve: () => {
      approval = "approved";
    },
    reject: () => {
      approval = "rejected";
    },
    expireLease: () => {
      leaseExpired = true;
    },
  };
}
