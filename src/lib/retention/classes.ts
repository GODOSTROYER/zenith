/**
 * Retention data classes and the hard invariants (PROD-OPS-07).
 *
 * Only the four classes below can ever be archived-and-pruned. They are the cold, regenerable or
 * operator-visibility records from the OPS-06 inventory: job and request log lines, observation history and drift
 * reports. Everything the platform's safety depends on (active operations, approvals, audit events, evidence,
 * receipts, the effect ledger, replay-prevention records, authority, custody) is in `NEVER_PRUNABLE` and no
 * configuration, environment flag or hold release can make a statement here touch it: every SQL statement of this
 * module is built from this registry (table names are constants, never config), and `assertPrunableClass` is called
 * before any delete is built.
 *
 * DEC-RETENTION is pending: the default policy retains everything forever.
 */
export const RETENTION_CLASSES = ["runner_job_logs", "machine_request_logs", "resource_observations", "drift_reports"] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Settled job and request statuses (same vocabulary as the OPS-06 minimizer). */
export const TERMINAL_STATUSES = "('succeeded','failed','rejected','timed_out','expired','cancelled')";

export interface ClassSpec {
  readonly table: string;
  /** SQL type of the `id` column, for typed parameters */
  readonly idType: "bigint" | "text";
  /** the column the row's age is measured on */
  readonly timeColumn: string;
  /** a parent whose status must be terminal before its rows are cold (active operations are never touched) */
  readonly parent?: { readonly table: string; readonly fk: string };
  /** SQL expressions (alias `l`, parent `p`) a resource-scoped hold can match */
  readonly resourceExprs: readonly string[];
  /** keep the newest row per this column group: the latest observation is live state, not history */
  /** the row a restore needs to exist before it can be re-inserted (foreign key) */
  readonly restoreParent?: { readonly table: string; readonly fk: string };
  readonly keepLatestBy?: { readonly column: string; readonly orderColumn: string };
  readonly label: string;
  readonly description: string;
}

export const CLASS_SPECS: Readonly<Record<RetentionClass, ClassSpec>> = {
  runner_job_logs: {
    table: "platform.runner_job_logs", idType: "bigint", timeColumn: "recorded_at",
    parent: { table: "platform.runner_jobs", fk: "job_id" }, restoreParent: { table: "platform.runner_jobs", fk: "job_id" }, resourceExprs: ["l.job_id", "p.operation_id"],
    label: "Runner job log lines", description: "Operator-visible log lines of settled runner jobs. The job row, result digest and operation ledger stay.",
  },
  machine_request_logs: {
    table: "platform.machine_request_logs", idType: "bigint", timeColumn: "recorded_at",
    parent: { table: "platform.machine_requests", fk: "request_id" }, restoreParent: { table: "platform.machine_requests", fk: "request_id" }, resourceExprs: ["l.request_id", "p.operation_id"],
    label: "Machine request log lines", description: "Log lines of settled zenithd requests. The request row and operation ledger stay.",
  },
  resource_observations: {
    table: "platform.resource_observations", idType: "bigint", timeColumn: "recorded_at",
    resourceExprs: ["l.resource_id"], restoreParent: { table: "platform.resources", fk: "resource_id" }, keepLatestBy: { column: "resource_id", orderColumn: "observed_at" },
    label: "Resource observation history", description: "Older observed-state snapshots. The latest observation of every resource is always kept.",
  },
  drift_reports: {
    table: "platform.drift_reports", idType: "text", timeColumn: "recorded_at",
    resourceExprs: ["l.environment_id", "l.id"], keepLatestBy: { column: "environment_id", orderColumn: "computed_at" },
    label: "Drift reports", description: "Older drift findings. The latest report of every environment is always kept.",
  },
};

/** Tables (and why) that no retention path may ever archive-delete or prune, whatever the configuration says. */
export const NEVER_PRUNABLE: Readonly<Record<string, string>> = {
  "platform.operations": "operation ledger and active operations",
  "platform.operation_authority": "durable fence record of every operation",
  "platform.durable_intents": "delivery record of effects that leave the database",
  "platform.approvals": "approval decisions bound to exact proposals",
  "platform.approved_semantics": "the semantics a reviewer approved",
  "platform.standing_grants": "standing pre-approvals (revoked, never deleted)",
  "platform.standing_grant_uses": "what a standing grant approved",
  "platform.policy_decisions": "policy decision audit",
  "platform.events": "append-only audit event log",
  "platform.evidence": "evidence records",
  "platform.agent_effect_receipts": "permanent receipts of agent outcomes",
  "platform.external_effects": "effect ledger of provider mutations",
  "platform.external_effect_events": "effect ledger events",
  "platform.external_effect_resolutions": "operator resolutions of uncertain effects",
  "platform.idempotency_keys": "replay prevention",
  "platform.agent_nonces": "request replay prevention",
  "platform.github_webhook_deliveries": "webhook replay prevention",
  "platform.runner_jobs": "job rows: status, envelope, evidence digests, active work",
  "platform.machine_requests": "request rows: status, envelope, active work",
  "platform.plan_artifacts": "plan custody",
  "platform.plan_custody_reads": "plan custody read audit",
  "platform.machine_runbook_audit": "hash-chained runbook audit",
  "platform.mixed_runs": "mixed run state",
  "platform.mixed_run_events": "mixed run event ledger",
  "platform.mixed_child_receipts": "child completion receipts",
  "platform.ops_maintenance_history": "maintenance change audit",
  "platform.legal_holds": "legal holds",
  "platform.retention_archives": "archive manifests",
  "platform.retention_destinations": "tenant archive destinations",
  "platform.retention_restores": "restore audit",
  "platform.leases": "fenced leases",
  "platform.mixed_output_records": "append-only producer provenance",
  "platform.slo_samples": "measurement history",
  "platform.slo_measurements": "append-only recovery objectives",
  "platform.recovery_epochs": "installation recovery fences",
  "platform.recovery_items": "recovery hand-off ledger",
  "platform.audit_exports": "signed export audit",
  "platform.managed_domains": "domain ownership and retirement",
  "platform.managed_storage_keys": "scoped key revocation history",
  "platform.billing_accounts": "account state",
  "platform.billing_account_events": "append-only billing audit",
  "platform.billing_invoices": "invoice idempotency",
  "platform.billing_usage_events": "usage meter idempotency",
  "platform.billing_webhook_events": "webhook replay prevention",
  "platform.approved_source_snapshots": "reviewed immutable sources",
  "platform.mixed_child_custody": "child execution authority",

};

export class RetentionInvariantError extends Error {
  readonly code = "retention_invariant";
  constructor(message: string) { super(message); this.name = "RetentionInvariantError"; }
}

export function isRetentionClass(value: unknown): value is RetentionClass {
  return typeof value === "string" && (RETENTION_CLASSES as readonly string[]).includes(value);
}

/**
 * Throws unless `cls` is a registered retention class whose table is not protected. Called before any prune or
 * archive statement is built, so a code or config change cannot route a delete at a protected table.
 */
export function assertPrunableClass(cls: string): RetentionClass {
  if (!isRetentionClass(cls)) {
    throw new RetentionInvariantError(`"${cls}" is not a retention class and can never be archived-deleted or pruned.`);
  }
  const spec = CLASS_SPECS[cls];
  if (spec.table in NEVER_PRUNABLE) throw new RetentionInvariantError(`${spec.table} is protected: ${NEVER_PRUNABLE[spec.table]}.`);
  return cls;
}

/** Why a name given in a policy is refused, or undefined when it is a retention class. */
export function refusalFor(name: string): string | undefined {
  if (isRetentionClass(name)) return undefined;
  const qualified = name.includes(".") ? name : `platform.${name}`;
  if (qualified in NEVER_PRUNABLE) return `"${name}" is protected (${NEVER_PRUNABLE[qualified]}) and can never be archived-deleted or pruned.`;
  return `"${name}" is not a retention class. Valid classes: ${RETENTION_CLASSES.join(", ")}.`;
}
