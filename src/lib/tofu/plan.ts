/**
 * `tofu show -json` → `NormalizedPlan` (ADR-0005) and the model-safe `planView`.
 *
 * What the normalizer guarantees:
 *   - deterministic: resources sort by address, changes by path, outputs by
 *     name; no timestamps or other nondeterministic fields feed `planDigest`;
 *   - masking follows the plan's own `before_sensitive`/`after_sensitive`
 *     trees; unknown-after-apply values become "(known after apply)";
 *   - ECHO SCRUB: a sensitive value that a provider copies into an attribute it
 *     did NOT mark sensitive (observed for real: `terraform_data.output` keeps
 *     the raw value of a sensitive `input` in `before`) is masked wherever it
 *     re-appears as a string of ≥ 8 characters (exact or embedded). Shorter
 *     echoes cannot be told from ordinary values and are not caught;
 *   - sensitive changes still move the digest: each masked change carries a
 *     `fingerprint`, an HMAC of the raw values, so rotating a secret between
 *     approval and apply changes `planDigest` without the value being
 *     recoverable from any plan artifact. The fingerprint is never part of
 *     `planView`.
 *   - no raw output values are kept (`outputChanges` has names and actions).
 *
 * `resource_drift` (out-of-band changes found by refresh) is not read: tofu
 * plans the corrective change into `resource_changes` anyway, and that is
 * what the digest binds.
 *
 * Fail closed: an unknown `format_version` major, an errored plan, a tofu
 * version other than the pin, or an action combination this file does not
 * know (e.g. `forget`) throws `TofuPlanFormatError` rather than approximating.
 */
import { createHmac } from "node:crypto";
import { canonical, digest, sha256Hex } from "@/lib/controlplane/digest";
import { redactExact, redactOutput } from "@/lib/tofu/redact";
import { STATEFUL_KINDS, type ResourceNode } from "@/lib/resources/types";
import { TOFU_VERSION, type NormalizedPlan, type PlanAttributeChange, type PlanResourceChange, type TofuAction } from "@/lib/tofu/types";

export const SENSITIVE_MASK = "(sensitive)";
export const UNKNOWN_MARK = "(known after apply)";

/** Types whose deletion or replacement destroys data rollback cannot restore. */
export const DEFAULT_STATEFUL_TYPES: readonly string[] = [
  // AWS
  "aws_db_instance",
  "aws_rds_cluster",
  "aws_rds_cluster_instance",
  "aws_s3_bucket",
  "aws_elasticache_replication_group",
  "aws_elasticache_cluster",
  "aws_elasticache_serverless_cache",
  "aws_dynamodb_table",
  "aws_efs_file_system",
  "aws_ebs_volume",
  "aws_sqs_queue",
  "aws_sns_topic",
  "aws_secretsmanager_secret",
  "aws_ssm_parameter",
  "aws_kms_key",
  "aws_ecr_repository",
  "aws_cloudwatch_log_group",
  "aws_backup_vault",
  "aws_opensearch_domain",
  "aws_msk_cluster",
  // GCP
  "google_sql_database_instance",
  "google_sql_database",
  "google_sql_user",
  "google_storage_bucket",
  "google_redis_instance",
  "google_secret_manager_secret",
  "google_secret_manager_secret_version",
  "google_artifact_registry_repository",
  "google_dns_managed_zone",
  "google_pubsub_topic",
  "google_pubsub_subscription",
  "google_compute_disk",
  // Azure
  "azurerm_postgresql_flexible_server",
  "azurerm_mysql_flexible_server",
  "azurerm_mssql_database",
  "azurerm_storage_account",
  "azurerm_storage_container",
  "azurerm_redis_cache",
  "azurerm_key_vault",
  "azurerm_key_vault_secret",
  "azurerm_servicebus_namespace",
  "azurerm_servicebus_queue",
  "azurerm_servicebus_topic",
  "azurerm_servicebus_subscription",
  "azurerm_dns_zone",
  "azurerm_private_dns_zone",
  "azurerm_managed_disk",
  // OCI
  "oci_database_db_system",
  "oci_objectstorage_bucket",
  "oci_core_volume",
  "oci_core_boot_volume",
  "oci_vault_secret",
  "oci_kms_vault",
  "oci_queue_queue",
  // Kubernetes
  "kubernetes_persistent_volume_claim",
  "kubernetes_persistent_volume_claim_v1",
  "kubernetes_persistent_volume",
  "kubernetes_persistent_volume_v1",
  "kubernetes_secret",
  "kubernetes_secret_v1",
];

/** Refusals expose addresses and reasons, never resource values. */
export class TofuDeletionRefusedError extends Error {
  readonly code = "deletion_refused";
  constructor(message: string) { super(message); this.name = "TofuDeletionRefusedError"; }
}

/** Stateful deletes/replacements need an explicit allow on their managed node. */
export function assertDeletionAllowed(plan: NormalizedPlan, nodes: readonly ResourceNode[]): void {
  const byAddress = new Map(nodes.map((node) => [node.address, node]));
  for (const change of plan.resourceChanges) {
    if (change.action !== "delete" && change.action !== "replace") continue;
    const node = byAddress.get(change.nodeAddress ?? change.address);
    if (node && node.ownership !== "managed") throw new TofuDeletionRefusedError(`Refusing to delete non-managed resource ${change.address}.`);
    const stateful = change.destroysData || DEFAULT_STATEFUL_TYPES.includes(change.type) || (node && STATEFUL_KINDS.includes(node.kind as (typeof STATEFUL_KINDS)[number]));
    if (stateful && (!node || node.spec.deletionPolicy !== "allow")) {
      throw new TofuDeletionRefusedError(`Stateful resource ${change.address} requires an explicit deletionPolicy of allow on its managed node.`);
    }
  }
}

export class TofuPlanFormatError extends Error {
  readonly code: "unsupported_format" | "unsupported_version" | "errored_plan" | "unsupported_action" | "malformed";
  constructor(code: TofuPlanFormatError["code"], message: string) {
    super(message);
    this.name = "TofuPlanFormatError";
    this.code = code;
  }
}

/* --------------------------- show -json (subset) --------------------------- */

interface ShowChange {
  actions?: string[];
  before?: unknown;
  after?: unknown;
  after_unknown?: unknown;
  before_sensitive?: unknown;
  after_sensitive?: unknown;
  replace_paths?: unknown;
}

interface ShowResourceChange {
  address?: string;
  mode?: string;
  type?: string;
  name?: string;
  index?: string | number;
  provider_name?: string;
  action_reason?: string;
  deposed?: string;
  change?: ShowChange;
}

export interface ShowJson {
  format_version?: string;
  terraform_version?: string;
  errored?: boolean;
  resource_changes?: ShowResourceChange[];
  output_changes?: Record<string, ShowChange>;
}

export interface PlanDiagnostic {
  severity: "warning" | "error";
  summary: string;
  detail?: string;
}

export interface NormalizePlanOptions {
  /** Trusted owning source-set identity supplied by canonical execution composition. */
  executableSourceDigest?: string;
  configDigest: string;
  lockDigest: string;
  /** node address → tofu addresses (`TofuWorkspace.addressMap`) */
  addressMap: Record<string, string[]>;
  statefulTypes?: readonly string[];
  /** warnings/errors parsed from the run's UI stream; redacted here */
  diagnostics?: readonly PlanDiagnostic[];
  /** exact secret values to strip from diagnostics (e.g. the session env) */
  secrets?: readonly string[];
  /**
   * Key for sensitive-change fingerprints. Default derives from the two
   * digests; pass a server-side secret to stop anyone holding a plan from
   * confirming guesses of a low-entropy sensitive value.
   */
  fingerprintKey?: string;
  expectedTofuVersion?: string;
  now?: () => Date;
}

/** Parse `tofu show -json` text. Throws `TofuPlanFormatError` on garbage. */
export function parseShowJson(text: string): ShowJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TofuPlanFormatError("malformed", "`tofu show -json` output is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TofuPlanFormatError("malformed", "`tofu show -json` output is not an object.");
  }
  return parsed as ShowJson;
}

/* --------------------------------- actions -------------------------------- */

export function mapActions(actions: readonly string[] | undefined, where: string): TofuAction {
  const a = actions ?? [];
  const key = a.join(",");
  switch (key) {
    case "no-op":
      return "no-op";
    case "create":
      return "create";
    case "read":
      return "read";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "delete,create":
    case "create,delete":
      return "replace";
    default:
      throw new TofuPlanFormatError("unsupported_action", `${where}: unsupported plan action [${a.join(", ")}]; refusing to approximate it.`);
  }
}

/* ---------------------------------- paths --------------------------------- */

type Seg = string | number;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function formatPath(segs: readonly Seg[]): string {
  let out = "";
  for (const s of segs) {
    if (typeof s === "number") out += `[${s}]`;
    else if (IDENT.test(s)) out += out === "" ? s : `.${s}`;
    else out += `[${JSON.stringify(s)}]`;
  }
  return out;
}

function segsRelated(a: readonly Seg[], b: readonly Seg[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (String(a[i]) !== String(b[i])) return false;
  return true;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/* ------------------------------ masking / scrub ---------------------------- */

const MIN_ECHO_LENGTH = 8;

/** Mask sensitive sub-values of `value` according to a sensitivity tree. */
function maskByTree(value: unknown, sens: unknown): { value: unknown; masked: boolean } {
  if (sens === true) return { value: value === null || value === undefined ? null : SENSITIVE_MASK, masked: value !== null && value !== undefined };
  if (isObj(value) && isObj(sens)) {
    const out: Record<string, unknown> = {};
    let masked = false;
    for (const [k, v] of Object.entries(value)) {
      const r = maskByTree(v, sens[k]);
      out[k] = r.value;
      masked ||= r.masked;
    }
    return { value: out, masked };
  }
  if (Array.isArray(value) && Array.isArray(sens)) {
    let masked = false;
    const out = value.map((v, i) => {
      const r = maskByTree(v, sens[i]);
      masked ||= r.masked;
      return r.value;
    });
    return { value: out, masked };
  }
  return { value, masked: false };
}

/** String leaves of `value` that a sensitivity tree marks sensitive. */
function collectSensitiveStrings(value: unknown, sens: unknown, into: Set<string>): void {
  if (sens === true) {
    collectAllStrings(value, into);
    return;
  }
  if (isObj(value) && isObj(sens)) {
    for (const [k, v] of Object.entries(value)) collectSensitiveStrings(v, sens[k], into);
  } else if (Array.isArray(value) && Array.isArray(sens)) {
    value.forEach((v, i) => collectSensitiveStrings(v, sens[i], into));
  }
}

function collectAllStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (value.length >= MIN_ECHO_LENGTH) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectAllStrings(v, into);
  } else if (isObj(value)) {
    for (const v of Object.values(value)) collectAllStrings(v, into);
  }
}

/** Mask any string that contains a known sensitive value. */
function scrubEcho(value: unknown, secrets: readonly string[]): { value: unknown; scrubbed: boolean } {
  if (secrets.length === 0) return { value, scrubbed: false };
  if (typeof value === "string") {
    for (const s of secrets) if (value.includes(s)) return { value: SENSITIVE_MASK, scrubbed: true };
    return { value, scrubbed: false };
  }
  if (Array.isArray(value)) {
    let scrubbed = false;
    const out = value.map((v) => {
      const r = scrubEcho(v, secrets);
      scrubbed ||= r.scrubbed;
      return r.value;
    });
    return { value: out, scrubbed };
  }
  if (isObj(value)) {
    let scrubbed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = scrubEcho(v, secrets);
      out[k] = r.value;
      scrubbed ||= r.scrubbed;
    }
    return { value: out, scrubbed };
  }
  return { value, scrubbed: false };
}

/* -------------------------------- diffing ---------------------------------- */

interface LeafChange {
  segs: Seg[];
  before: unknown;
  after: unknown;
  beforeSens: unknown;
  afterSens: unknown;
  unknownAfter: boolean;
}

function childKeys(before: unknown, after: unknown, unknown_: unknown): string[] {
  const keys = new Set<string>();
  for (const v of [before, after, unknown_]) if (isObj(v)) for (const k of Object.keys(v)) keys.add(k);
  return [...keys].sort();
}

function walk(before: unknown, after: unknown, unk: unknown, bSens: unknown, aSens: unknown, segs: Seg[], out: LeafChange[]): void {
  const wholeSens = bSens === true || aSens === true;
  const unknownWhole = unk === true;
  if (!wholeSens && !unknownWhole) {
    const objectish = (isObj(before) || before == null) && (isObj(after) || after == null) && (isObj(before) || isObj(after) || isObj(unk));
    if (objectish) {
      const keys = childKeys(before, after, unk);
      if (keys.length > 0) {
        for (const k of keys) {
          walk(
            isObj(before) ? before[k] : undefined,
            isObj(after) ? after[k] : undefined,
            isObj(unk) ? unk[k] : undefined,
            isObj(bSens) ? bSens[k] : undefined,
            isObj(aSens) ? aSens[k] : undefined,
            [...segs, k],
            out
          );
        }
        return;
      }
    }
    const arrayish = (Array.isArray(before) || before == null) && (Array.isArray(after) || after == null) && (Array.isArray(before) || Array.isArray(after) || Array.isArray(unk));
    if (arrayish) {
      const len = Math.max(Array.isArray(before) ? before.length : 0, Array.isArray(after) ? after.length : 0, Array.isArray(unk) ? unk.length : 0);
      if (len > 0) {
        for (let i = 0; i < len; i++) {
          walk(
            Array.isArray(before) ? before[i] : undefined,
            Array.isArray(after) ? after[i] : undefined,
            Array.isArray(unk) ? unk[i] : undefined,
            Array.isArray(bSens) ? bSens[i] : undefined,
            Array.isArray(aSens) ? aSens[i] : undefined,
            [...segs, i],
            out
          );
        }
        return;
      }
    }
  }
  // a leaf: record it when it changes or is only known after apply
  const changed = canonical(before ?? null) !== canonical(after ?? null);
  if (unknownWhole || changed) {
    out.push({ segs, before, after, beforeSens: bSens, afterSens: aSens, unknownAfter: unknownWhole });
  }
}

/** Convert `replace_paths` (arrays of steps) to segment arrays. */
function replacePathsOf(raw: unknown): Seg[][] {
  if (!Array.isArray(raw)) return [];
  const out: Seg[][] = [];
  for (const p of raw) {
    if (!Array.isArray(p)) continue;
    out.push(p.map((s) => (typeof s === "number" ? s : typeof s === "string" ? s : isObj(s) && "value" in s ? (s as { value: Seg }).value : String(s))));
  }
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------ normalization ------------------------------ */

function baseAddress(address: string): string {
  // strip a trailing instance key: aws_x.y["a"] / aws_x.y[0]
  return address.replace(/\[[^\]]*\]$/, "");
}

export function normalizePlan(showJson: ShowJson, opts: NormalizePlanOptions): NormalizedPlan {
  const expected = opts.expectedTofuVersion ?? TOFU_VERSION;
  const formatVersion = showJson.format_version ?? "";
  if (!/^1\.\d+$/.test(formatVersion)) {
    throw new TofuPlanFormatError("unsupported_format", `Unsupported plan format_version "${formatVersion}" (expected 1.x).`);
  }
  if (showJson.terraform_version !== expected) {
    throw new TofuPlanFormatError("unsupported_version", `Plan was produced by tofu ${showJson.terraform_version ?? "unknown"}, expected ${expected}.`);
  }
  if (showJson.errored === true) {
    throw new TofuPlanFormatError("errored_plan", "The plan is marked errored and cannot be normalized.");
  }

  const stateful = new Set(opts.statefulTypes ?? DEFAULT_STATEFUL_TYPES);
  const nodeOf = new Map<string, string>();
  for (const [node, addrs] of Object.entries(opts.addressMap)) for (const a of addrs) nodeOf.set(a, node);
  const fpKey = opts.fingerprintKey ?? sha256Hex(`zenith.tofu.plan.fingerprint.v1\0${opts.configDigest}\0${opts.lockDigest}`);
  const fingerprint = (address: string, path: string, before: unknown, after: unknown, unknownAfter: boolean) =>
    createHmac("sha256", fpKey).update(canonical([address, path, before ?? null, unknownAfter ? "(unknown)" : (after ?? null)])).digest("hex");

  const rcs = showJson.resource_changes ?? [];
  const outs = showJson.output_changes ?? {};

  // pass 1: every sensitive string in the plan, so echoes can be scrubbed
  const sensitiveStrings = new Set<string>();
  for (const rc of rcs) {
    const c = rc.change;
    if (!c) continue;
    collectSensitiveStrings(c.before, c.before_sensitive, sensitiveStrings);
    collectSensitiveStrings(c.after, c.after_sensitive, sensitiveStrings);
  }
  for (const c of Object.values(outs)) {
    if (c.before_sensitive === true) collectAllStrings(c.before, sensitiveStrings);
    if (c.after_sensitive === true) collectAllStrings(c.after, sensitiveStrings);
  }
  // longest first so the widest secret is matched before a substring of it
  const secretList = [...sensitiveStrings].sort((a, b) => b.length - a.length || cmp(a, b));

  const resourceChanges: PlanResourceChange[] = [];
  for (const rc of rcs) {
    if (typeof rc.address !== "string" || typeof rc.type !== "string" || !rc.change) {
      throw new TofuPlanFormatError("malformed", "A resource_changes entry is missing address, type or change.");
    }
    const address = rc.deposed ? `${rc.address} (deposed ${rc.deposed})` : rc.address;
    const action = mapActions(rc.change.actions, address);
    const changes: PlanAttributeChange[] = [];

    if (action !== "no-op" && action !== "read") {
      const leaves: LeafChange[] = [];
      walk(rc.change.before, rc.change.after, rc.change.after_unknown, rc.change.before_sensitive, rc.change.after_sensitive, [], leaves);
      const replacePaths = action === "replace" ? replacePathsOf(rc.change.replace_paths) : [];
      for (const leaf of leaves) {
        const path = formatPath(leaf.segs);
        const b = maskByTree(leaf.before, leaf.beforeSens);
        const a = leaf.unknownAfter ? { value: UNKNOWN_MARK, masked: false } : maskByTree(leaf.after, leaf.afterSens);
        const bs = scrubEcho(b.value, secretList);
        const as = scrubEcho(a.value, secretList);
        const sensitive = b.masked || a.masked || bs.scrubbed || as.scrubbed;
        // a masked attribute masks both sides: revealing one side of a sensitive value is still revealing it
        const beforeOut = sensitive && bs.value !== null && bs.value !== undefined ? SENSITIVE_MASK : (bs.value ?? null);
        const afterOut = leaf.unknownAfter ? UNKNOWN_MARK : sensitive && as.value !== null && as.value !== undefined ? SENSITIVE_MASK : (as.value ?? null);
        const change: PlanAttributeChange = {
          path,
          before: beforeOut,
          after: afterOut,
          sensitive,
          forcesReplacement: replacePaths.some((rp) => segsRelated(rp, leaf.segs)),
        };
        if (sensitive) change.fingerprint = fingerprint(address, path, leaf.before, leaf.after, leaf.unknownAfter);
        changes.push(change);
      }
      changes.sort((x, y) => cmp(x.path, y.path));
    }

    const type = rc.type;
    resourceChanges.push({
      address,
      nodeAddress: nodeOf.get(baseAddress(rc.address)),
      type,
      providerName: rc.provider_name ?? "",
      action,
      changes,
      destroysData: (action === "delete" || action === "replace") && stateful.has(type),
    });
  }
  resourceChanges.sort((x, y) => cmp(x.address, y.address));

  const outputChanges: NormalizedPlan["outputChanges"] = Object.entries(outs)
    .map(([name, c]) => ({
      name,
      action: mapActions(c.actions, `output ${name}`),
      sensitive: c.before_sensitive === true || c.after_sensitive === true,
    }))
    .sort((x, y) => cmp(x.name, y.name));

  const summary = { create: 0, update: 0, delete: 0, replace: 0, noop: 0 };
  for (const r of resourceChanges) {
    if (r.action === "create") summary.create++;
    else if (r.action === "update") summary.update++;
    else if (r.action === "delete") summary.delete++;
    else if (r.action === "replace") summary.replace++;
    else if (r.action === "no-op") summary.noop++;
  }
  const changing = (a: TofuAction) => a === "create" || a === "update" || a === "delete" || a === "replace";
  const empty = !resourceChanges.some((r) => changing(r.action)) && !outputChanges.some((o) => changing(o.action));

  const diagnostics = (opts.diagnostics ?? []).map((d) => ({
    severity: d.severity,
    summary: redactOutput(redactExact(d.summary, [...(opts.secrets ?? []), ...secretList])),
    ...(d.detail ? { detail: redactOutput(redactExact(d.detail, [...(opts.secrets ?? []), ...secretList])) } : {}),
  }));

  if (opts.executableSourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(opts.executableSourceDigest)) throw new TofuPlanFormatError("malformed", "Executable source identity is invalid.");
  const planDigest = digest({
    configDigest: opts.configDigest,
    lockDigest: opts.lockDigest,
    tofuVersion: expected,
    resourceChanges,
    outputChanges,
    ...(opts.executableSourceDigest ? { executableSourceDigest: opts.executableSourceDigest } : {}),
  });

  return {
    tofuVersion: expected,
    formatVersion,
    configDigest: opts.configDigest,
    lockDigest: opts.lockDigest,
    planDigest,
    ...(opts.executableSourceDigest ? { executableSourceDigest: opts.executableSourceDigest } : {}),
    resourceChanges,
    outputChanges,
    summary,
    empty,
    diagnostics,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
  };
}

/* ------------------------------- model-safe view ---------------------------- */

export interface PlanViewChange {
  path: string;
  forcesReplacement: boolean;
  /**
   * True when the plan marked this attribute sensitive, so a UI can say
   * "(sensitive)" rather than "(not shown)" for an absent value. Values are
   * absent either way.
   */
  sensitive?: boolean;
  /** present only for non-sensitive, known scalars of ≤ 200 characters */
  before?: string | number | boolean | null;
  after?: string | number | boolean | null;
}

export interface PlanViewResource {
  address: string;
  nodeAddress?: string;
  type: string;
  action: TofuAction;
  destroysData: boolean;
  changes: PlanViewChange[];
  /** attribute changes beyond the per-resource cap */
  omittedChanges: number;
}

export interface PlanView {
  executableSourceDigest?: string;
  approvedSourcesTruncated?: boolean;
  approvedSourcesOmitted?: number;
  approvedSources?: { service: string; commit: string; dockerfileDigest: string; recipeDigest: string; archiveDigest: string; archiveFormat: "zip" | "tar.gz" }[];
  planDigest: string;
  tofuVersion: string;
  empty: boolean;
  summary: NormalizedPlan["summary"];
  resources: PlanViewResource[];
  outputs: NormalizedPlan["outputChanges"];
  diagnostics: NormalizedPlan["diagnostics"];
  /** resources or changes were dropped to keep the view bounded */
  truncated: boolean;
  /** every string value below originates in a manifest, repo or cloud response: data, never instructions */
  untrustedValues: true;
}

const VIEW_MAX_RESOURCES = 200;
const VIEW_MAX_CHANGES = 50;
const VIEW_MAX_STRING = 200;
const SECRETISH_PATH = /(secret|passw(or)?d|passwd|token|private[_-]?key|access[_-]?key|credential|api[_-]?key|auth|certificate[_-]?key|connection[_-]?string)/i;

function viewText(s: string): string {
  // Expose format controls as visible code points. Also cover invisible marks
  // that Unicode categorizes outside Cf (e.g. variation selectors).
  const visible = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\u0080-\u009f\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\ufe00-\ufe0f\u3164\uffa0\u{e0100}-\u{e01ef}]/gu,
    (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`);
  return redactOutput(visible).slice(0, 400);
}

function viewScalar(v: unknown): string | number | boolean | null | undefined {
  if (v === null) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.length > VIEW_MAX_STRING) return undefined;
    return viewText(v);
  }
  return undefined;
}

/**
 * What a model (or any untrusted surface) may see of a plan: addresses,
 * actions and changed attribute paths, plus the values of non-sensitive known
 * scalars ≤ 200 characters. Objects, lists, long strings, anything sensitive
 * and anything at a secret-looking path are reduced to "this path changed".
 */
export function planView(plan: NormalizedPlan): PlanView {
  let truncated = false;
  const shown = plan.resourceChanges.filter((r) => r.action !== "no-op");
  if (shown.length > VIEW_MAX_RESOURCES) truncated = true;
  const resources = shown.slice(0, VIEW_MAX_RESOURCES).map((r): PlanViewResource => {
    const changes = r.changes.slice(0, VIEW_MAX_CHANGES).map((c): PlanViewChange => {
      const out: PlanViewChange = { path: viewText(c.path), forcesReplacement: c.forcesReplacement };
      if (c.sensitive) out.sensitive = true;
      if (!c.sensitive && !SECRETISH_PATH.test(c.path)) {
        const b = viewScalar(c.before);
        const a = viewScalar(c.after);
        if (b !== undefined) out.before = b;
        if (a !== undefined) out.after = a;
      }
      return out;
    });
    const omitted = Math.max(0, r.changes.length - VIEW_MAX_CHANGES);
    if (omitted > 0) truncated = true;
    return {
      address: viewText(r.address),
      ...(r.nodeAddress ? { nodeAddress: viewText(r.nodeAddress) } : {}),
      type: viewText(r.type),
      action: r.action,
      destroysData: r.destroysData,
      changes,
      omittedChanges: omitted,
    };
  });
  return {
    planDigest: plan.planDigest,
    ...(plan.executableSourceDigest ? { executableSourceDigest: plan.executableSourceDigest } : {}),
    tofuVersion: plan.tofuVersion,
    empty: plan.empty,
    summary: plan.summary,
    resources,
    outputs: plan.outputChanges.map((o) => ({ ...o, name: viewText(o.name) })),
    diagnostics: plan.diagnostics.map((d) => ({ severity: d.severity, summary: viewText(d.summary), ...(d.detail ? { detail: viewText(d.detail) } : {}) })),
    truncated,
    untrustedValues: true,
  };
}
