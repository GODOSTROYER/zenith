/**
 * The platform-store ports, implemented for real over the merged control store
 * (`@/lib/controlplane`): operations ledger, leases, events, evidence,
 * resources/observations/drift and provider connections.
 *
 *     const db = await platformDb();                     // Postgres, or PGlite in development
 *     const ports = createPlatformPorts(db);
 *     createExecutionActivities({ ...ports, product: createProductPort(), … });
 *
 * The adapters add no authority of their own: every call is a repository call,
 * workspace-scoped in SQL. `getForSystem` is the explicit exception: this
 * trusted worker lookup receives only an id and must never be exposed on a
 * tenant request path. Plan metadata and suspension use store services, with
 * audit events in the same transaction; no SQL is issued by this adapter.
 *
 * Status mapping (the workflow's statuses onto the ledger's state machine):
 *
 *   running            approved|queued → `claimOperation` (digest-checked, approvals consumed once);
 *                      already running → no-op
 *   awaiting_approval  running → `suspendForApproval`; otherwise no-op
 *   succeeded|failed   running → `completeOperation`
 *   uncertain          running → `uncertain` (+ `operation.uncertain`)
 *   cancelled          pre-execution → `cancelOperation`; running → `cancelRunningOperation`
 *                      (a requested stop, with no claim of cloud rollback)
 *   expired            pre-execution → `expired` (+ event)
 *
 * A request that finds the operation already terminal changes nothing and returns
 * the record as it is ("terminal is terminal"). Definitive refusals from the
 * claim (expired, digest changed, approval missing) become `StepFailedError`:
 * retrying them cannot help.
 *
 * The execution heartbeat holder is `workflow:<operationId>`, not a worker id, so
 * any worker's activity can extend the claim.
 */
import { claimOperation, cancelOperation, cancelRunningOperation, completeOperation, suspendForApproval, setPlanDigest, setPolicyDecision } from "@/lib/controlplane/operations";
import { emitForOperation } from "@/lib/controlplane/events";
import * as repos from "@/lib/controlplane/db/repos";
import { HEX64 } from "@/lib/controlplane/db/sql";
import { TERMINAL_OPERATION_STATUSES, type OperationRecord, type Sql } from "@/lib/controlplane/types";
import type { ConnectionsPort, EventsPort, EvidencePort, LeasesPort, OperationsPort, ResourcesPort } from "./ports";
import { errorCode, StepFailedError } from "./errors";
import { errorText } from "./text";

/** How long a claim stays valid without a heartbeat (every activity and keep-alive tick extends it). */
export const CLAIM_LEASE_MS = 5 * 60_000;

const DEFINITIVE_CLAIM_ERRORS = new Set(["operation_expired", "digest_mismatch", "approval_required", "policy_changed", "operation_not_found", "invalid_state"]);

export const executionHolder = (operationId: string): string => `workflow:${operationId}`;

const isTerminal = (status: OperationRecord["status"]): boolean => TERMINAL_OPERATION_STATUSES.includes(status);

export function createOperationsPort(sql: Sql): OperationsPort {
  const current = async (workspaceId: string, id: string): Promise<OperationRecord | null> => repos.operations.get(sql, workspaceId, id);

  const markUncertain = async (workspaceId: string, id: string, reason: string): Promise<OperationRecord | null> =>
    sql.tx(async (tx) => {
      const op = await repos.operations.transition(tx, { workspaceId, id, from: ["running"], to: "uncertain", patch: { error: reason.slice(0, 1000) } });
      if (!op) return repos.operations.get(tx, workspaceId, id);
      await emitForOperation(tx, op, "operation.uncertain", { data: { reason: reason.slice(0, 500) } });
      return op;
    });

  return {
    async get(operationId) {
      return repos.operations.getForSystem(sql, operationId);
    },

    async transition({ workspaceId, operationId, to, error }) {
      const op = await current(workspaceId, operationId);
      if (!op) return null;
      if (op.status === to || isTerminal(op.status)) return op;
      try {
        switch (to) {
          case "running":
            if (op.status === "approved" || op.status === "queued") {
              const decision = op.policyDecisionId ? await repos.policyDecisions.get(sql, workspaceId, op.policyDecisionId) : null;
              return await claimOperation(sql, { workspaceId, id: operationId, expectedDigest: op.proposalDigest, holder: executionHolder(operationId), leaseMs: CLAIM_LEASE_MS, expectedPolicyVersion: decision?.policyVersion });
            }
            return op;
          case "awaiting_approval":
            // The workflow releases its environment lease before this gate.
            // Suspension only removes authority; callers that still hold a
            // lease can use the store service's optional live-fence check.
            return op.status === "running" ? ((await suspendForApproval(sql, { workspaceId, id: operationId })) ?? (await current(workspaceId, operationId))) : op;
          case "succeeded":
          case "failed":
            return op.status === "running" ? ((await completeOperation(sql, { workspaceId, id: operationId, outcome: to, error })) ?? (await current(workspaceId, operationId))) : op;
          case "uncertain":
            return op.status === "running" ? await markUncertain(workspaceId, operationId, error ?? "The outcome could not be proven.") : op;
          case "cancelled":
            if (op.status === "running") {
              return (await cancelRunningOperation(sql, { workspaceId, id: operationId, reason: error, fence: recordedFence(op) })) ?? (await current(workspaceId, operationId));
            }
            return (await cancelOperation(sql, { workspaceId, id: operationId, reason: error })) ?? (await current(workspaceId, operationId));
          case "expired":
            if (op.status === "running") return op;
            return sql.tx(async (tx) => {
              const moved = await repos.operations.transition(tx, { workspaceId, id: operationId, from: [op.status], to: "expired", patch: { error } });
              if (moved) await emitForOperation(tx, moved, "operation.cancelled", { data: { reason: "expired" } });
              return moved ?? (await repos.operations.get(tx, workspaceId, operationId));
            });
        }
      } catch (err) {
        const code = errorCode(err);
        if (code && DEFINITIVE_CLAIM_ERRORS.has(code)) throw new StepFailedError(`The operation could not be moved to ${to}: ${errorText(err)}`);
        throw err;
      }
    },

    markUncertain: ({ workspaceId, operationId, reason }) => markUncertain(workspaceId, operationId, reason),

    async heartbeat({ workspaceId, operationId }) {
      return repos.operations.heartbeat(sql, { workspaceId, id: operationId, holder: executionHolder(operationId), leaseMs: CLAIM_LEASE_MS });
    },

    async setPlanDigest({ workspaceId, operationId, planDigest }) {
      if (!HEX64.test(planDigest)) throw new StepFailedError("The plan digest is not a SHA-256 hex digest.");
      const recorded = await setPlanDigest(sql, { workspaceId, id: operationId, planDigest });
      const op = recorded ?? await current(workspaceId, operationId);
      if (op && op.planDigest !== planDigest) throw new StepFailedError("plan_changed: the recorded plan cannot be replaced. Review a new operation.");
    },

    async setPolicyDecision({ workspaceId, operationId, decisionId }) {
      const linked = await setPolicyDecision(sql, { workspaceId, id: operationId, decisionId });
      if (linked) return;
      const op = await current(workspaceId, operationId);
      if (!op || op.policyDecisionId === decisionId || (op.status !== "running" && op.status !== "awaiting_approval")) return;
      const decision = await repos.policyDecisions.get(sql, workspaceId, decisionId);
      if (!decision || (decision.operationId !== undefined && decision.operationId !== operationId)) return;
      // A real replacement refused after review began must stop the activity:
      // silently retaining older requirements could authorize a changed policy.
      throw new StepFailedError("The policy decision could not be linked to the operation's current approval round. Review a fresh operation before continuing.");
    },
  };
}

function recordedFence(op: OperationRecord): { scope: string; fenceToken: number } | undefined {
  return op.leaseScope !== undefined && op.fenceToken !== undefined ? { scope: op.leaseScope, fenceToken: op.fenceToken } : undefined;
}

export function createLeasesPort(sql: Sql): LeasesPort {
  return {
    async acquire(input) {
      if(!input.operation)return repos.leases.acquire(sql,input);
      const requested={...input,operation:Object.freeze({...input.operation})};
      try {
        return await repos.operations.acquireExecutionLease(sql,requested);
      } catch(err) {
        if(["invalid_input","invalid_state","digest_mismatch","operation_not_found","operation_expired","tenant_mismatch"].includes(errorCode(err)??""))
          throw new StepFailedError("The running workflow claim could not bind its environment lease; no source was captured.");
        throw err;
      }
    },
    renew: (lease, ttlMs) => repos.leases.renew(sql, lease, ttlMs),
    release: (lease) => repos.leases.release(sql, lease),
    assertFence: (scope, fenceToken) => repos.leases.assertFence(sql, scope, fenceToken),
  };
}

export function createEventsPort(sql: Sql): EventsPort {
  return {
    async append(event) {
      await repos.events.append(sql, { ...event, correlationId: event.correlationId });
    },
  };
}

export function createEvidencePort(sql: Sql): EvidencePort {
  return {
    async append(input) {
      // Insert-or-return on a deterministic id: a retried activity appends the same row once.
      if (input.id) {
        const existing = await repos.evidence.get(sql, input.workspaceId, input.id);
        if (existing) return existing;
      }
      try {
        return await repos.evidence.insert(sql, input);
      } catch (err) {
        if (input.id) {
          const raced = await repos.evidence.get(sql, input.workspaceId, input.id);
          if (raced) return raced;
        }
        throw err;
      }
    },
    async find({ workspaceId, operationId, kind, digest, stage }) {
      const rows = await repos.evidence.list(sql, workspaceId, { operationId, limit: 200 });
      return rows.find((r) => r.kind === kind && (digest === undefined || r.digest === digest) && (stage === undefined || r.summary.stage === stage)) ?? null;
    },
  };
}

export function createResourcesPort(sql: Sql): ResourcesPort {
  return {
    upsertDesired: ({ workspaceId, projectId, environmentId, node, revisionId }) => repos.resources.upsertDesired(sql, { workspaceId, projectId, environmentId, node, revisionId }),
    list: (workspaceId, environmentId) => repos.resources.listByEnvironment(sql, workspaceId, environmentId),
    get: (workspaceId, resourceId) => repos.resources.get(sql, workspaceId, resourceId),
    async setStatus({ workspaceId, resourceId, status }) {
      await repos.resources.setStatus(sql, workspaceId, resourceId, status);
    },
    appendObservation: ({ workspaceId, resourceId, observation }) => repos.observations.appendObservation(sql, { workspaceId, resourceId, observation }),
    async upsertRuntime({ workspaceId, resourceId, runtime }) {
      await repos.observations.upsertRuntime(sql, { workspaceId, resourceId, runtime });
    },
    latestDriftReport: (workspaceId, environmentId) => repos.drift.latest(sql, workspaceId, environmentId),
    activeOwnershipTransfers: (workspaceId, environmentId) => repos.ownershipTransfers.listActive(sql, workspaceId, environmentId),
    async saveDriftReport({ workspaceId, report }) {
      await repos.drift.insert(sql, { workspaceId, report });
    },
  };
}

export function createConnectionsPort(sql: Sql): ConnectionsPort {
  return {
    async resolve({ workspaceId, connectionId }) {
      const direct = await repos.connections.get(sql, workspaceId, connectionId);
      // A revoked connection is final: it never resolves, and never falls through to another connection
      // (no privileged fallback after revocation).
      if (direct) return direct.status === "revoked" ? null : direct;
      // The environment points at the PRODUCT connection; the platform connection extends it.
      const all = await repos.connections.list(sql, workspaceId);
      const matches = all.filter((c) => c.legacyConnectionId === connectionId && c.status !== "revoked" && c.revokedAt === undefined);
      return matches.find((c) => c.status === "verified") ?? matches[0] ?? null;
    },
  };
}

export interface PlatformPorts {
  ops: OperationsPort;
  leases: LeasesPort;
  events: EventsPort;
  evidence: EvidencePort;
  resources: ResourcesPort;
  connections: ConnectionsPort;
}

/** All six platform-store ports over one handle. Pass the top-level `PlatformDb`, never an open transaction. */
export function createPlatformPorts(sql: Sql): PlatformPorts {
  return {
    ops: createOperationsPort(sql),
    leases: createLeasesPort(sql),
    events: createEventsPort(sql),
    evidence: createEvidencePort(sql),
    resources: createResourcesPort(sql),
    connections: createConnectionsPort(sql),
  };
}
