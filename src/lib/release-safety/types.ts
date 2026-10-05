/**
 * Release and data migration safety (PROD-LIFE-10): shared vocabulary.
 *
 * A release run is the durable record of ONE image digest moving through ONE service of ONE
 * environment: source -> build/digest -> provenance -> migration gate -> deploy -> migration
 * -> readiness -> cutover -> readback. The digest is bound when the run reaches `built` and
 * can never change; a different digest is a different run.
 */

export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const HEX64 = /^[0-9a-f]{64}$/;

export const RELEASE_STATES = [
  "planned",
  "built",
  "verified",
  "blocked_approval",
  "deployed",
  "migrated",
  "ready",
  "cut_over",
  "readback_verified",
  "cut_over_unverified",
  "failed",
  "uncertain",
  "rolled_back",
  "refused",
] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

export const TERMINAL_RELEASE_STATES: ReadonlySet<ReleaseState> = new Set<ReleaseState>(["readback_verified", "cut_over_unverified", "failed", "uncertain", "rolled_back", "refused"]);

/** What a release run is doing to production: a forward release or a code rollback. */
export type ReleaseKind = "deploy" | "rollback";

/**
 * Migration classes, least to most dangerous.
 *  none          no migration is declared
 *  expand        additive and backward compatible: the previous code keeps working against the result
 *  data          moves or rewrites data (backfills, deletes of rows): reviewed by a person
 *  contract      removes or changes schema the previous code relies on: reviewed by a person, and a
 *                code rollback across it is refused
 *  unclassified  a command nobody classified: handled exactly like `contract`
 */
export const MIGRATION_CLASSES = ["none", "expand", "data", "contract", "unclassified"] as const;
export type MigrationClass = (typeof MIGRATION_CLASSES)[number];

/**
 *  none              no migration
 *  pending_approval  a person has not approved it yet
 *  cleared           compatible (expand); may run without a separate approval
 *  approved          a person approved this exact binding
 *  started           the one-off task was dispatched (an approval is consumed here; a retry reuses the provider idempotency key)
 *  ran | failed      terminal outcomes of the task
 */
export type MigrationStatus = "none" | "pending_approval" | "cleared" | "approved" | "started" | "ran" | "failed";

/**
 * How strongly the digest is tied to a verified build. LIFE-09 (isolated build provenance) owns
 * the producer of `attested`; this requirement only consumes a level through `ProvenanceVerifier`.
 *  pinned_digest  an operator-pinned image reference; Zenith knows the digest, not where it came from
 *  build_record   Zenith's own build step recorded this digest for the approved source snapshot
 *  attested       a verified provenance attestation (LIFE-09)
 */
export const PROVENANCE_LEVELS = ["none", "pinned_digest", "build_record", "attested"] as const;
export type ProvenanceLevel = (typeof PROVENANCE_LEVELS)[number];

export interface ProvenanceVerdict {
  verified: boolean;
  level: ProvenanceLevel;
  /** an opaque reference to the evidence (never a secret) */
  evidenceRef?: string;
  verifiedAt?: string;
  reason?: string;
}

export interface MigrationRecord {
  class: MigrationClass;
  status: MigrationStatus;
  /** digest of the argv; the argv itself is never stored */
  commandDigest?: string;
  /** digest of the SQL when the caller supplied it for classification */
  sqlDigest?: string;
  /** what the classifier found, short and scrubbed */
  findings: readonly string[];
  /** the exact effect a person approves */
  bindingDigest?: string;
  approvalId?: string;
  exitCode?: number;
}

export type RolloutStrategy = "rolling" | "progressive";

export interface RolloutRecord {
  strategy: RolloutStrategy;
  /** ascending percentages; the last one is 100 (the cutover) */
  steps: readonly number[];
  bakeSec: number;
  /** the percentage the provider has been observed serving the candidate at */
  percent: number;
}

export interface ReadbackRecord {
  status: "verified" | "mismatch" | "unsupported" | "unreadable";
  observedDigest?: string;
  detail?: string;
  at: string;
}

export interface ReleaseRun {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  operationId: string;
  /** the saved revision this operation deploys (lets a rollback find the digest that revision last served) */
  revisionId?: string;
  /** the accountable identity that asked for this release; it cannot approve its own migration */
  requestedBy: string;
  serviceAddress: string;
  kind: ReleaseKind;
  state: ReleaseState;
  imageUri: string;
  imageDigest: string;
  sourceDigest?: string;
  /** the digest this run replaced (the code rollback target if a rollback is wanted) */
  previousDigest?: string;
  /** for a rollback run: the release run whose digest is being restored */
  restoresRunId?: string;
  provenance: { level: ProvenanceLevel; evidenceRef?: string; verifiedAt?: string };
  migration: MigrationRecord;
  rollout: RolloutRecord;
  readback?: ReadbackRecord;
  /** short, scrubbed reason for failed / uncertain / refused / rolled_back */
  reason?: string;
  /** compare-and-set counter */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseEvent {
  runId: string;
  seq: number;
  from: ReleaseState | null;
  to: ReleaseState;
  detail: string;
  actor: string;
  at: string;
}

export interface MigrationApproval {
  id: string;
  workspaceId: string;
  runId: string;
  bindingDigest: string;
  class: MigrationClass;
  approvedBy: string;
  requestedBy: string;
  approvedAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export type ReleaseErrorCode =
  | "invalid_input"
  | "invalid_transition"
  | "digest_immutable"
  | "provenance_unverified"
  | "migration_approval_required"
  | "approval_invalid"
  | "rollout_unsupported"
  | "rollback_unsafe"
  | "not_found"
  | "conflict"
  | "forbidden";

export class ReleaseSafetyError extends Error {
  constructor(readonly code: ReleaseErrorCode, message: string) {
    super(message);
    this.name = "ReleaseSafetyError";
  }
}

/** Anything free-form that is stored or shown: bounded, no control characters. */
export function scrub(text: unknown, max = 300): string {
  const s = typeof text === "string" ? text : text instanceof Error ? text.message : String(text);
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
