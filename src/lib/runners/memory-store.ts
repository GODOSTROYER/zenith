/**
 * In-memory `RunnerStore` with the semantics of the platform control store's
 * repositories (`runners.ts`, `jobs.ts`, `nonces.ts`, `machines.ts`).
 *
 * It is what tests and local development run on — NOT a production store: it
 * lives in one process, so on a serverless deployment a registration made on
 * one instance would be invisible to the next. `runtime.ts` refuses to use it
 * in production unless `ZENITH_RUNNER_STORE=memory` says so explicitly.
 *
 * Every operation here is synchronous inside (no `await` between a check and
 * the write it guards), so each one is atomic exactly as the equivalent single
 * SQL statement is; concurrency tests exercise the callers, not JS timing.
 *
 * Faithful to the DB: status transitions are conditional; claim order is
 * creation order; staleness is derived on the store clock; results are
 * structurally cloned in and out (nothing the caller holds aliases store
 * state). Not modelled: the DB's per-value secret scan on results and log
 * lines (the service redacts and seals first), and the operation foreign key
 * unless `operationExists` is supplied.
 */
import { randomUUID } from "node:crypto";
import {
  RunnerStoreError,
  type AgentJob,
  type AgentJobResultStatus,
  type AgentJobStatus,
  type AgentRecord,
  type AgentRegistry,
  type CreateRegistrationTokenInput,
  type EnqueueJobInput,
  type JobLogEntry,
  type JobLogLine,
  type JobQueue,
  type RegisterAgentInput,
  type RunnerStore,
} from "@/lib/runners/ports";
import { AGENT_KINDS, STALE_AFTER_SEC, STORE_LOG_BATCH_LINES, MAX_LOG_LINES_PER_JOB, MAX_LOG_LINE_CHARS, MAX_ENVELOPE_BYTES, type AgentKind } from "@/lib/runners/types";

export interface MemoryStoreOptions {
  /** epoch milliseconds; inject a fake clock to test expiry, staleness and leases */
  now?: () => number;
  /** mimic the `runner_jobs → operations` foreign key */
  operationExists?: (workspaceId: string, operationId: string) => boolean;
}

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const HOUR_MS = 60 * 60 * 1000;

const iso = (ms: number): string => new Date(ms).toISOString();

function clamp(n: number | undefined, fallback: number, min: number, max: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function bounded(name: string, ms: number, min: number, max: number): number {
  if (!Number.isFinite(ms) || ms < min || ms > max) throw new RunnerStoreError("invalid_input", `${name} must be between ${min} and ${max} milliseconds.`);
  return Math.trunc(ms);
}

interface TokenRow {
  workspaceId: string;
  kind: AgentKind;
  binding: { environmentId?: string; address?: string };
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  usedBy?: string;
}

interface AgentRow {
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
  environmentId?: string;
  address?: string;
  registeredAt: number;
  lastHeartbeatAt?: number;
  revokedAt?: number;
}

interface JobRow {
  seq: number;
  id: string;
  agentId: string;
  workspaceId: string;
  operationId: string;
  kind: string;
  capability: string;
  envelope: string;
  status: AgentJobStatus;
  leaseUntil?: number;
  result?: unknown;
  error?: string;
  createdAt: number;
  claimedAt?: number;
  startedAt?: number;
  expiresAt: number;
  settledAt?: number;
}

interface LogRow {
  id: number;
  jobId: string;
  batchSeq: number;
  lineNo: number;
  ts: string;
  stream: JobLogLine["stream"];
  line: string;
}

export function createMemoryRunnerStore(options: MemoryStoreOptions = {}): RunnerStore {
  const now = options.now ?? Date.now;
  const tokens = new Map<string, TokenRow>();
  const agents: Record<AgentKind, Map<string, AgentRow>> = { runner: new Map(), machine: new Map() };
  const nonces = new Map<string, number>();
  let logSeq = 0;

  const toRecord = (row: AgentRow): AgentRecord => ({
    kind: row.kind,
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    protocol: row.protocol,
    publicKey: row.publicKey,
    version: row.version,
    capabilities: [...row.capabilities],
    labels: { ...row.labels },
    host: { ...row.host },
    environmentId: row.environmentId,
    address: row.address,
    registeredAt: iso(row.registeredAt),
    lastHeartbeatAt: row.lastHeartbeatAt === undefined ? undefined : iso(row.lastHeartbeatAt),
    revokedAt: row.revokedAt === undefined ? undefined : iso(row.revokedAt),
    stale: row.status === "active" && (row.lastHeartbeatAt ?? row.registeredAt) < now() - STALE_AFTER_SEC * 1000,
  });

  /* -------------------------------- queues -------------------------------- */

  function makeQueue(kind: AgentKind): { queue: JobQueue; cancelOpenFor: (workspaceId: string, agentId: string) => number } {
    const jobs = new Map<string, JobRow>();
    const logs = new Map<string, LogRow[]>();
    let seq = 0;

    const toJob = (row: JobRow): AgentJob => ({
      id: row.id,
      agentId: row.agentId,
      workspaceId: row.workspaceId,
      operationId: row.operationId,
      kind: row.kind,
      capability: row.capability,
      envelope: row.envelope,
      status: row.status,
      leaseUntil: row.leaseUntil === undefined ? undefined : iso(row.leaseUntil),
      result: row.result === undefined ? undefined : structuredClone(row.result),
      error: row.error,
      createdAt: iso(row.createdAt),
      claimedAt: row.claimedAt === undefined ? undefined : iso(row.claimedAt),
      startedAt: row.startedAt === undefined ? undefined : iso(row.startedAt),
      expiresAt: iso(row.expiresAt),
      settledAt: row.settledAt === undefined ? undefined : iso(row.settledAt),
    });

    const isActive = (workspaceId: string, agentId: string): boolean => {
      const a = agents[kind].get(agentId);
      return a !== undefined && a.workspaceId === workspaceId && a.status === "active";
    };

    const settleRow = (row: JobRow, status: AgentJobStatus, error?: string): void => {
      row.status = status;
      row.settledAt = now();
      row.leaseUntil = undefined;
      if (error !== undefined && row.error === undefined) row.error = error;
    };

    const queue: JobQueue = {
      async enqueue(input: EnqueueJobInput) {
        if (input.envelope.length === 0 || input.envelope.length > MAX_ENVELOPE_BYTES)
          throw new RunnerStoreError("invalid_input", "envelope must be a non-empty compact JWS of at most 256 KiB.");
        if (!input.id || input.id.length > 128) throw new RunnerStoreError("invalid_input", "id must be 1 to 128 characters.");
        const ttl = bounded("ttlMs", input.ttlMs ?? 5 * 60 * 1000, 1000, HOUR_MS);
        if (!isActive(input.workspaceId, input.agentId) || (options.operationExists && !options.operationExists(input.workspaceId, input.operationId)))
          throw new RunnerStoreError("not_found", "No active agent and operation with those ids in this workspace.");
        if (jobs.has(input.id)) throw new RunnerStoreError("conflict", "A job with this id already exists.");
        const createdAt = now();
        const row: JobRow = {
          seq: ++seq,
          id: input.id,
          agentId: input.agentId,
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          kind: input.kind,
          capability: input.capability,
          envelope: input.envelope,
          status: "queued",
          createdAt,
          expiresAt: createdAt + ttl,
        };
        jobs.set(row.id, row);
        return toJob(row);
      },

      async claimNext(input) {
        const lease = bounded("leaseMs", input.leaseMs ?? 60_000, 1000, 24 * HOUR_MS);
        const max = clamp(input.max, 1, 1, 20);
        if (!isActive(input.workspaceId, input.agentId)) return [];
        const t = now();
        const claimable = [...jobs.values()]
          .filter((j) => j.workspaceId === input.workspaceId && j.agentId === input.agentId && j.status === "queued" && j.expiresAt > t)
          .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
          .slice(0, max);
        for (const j of claimable) {
          j.status = "claimed";
          j.claimedAt = t;
          j.leaseUntil = t + lease;
        }
        return claimable.map(toJob);
      },

      async markRunning(input) {
        const lease = bounded("leaseMs", input.leaseMs, 1000, 24 * HOUR_MS);
        const j = jobs.get(input.jobId);
        const t = now();
        if (!j || j.workspaceId !== input.workspaceId || j.agentId !== input.agentId) return false;
        if ((j.status !== "claimed" && j.status !== "running") || j.leaseUntil === undefined || j.leaseUntil <= t) return false;
        j.status = "running";
        j.startedAt ??= t;
        j.leaseUntil = t + lease;
        return true;
      },

      async settle(input: { workspaceId: string; agentId: string; jobId: string; status: AgentJobResultStatus; result?: unknown; error?: string }) {
        if (!["succeeded", "failed", "rejected", "timed_out"].includes(input.status)) throw new RunnerStoreError("invalid_input", "status must be succeeded, failed, rejected or timed_out.");
        if (input.error !== undefined && input.error.length > 4000) throw new RunnerStoreError("invalid_input", "error is too long (max 4000 characters).");
        const j = jobs.get(input.jobId);
        if (!j || j.workspaceId !== input.workspaceId || j.agentId !== input.agentId) return false;
        if (j.status !== "claimed" && j.status !== "running") return false;
        j.result = input.result === undefined ? undefined : structuredClone(input.result);
        j.error = input.error;
        settleRow(j, input.status);
        return true;
      },

      async cancel(workspaceId, jobId, reason) {
        const j = jobs.get(jobId);
        if (!j || j.workspaceId !== workspaceId) return null;
        if (j.status !== "queued" && j.status !== "claimed" && j.status !== "running") return null;
        settleRow(j, "cancelled");
        if (reason !== undefined) j.error = reason;
        return toJob(j);
      },

      async expireOne(workspaceId, jobId, reason) {
        const j = jobs.get(jobId);
        if (!j || j.workspaceId !== workspaceId) return null;
        if (j.status !== "queued" && j.status !== "claimed" && j.status !== "running") return null;
        settleRow(j, j.status === "queued" ? "expired" : "timed_out", reason);
        return toJob(j);
      },

      async get(workspaceId, jobId) {
        const j = jobs.get(jobId);
        return j && j.workspaceId === workspaceId ? toJob(j) : null;
      },

      async listForOperation(workspaceId, operationId) {
        return [...jobs.values()]
          .filter((j) => j.workspaceId === workspaceId && j.operationId === operationId)
          .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
          .map(toJob);
      },

      async expireStale(limit = 100) {
        const t = now();
        const stale = [...jobs.values()]
          .filter((j) => (j.status === "queued" && j.expiresAt <= t) || ((j.status === "claimed" || j.status === "running") && j.leaseUntil !== undefined && j.leaseUntil <= t))
          .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
          .slice(0, clamp(limit, 100, 1, 1000));
        for (const j of stale) settleRow(j, j.status === "queued" ? "expired" : "timed_out", j.status === "queued" ? "not claimed before expiry" : "agent stopped reporting before its lease ended");
        return stale.map(toJob);
      },

      async appendLogs(input) {
        if (!Number.isInteger(input.batchSeq) || input.batchSeq < 0) throw new RunnerStoreError("invalid_input", "batchSeq must be a non-negative integer.");
        if (input.lines.length > STORE_LOG_BATCH_LINES) throw new RunnerStoreError("invalid_input", `A log batch holds at most ${STORE_LOG_BATCH_LINES} lines.`);
        const j = jobs.get(input.jobId);
        if (!j || j.workspaceId !== input.workspaceId || j.agentId !== input.agentId) return null;
        const rows = logs.get(j.id) ?? [];
        let room = MAX_LOG_LINES_PER_JOB - rows.length;
        let stored = 0;
        for (let i = 0; i < input.lines.length && room > 0; i++) {
          const l = input.lines[i];
          if (!["stdout", "stderr", "info"].includes(l.stream)) throw new RunnerStoreError("invalid_input", "stream must be stdout, stderr or info.");
          if (rows.some((r) => r.batchSeq === input.batchSeq && r.lineNo === i)) continue;
          rows.push({ id: ++logSeq, jobId: j.id, batchSeq: input.batchSeq, lineNo: i, ts: l.ts, stream: l.stream, line: String(l.line).slice(0, MAX_LOG_LINE_CHARS) });
          stored++;
          room--;
        }
        logs.set(j.id, rows);
        return stored;
      },

      async logUsage(workspaceId, jobId) {
        const j = jobs.get(jobId);
        if (!j || j.workspaceId !== workspaceId) return { lines: 0, bytes: 0 };
        const rows = logs.get(jobId) ?? [];
        return { lines: rows.length, bytes: rows.reduce((n, r) => n + Buffer.byteLength(r.line, "utf8"), 0) };
      },

      async listLogs(input) {
        const j = jobs.get(input.jobId);
        if (!j || j.workspaceId !== input.workspaceId) return [];
        const after = input.afterId ?? 0;
        return (logs.get(j.id) ?? [])
          .filter((r) => r.id > after)
          .slice(0, clamp(input.limit, 200, 1, 1000))
          .map((r): JobLogEntry => ({ id: r.id, jobId: r.jobId, batchSeq: r.batchSeq, ts: r.ts, stream: r.stream, line: r.line }));
      },
    };

    const cancelOpenFor = (workspaceId: string, agentId: string): number => {
      let n = 0;
      for (const j of jobs.values()) {
        if (j.workspaceId === workspaceId && j.agentId === agentId && (j.status === "queued" || j.status === "claimed")) {
          settleRow(j, "cancelled", "agent revoked");
          n++;
        }
      }
      return n;
    };

    return { queue, cancelOpenFor };
  }

  const runnerQueue = makeQueue("runner");
  const machineQueue = makeQueue("machine");
  const cancelOpen = { runner: runnerQueue.cancelOpenFor, machine: machineQueue.cancelOpenFor };

  /* ------------------------------ registries ------------------------------ */

  function makeRegistry(kind: AgentKind): AgentRegistry {
    const info = AGENT_KINDS[kind];
    const map = agents[kind];
    return {
      async register(input: RegisterAgentInput) {
        if (!PUBLIC_KEY.test(input.publicKey)) throw new RunnerStoreError("invalid_input", "publicKey must be the base64url of a raw 32-byte Ed25519 key.");
        if (!input.name || input.name.length > 200) throw new RunnerStoreError("invalid_input", "name must be 1 to 200 characters.");
        const id = input.id ?? `${info.idPrefix}_${randomUUID()}`;
        const t = now();
        const token = tokens.get(input.tokenHash);
        if (!token || token.kind !== kind || token.usedAt !== undefined || token.expiresAt <= t)
          throw new RunnerStoreError("invalid_registration_token", "The registration token is invalid, expired or already used.");
        if (map.has(id)) throw new RunnerStoreError("conflict", "An agent with this id already exists.");
        token.usedAt = t;
        token.usedBy = id;
        const row: AgentRow = {
          kind,
          id,
          workspaceId: token.workspaceId,
          name: input.name,
          status: "active",
          protocol: input.protocol,
          publicKey: input.publicKey,
          version: input.version,
          capabilities: [...input.capabilities],
          labels: { ...input.labels },
          host: { ...input.host },
          environmentId: kind === "machine" ? token.binding.environmentId : undefined,
          address: kind === "machine" ? token.binding.address : undefined,
          registeredAt: t,
        };
        map.set(id, row);
        return toRecord(row);
      },

      async findForAuth(id) {
        const row = map.get(id);
        return row ? toRecord(row) : null;
      },

      async get(workspaceId, id) {
        const row = map.get(id);
        return row && row.workspaceId === workspaceId ? toRecord(row) : null;
      },

      async list(workspaceId) {
        return [...map.values()]
          .filter((r) => r.workspaceId === workspaceId)
          .sort((a, b) => b.registeredAt - a.registeredAt || (a.id < b.id ? -1 : 1))
          .map(toRecord);
      },

      async heartbeat(input) {
        const row = map.get(input.id);
        if (!row || row.workspaceId !== input.workspaceId) return null;
        if (row.status === "revoked") return { revoked: true };
        row.lastHeartbeatAt = now();
        if (input.version !== undefined) row.version = input.version;
        if (input.capabilities !== undefined) row.capabilities = [...input.capabilities];
        if (input.host !== undefined) row.host = { ...input.host };
        return { revoked: false };
      },

      async revoke(workspaceId, id) {
        const row = map.get(id);
        if (!row || row.workspaceId !== workspaceId) return null;
        row.status = "revoked";
        row.revokedAt ??= now();
        return { agent: toRecord(row), cancelledJobs: cancelOpen[kind](workspaceId, id) };
      },
    };
  }

  return {
    tokens: {
      async create(input: CreateRegistrationTokenInput) {
        if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) throw new RunnerStoreError("invalid_input", "tokenHash must be the SHA-256 hex of the token (never the token itself).");
        if (input.kind !== "runner" && input.kind !== "machine") throw new RunnerStoreError("invalid_input", "kind must be runner or machine.");
        if (!input.workspaceId || !input.createdBy) throw new RunnerStoreError("invalid_input", "workspaceId and createdBy are required.");
        if (tokens.has(input.tokenHash)) throw new RunnerStoreError("conflict", "token already exists");
        const ttl = bounded("ttlMs", input.ttlMs ?? HOUR_MS, 1000, HOUR_MS);
        const createdAt = now();
        tokens.set(input.tokenHash, {
          workspaceId: input.workspaceId,
          kind: input.kind,
          binding: { ...(input.binding ?? {}) },
          createdBy: input.createdBy,
          createdAt,
          expiresAt: createdAt + ttl,
        });
        return { tokenHash: input.tokenHash, expiresAt: iso(createdAt + ttl) };
      },
    },
    runners: makeRegistry("runner"),
    machines: makeRegistry("machine"),
    nonces: {
      async remember(agentId, nonce, windowMs) {
        const window = bounded("windowMs", windowMs, 1000, 24 * HOUR_MS);
        const key = `${agentId}\u0000${nonce}`;
        const t = now();
        const seen = nonces.get(key);
        if (seen !== undefined && seen > t - window) return false;
        nonces.set(key, t);
        return true;
      },
      async prune(olderThanMs = 20 * 60 * 1000, limit = 10_000) {
        const cutoff = now() - olderThanMs;
        let n = 0;
        for (const [k, seen] of nonces) {
          if (n >= limit) break;
          if (seen <= cutoff) {
            nonces.delete(k);
            n++;
          }
        }
        return n;
      },
    },
    jobs: runnerQueue.queue,
    machineRequests: machineQueue.queue,
  };
}
