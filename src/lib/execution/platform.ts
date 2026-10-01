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
 * workspace-scoped in SQL. Three places go beyond what the repositories expose,
 * and they are listed here because each is a request to the store's owner:
 *
 *  1. `OperationsPort.get(id)` looks an operation up by id alone (the workflow
 *     hands activities only an id). The repository's `get` needs the workspace.
 *  2. The workflow's plan-level approval gate needs `running → awaiting_approval`
 *     (release the claim, require approval) and then `approved → running` again.
 *     The ledger's state machine has no such edge (`running` leads only to a
 *     terminal status), and `approvals.record` only accepts an operation that is
 *     `awaiting_approval`. `suspendForApproval` below performs exactly that one
 *     edge with a conditional UPDATE (`where status = 'running'`), clears the
 *     execution claim and sets `approval_required`; it can only make an
 *     operation MORE restricted. The proper fix is a repository function
 *     (`operations.suspendForApproval`) and then this SQL goes away.
 *  3. `setPlanDigest` and `setPolicyDecision` are standalone column writes; the
 *     repository only sets them as part of a status transition (and
 *     `policyDecisionId` only when leaving `proposed`). Approvers' requirements
 *     are read from the operation's `policy_decision_id`, so a plan-level
 *     re-evaluation must be able to link its decision. Same remedy.
 *
 * Status mapping (the workflow's statuses onto the ledger's state machine):
 *
 *   running            approved|queued → `claimOperation` (digest-checked, approvals consumed once);
 *                      already running → no-op
 *   awaiting_approval  running → `suspendForApproval`; otherwise no-op
 *   succeeded|failed   running → `completeOperation`
 *   uncertain          running → `uncertain` (+ `operation.uncertain`)
 *   cancelled          pre-execution → `cancelOperation`; RUNNING has no ledger edge to `cancelled`, so it
 *                      ends `uncertain` if a mutating call had begun (a `resource.applying` event exists),
 *                      else `failed` with the cancellation text
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
import { claimOperation, cancelOperation, completeOperation } from "@/lib/controlplane/operations";
import { emitForOperation } from "@/lib/controlplane/events";
import * as repos from "@/lib/controlplane/db/repos";
import { OPERATION_COLUMNS, toOperation, type OperationRow } from "@/lib/controlplane/db/repos/operations";
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

  const suspendForApproval = async (workspaceId: string, id: string): Promise<OperationRecord | null> => {
    const rows = await sql.query<OperationRow>(
      `update platform.operations
          set status = 'awaiting_approval', approval_required = true, updated_at = clock_timestamp(),
              lease_holder = null, lease_until = null, lease_scope = null, fence_token = null
        where workspace_id = $1 and id = $2 and status = 'running'
        returning ${OPERATION_COLUMNS}`,
      [workspaceId, id]
    );
    return rows.length ? toOperation(rows[0]) : current(workspaceId, id);
  };

  const mutationBegan = async (workspaceId: string, id: string): Promise<boolean> => {
    const rows = await sql.query<{ n: number }>("select 1 as n from platform.events where workspace_id = $1 and operation_id = $2 and type = 'resource.applying' limit 1", [workspaceId, id]);
    return rows.length > 0;
  };

  const markUncertain = async (workspaceId: string, id: string, reason: string): Promise<OperationRecord | null> =>
    sql.tx(async (tx) => {
      const op = await repos.operations.transition(tx, { workspaceId, id, from: ["running"], to: "uncertain", patch: { error: reason.slice(0, 1000) } });
      if (!op) return repos.operations.get(tx, workspaceId, id);
      await emitForOperation(tx, op, "operation.uncertain", { data: { reason: reason.slice(0, 500) } });
      return op;
    });

  return {
    async get(operationId) {
      const rows = await sql.query<OperationRow>(`select ${OPERATION_COLUMNS} from platform.operations where id = $1`, [operationId]);
      return rows.length ? toOperation(rows[0]) : null;
    },

    async transition({ workspaceId, operationId, to, error }) {
      const op = await current(workspaceId, operationId);
      if (!op) return null;
      if (op.status === to || isTerminal(op.status)) return op;
      try {
        switch (to) {
          case "running":
            if (op.status === "approved" || op.status === "queued") {
              return await claimOperation(sql, { workspaceId, id: operationId, expectedDigest: op.proposalDigest, holder: executionHolder(operationId), leaseMs: CLAIM_LEASE_MS });
            }
            return op;
          case "awaiting_approval":
            return op.status === "running" ? await suspendForApproval(workspaceId, operationId) : op;
          case "succeeded":
          case "failed":
            return op.status === "running" ? ((await completeOperation(sql, { workspaceId, id: operationId, outcome: to, error })) ?? (await current(workspaceId, operationId))) : op;
          case "uncertain":
            return op.status === "running" ? await markUncertain(workspaceId, operationId, error ?? "The outcome could not be proven.") : op;
          case "cancelled":
            if (op.status === "running") {
              if (await mutationBegan(workspaceId, operationId)) return await markUncertain(workspaceId, operationId, error ?? "Cancelled after changes had begun; the outcome could not be proven.");
              return (await completeOperation(sql, { workspaceId, id: operationId, outcome: "failed", error: error ?? "Cancelled by request before any change was made." })) ?? (await current(workspaceId, operationId));
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
      await sql.query("update platform.operations set plan_digest = coalesce(plan_digest, $3), updated_at = clock_timestamp() where workspace_id = $1 and id = $2", [workspaceId, operationId, planDigest]);
    },

    async setPolicyDecision({ workspaceId, operationId, decisionId }) {
      await sql.query(
        `update platform.operations set policy_decision_id = $3, updated_at = clock_timestamp()
          where workspace_id = $1 and id = $2 and status in ('running','awaiting_approval')
            and exists (select 1 from platform.policy_decisions d where d.workspace_id = $1 and d.id = $3)`,
        [workspaceId, operationId, decisionId]
      );
    },
  };
}

export function createLeasesPort(sql: Sql): LeasesPort {
  return {
    acquire: (input) => repos.leases.acquire(sql, input),
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
    async find({ workspaceId, operationId, kind, digest }) {
      const rows = await repos.evidence.list(sql, workspaceId, { operationId, limit: 200 });
      return rows.find((r) => r.kind === kind && (digest === undefined || r.digest === digest)) ?? null;
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
    async saveDriftReport({ workspaceId, report }) {
      await repos.drift.insert(sql, { workspaceId, report });
    },
  };
}

export function createConnectionsPort(sql: Sql): ConnectionsPort {
  return {
    async resolve({ workspaceId, connectionId }) {
      const direct = await repos.connections.get(sql, workspaceId, connectionId);
      if (direct && direct.status !== "revoked") return direct;
      // The environment points at the PRODUCT connection; the platform connection extends it.
      const all = await repos.connections.list(sql, workspaceId);
      const matches = all.filter((c) => c.legacyConnectionId === connectionId);
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
