/**
 * `RunnerStore` over the platform control store (ADR-0002) — Postgres in
 * production, PGlite locally and in tests, the same SQL on both.
 *
 *   port                     backed by
 *   -----------------------  --------------------------------------------------------------
 *   tokens.create            repos.runners.createRegistrationToken
 *   runners.*                repos.runners  (registerRunner consumes the token atomically)
 *   machines.*               repos.machines (zenithd rows only; revoke also cancels requests)
 *   nonces.*                 repos.nonces
 *   jobs.*                   repos.jobs     (+ one aggregate query for `logUsage`)
 *   machineRequests.*        ./machine-requests (platform.machine_requests — see the migration)
 *
 * Nothing here adds semantics: each port method is one repository call (or the
 * mirror SQL for machines), so the in-memory store and this one are checked
 * against the same contract tests (tests/runners/store-contract.test.ts).
 *
 * Translations only: `ControlStoreError` codes the runner plane branches on
 * become `RunnerStoreError`; a `secret_material` refusal of an error string
 * settles the job with a withheld message instead of losing the result.
 */
import { ControlStoreError, PlatformDbError, repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import type { RunnerJob } from "@/lib/controlplane/db/repos/jobs";
import { createMachineRequestQueue } from "@/lib/runners/db/machine-requests";
import { get as getEffectReceipt } from "@/lib/controlplane/db/repos/agent-effect-receipts";
import {
  RunnerStoreError,
  type AgentJob,
  type AgentRecord,
  type AgentRegistry,
  type JobQueue,
  type RunnerStore,
} from "@/lib/runners/ports";
import { MACHINE_PROTOCOL, RUNNER_PROTOCOL } from "@/lib/runners/types";

/** Keep only what the runner plane branches on; everything else propagates unchanged. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ControlStoreError) {
      if (error.code === "invalid_registration_token") throw new RunnerStoreError("invalid_registration_token", error.message);
      if (error.code === "not_found" || error.code === "tenant_mismatch") throw new RunnerStoreError("not_found", error.message);
      if (error.code === "invalid_input" || error.code === "value_out_of_range") throw new RunnerStoreError("invalid_input", error.message);
      if (error.code === "conflict") throw new RunnerStoreError("conflict", error.message);
    }
    if (error instanceof PlatformDbError && error.isUniqueViolation) throw new RunnerStoreError("conflict", "That id already exists.");
    throw error;
  }
}

const strings = (host: Record<string, unknown>): Record<string, string> => Object.fromEntries(Object.entries(host).map(([k, v]) => [k, String(v)]));

type RunnerRow = NonNullable<Awaited<ReturnType<typeof repos.runners.getRunner>>>;
type MachineRow = NonNullable<Awaited<ReturnType<typeof repos.machines.getMachine>>>;

const runnerRecord = (r: RunnerRow): AgentRecord => ({
  kind: "runner",
  id: r.id,
  workspaceId: r.workspaceId,
  name: r.name,
  status: r.status,
  protocol: r.protocol || RUNNER_PROTOCOL,
  publicKey: r.publicKey,
  version: r.version,
  capabilities: r.capabilities,
  labels: r.labels,
  host: strings(r.host),
  registeredAt: r.registeredAt,
  lastHeartbeatAt: r.lastHeartbeatAt,
  revokedAt: r.revokedAt,
  stale: r.stale,
});

const machineRecord = (m: MachineRow): AgentRecord => ({
  kind: "machine",
  id: m.id,
  workspaceId: m.workspaceId,
  name: m.name,
  status: m.status === "revoked" ? "revoked" : "active",
  protocol: MACHINE_PROTOCOL,
  publicKey: m.publicKey ?? "",
  version: m.version,
  capabilities: m.capabilities,
  labels: m.labels,
  host: strings(m.host),
  environmentId: m.environmentId,
  address: m.address,
  registeredAt: m.registeredAt,
  lastHeartbeatAt: m.lastHeartbeatAt,
  revokedAt: m.revokedAt,
  stale: m.stale,
});

/** A zenithd machine that can authenticate: a transport-addressed target has no key and no heartbeat. */
const isAgent = (m: MachineRow | null): m is MachineRow => m !== null && m.transport === "zenithd" && !!m.publicKey;

const jobRecord = (j: RunnerJob): AgentJob => ({
  id: j.id,
  agentId: j.runnerId,
  workspaceId: j.workspaceId,
  operationId: j.operationId,
  kind: j.kind,
  capability: j.capability,
  envelope: j.envelope,
  status: j.status,
  leaseUntil: j.leaseUntil,
  result: j.result,
  error: j.error,
  createdAt: j.createdAt,
  claimedAt: j.claimedAt,
  startedAt: j.startedAt,
  expiresAt: j.expiresAt,
  settledAt: j.settledAt,
});

function runnerJobQueue(sql: Sql): JobQueue {
  return {
    settleOutcome: i => guard(() => repos.jobs.settleOutcome(sql, i)),
    getEffectReceipt: (workspaceId, jobId) => guard(() => getEffectReceipt(sql, { workspaceId, jobId, agentKind: "runner" })),
    enqueue: (i) => guard(async () => jobRecord(await repos.jobs.enqueue(sql, { id: i.id, workspaceId: i.workspaceId, runnerId: i.agentId, operationId: i.operationId, kind: i.kind, capability: i.capability, envelope: i.envelope, ttlMs: i.ttlMs }))),
    claimNext: (i) => guard(async () => (await repos.jobs.claimNext(sql, { workspaceId: i.workspaceId, runnerId: i.agentId, max: i.max, leaseMs: i.leaseMs })).map(jobRecord)),
    markRunning: (i) => guard(() => repos.jobs.markRunning(sql, { workspaceId: i.workspaceId, runnerId: i.agentId, jobId: i.jobId, leaseMs: i.leaseMs })),
    async settle(i) {
      const base = { workspaceId: i.workspaceId, runnerId: i.agentId, jobId: i.jobId, status: i.status, result: i.result };
      try {
        return await guard(() => repos.jobs.settle(sql, { ...base, error: i.error }));
      } catch (error) {
        // the control store refuses error text that looks like a secret; losing the result is worse than withholding the text
        if (error instanceof ControlStoreError && error.code === "secret_material" && i.error !== undefined)
          return guard(() => repos.jobs.settle(sql, { ...base, error: "[error withheld: it matched a secret pattern]" }));
        throw error;
      }
    },
    cancel: (ws, id, reason) => guard(async () => { const j = await repos.jobs.cancel(sql, ws, id, reason); return j ? jobRecord(j) : null; }),
    get: (ws, id) => guard(async () => { const j = await repos.jobs.get(sql, ws, id); return j ? jobRecord(j) : null; }),
    listForOperation: (ws, op) => guard(async () => (await repos.jobs.listForOperation(sql, ws, op)).map(jobRecord)),
    expireStale: (limit) => guard(async () => (await repos.jobs.expireStale(sql, limit)).map(jobRecord)),
    appendLogs: (i) => guard(() => repos.jobs.appendLogs(sql, { workspaceId: i.workspaceId, runnerId: i.agentId, jobId: i.jobId, batchSeq: i.batchSeq, lines: i.lines })),
    async logUsage(ws, id) {
      const rows = await sql.query<{ lines: number; bytes: number }>(
        "select count(*)::int as lines, coalesce(sum(octet_length(line)), 0)::bigint as bytes from platform.runner_job_logs where workspace_id = $1 and job_id = $2",
        [ws, id]
      );
      return { lines: rows[0]?.lines ?? 0, bytes: Number(rows[0]?.bytes ?? 0) };
    },
    listLogs: (i) => guard(() => repos.jobs.listLogs(sql, i)),
  };
}

/** The same error translation for a queue that talks to the database directly. */
function guardQueue(q: JobQueue): JobQueue {
  return {
    settleOutcome: i => guard(() => q.settleOutcome(i)),
    getEffectReceipt: (workspaceId, jobId) => guard(() => q.getEffectReceipt(workspaceId, jobId)),
    enqueue: (i) => guard(() => q.enqueue(i)),
    claimNext: (i) => guard(() => q.claimNext(i)),
    markRunning: (i) => guard(() => q.markRunning(i)),
    settle: (i) => guard(() => q.settle(i)),
    cancel: (ws, id, reason) => guard(() => q.cancel(ws, id, reason)),
    get: (ws, id) => guard(() => q.get(ws, id)),
    listForOperation: (ws, op) => guard(() => q.listForOperation(ws, op)),
    expireStale: (limit) => guard(() => q.expireStale(limit)),
    appendLogs: (i) => guard(() => q.appendLogs(i)),
    logUsage: (ws, id) => guard(() => q.logUsage(ws, id)),
    listLogs: (i) => guard(() => q.listLogs(i)),
  };
}

/** The runner plane's store, over one platform `Sql` (the process handle, or a transaction). */
export function createPlatformRunnerStore(sql: Sql): RunnerStore {
  const machineRequests = guardQueue(createMachineRequestQueue(sql));

  const runners: AgentRegistry = {
    register: (i) => guard(async () => runnerRecord(await repos.runners.registerRunner(sql, { tokenHash: i.tokenHash, id: i.id, name: i.name, publicKey: i.publicKey, version: i.version, capabilities: i.capabilities, labels: i.labels, host: i.host }))),
    findForAuth: async (id) => {
      const r = await repos.runners.findRunnerForAuth(sql, id);
      return r ? runnerRecord(r) : null;
    },
    get: async (ws, id) => {
      const r = await repos.runners.getRunner(sql, ws, id);
      return r ? runnerRecord(r) : null;
    },
    list: async (ws) => (await repos.runners.listRunners(sql, ws)).map(runnerRecord),
    heartbeat: (i) => guard(() => repos.runners.heartbeat(sql, i)),
    revoke: (ws, id) =>
      guard(async () => {
        const r = await repos.runners.revokeRunner(sql, ws, id);
        return r ? { agent: runnerRecord(r.runner), cancelledJobs: r.cancelledJobs } : null;
      }),
  };

  const machines: AgentRegistry = {
    register: (i) => guard(async () => machineRecord(await repos.machines.registerMachine(sql, { tokenHash: i.tokenHash, id: i.id, name: i.name, publicKey: i.publicKey, version: i.version, capabilities: i.capabilities, labels: i.labels, host: i.host }))),
    findForAuth: async (id) => {
      const m = await repos.machines.findMachineForAuth(sql, id);
      return isAgent(m) ? machineRecord(m) : null;
    },
    get: async (ws, id) => {
      const m = await repos.machines.getMachine(sql, ws, id);
      return isAgent(m) ? machineRecord(m) : null;
    },
    list: async (ws) => (await repos.machines.listMachines(sql, ws, { transport: "zenithd" })).map(machineRecord),
    heartbeat: (i) => guard(() => repos.machines.heartbeatMachine(sql, i)),
    revoke: (ws, id) =>
      guard(() =>
        sql.tx(async (tx) => {
          // only zenithd machines are agents: a transport-addressed target (SSM, pod, …) is not ours to revoke
          if (!isAgent(await repos.machines.getMachine(tx, ws, id))) return null;
          const m = await repos.machines.revokeMachine(tx, ws, id);
          if (!m) return null;
          // same rule as runners: cancel what has not been handed over (queued, claimed); running work is left for the reaper
          const cancelled = await tx.query<{ id: string }>(
            `update platform.machine_requests set status = 'cancelled', settled_at = clock_timestamp(), lease_until = null, error = coalesce(error, 'machine revoked')
              where workspace_id = $1 and machine_id = $2 and status in ('queued','claimed') returning id`,
            [ws, id]
          );
          return { agent: machineRecord(m), cancelledJobs: cancelled.length };
        })
      ),
  };

  return {
    tokens: {
      create: (i) => guard(() => repos.runners.createRegistrationToken(sql, i)),
    },
    runners,
    machines,
    nonces: {
      remember: (agentId, nonce, windowMs) => repos.nonces.remember(sql, agentId, nonce, windowMs),
      prune: (olderThanMs, limit) => repos.nonces.prune(sql, olderThanMs, limit),
    },
    jobs: runnerJobQueue(sql),
    machineRequests,
  };
}
