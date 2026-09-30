/**
 * Reconciliation controller contracts: the ports it is coded against, the
 * options that bound it, and the results it reports.
 *
 * The controller is the classic loop — desired, observe, diff, policy, repair —
 * with one deliberate restriction: it NEVER repairs anything itself. A repair
 * is a `drift.repair` capability request handed to the capability broker
 * (origin `reconciler`); the broker and policy decide allow / approval / deny,
 * and an allowed operation is handed to `startRepair` so the durable day-two
 * workflow executes it under the `env:<id>` lease with its own credentials.
 *
 * Everything the controller touches from outside is a PORT defined here, so the
 * core is deterministic and testable without a database, a cloud or a clock:
 *
 *   store               persisted observations, runtime, drift reports, events
 *   withObserveSession  ONE read-only credential session (the credential broker
 *                       behind a `infrastructure.observe` grant, wired by the
 *                       orchestrator); the session object never leaves the
 *                       callback and is never stored
 *   broker              the capability broker's `propose`
 *   startRepair         hands an ALLOWED repair operation to Temporal
 *   state / guard /     scheduling, mutual exclusion and deploy/incident
 *   signals             signals, used by `reconcilePass` only
 *
 * Invariants: no secret value in any port payload; an attribute that was not
 * read is `unknown`, never "matches"; referenced and external resources are
 * reported, never proposed for repair; every persisted row and every query is
 * scoped by `workspaceId`.
 */
import type { CapabilityRequest } from "@/lib/capabilities/catalog";
import type { OperationStatus, PlatformEventType, Principal } from "@/lib/controlplane/types";
import type { ProviderConnection } from "@/lib/credentials/types";
import type { DriverLog, ResourceDriver } from "@/lib/drivers/types";
import type { AutonomyLevel, EnvironmentClass } from "@/lib/policy/types";
import type { DriftClass, DriftReport, Observation, ProviderKey, ResourceNode, ResourceOwnership, RuntimeState } from "@/lib/resources/types";

/* ------------------------------- environments ------------------------------ */

/** What the controller needs to know about one environment. Resolved by the caller, never inferred. */
export interface ReconcileEnvironment {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  class: EnvironmentClass;
  /** the environment's primary provider (individual nodes may override it) */
  provider: ProviderKey;
  region: string;
  /** the provider connection reads go through; absent or unverified means the environment is not reconcilable */
  connection?: { id: string; status: ProviderConnection["status"] };
  /** 0 observe … 5 broad (ADR-0007). 0 means observe only: the controller proposes nothing. */
  autonomyLevel?: AutonomyLevel;
}

/** An environment as the scheduler sees it: the above plus the signals that set its priority. */
export interface SchedulableEnvironment extends ReconcileEnvironment {
  /** when the most recent deploy/apply of this environment finished */
  lastDeployAt?: string;
  /** open incidents on this environment */
  openIncidents?: number;
}

/* --------------------------------- resources ------------------------------- */

/** Lifecycle status of a stored resource row (mirrors `platform.resources.status`). */
export type StoredResourceStatus = "planned" | "provisioning" | "active" | "updating" | "deleting" | "deleted" | "failed" | "unknown";

/** One stored resource row, as much as the controller needs. */
export interface StoredResourceRef {
  id: string;
  address: string;
  ownership: ResourceOwnership;
  status: StoredResourceStatus;
  externalId?: string;
}

/* ---------------------------------- events --------------------------------- */

export type ReconcileEventType = Extract<PlatformEventType, "drift.detected" | "drift.cleared" | "remediation.proposed">;

/** An append-only platform event the controller produced. `data` carries no attribute values and no secrets. */
export interface ReconcileEvent {
  /** deterministic, so re-appending after a retry is idempotent */
  id: string;
  type: ReconcileEventType;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  resourceId?: string;
  operationId?: string;
  correlationId: string;
  actor: Principal;
  data: Record<string, unknown>;
}

/* ---------------------------------- store ---------------------------------- */

export interface PreviousReconcile {
  report: DriftReport;
  /**
   * First-seen instant of every finding that was open at the previous report,
   * keyed by `findingKey`. Drives stable correlation ids across detect/clear.
   * Empty when unknown (a lost map degrades correlation, never correctness).
   */
  findingSince: Record<string, string>;
}

/** Everything one reconciliation persists. The adapter writes it in ONE transaction. */
export interface ReconcileCommit {
  environment: ReconcileEnvironment;
  observations: { resourceId: string; observation: Observation }[];
  runtime: { resourceId: string; runtime: RuntimeState }[];
  report: DriftReport;
  events: ReconcileEvent[];
  /** replaces the stored map: only findings open in `report` */
  findingSince: Record<string, string>;
}

/**
 * A `drift.repair` operation in the operations ledger, as the controller needs
 * it to avoid duplicates and to rate-limit. The adapter returns every such
 * operation of the environment that is either NOT terminal or was created at
 * or after `sinceIso`.
 */
export interface RepairOperationRef {
  operationId: string;
  /** the resource the operation is scoped to (drift.repair is a resource-level capability) */
  resourceId?: string;
  status: OperationStatus;
  createdAt: string;
  /** proposed by this controller (principal `reconciler`), as opposed to a person or an agent */
  byReconciler: boolean;
}

export interface ReconcileStore {
  /** Stored resource rows of the environment, tenant-scoped. */
  listResources(environment: ReconcileEnvironment): Promise<StoredResourceRef[]>;
  /** Latest persisted report + first-seen map, or null on the first pass. */
  loadPrevious(environment: ReconcileEnvironment): Promise<PreviousReconcile | null>;
  /** Persist observations, runtime, report, events and the first-seen map atomically. */
  commit(commit: ReconcileCommit): Promise<void>;
  /** Append events outside the commit (repair proposals happen after it). Idempotent on `event.id`. */
  appendEvents(environment: ReconcileEnvironment, events: ReconcileEvent[]): Promise<void>;
  listRepairOperations(environment: ReconcileEnvironment, sinceIso: string): Promise<RepairOperationRef[]>;
}

/* -------------------------------- observation ------------------------------ */

export interface ObserveSessionRequest {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  /** one session per provider present in the graph */
  provider: ProviderKey;
  region: string;
  connectionId?: string;
  correlationId: string;
  /** aborts when the environment's observation deadline passes; the session must stop handing out clients */
  signal: AbortSignal;
}

/* ---------------------------------- broker --------------------------------- */

/** The controller's identity on every proposal and event. A system principal, never a person. */
export const RECONCILER_PRINCIPAL: Principal = { kind: "system", id: "reconciler", name: "Zenith reconciliation controller" };

export interface RepairProposal {
  /** `drift.repair`, scoped to the resource, with the reason and an idempotency key */
  request: CapabilityRequest;
  /** the policy input's `context.origin` */
  origin: "reconciler";
  principal: Principal;
  /** the drift finding's lifecycle id: detection, this proposal and the clear share it */
  correlationId: string;
}

export type RepairProposalResult =
  /** policy allowed it without approval: `operationId` is ready to start */
  | { outcome: "allow"; operationId: string }
  /** a person must approve first; the approval flow starts it */
  | { outcome: "require_approval"; operationId: string }
  | { outcome: "deny"; operationId?: string; reason?: string };

export interface RepairBroker {
  propose(proposal: RepairProposal): Promise<RepairProposalResult>;
}

export interface StartRepairRequest {
  operationId: string;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  correlationId: string;
}

/* ---------------------------------- ports ---------------------------------- */

/** Ports `reconcileEnvironment` needs. */
export interface ReconcilePorts {
  now(): Date;
  store: ReconcileStore;
  broker: RepairBroker;
  /**
   * Run `fn` inside ONE read-only credential session for the environment's
   * provider (the `infrastructure.observe` grant behind the credential broker's
   * `observe` purpose). The session is handed straight to drivers as
   * `DriverContext.session`; it is never stored or returned.
   */
  withObserveSession<T>(request: ObserveSessionRequest, fn: (session: unknown) => Promise<T>): Promise<T>;
  /**
   * Hand an ALLOWED repair operation to the durable workflow. MUST be
   * idempotent (the workflow id is `op-<operationId>`, so a second start is
   * refused by Temporal; treat "already started" as success).
   */
  startRepair(request: StartRepairRequest): Promise<void>;
  /** The driver for a node. Defaults to the global registry (`findDriver`). */
  driverFor?(node: ResourceNode): ResourceDriver | undefined;
  /** Receives driver log lines; default discards them. Never persisted by the controller. */
  log?: DriverLog;
}

/* --------------------------------- options --------------------------------- */

export interface ReconcileOptions {
  /** nodes observed at once (default 4) */
  nodeConcurrency?: number;
  /** one driver call (observe, then runtime) may take this long (default 15 000 ms) */
  nodeTimeoutMs?: number;
  /** the whole environment's observation may take this long (default 30 000 ms) */
  environmentTimeoutMs?: number;
  /** absolute wall-clock deadline (epoch ms) imposed by a pass budget; wins when earlier */
  deadlineAt?: number;
  /** also read runtime state (default true) */
  observeRuntime?: boolean;
  /** false: observe and report only, never propose a repair (default true) */
  autoRepair?: boolean;
  /** repair proposals per environment per window (default 3) */
  maxRepairProposals?: number;
  /** the rate-limit window (default 1 hour) */
  repairWindowMs?: number;
  /** a finding is not re-proposed for this long after any proposal for it (default 1 hour) */
  repairCooldownMs?: number;
  /** …and this long after a proposal was rejected or denied (default 24 hours) */
  rejectedCooldownMs?: number;
  /** a finding must be present in this many consecutive reports before it is proposed (default 1) */
  minConfirmations?: number;
}

export interface ResolvedReconcileOptions {
  nodeConcurrency: number;
  nodeTimeoutMs: number;
  environmentTimeoutMs: number;
  deadlineAt: number | undefined;
  observeRuntime: boolean;
  autoRepair: boolean;
  maxRepairProposals: number;
  repairWindowMs: number;
  repairCooldownMs: number;
  rejectedCooldownMs: number;
  minConfirmations: number;
}

export const DEFAULT_RECONCILE_OPTIONS: ResolvedReconcileOptions = {
  nodeConcurrency: 4,
  nodeTimeoutMs: 15_000,
  environmentTimeoutMs: 30_000,
  deadlineAt: undefined,
  observeRuntime: true,
  autoRepair: true,
  maxRepairProposals: 3,
  repairWindowMs: 60 * 60_000,
  repairCooldownMs: 60 * 60_000,
  rejectedCooldownMs: 24 * 60 * 60_000,
  minConfirmations: 1,
};

/* --------------------------------- results --------------------------------- */

export type RepairSkipReason =
  | "auto_repair_disabled"
  | "autonomy_observe_only"
  | "simulated_observation"
  /** unknown, inaccessible, extra, or a finding with no repair path */
  | "not_repairable"
  /** referenced or external: Zenith never repairs what it does not own */
  | "not_managed"
  | "ownership_mismatch"
  | "no_resource_row"
  | "stateful_missing"
  | "stateful"
  | "identity"
  | "firewall_opened"
  | "high_severity"
  | "not_auto_eligible"
  | "awaiting_confirmation"
  | "repair_open"
  | "cooldown"
  | "rate_limited";

export interface RepairDecision {
  address: string;
  class: DriftClass;
  status: "proposed" | "skipped" | "failed";
  /** for `proposed`: what the broker said */
  outcome?: RepairProposalResult["outcome"];
  operationId?: string;
  /** an allowed operation was handed to the workflow */
  started?: boolean;
  reason?: RepairSkipReason | "broker_error" | "start_failed";
  /** scrubbed, for `failed` */
  error?: string;
}

export interface SkippedNode {
  address: string;
  reason: "not_applied" | "being_deleted" | "no_resource_row" | "external";
}

export interface ReconcileResult {
  workspaceId: string;
  environmentId: string;
  /** `nothing_to_reconcile`: no node was in an observable state, so no report was produced */
  status: "reconciled" | "nothing_to_reconcile";
  report?: DriftReport;
  /** nodes whose observation was read without error */
  observed: number;
  /** nodes that have no observation because something failed or no driver exists */
  unread: number;
  skippedNodes: SkippedNode[];
  counts: Record<DriftClass, number>;
  /** new findings and findings whose risk signature changed */
  detected: number;
  cleared: number;
  /** anything moved since the previous report: findings, or the desired graph */
  changed: boolean;
  openFindings: number;
  repairs: RepairDecision[];
  startedAt: string;
  finishedAt: string;
}
