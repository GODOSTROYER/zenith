/**
 * OpenTofu engine contract (spec §10, ADR-0005).
 *
 *   ResourceGraph ─compile─▶ TofuWorkspace (tf.json files + pinned lockfile)
 *     ─init/plan─▶ binary plan + `tofu show -json` ─normalize─▶ NormalizedPlan
 *     ─▶ policy / cost / risk ─▶ approval bound to `planDigest`
 *     ─▶ re-plan immediately before apply; refuse if the digest moved
 *     ─▶ `tofu apply <original saved plan file>` (authenticated review bytes)
 *
 * Pins: the tofu binary version, every provider version (exact `=`), and the
 * `.terraform.lock.hcl` (multi-platform hashes) are part of the workspace and
 * of its digest. `init` runs with `-lockfile=readonly`.
 *
 * The runner executes tofu as a child process with an allowlisted
 * environment — never the control plane's own environment — so no
 * `ZENITH_*`, database URL or signing key can reach a provider plugin.
 */

export const TOFU_VERSION = "1.12.5";

export interface TofuFile {
  /** relative path inside the workspace, e.g. `main.tf.json` */
  path: string;
  content: string;
}

export interface TofuWorkspace {
  files: TofuFile[];
  /** `.terraform.lock.hcl` contents, pinned per provider set */
  lockfile: string;
  /** sha256 over sorted (path, sha256(content)) of files (excluding lockfile) */
  configDigest: string;
  /** sha256 of the lockfile */
  lockDigest: string;
  /** node address → tofu addresses it owns */
  addressMap: Record<string, string[]>;
  /** backend kind; config values live in files, credentials never do */
  backend: "local" | "s3" | "http" | "gcs" | "azurerm";
}

export type TofuAction = "create" | "update" | "delete" | "replace" | "read" | "no-op";

export interface PlanAttributeChange {
  path: string;
  /** masked when sensitive: the string "(sensitive)"; "(known after apply)" when unknown */
  before: unknown;
  after: unknown;
  sensitive: boolean;
  forcesReplacement: boolean;
  /**
   * Additive (WS-TOFU): present only when `sensitive`. HMAC-SHA256 of the raw
   * before/after values, so a sensitive value that changes between approval
   * and apply still changes `planDigest` although the plan only shows
   * "(sensitive)". Server-side only; `planView` never exposes it.
   */
  fingerprint?: string;
}

export interface PlanResourceChange {
  /** tofu address, e.g. `aws_ecs_service.web` */
  address: string;
  /** Zenith resource address it belongs to, from the workspace addressMap */
  nodeAddress?: string;
  type: string;
  providerName: string;
  action: TofuAction;
  changes: PlanAttributeChange[];
  /** deletes or replaces of stateful types (db, bucket, volume, …) */
  destroysData: boolean;
}

export interface NormalizedPlan {
  tofuVersion: string;
  formatVersion: string;
  configDigest: string;
  lockDigest: string;
  /** digest over { configDigest, lockDigest, tofuVersion, resourceChanges(sorted), outputChanges } */
  planDigest: string;
  resourceChanges: PlanResourceChange[];
  outputChanges: { name: string; action: TofuAction; sensitive: boolean }[];
  summary: { create: number; update: number; delete: number; replace: number; noop: number };
  /** plan contains no changes */
  empty: boolean;
  /** tofu diagnostics (warnings), redacted */
  diagnostics: { severity: "warning" | "error"; summary: string; detail?: string }[];
  createdAt: string;
}

export interface TofuRunLimits {
  /** wall clock per command */
  timeoutMs: number;
  /** stdout+stderr bytes retained */
  maxOutputBytes: number;
}

export interface TofuRunResult {
  command: "init" | "plan" | "show" | "apply" | "output" | "providers-lock" | "validate";
  exitCode: number;
  /** redacted, truncated combined output */
  output: string;
  truncated: boolean;
  durationMs: number;
}

export class TofuPlanChangedError extends Error {
  readonly code = "plan_changed";
  constructor(
    readonly approvedDigest: string,
    readonly currentDigest: string
  ) {
    super(`The infrastructure plan changed since it was approved (${approvedDigest.slice(0, 12)} → ${currentDigest.slice(0, 12)}); a new approval is required.`);
  }
}

/** Authenticated review inputs no longer match; no fresh plan digest was observed. */
export class TofuPlanProvenanceError extends Error {
  readonly code = "plan_provenance_changed";
  constructor() {
    super("Reviewed plan provenance changed; a new review is required.");
  }
}
