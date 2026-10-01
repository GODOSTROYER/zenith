/**
 * The server API execution activities use to run work on a customer-side
 * runner or zenithd: enqueue a signed job, then await its outcome.
 *
 *   const jobId = await enqueueRunnerJob({ workspaceId, runnerId, operationId, capability, kind, payload, grant, … });
 *   const done  = await awaitRunnerJob(jobId, { workspaceId, signal });
 *   // done.uncertain === true  →  mark the operation `uncertain`; NEVER re-dispatch
 *
 * Enqueue refuses, before anything is signed: an unknown/foreign runner, a
 * revoked or stale one (3 missed heartbeats), one that did not advertise the
 * job kind, an invalid payload (zod, strict — the Go agent is strict too), and a
 * grant that does not bind this exact runner, capability, operation and
 * workspace (the agent would reject it; failing here is cheaper and clearer).
 *
 * Await never re-dispatches. Outcomes (`AwaitedJob.status`):
 *   succeeded / failed / rejected   the agent reported; `rejected` means it did not execute
 *   timed_out                       ran (or may have) and the outcome is unknown  → uncertain
 *   expired                         never claimed before its expiry: provably not delivered
 *   cancelled                       cancelled by the control plane; uncertain only if it had been handed over
 * When the control plane stops waiting (queue window over, or the lease of a
 * running job lapsed) it cancels the job itself, so a late result from the agent
 * gets `409 already_settled` and is discarded — the operation is reconciled by
 * observing reality, not by trusting a stale report. A job it cancelled that had
 * been handed over reads `timed_out` (uncertain); one never handed over reads `expired`.
 */
import { randomUUID } from "node:crypto";
import { isCapability } from "@/lib/capabilities/catalog";
import { GrantVerificationError } from "@/lib/credentials/errors";
import { verifyCapabilityGrant } from "@/lib/credentials/grants";
import type { MachineResult } from "@/lib/machines/types";
import { PayloadError, validateMachineArgs, validateRunnerPayload } from "@/lib/runners/payloads";
import { queueOf, registryOf, RunnerStoreError, TERMINAL_JOB_STATUSES, type AgentJob, type AgentRecord } from "@/lib/runners/ports";
import { abortError, getRunnerRuntime, type RunnerRuntime } from "@/lib/runners/runtime";
import { sealAad, type StoredResult } from "@/lib/runners/service";
import { signEnvelope, unverifiedClaims } from "@/lib/runners/signing";
import {
  AGENT_KINDS,
  MAX_ENVELOPE_BYTES,
  RUNNER_JOB_KINDS,
  isValidId,
  type AgentKind,
  type JobEnvelope,
  type MachineEnvelope,
  type RunnerJobKind,
} from "@/lib/runners/types";

/* --------------------------------- errors --------------------------------- */

export type DispatchErrorCode =
  | "invalid_input"
  | "invalid_payload"
  | "agent_not_found"
  | "agent_revoked"
  | "agent_stale"
  | "agent_lacks_capability"
  | "grant_invalid"
  | "payload_too_large"
  | "job_not_found";

export class DispatchError extends Error {
  constructor(
    readonly code: DispatchErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

/* --------------------------------- defaults --------------------------------- */

interface KindDefaults {
  timeoutSec: number;
  maxOutputBytes: number;
  queueTtlSec: number;
}

const KIND_DEFAULTS: Record<RunnerJobKind, KindDefaults> = {
  "tofu.run": { timeoutSec: 1800, maxOutputBytes: 1024 * 1024, queueTtlSec: 300 },
  "aws.http": { timeoutSec: 60, maxOutputBytes: 2 * 1024 * 1024, queueTtlSec: 120 },
  "oci.http": { timeoutSec: 60, maxOutputBytes: 1024 * 1024, queueTtlSec: 120 },
  "k8s.http": { timeoutSec: 60, maxOutputBytes: 2 * 1024 * 1024, queueTtlSec: 120 },
  "probe.http": { timeoutSec: 30, maxOutputBytes: 64 * 1024, queueTtlSec: 120 },
  "probe.tcp": { timeoutSec: 30, maxOutputBytes: 64 * 1024, queueTtlSec: 120 },
  "probe.dns": { timeoutSec: 30, maxOutputBytes: 64 * 1024, queueTtlSec: 120 },
};
const MACHINE_DEFAULTS: KindDefaults = { timeoutSec: 30, maxOutputBytes: 64 * 1024, queueTtlSec: 120 };

const MAX_TIMEOUT_SEC = 2 * 60 * 60;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** a grant must outlive the job's queue window by at least this, or the agent rejects it on receipt */
const MIN_GRANT_REMAINING_SEC = 5;
/** how long past `expiresAt` / lease the awaiting side waits before it settles the job itself (clock skew between app and store) */
const SETTLE_SLACK_MS = 5000;

function bounded(name: string, v: number | undefined, fallback: number, min: number, max: number): number {
  const n = v ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new DispatchError("invalid_input", `${name} must be an integer between ${min} and ${max}.`);
  return n;
}

/* ----------------------------------- guards ----------------------------------- */

async function requireDispatchable(rt: RunnerRuntime, kind: AgentKind, workspaceId: string, agentId: string): Promise<AgentRecord> {
  const what = kind === "runner" ? "runner" : "machine";
  const agent = await registryOf(rt.store, kind).get(workspaceId, agentId);
  if (!agent) throw new DispatchError("agent_not_found", `No ${what} ${agentId} in this workspace.`);
  if (agent.status === "revoked") throw new DispatchError("agent_revoked", `The ${what} ${agentId} is revoked.`);
  if (agent.stale) throw new DispatchError("agent_stale", `The ${what} ${agentId} has not sent a heartbeat for 90 seconds; work is not dispatched to a silent ${what}.`);
  return agent;
}

/**
 * The grant must be ours (pinned control-plane key, EdDSA, `zenith-grant+jwt`, unexpired — the
 * credential module's `verifyCapabilityGrant`) and must bind exactly this agent, capability,
 * operation and workspace. Returns its `exp`.
 */
async function checkGrant(rt: RunnerRuntime, grant: string, want: { audience: string; capability: string; operationId: string; workspaceId: string }): Promise<number> {
  let claims;
  try {
    claims = await verifyCapabilityGrant(grant, {
      audience: want.audience,
      expectedCapability: want.capability,
      expectedOperationId: want.operationId,
      keys: await rt.verificationKeys(),
      now: new Date(rt.now()),
    });
  } catch (error) {
    if (error instanceof GrantVerificationError) throw new DispatchError("grant_invalid", `The capability grant was refused (${error.code}): ${error.message}`);
    throw error;
  }
  if (claims.ws !== want.workspaceId) throw new DispatchError("grant_invalid", "The capability grant is bound to another workspace.");
  return claims.exp;
}

/* --------------------------------- enqueue --------------------------------- */

export interface EnqueueRunnerJobInput {
  workspaceId: string;
  runnerId: string;
  operationId: string;
  capability: string;
  kind: RunnerJobKind;
  payload: unknown;
  /** compact JWS capability grant for this exact operation (from the capability broker) */
  grant: string;
  timeoutSec?: number;
  maxOutputBytes?: number;
  /** how long the job may wait to be claimed */
  queueTtlSec?: number;
}

interface Built {
  jti: string;
  envelope: string;
  ttlSec: number;
}

async function enqueueCommon(
  rt: RunnerRuntime,
  kind: AgentKind,
  args: { workspaceId: string; agentId: string; operationId: string; capability: string; jobKind: string; envelope: (b: { jti: string; iat: number; exp: number }) => JobEnvelope | MachineEnvelope; grant: string; ttlSec: number }
): Promise<Built> {
  const grantExp = await checkGrant(rt, args.grant, {
    audience: `${kind}:${args.agentId}`,
    capability: args.capability,
    operationId: args.operationId,
    workspaceId: args.workspaceId,
  });
  const iat = Math.floor(rt.now() / 1000);
  const ttlSec = Math.min(args.ttlSec, grantExp - iat);
  if (ttlSec < MIN_GRANT_REMAINING_SEC) throw new DispatchError("grant_invalid", "The capability grant has expired or is about to expire.");
  const jti = `${AGENT_KINDS[kind].jobPrefix}_${randomUUID()}`;
  const envelope = await signEnvelope(rt.signer, AGENT_KINDS[kind].jobTyp, args.envelope({ jti, iat, exp: iat + ttlSec }));
  if (envelope.length > MAX_ENVELOPE_BYTES) throw new DispatchError("payload_too_large", `The signed job is ${envelope.length} bytes; the store keeps at most ${MAX_ENVELOPE_BYTES}. Split the work or reduce the workspace files.`);
  try {
    await queueOf(rt.store, kind).enqueue({ id: jti, workspaceId: args.workspaceId, agentId: args.agentId, operationId: args.operationId, kind: args.jobKind, capability: args.capability, envelope, ttlMs: ttlSec * 1000 });
  } catch (error) {
    if (error instanceof RunnerStoreError && error.code === "not_found") throw new DispatchError("agent_not_found", "The agent is no longer active in this workspace, or the operation does not exist.");
    throw error;
  }
  return { jti, envelope, ttlSec };
}

/** Sign a job for `runnerId` and queue it. Returns the job id (`job_…`). */
export async function enqueueRunnerJob(input: EnqueueRunnerJobInput, runtime?: RunnerRuntime): Promise<string> {
  const rt = runtime ?? (await getRunnerRuntime());
  for (const [name, v] of [
    ["workspaceId", input.workspaceId],
    ["runnerId", input.runnerId],
    ["operationId", input.operationId],
  ] as const)
    if (!isValidId(v)) throw new DispatchError("invalid_input", `${name} must be 1-128 characters of A-Za-z0-9_.:-.`);
  if (!isCapability(input.capability)) throw new DispatchError("invalid_input", `"${input.capability}" is not a capability in the catalog.`);
  if (!(RUNNER_JOB_KINDS as readonly string[]).includes(input.kind)) throw new DispatchError("invalid_input", `"${input.kind}" is not a runner job kind.`);
  const d = KIND_DEFAULTS[input.kind];
  const timeoutSec = bounded("timeoutSec", input.timeoutSec, d.timeoutSec, 1, MAX_TIMEOUT_SEC);
  const maxOutputBytes = bounded("maxOutputBytes", input.maxOutputBytes, d.maxOutputBytes, 1024, MAX_OUTPUT_BYTES);
  const queueTtlSec = bounded("queueTtlSec", input.queueTtlSec, d.queueTtlSec, 10, 3600);
  let payload: unknown;
  try {
    payload = validateRunnerPayload(input.kind, input.payload);
  } catch (error) {
    if (error instanceof PayloadError) throw new DispatchError("invalid_payload", error.message);
    throw error;
  }

  const runner = await requireDispatchable(rt, "runner", input.workspaceId, input.runnerId);
  if (!runner.capabilities.includes(input.kind)) throw new DispatchError("agent_lacks_capability", `The runner ${runner.id} does not advertise the ${input.kind} job kind (it offers: ${runner.capabilities.join(", ") || "nothing"}).`);

  const built = await enqueueCommon(rt, "runner", {
    workspaceId: input.workspaceId,
    agentId: input.runnerId,
    operationId: input.operationId,
    capability: input.capability,
    jobKind: input.kind,
    grant: input.grant,
    ttlSec: queueTtlSec,
    envelope: ({ jti, iat, exp }): JobEnvelope => ({
      protocol: runner.protocol,
      jti,
      runnerId: input.runnerId,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      capability: input.capability,
      kind: input.kind,
      payload,
      grant: input.grant,
      iat,
      exp,
      timeoutSec,
      maxOutputBytes,
    }),
  });
  return built.jti;
}

export interface EnqueueMachineRequestInput {
  workspaceId: string;
  machineId: string;
  operationId: string;
  /** a machine operation; it is also the capability the grant names */
  operation: string;
  args: Record<string, unknown>;
  grant: string;
  timeoutSec?: number;
  maxOutputBytes?: number;
  queueTtlSec?: number;
}

/** Sign a request for a zenithd machine and queue it. Returns the request id (`mreq_…`). */
export async function enqueueMachineRequest(input: EnqueueMachineRequestInput, runtime?: RunnerRuntime): Promise<string> {
  const rt = runtime ?? (await getRunnerRuntime());
  for (const [name, v] of [
    ["workspaceId", input.workspaceId],
    ["machineId", input.machineId],
    ["operationId", input.operationId],
  ] as const)
    if (!isValidId(v)) throw new DispatchError("invalid_input", `${name} must be 1-128 characters of A-Za-z0-9_.:-.`);
  if (!isCapability(input.operation)) throw new DispatchError("invalid_input", `"${input.operation}" is not a capability in the catalog.`);
  const timeoutSec = bounded("timeoutSec", input.timeoutSec, MACHINE_DEFAULTS.timeoutSec, 1, 3600);
  const maxOutputBytes = bounded("maxOutputBytes", input.maxOutputBytes, MACHINE_DEFAULTS.maxOutputBytes, 1024, MAX_OUTPUT_BYTES);
  const queueTtlSec = bounded("queueTtlSec", input.queueTtlSec, MACHINE_DEFAULTS.queueTtlSec, 10, 3600);
  let args: Record<string, unknown>;
  try {
    args = validateMachineArgs(input.operation, input.args);
  } catch (error) {
    if (error instanceof PayloadError) throw new DispatchError("invalid_payload", error.message);
    throw error;
  }

  const machine = await requireDispatchable(rt, "machine", input.workspaceId, input.machineId);
  if (!machine.capabilities.includes(input.operation)) throw new DispatchError("agent_lacks_capability", `The machine ${machine.id} does not advertise ${input.operation} (it offers: ${machine.capabilities.join(", ") || "nothing"}).`);

  const built = await enqueueCommon(rt, "machine", {
    workspaceId: input.workspaceId,
    agentId: input.machineId,
    operationId: input.operationId,
    capability: input.operation,
    jobKind: input.operation,
    grant: input.grant,
    ttlSec: queueTtlSec,
    envelope: ({ jti, iat, exp }): MachineEnvelope => ({
      protocol: machine.protocol,
      jti,
      machineId: input.machineId,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      operation: input.operation,
      args,
      grant: input.grant,
      iat,
      exp,
      timeoutSec,
      maxOutputBytes,
    }),
  });
  return built.jti;
}

/* ---------------------------------- await ---------------------------------- */

export type AwaitedStatus = "succeeded" | "failed" | "rejected" | "timed_out" | "expired" | "cancelled";

export interface AwaitedJob<R = unknown> {
  jobId: string;
  status: AwaitedStatus;
  /**
   * The side effect may have happened and its outcome is unknown. The caller
   * marks the operation `uncertain` and never re-dispatches; reconciliation
   * observes reality.
   */
  uncertain: boolean;
  /** the agent's result (opened from its sealed form); absent when the agent never reported */
  result?: R;
  /** redacted, bounded */
  error?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface AwaitOptions {
  /** required: every store read is scoped to the workspace */
  workspaceId: string;
  signal?: AbortSignal;
  /** polling step; default the runtime's (500 ms) */
  pollMs?: number;
  /** absolute epoch-ms cap on the caller's patience, in addition to the job's own expiry/lease */
  deadlineMs?: number;
}

/**
 * `stoppedWaiting`: the control plane itself cancelled the job because it stopped waiting.
 * A job handed over by then (`startedAt`) is `timed_out` — unknown outcome — and one never
 * handed over is `expired`.
 */
function outcomeOf<R>(rt: RunnerRuntime, job: AgentJob, stoppedWaiting = false): AwaitedJob<R> {
  const status = (stoppedWaiting ? (job.startedAt !== undefined ? "timed_out" : "expired") : job.status) as AwaitedStatus;
  const stored = job.result as StoredResult | undefined;
  let result: R | undefined;
  let openFailed = false;
  if (stored && typeof stored === "object" && "sealed" in stored) {
    try {
      result = rt.sealer.open(sealAad(job.workspaceId, job.id), stored.sealed) as R;
    } catch {
      openFailed = true;
    }
  }
  // timed_out (runner-reported or reaped) and a cancel after hand-over leave the outcome unknown
  const uncertain = status === "timed_out" || (status === "cancelled" && job.startedAt !== undefined) || openFailed;
  return {
    jobId: job.id,
    status: openFailed && status === "succeeded" ? "failed" : status,
    uncertain,
    result,
    error: openFailed ? "The job's result could not be opened (sealing key mismatch); its outcome is unknown." : job.error,
    exitCode: stored?.exitCode,
    startedAt: stored?.startedAt ?? job.startedAt,
    finishedAt: stored?.finishedAt ?? job.settledAt,
  };
}

async function awaitJob<R>(rt: RunnerRuntime, kind: AgentKind, jobId: string, opts: AwaitOptions): Promise<AwaitedJob<R>> {
  if (!isValidId(jobId) || !isValidId(opts.workspaceId)) throw new DispatchError("invalid_input", "jobId and workspaceId must be valid ids.");
  const queue = queueOf(rt.store, kind);
  const step = Math.max(10, opts.pollMs ?? rt.pollStepMs);
  for (;;) {
    let job = await queue.get(opts.workspaceId, jobId);
    if (!job) throw new DispatchError("job_not_found", `No ${kind === "runner" ? "job" : "request"} ${jobId} in this workspace.`);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return outcomeOf<R>(rt, job);

    const t = rt.now();
    const queueOver = job.status === "queued" && t >= Date.parse(job.expiresAt) + SETTLE_SLACK_MS;
    const leaseOver = (job.status === "claimed" || job.status === "running") && job.leaseUntil !== undefined && t >= Date.parse(job.leaseUntil) + SETTLE_SLACK_MS;
    const impatient = opts.deadlineMs !== undefined && t >= opts.deadlineMs;
    if (queueOver || leaseOver || impatient) {
      const reason = queueOver ? "the job was not claimed before its expiry" : leaseOver ? "the agent did not report before the job's lease ended" : "the caller stopped waiting";
      const cancelled = await queue.cancel(opts.workspaceId, jobId, reason);
      // null: the agent's result landed first; report what it reported
      job = cancelled ?? (await queue.get(opts.workspaceId, jobId));
      if (!job) throw new DispatchError("job_not_found", `No ${kind === "runner" ? "job" : "request"} ${jobId} in this workspace.`);
      return outcomeOf<R>(rt, job, cancelled !== null);
    }

    try {
      await rt.sleep(step, opts.signal);
    } catch (error) {
      if (opts.signal?.aborted && job.status === "queued") await queue.cancel(opts.workspaceId, jobId, "the caller was cancelled before the job was claimed").catch(() => undefined);
      throw error instanceof Error ? error : abortError();
    }
  }
}

/** Wait for a runner job to settle. Never re-dispatches; see the module header for outcomes. */
export async function awaitRunnerJob<R = unknown>(jobId: string, opts: AwaitOptions, runtime?: RunnerRuntime): Promise<AwaitedJob<R>> {
  return awaitJob<R>(runtime ?? (await getRunnerRuntime()), "runner", jobId, opts);
}

/** Wait for a zenithd request to settle. */
export async function awaitMachineRequest<R = unknown>(requestId: string, opts: AwaitOptions, runtime?: RunnerRuntime): Promise<AwaitedJob<R>> {
  return awaitJob<R>(runtime ?? (await getRunnerRuntime()), "machine", requestId, opts);
}

/* ------------------------------- result helpers ------------------------------- */

export type RunnerJobFailureCode = "runner_job_failed" | "runner_job_rejected" | "runner_job_uncertain" | "runner_job_not_delivered";

/** A non-successful outcome, as an exception. `uncertain` tells the caller which operation status to set. */
export class RunnerJobError extends Error {
  constructor(
    readonly code: RunnerJobFailureCode,
    readonly awaited: AwaitedJob,
    message: string
  ) {
    super(message);
    this.name = "RunnerJobError";
  }
  get uncertain(): boolean {
    return this.awaited.uncertain;
  }
}

export const isUncertainJobError = (e: unknown): e is RunnerJobError => e instanceof RunnerJobError && e.uncertain;

/** Throw a `RunnerJobError` unless the job succeeded. */
export function requireSucceeded<R>(awaited: AwaitedJob<R>): AwaitedJob<R> & { result: R } {
  if (awaited.status === "succeeded" && awaited.result !== undefined) return awaited as AwaitedJob<R> & { result: R };
  const detail = awaited.error ? `: ${awaited.error}` : "";
  if (awaited.uncertain) throw new RunnerJobError("runner_job_uncertain", awaited, `The job ${awaited.jobId} ended ${awaited.status}; whether it took effect is unknown${detail}`);
  if (awaited.status === "expired" || awaited.status === "cancelled") throw new RunnerJobError("runner_job_not_delivered", awaited, `The job ${awaited.jobId} was ${awaited.status} before it reached the runner${detail}`);
  if (awaited.status === "rejected") throw new RunnerJobError("runner_job_rejected", awaited, `The runner rejected job ${awaited.jobId} without executing it${detail}`);
  throw new RunnerJobError("runner_job_failed", awaited, `The job ${awaited.jobId} ${awaited.status}${detail}`);
}

/** Map a settled zenithd request onto the machines contract's `MachineResult`. */
export function toMachineResult(awaited: AwaitedJob<Record<string, unknown>>, operation: MachineResult["operation"]): MachineResult {
  const r = awaited.result ?? {};
  const output = r.output as { stdout?: string; stderr?: string; exitCode?: number | null; truncated?: boolean } | undefined;
  return {
    ok: awaited.status === "succeeded" && r.ok !== false,
    operation,
    data: (r.data as Record<string, unknown> | undefined) ?? {},
    output: output ? { stdout: String(output.stdout ?? ""), stderr: String(output.stderr ?? ""), exitCode: output.exitCode ?? null, truncated: output.truncated === true } : undefined,
    startedAt: awaited.startedAt ?? new Date(0).toISOString(),
    finishedAt: awaited.finishedAt ?? new Date(0).toISOString(),
    transport: "zenithd",
    transportRef: awaited.jobId,
    simulated: false,
  };
}

/** The claims a job envelope was signed with (diagnostics and tests; unverified). */
export const envelopeClaims = (compact: string): Record<string, unknown> | undefined => unverifiedClaims(compact);
