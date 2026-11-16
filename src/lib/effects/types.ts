/**
 * External-effect ledger vocabulary (PROD-DUR-07 / PROD-DUR-08).
 *
 * An external effect is one provider mutation Zenith dispatched (or refused to
 * dispatch) that cannot be undone by retrying: a build launch, a destructive
 * cleanup apply, a workflow start. The ledger row is created BEFORE the call
 * and is never deleted. Its state is the single answer to "do we know whether
 * this happened":
 *
 *   pending     recorded, call not yet known to have been accepted
 *   accepted    the provider returned a receipt (request id / resource id)
 *   confirmed   independent readback saw exactly the effect that was requested
 *   uncertain   we cannot prove whether it happened (lost response, lost lease,
 *               partition, timeout). NEVER retried. Resolved only by evidence
 *               plus a fresh human authorization.
 *   conflict    receipts or readback disagree with each other or with the
 *               request (duplicate resources, different digest, late receipt
 *               after a tombstone). Resolved only like uncertain.
 *   tombstoned  proven not applied (provider rejection, or operator-authorized
 *               absence), or retired. Terminal. The same effect id and dedup key
 *               are never reused; a new effect needs a new operation.
 *
 * The pure transition table here is mirrored by the SQL trigger in migration
 * 0033; the unit test asserts the two agree.
 */

/**
 * Families wired into real callers: provider build launches (all providers), the destructive apply of a reviewed
 * destroy plan, and every mutating request sent through a runner HTTP proxy (`aws.http`, `oci.http`, `k8s.http`), and the apply of a tenant isolation bundle (`isolation_apply`, migration 50). A new family is a new migration (the family check) plus a resolver, never an implicit string.
 * Workflow starts keep their own tombstone table (migration 12) and agent deliveries their immutable receipt table
 * (migration 11); both already preserve uncertainty and are projected through the operation they belong to.
 */
export const EFFECT_FAMILIES = ["build_launch", "cleanup_apply", "proxy_request", "isolation_apply"] as const;
export type EffectFamily = (typeof EFFECT_FAMILIES)[number];

export const EFFECT_STATES = ["pending", "accepted", "uncertain", "conflict", "confirmed", "tombstoned"] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

/** States an operator must resolve or automation must still drive; shown by the UX-01 projection. */
export const UNRESOLVED_STATES: readonly EffectState[] = ["pending", "accepted", "uncertain", "conflict"];
/** States that block every further dispatch of the same effect. */
export const BLOCKING_STATES: readonly EffectState[] = ["pending", "uncertain", "conflict"];
export const TERMINAL_STATES: readonly EffectState[] = ["confirmed", "tombstoned"];

/** What an automatic caller may do. Resolution transitions need an operator resolution row. */
export const AUTOMATIC_TRANSITIONS: Readonly<Record<EffectState, readonly EffectState[]>> = {
  pending: ["accepted", "uncertain", "tombstoned"],
  accepted: ["confirmed", "uncertain", "conflict"],
  uncertain: ["conflict"],
  conflict: [],
  confirmed: [],
  tombstoned: [],
};
/** Transitions that exist only through an authorized resolution. */
export const RESOLUTION_TRANSITIONS: Readonly<Record<EffectState, readonly EffectState[]>> = {
  pending: [],
  accepted: [],
  uncertain: ["confirmed", "tombstoned"],
  conflict: ["confirmed", "tombstoned"],
  confirmed: [],
  tombstoned: [],
};

export function canTransitionAutomatically(from: EffectState, to: EffectState): boolean {
  return AUTOMATIC_TRANSITIONS[from].includes(to);
}
export function canTransitionByResolution(from: EffectState, to: EffectState): boolean {
  return RESOLUTION_TRANSITIONS[from].includes(to);
}

export type TombstoneReason = "provider_rejected" | "operator_resolved_not_applied" | "superseded";

/** The evidence a provider call produced; opaque ids only, never credentials or payloads. */
export interface ProviderReceipt {
  /** e.g. CodeBuild build id, ACR run id, Temporal run id */
  resourceId?: string;
  requestIds: string[];
  /** when the provider says it accepted the call, if it says */
  acceptedAt?: string;
  /** non-secret identity (account, region, project) */
  identity?: Record<string, string>;
}

export type ReadbackOutcome = "present" | "absent" | "mismatch" | "unavailable";

/**
 * One independent provider/store read of the effect's result. `present` means
 * exactly one object that matches the request identity; `mismatch` means
 * duplicates or a different identity. `absent` is only a point-in-time fact:
 * resolution additionally needs fence supersession and a settle window.
 */
export interface Readback {
  outcome: ReadbackOutcome;
  /** which independent source produced it, e.g. "aws.codebuild.list-builds" */
  source: string;
  observedAt: string;
  /** provider object this readback matched, when outcome is `present` */
  resourceId?: string;
  requestIds?: string[];
  /** bounded, non-secret facts the operator reviews */
  facts: Record<string, string | number | boolean | null>;
  /** why a read was unavailable or a mismatch happened */
  reason?: string;
  /** digest of the above; what a resolution binds to */
  digest: string;
}

export interface EffectTarget {
  [key: string]: string | number | boolean | null | string[];
}

export type LateReceipt = ProviderReceipt & { receivedAt: string; staleFence: boolean; digest: string };

export interface EffectRecord {
  workspaceId: string;
  effectId: string;
  family: EffectFamily;
  operationId: string;
  environmentId: string | null;
  provider: string;
  dedupKey: string;
  requestDigest: string;
  target: EffectTarget;
  /** Token sent to the provider where the provider supports one. */
  idempotencyToken: string | null;
  idempotencySupported: boolean;
  fenceScope: string | null;
  fenceEpoch: number | null;
  state: EffectState;
  stateReason: string | null;
  providerReceipt: ProviderReceipt | null;
  lateReceipt: LateReceipt | null;
  readback: Readback | null;
  tombstoneReason: TombstoneReason | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  uncertainAt: string | null;
}

export type ResolutionDecision = "confirm_applied" | "confirm_not_applied";

export interface EffectResolution {
  id: string;
  workspaceId: string;
  effectId: string;
  effectVersion: number;
  decision: ResolutionDecision;
  readbackDigest: string;
  bindingDigest: string;
  approverId: string;
  reason: string;
  createdAt: string;
}

export interface EffectEvent {
  seq: number;
  effectId: string;
  kind: string;
  fromState: EffectState | null;
  toState: EffectState;
  actor: string;
  evidenceDigest: string | null;
  at: string;
}

/** Quiet period after which an `absent` readback can no longer be explained by a delayed provider call. */
export const ABSENCE_SETTLE_MS = 15 * 60_000;
/** A pending effect whose dispatcher vanished is declared uncertain after this long. */
export const PENDING_STALE_MS = 10 * 60_000;
