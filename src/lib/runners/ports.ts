/**
 * The persistence port of the runner plane.
 *
 * `RunnerStore` is what this module needs from the platform control store
 * (ADR-0002, `src/lib/controlplane/db`). It is a PORT: `memory-store.ts` is the
 * in-memory implementation used by tests and local development, and the
 * orchestrator wires a `Sql`-backed adapter over the WS-DB repositories
 * (`repos/runners.ts`, `repos/jobs.ts`, `repos/nonces.ts`, `repos/machines.ts`).
 * The mapping, method by method, is in the WS-RUNSRV handoff.
 *
 * Semantics every implementation must keep (they are the DB's, and the
 * in-memory store is tested against them):
 *  - Registration consumes the token and creates the agent row in ONE atomic
 *    step, taking the workspace from the token; an unknown, expired, used or
 *    wrong-kind token is the same `invalid_registration_token` (no oracle).
 *  - `findForAuth` is the only unscoped read (a signed request names only the
 *    agent id). Everything else takes a workspace id and filters on it.
 *  - `remember` (nonce) is atomic: of two racing requests with the same nonce
 *    exactly one gets `true`.
 *  - `claimNext` is exclusive (`FOR UPDATE SKIP LOCKED`): concurrent pollers of
 *    one agent never receive the same job; a revoked agent's jobs are never
 *    claimable; an expired job is never claimable.
 *  - `settle` is a conditional update from `claimed`/`running`: first writer
 *    wins, everyone else gets `false`.
 *  - Nothing is re-queued. A lapsed lease becomes `timed_out`, an unclaimed
 *    job past its expiry becomes `expired`; callers reconcile the operation to
 *    `uncertain`.
 *  - Time is the store's clock (`clock_timestamp()` in SQL).
 */
import type { AgentKind } from "@/lib/runners/types";

/* --------------------------------- errors ---------------------------------- */

export type RunnerStoreErrorCode = "not_found" | "invalid_input" | "invalid_registration_token" | "conflict";

export class RunnerStoreError extends Error {
  constructor(
    readonly code: RunnerStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RunnerStoreError";
  }
}

/* ------------------------------ registration ------------------------------ */

export interface CreateRegistrationTokenInput {
  workspaceId: string;
  kind: AgentKind;
  /** machines: optional `{ environmentId, address }`; holds no secrets */
  binding?: { environmentId?: string; address?: string };
  createdBy: string;
  /** SHA-256 hex of the raw token; the raw token is never stored */
  tokenHash: string;
  /** default and maximum one hour */
  ttlMs?: number;
}

export interface RegisterAgentInput {
  tokenHash: string;
  /** default `run_<uuid>` / `mac_<uuid>` */
  id?: string;
  name: string;
  /** base64url of the raw 32-byte Ed25519 public key */
  publicKey: string;
  /** the protocol id the agent registered under (the route's collection decides it) */
  protocol: string;
  version?: string;
  capabilities: string[];
  labels: Record<string, string>;
  host: Record<string, string>;
}

/** A registered runner or zenithd machine (ws-db `PlatformRunner` / `PlatformMachine`). */
export interface AgentRecord {
  kind: AgentKind;
  id: string;
  workspaceId: string;
  name: string;
  status: "active" | "revoked";
  protocol: string;
  publicKey: string;
  version?: string;
  capabilities: string[];
  labels: Record<string, string>;
  host: Record<string, string>;
  /** machines only: from the registration token's binding */
  environmentId?: string;
  address?: string;
  registeredAt: string;
  lastHeartbeatAt?: string;
  revokedAt?: string;
  /** derived on the store's clock: active and silent for 90 s */
  stale: boolean;
}

export interface AgentRegistry {
  /** Consume the token and create the agent, atomically. Throws `invalid_registration_token`. */
  register(input: RegisterAgentInput): Promise<AgentRecord>;
  /** Authentication lookup by agent id ALONE (the one unscoped read). */
  findForAuth(id: string): Promise<AgentRecord | null>;
  get(workspaceId: string, id: string): Promise<AgentRecord | null>;
  list(workspaceId: string): Promise<AgentRecord[]>;
  /** null when the agent is not in this workspace */
  heartbeat(input: { workspaceId: string; id: string; version?: string; capabilities?: string[]; host?: Record<string, string> }): Promise<{ revoked: boolean } | null>;
  /**
   * Revoke (terminal, idempotent) and cancel the work not yet started
   * (queued and claimed). Work already `running` is left for the reaper: the
   * agent may still be executing it, so its outcome is unknown.
   * Null when the agent is not in this workspace.
   */
  revoke(workspaceId: string, id: string): Promise<{ agent: AgentRecord; cancelledJobs: number } | null>;
}

/* ---------------------------------- jobs ----------------------------------- */

export type AgentJobStatus = "queued" | "claimed" | "running" | "succeeded" | "failed" | "rejected" | "timed_out" | "expired" | "cancelled";
export const TERMINAL_JOB_STATUSES: readonly AgentJobStatus[] = ["succeeded", "failed", "rejected", "timed_out", "expired", "cancelled"];
export type AgentJobResultStatus = "succeeded" | "failed" | "rejected" | "timed_out";

/**
 * One queued unit of work: a runner job (ws-db `runner_jobs`) or a zenithd
 * request (a `machine_requests` table mirroring it — WS-DB has none yet).
 */
export interface AgentJob {
  /** the envelope's `jti` */
  id: string;
  agentId: string;
  workspaceId: string;
  operationId: string;
  /** runner job kind, or the machine operation */
  kind: string;
  capability: string;
  /** compact JWS — opaque; deliver to the agent, never log or show */
  envelope: string;
  status: AgentJobStatus;
  leaseUntil?: string;
  /** what `settle` stored (already sealed by the service); opaque to the store */
  result?: unknown;
  error?: string;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  expiresAt: string;
  settledAt?: string;
}

export interface EnqueueJobInput {
  id: string;
  workspaceId: string;
  agentId: string;
  operationId: string;
  kind: string;
  capability: string;
  envelope: string;
  /** how long the job may wait unclaimed; default 5 min, max 1 h */
  ttlMs?: number;
}

export interface JobLogLine {
  ts: string;
  stream: "stdout" | "stderr" | "info";
  line: string;
}

export interface JobLogEntry extends JobLogLine {
  id: number;
  jobId: string;
  batchSeq: number;
}

export interface JobQueue {
  /**
   * Queue a job. The agent must exist in this workspace and be active, and
   * (in the DB) the operation must belong to it. Throws `not_found` otherwise.
   */
  enqueue(input: EnqueueJobInput): Promise<AgentJob>;
  /** Claim up to `max` queued, unexpired jobs, oldest first; exclusive. */
  claimNext(input: { workspaceId: string; agentId: string; max?: number; leaseMs?: number }): Promise<AgentJob[]>;
  /** The job is handed to the agent: extend the lease to cover its timeout. False when not claimed by this agent. */
  markRunning(input: { workspaceId: string; agentId: string; jobId: string; leaseMs: number }): Promise<boolean>;
  /** First result of a job this agent holds (claimed/running) wins: true. Anything else: false. */
  settle(input: { workspaceId: string; agentId: string; jobId: string; status: AgentJobResultStatus; result?: unknown; error?: string }): Promise<boolean>;
  /** Cancel a job that has not finished (control-plane initiated). Null when unknown or already settled. */
  cancel(workspaceId: string, jobId: string, reason?: string): Promise<AgentJob | null>;
  /**
   * NEW (not in ws-db yet): the control plane stops waiting. queued → `expired`
   * (never delivered), claimed/running → `timed_out` (outcome unknown). Null
   * when the job is unknown or already settled. A late result then gets
   * `settle() === false` (HTTP 409 `already_settled`).
   */
  expireOne(workspaceId: string, jobId: string, reason: string): Promise<AgentJob | null>;
  get(workspaceId: string, jobId: string): Promise<AgentJob | null>;
  listForOperation(workspaceId: string, operationId: string): Promise<AgentJob[]>;
  /**
   * The reaper (cross-tenant, system): unclaimed past expiry → `expired`,
   * claimed/running past lease → `timed_out`. Returns the affected jobs so the
   * caller can reconcile each operation to `uncertain`. Nothing is re-queued.
   */
  expireStale(limit?: number): Promise<AgentJob[]>;
  /**
   * Append one batch of log lines from the agent that holds the job. A retried
   * append of the same `batchSeq` does not duplicate lines. Returns how many
   * lines were stored; null when the job is not this agent's in this workspace.
   * At most `STORE_LOG_BATCH_LINES` lines per call.
   */
  appendLogs(input: { workspaceId: string; agentId: string; jobId: string; batchSeq: number; lines: readonly JobLogLine[] }): Promise<number | null>;
  /** NEW (not in ws-db yet): stored log volume of a job, one aggregate query. */
  logUsage(workspaceId: string, jobId: string): Promise<{ lines: number; bytes: number }>;
  listLogs(input: { workspaceId: string; jobId: string; afterId?: number; limit?: number }): Promise<JobLogEntry[]>;
}

/* ---------------------------------- store ---------------------------------- */

export interface RunnerStore {
  readonly tokens: {
    /** Store only the hash. Returns the (database-clock) expiry. */
    create(input: CreateRegistrationTokenInput): Promise<{ tokenHash: string; expiresAt: string }>;
  };
  readonly runners: AgentRegistry;
  readonly machines: AgentRegistry;
  readonly nonces: {
    /** True when the nonce is fresh for this agent (accept), false when seen within the window (replay). Atomic. */
    remember(agentId: string, nonce: string, windowMs: number): Promise<boolean>;
    prune(olderThanMs?: number, limit?: number): Promise<number>;
  };
  /** runner jobs (`runner_jobs`) */
  readonly jobs: JobQueue;
  /** zenithd requests (`machine_requests`, to be added by WS-DB) */
  readonly machineRequests: JobQueue;
}

export const registryOf = (store: RunnerStore, kind: AgentKind): AgentRegistry => (kind === "runner" ? store.runners : store.machines);
export const queueOf = (store: RunnerStore, kind: AgentKind): JobQueue => (kind === "runner" ? store.jobs : store.machineRequests);

/* ---------------------------------- events --------------------------------- */

/**
 * The events the runner plane emits (subset of `PlatformEventType`). The
 * orchestrator maps them onto `events.append`. `data` is a bounded, redacted
 * summary: ids, kinds, statuses — never payloads, results or log lines.
 */
export interface RunnerEvent {
  type: "runner.registered" | "runner.revoked" | "runner.job.dispatched" | "runner.job.completed" | "machine.registered" | "machine.revoked" | "machine.request.completed";
  workspaceId: string;
  operationId?: string;
  agentId: string;
  /** the human who revoked, for `*.revoked` */
  actorId?: string;
  data: Record<string, unknown>;
}

export interface RunnerEventSink {
  emit(event: RunnerEvent): void | Promise<void>;
}
