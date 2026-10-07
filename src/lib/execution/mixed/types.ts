/**
 * Parent/child mixed-cloud plan types (PROD-MIX-01 / PROD-MIX-02).
 *
 * This module is the stable contract other mixed-cloud work builds on (typed
 * outputs, failure and teardown ordering). It holds types, constants and one
 * error class only: no I/O and no behaviour, so it can be imported from the
 * workflow sandbox, the API routes and the worker alike. Changing a field here
 * changes a persisted, digest-bound document; add fields, never reinterpret.
 *
 * Model in one paragraph. A mixed graph is partitioned by provider, account,
 * region and state backend. Each partition is one CHILD: an immutable subplan
 * bound to one verified, workspace-owned connection with its own state backend.
 * The PARENT plan is the ordered set of child subplans. A human approves the
 * parent as an ordinary platform operation whose immutable proposal input
 * carries the child digest set (`MixedParentProposalInput`), so approval binds
 * exactly those children and nothing else. Each child then runs as its own
 * platform operation (its own approvals, DUR-B semantics digest, DUR-C custody
 * and DUR-D effect ledger); the parent records a durable receipt per child and
 * never compensates or destroys anything.
 */

export const MIXED_PARENT_PLAN_FORMAT = "zenith.mixed-parent-plan.v1" as const;
export const MIXED_CHILD_SEMANTICS_FORMAT = "zenith.mixed-child-semantics.v1" as const;
export const MIXED_CHILD_SET_FORMAT = "zenith.mixed-child-set.v1" as const;
export const MIXED_RECEIPT_FORMAT = "zenith.mixed-child-receipt.v1" as const;
export const MIXED_ADDRESS_FORMAT = "zenith.mixed-address.v1" as const;

/** The parent approval is an ordinary `deployment.deploy` operation on the parent environment, marked by this input key. */
export const MIXED_PARENT_CAPABILITY = "deployment.deploy" as const;
export const MIXED_PARENT_INPUT_KEY = "mixedParentPlanId" as const;

export type MixedProviderName = "aws" | "gcp" | "azure" | "oci";

/** Lifecycle of the parent execution. Approval is NOT a status here: it is the parent operation's own authority record. */
export type ParentStatus = "planned" | "running" | "succeeded" | "failed" | "uncertain" | "cancelled";
export const PARENT_TERMINAL: readonly ParentStatus[] = ["succeeded", "failed", "uncertain", "cancelled"];

/**
 * Lifecycle of one child.
 *  pending   subplan exists; no child operation adopted
 *  adopted   a child operation was bound to this subplan (write-once)
 *  started   the parent claimed the child operation and started its workflow (durable start intent)
 *  succeeded|failed|uncertain|cancelled   terminal, with a durable receipt
 *  blocked   terminal for children that never started because a dependency did not succeed
 */
export type ChildState = "pending" | "adopted" | "started" | "succeeded" | "failed" | "uncertain" | "cancelled" | "blocked";
export const CHILD_TERMINAL: readonly ChildState[] = ["succeeded", "failed", "uncertain", "cancelled", "blocked"];
export type ChildTerminalOutcome = "succeeded" | "failed" | "uncertain" | "cancelled";

/** Everything that authorizes a child to act, as digests. Never credentials. */
export interface ChildAuthority {
  bindingId: string;
  connectionId: string;
  provider: MixedProviderName;
  accountId: string;
  region: string;
  connectionIdentityDigest: string;
  backendKind: "s3" | "gcs" | "azurerm";
  backendDigest: string;
  stateLocationDigest: string;
  /** The child environment whose own state prefix holds this partition's state. */
  stateEnvironmentId: string;
}

export interface ChildNode {
  /** Stable across resume, rotation and re-planning: see addresses.ts. */
  stableAddress: string;
  /** The graph's own address (identical in the child environment's graph). */
  address: string;
  kind: string;
  nativeType: string;
  ownership: "managed" | "referenced" | "external";
  specDigest: string;
  /** Node addresses inside the same partition this node waits for. */
  dependsOn: readonly string[];
}

/** One immutable child. Ordered by `ordinal` in the parent's dependency order. */
export interface ChildSubplan {
  partitionId: string;
  ordinal: number;
  childEnvironmentId: string;
  /** Partition ids that must succeed first. */
  dependsOn: readonly string[];
  authority: ChildAuthority;
  nodes: readonly ChildNode[];
  /** Desired child inputs, excluding values produced by other children. */
  subplanDigest: string;
  /** Subplan plus the exact incoming dependency materialization the child will consume. */
  effectDigest: string;
  /** Digest the parent approval pins for this child (see childSemanticsDigest). */
  semanticsDigest: string;
  /** Reference ids whose producers are not yet materialized; non-empty means the child is not yet startable. */
  blockedByReferences: readonly string[];
}

export interface ChildReference {
  referenceId: string;
  producerPartitionId: string;
  consumerPartitionId: string;
  contractDigest: string;
  materializationDigest: string;
  state: "available" | "unavailable";
  unavailableReason?: string;
  /**
   * The declared contract (addresses, output and input names, value type), kept so the run orchestration (MIX-03/04) can
   * rebuild the planner input and its reference view from the stored plan alone. Additive: absent on a reference stored
   * before the join; such a plan cannot materialize outputs and refuses with plan_refused.
   */
  producerAddress?: string;
  producerOutput?: string;
  consumerAddress?: string;
  consumerInput?: string;
  valueType?: "string" | "number" | "boolean" | "resource_id" | "endpoint" | "secret_ref";
}

export interface StableAddressEntry {
  stableAddress: string;
  address: string;
  partitionId: string;
  specDigest: string;
}

/** The persisted, digest-bound parent document. Immutable once stored. */
export interface MixedParentPlan {
  format: typeof MIXED_PARENT_PLAN_FORMAT;
  parentPlanId: string;
  workspaceId: string;
  projectId: string;
  parentEnvironmentId: string;
  manifestDigest: string;
  graphDigest: string;
  desiredDigest: string;
  parentDigest: string;
  /** Digest over the ordered child set; what the approval binds. */
  childSetDigest: string;
  children: readonly ChildSubplan[];
  references: readonly ChildReference[];
  /** Partition ids in dependency order. */
  executionOrder: readonly string[];
  /** Reverse of executionOrder. Teardown ordering is MIX-04's; this is the dependency fact it starts from. */
  teardownOrder: readonly string[];
  addresses: readonly StableAddressEntry[];
}

/** Marks a parent REVIEW operation: a human approval of a changed parent digest after outputs were materialized (MIX-03 join). Never executable. */
export const MIXED_PARENT_REVIEW_KEY = "mixedParentReviewOf" as const;

/**
 * The immutable input of a parent review operation. It binds the exact new parent digest and the child set the original
 * parent approval pinned, plus every consumer whose effect digest the new materialization changes, so the approver sees
 * exactly what moved. Opened by the run orchestration (never by a caller) when `consumeOutputs` returns review_required.
 */
export interface MixedParentReviewInput {
  mixedParentReviewOf: string;
  parentPlanId: string;
  previousParentDigest: string;
  requiredParentDigest: string;
  childSetDigest: string;
  consumers: readonly { childId: string; previousEffectDigest: string; newEffectDigest: string; referenceIds: readonly string[] }[];
}

/** The immutable input of the parent operation. A human approves exactly this. */
export interface MixedParentProposalInput {
  mixedParentPlanId: string;
  parentDigest: string;
  childSetDigest: string;
  children: readonly {
    partitionId: string;
    ordinal: number;
    childEnvironmentId: string;
    subplanDigest: string;
    semanticsDigest: string;
    connectionIdentityDigest: string;
    backendDigest: string;
  }[];
}

/** Mutable execution view of one child (SQL row). The subplan itself never changes. */
export interface ChildExecution {
  partitionId: string;
  ordinal: number;
  state: ChildState;
  childOperationId?: string;
  /** DUR-B executable semantics digest of the child operation's reviewed plan, captured write-once. */
  executableSemanticsDigest?: string;
  version: number;
}

/** Durable, append-only record that a child reached a terminal outcome. */
export interface ChildReceipt {
  format: typeof MIXED_RECEIPT_FORMAT;
  receiptId: string;
  workspaceId: string;
  parentPlanId: string;
  partitionId: string;
  ordinal: number;
  childOperationId: string;
  outcome: ChildTerminalOutcome;
  /** The child operation's own terminal status string at the time. */
  childStatus: string;
  executableSemanticsDigest?: string;
  planDigest?: string;
  /** Digest of the child's recorded outputs; never the outputs themselves. */
  outputsDigest?: string;
  receiptDigest: string;
  recordedAt: string;
}

/** Why a parent cannot proceed. Fail-stop reasons; none of them triggers compensation. */
export type MixedBlockReason =
  | "dependency_not_succeeded"
  | "dependency_uncertain"
  | "child_timeout"
  | "approval_missing"
  | "approval_changed"
  | "connection_unverified"
  | "address_drift"
  | "plan_changed"
  | "outputs_unavailable"
  | "review_pending"
  | "cancelled"
  | "outage";

export type MixedPlanErrorCode =
  | "unbound_partition"
  | "ambiguous_partition"
  | "connection_unverified"
  | "connection_foreign"
  | "backend_refused"
  | "plan_refused"
  | "not_found"
  | "conflict"
  | "child_mismatch"
  | "approval_mismatch"
  | "address_drift"
  | "invalid_state"
  | "invalid_input";

export class MixedPlanError extends Error {
  constructor(readonly code: MixedPlanErrorCode, message: string, readonly detail?: Readonly<Record<string, string | number | boolean>>) {
    super(message);
    this.name = "MixedPlanError";
  }
}
