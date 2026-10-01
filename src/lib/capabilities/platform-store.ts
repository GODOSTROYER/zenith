/**
 * `PlatformBrokerStore` — the `BrokerStore` port over the platform control store
 * (`src/lib/controlplane`, ADR-0002): Postgres in production, PGlite in local
 * development and tests, one set of repositories and real transactions.
 *
 * Mapping (port method → store):
 *
 *   createOperation         one transaction: operations.proposeOperation (operation +
 *                           `operation.proposed`, idempotency reserved in the same
 *                           transaction) then operations.recordPolicyOutcome (decision row,
 *                           proposed → approved | awaiting_approval | denied, `policy.evaluated`,
 *                           `operation.approved` by policy / `operation.denied`). A replay
 *                           returns the original operation and decision and writes nothing.
 *   getOperation/list       repos.operations.get / list
 *   cancelOperation         operations.cancelOperation (conditional cancel + grant revocation + event)
 *   expireOperation         conditional UPDATE … expires_at <= clock_timestamp() + grant revocation + event
 *   completeOperation       operations.completeOperation (succeeded | failed) ; uncertain: the same
 *                           conditional running → uncertain transition, fenced, with `operation.uncertain`
 *   claimForExecution       operations.claimOperation (digest, expiry, fence, approval consumption,
 *                           `running`, `operation.started` — all in one transaction)
 *   recordPolicyDecision    repos.policyDecisions.insert
 *   getPolicyDecision       repos.policyDecisions.get
 *   recordApproval          approvals.decide (human-only, digest-bound, role, separation of duties,
 *                           one decision per approver, N distinct approvers; `operation.approved|rejected`)
 *   listApprovals           repos.approvals.listForOperation
 *   insertGrant/consume/    repos.grants.insert / consume / revokeForOperation
 *   revokeGrantsForOperation
 *   get/putEnvironment…     repos.settings.getEnvironmentSettings / putEnvironmentSettings. The store's
 *                           "never configured" default (level 1, isDefault) is passed through; the
 *                           BROKER applies the per-class default. Writing the autonomy level keeps the
 *                           row's existing `policyParams` (the upsert would otherwise reset them).
 *   get/putWorkspacePolicy  repos.settings.getWorkspacePolicy / putWorkspacePolicy
 *   appendEvent/listEvents  repos.events.append / list
 *
 * Every store refusal is translated to a `BrokerError` (`mapStoreError`), so the
 * broker answers identically whichever store is behind it: a wrong-tenant id is
 * `not_found`, `policy_changed` is `reapproval_required`, an idempotency
 * conflict is `idempotency_conflict`, a lost lease is `lease_lost`, a foreign-key
 * violation on (workspace_id, operation_id) is `not_found`, a behind or
 * tampered schema is `platform_store_unavailable`. Unexpected database errors
 * are rethrown untouched (the store already strips parameters and row values
 * from them) and `route()` answers them with a generic 500.
 */
import { ControlStoreError, IdempotencyConflictError, PlatformDbError } from "@/lib/controlplane/db/errors";
import * as approvalRepo from "@/lib/controlplane/db/repos/approvals";
import * as eventRepo from "@/lib/controlplane/db/repos/events";
import * as grantRepo from "@/lib/controlplane/db/repos/grants";
import * as operationRepo from "@/lib/controlplane/db/repos/operations";
import * as policyDecisionRepo from "@/lib/controlplane/db/repos/policy-decisions";
import * as settingsRepo from "@/lib/controlplane/db/repos/settings";
import { decide } from "@/lib/controlplane/approvals";
import { cancelOperation as cancelOperationService, claimOperation, completeOperation as completeOperationService, proposeOperation, recordPolicyOutcome } from "@/lib/controlplane/operations";
import { emitForOperation } from "@/lib/controlplane/events";
import { LeaseLostError, type ApprovalRecord, type OperationRecord, type PlatformEvent, type PolicyDecisionRecord, type Principal, type Sql } from "@/lib/controlplane/types";
import type { AutonomyLevel } from "@/lib/policy";
import { BrokerError, notFound } from "./errors";
import type {
  BrokerStore,
  ClaimRequest,
  CompleteRequest,
  CreateOperationResult,
  EnvironmentSettings,
  GrantRecord,
  ListEventsRequest,
  NewDecision,
  NewEvent,
  NewOperation,
  OperationFilters,
  OperationPage,
  PageRequest,
  RecordApprovalRequest,
  RecordApprovalResult,
  WorkspacePolicySettings,
} from "./ports";

/** Translate a store failure into the broker's error vocabulary. Never returns. */
export function mapStoreError(error: unknown): never {
  if (error instanceof BrokerError) throw error;
  if (error instanceof LeaseLostError) throw new BrokerError("lease_lost", "The environment lease is no longer held; the operation must stop and be reconciled.");
  if (error instanceof IdempotencyConflictError) {
    throw new BrokerError("idempotency_conflict", "This idempotency key was already used for a different request.", "Send a new idempotency key for a new request, or resend the original request unchanged.");
  }
  // A composite foreign key (workspace_id, operation_id) rejected a row naming an operation of another
  // workspace (or none): that is a wrong-tenant id, and it answers like one.
  if (error instanceof PlatformDbError && error.sqlstate === "23503") throw notFound();
  if (error instanceof ControlStoreError) {
    switch (error.code) {
      case "invalid_input":
        throw new BrokerError("invalid_request", error.message);
      case "not_found":
      case "tenant_mismatch":
      case "operation_not_found":
        throw notFound();
      case "conflict":
        throw new BrokerError("conflict", error.message, undefined, error.details);
      case "idempotency_conflict":
        throw new BrokerError("idempotency_conflict", error.message);
      case "invalid_state":
        throw new BrokerError("invalid_state", error.message, undefined, error.details);
      case "digest_mismatch":
      case "operation_expired":
      case "approval_required":
      case "approver_not_human":
      case "approver_role_insufficient":
      case "separation_of_duties":
      case "duplicate_decision":
        throw new BrokerError(error.code, error.message, undefined, error.details);
      case "policy_changed":
        throw new BrokerError("reapproval_required", error.message);
      case "lease_unavailable":
        throw new BrokerError("conflict", error.message);
      case "secret_material":
        throw new BrokerError("secret_material", error.message);
      case "schema_behind":
      case "schema_tampered":
        throw new BrokerError("platform_store_unavailable", "The platform control store schema is not current, so capability requests are refused.", "An operator must run the platform migration.");
      default:
        break;
    }
  }
  throw error;
}

const PRE_EXECUTION = ["proposed", "awaiting_approval", "approved", "queued"] as const;

export class PlatformBrokerStore implements BrokerStore {
  constructor(private readonly db: Sql) {}

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      return mapStoreError(error);
    }
  }

  /* -------------------------------- operations ------------------------------- */

  createOperation(input: NewOperation): Promise<CreateOperationResult> {
    return this.run(() =>
      this.db.tx(async (tx) => {
        const created = await proposeOperation(tx, {
          id: input.id,
          workspaceId: input.workspaceId,
          principal: input.principal,
          proposal: input.proposal,
          correlationId: input.correlationId,
          ttlMs: input.ttlMs,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          actor: input.principal,
        });
        if (!created.created) {
          const decisionId = created.operation.policyDecisionId;
          const decision = decisionId ? await policyDecisionRepo.get(tx, input.workspaceId, decisionId) : null;
          if (!decision) throw new BrokerError("conflict", "The idempotency key is bound to an operation that has no recorded decision.");
          return { operation: created.operation, decision, created: false };
        }
        const outcome = await recordPolicyOutcome(tx, {
          workspaceId: input.workspaceId,
          operationId: created.operation.id,
          decision: {
            id: input.decisionId,
            policyVersion: input.decision.policyVersion,
            inputDigest: input.decision.inputDigest,
            outcome: input.decision.outcome,
            reasons: input.decision.reasons,
            ...(input.decision.approval ? { approval: input.decision.approval } : {}),
            ...(input.decision.constraints ? { constraints: input.decision.constraints } : {}),
          },
        });
        if (!outcome) throw new BrokerError("conflict", "The operation changed while its decision was being recorded.");
        return { operation: outcome.operation, decision: outcome.decision, created: true };
      })
    );
  }

  getOperation(workspaceId: string, id: string): Promise<OperationRecord | null> {
    return this.run(() => operationRepo.get(this.db, workspaceId, id));
  }

  listOperations(workspaceId: string, filters: OperationFilters = {}, page: PageRequest = {}): Promise<OperationPage> {
    return this.run(() => operationRepo.list(this.db, workspaceId, filters, page));
  }

  cancelOperation(input: { workspaceId: string; id: string; reason?: string; actor?: Principal }): Promise<OperationRecord | null> {
    return this.run(() => cancelOperationService(this.db, input));
  }

  expireOperation(input: { workspaceId: string; id: string }): Promise<OperationRecord | null> {
    return this.run(() =>
      this.db.tx(async (tx) => {
        const rows = await tx.query<operationRepo.OperationRow>(
          `update platform.operations set status = 'expired', finished_at = clock_timestamp(), updated_at = clock_timestamp()
            where workspace_id = $1 and id = $2 and status = any($3::text[]) and expires_at <= clock_timestamp()
            returning ${operationRepo.OPERATION_COLUMNS}`,
          [input.workspaceId, input.id, `{${PRE_EXECUTION.map((s) => `"${s}"`).join(",")}}`]
        );
        if (rows.length === 0) return null;
        const op = operationRepo.toOperation(rows[0]);
        await grantRepo.revokeForOperation(tx, op.workspaceId, op.id);
        await emitForOperation(tx, op, "operation.cancelled", { data: { reason: "expired" } });
        return op;
      })
    );
  }

  completeOperation(input: CompleteRequest): Promise<OperationRecord | null> {
    return this.run(async () => {
      if (input.outcome === "succeeded" || input.outcome === "failed") {
        return completeOperationService(this.db, { workspaceId: input.workspaceId, id: input.id, outcome: input.outcome, result: input.result, error: input.error, fence: input.fence, actor: input.actor });
      }
      // `uncertain`: the executor cannot prove whether the side effect happened.
      return this.db.tx(async (tx) => {
        const op = await operationRepo.transition(tx, {
          workspaceId: input.workspaceId,
          id: input.id,
          from: ["running"],
          to: "uncertain",
          patch: { result: input.result, error: input.error },
          fence: input.fence,
        });
        if (!op) return null;
        await emitForOperation(tx, op, "operation.uncertain", { actor: input.actor, data: input.error ? { error: input.error.slice(0, 500) } : {} });
        return op;
      });
    });
  }

  claimForExecution(input: ClaimRequest): Promise<OperationRecord> {
    return this.run(() => claimOperation(this.db, input));
  }

  /* -------------------------------- decisions -------------------------------- */

  recordPolicyDecision(input: NewDecision & { workspaceId: string; operationId: string; id?: string }): Promise<PolicyDecisionRecord> {
    return this.run(() => policyDecisionRepo.insert(this.db, input));
  }

  getPolicyDecision(workspaceId: string, id: string): Promise<PolicyDecisionRecord | null> {
    return this.run(() => policyDecisionRepo.get(this.db, workspaceId, id));
  }

  /* -------------------------------- approvals -------------------------------- */

  recordApproval(input: RecordApprovalRequest): Promise<RecordApprovalResult> {
    return this.run(() => decide(this.db, input));
  }

  listApprovals(workspaceId: string, operationId: string): Promise<ApprovalRecord[]> {
    return this.run(() => approvalRepo.listForOperation(this.db, workspaceId, operationId));
  }

  /* ---------------------------------- grants --------------------------------- */

  insertGrant(input: Omit<GrantRecord, "consumedAt" | "revokedAt">): Promise<GrantRecord> {
    return this.run(() => grantRepo.insert(this.db, input));
  }

  consumeGrant(input: { workspaceId: string; jti: string; audience?: string }): Promise<boolean> {
    return this.run(() => grantRepo.consume(this.db, input));
  }

  revokeGrantsForOperation(workspaceId: string, operationId: string): Promise<number> {
    return this.run(() => grantRepo.revokeForOperation(this.db, workspaceId, operationId));
  }

  /* --------------------------------- settings -------------------------------- */

  getEnvironmentSettings(workspaceId: string, environmentId: string): Promise<EnvironmentSettings> {
    return this.run(async () => toEnvironmentSettings(await settingsRepo.getEnvironmentSettings(this.db, workspaceId, environmentId)));
  }

  putEnvironmentAutonomy(input: { workspaceId: string; environmentId: string; autonomyLevel: AutonomyLevel; updatedBy: string; expectedVersion?: number }): Promise<EnvironmentSettings> {
    return this.run(() =>
      this.db.tx(async (tx) => {
        // The upsert replaces `policy_params`; carry the existing ones so changing the level never wipes them.
        const current = await settingsRepo.getEnvironmentSettings(tx, input.workspaceId, input.environmentId);
        const saved = await settingsRepo.putEnvironmentSettings(tx, {
          workspaceId: input.workspaceId,
          environmentId: input.environmentId,
          autonomyLevel: input.autonomyLevel,
          policyParams: current.policyParams,
          updatedBy: input.updatedBy,
          expectedVersion: input.expectedVersion ?? current.version,
        });
        return toEnvironmentSettings(saved);
      })
    );
  }

  getWorkspacePolicy(workspaceId: string): Promise<WorkspacePolicySettings> {
    return this.run(() => settingsRepo.getWorkspacePolicy(this.db, workspaceId));
  }

  putWorkspacePolicy(input: { workspaceId: string; params: Record<string, unknown>; updatedBy: string; expectedVersion?: number }): Promise<WorkspacePolicySettings> {
    return this.run(() => settingsRepo.putWorkspacePolicy(this.db, input));
  }

  /* ---------------------------------- events --------------------------------- */

  appendEvent(input: NewEvent): Promise<number> {
    return this.run(() => eventRepo.append(this.db, input));
  }

  listEvents(workspaceId: string, filter: ListEventsRequest = {}): Promise<PlatformEvent[]> {
    return this.run(() => eventRepo.list(this.db, workspaceId, filter));
  }
}

function toEnvironmentSettings(row: settingsRepo.EnvironmentSettings): EnvironmentSettings {
  return {
    environmentId: row.environmentId,
    workspaceId: row.workspaceId,
    autonomyLevel: row.autonomyLevel,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
    isDefault: row.isDefault,
  };
}
