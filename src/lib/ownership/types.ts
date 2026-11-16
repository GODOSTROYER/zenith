/**
 * Field ownership: the vocabulary (PROD-LIFE-12).
 *
 * Every mutable field of a managed resource has exactly ONE owner at a time:
 *
 *   iac               the manifest / OpenTofu. The default for anything declared.
 *   native-op         a sanctioned native operation (release image pointer, a
 *                     transferred scale target, a secret value written natively).
 *   autoscaler        a live controller (HPA, Application Auto Scaling, a managed
 *                     DB autoscaler). IaC seeds the field on create, never again.
 *   provider-managed  the provider decides (zone placement, AMI lookups). Nobody
 *                     writes it; drift on it is expected variance.
 *
 * Ownership moves only through an explicit, approved, exact `OwnershipTransfer`.
 * Pure types: no fs, no env, no store.
 */

export const FIELD_OWNERS = ["iac", "native-op", "autoscaler", "provider-managed"] as const;
export type FieldOwner = (typeof FIELD_OWNERS)[number];

/** Owners that can actually perform a write. `provider-managed` is never a writer. */
export type WriterKind = Exclude<FieldOwner, "provider-managed">;

/** Facts about one resource that change who owns a field. Derived from the graph, never from a caller claim. */
export interface OwnershipFacts {
  /** a live autoscaler is attached to this resource */
  autoscaled?: boolean;
  /** the workload's image is produced by Zenith releases (artifact.type "built") */
  releaseManaged?: boolean;
}
export type OwnershipFactKey = keyof OwnershipFacts;

export interface OwnershipRule {
  /** stable id, cited in findings and refusals */
  id: string;
  /** Zenith native types (`aws:ecs_service`) and/or tofu types (`aws_ecs_service`) this rule covers */
  resourceTypes: readonly string[];
  /** portable attribute names and/or tofu attribute paths; a path also covers its children */
  paths: readonly string[];
  /** owner when no fact below applies */
  owner: FieldOwner;
  /** owner when the named fact holds (first matching fact in declaration order wins) */
  whenFact?: Partial<Record<OwnershipFactKey, FieldOwner>>;
  /**
   * Tofu attribute paths to put in `lifecycle.ignore_changes` whenever the
   * resolved owner is not `iac`. Empty for rules that only classify.
   */
  ignorePaths?: readonly string[];
  reason: string;
}

export interface FieldQuery {
  /** `aws:ecs_service` or `aws_ecs_service` */
  resourceType: string;
  path: string;
  /** resource address; needed for transfers to apply */
  address?: string;
  facts?: OwnershipFacts;
}

export type OwnerSource = "rule" | "default" | "transfer";

export interface FieldOwnerResolution {
  owner: FieldOwner;
  /** the owner before any transfer */
  baseOwner: FieldOwner;
  source: OwnerSource;
  ruleId?: string;
  transferId?: string;
  reason: string;
}

/**
 * An approved, exact movement of one field from one owner to another. It is
 * data: whoever persists it must bind `approvalId` to a human approval of
 * exactly this digest. `resolveFieldOwner` only HONOURS a transfer; it does not
 * create authority.
 */
export interface OwnershipTransfer {
  address: string;
  /** native type or tofu type the transfer was approved for */
  resourceType: string;
  path: string;
  from: FieldOwner;
  to: FieldOwner;
  /** the approval that bound exactly this transfer */
  approvalId: string;
  approvedAt: string;
  /** after this instant the transfer no longer applies */
  expiresAt?: string;
  /** `transferDigest(...)` of address/resourceType/path/from/to; a mismatch voids it */
  digest: string;
}

export type OwnershipTransferRequest = Omit<OwnershipTransfer, "approvalId" | "approvedAt" | "expiresAt" | "digest"> & { digest: string };

export interface FieldWrite {
  address: string;
  resourceType: string;
  path: string;
  writer: WriterKind;
  /** for iac plan writes; create/replace seed the field rather than compete for it */
  action?: "create" | "update" | "delete" | "replace";
  /** capability or label for messages, e.g. `service.scale` */
  via?: string;
  facts?: OwnershipFacts;
}

export type ConflictVerdict = "allowed" | "refused" | "transfer_required";

export interface FieldConflict {
  verdict: ConflictVerdict;
  write: FieldWrite;
  resolution: FieldOwnerResolution;
  /** the writer is seeding a new object (create/replace), which is not a competing write */
  seed?: boolean;
  message: string;
  /** present for `transfer_required` */
  transfer?: OwnershipTransferRequest;
}
