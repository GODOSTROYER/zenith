/**
 * Helpers private to the AWS data drivers (RDS, ElastiCache, S3, SQS, Secrets
 * Manager, IAM roles, CloudWatch log groups). Everything generic lives in
 * `./_shared` (a snapshot of WS-AWS-NET's shared helpers); what is here is what
 * the data group needs on top:
 *
 *   - `call`            abort-aware SDK send (`ctx.signal` → `abortSignal`);
 *   - template safety   `escapeTemplate`/`safeTags`: a `.tf.json` string is an
 *                       HCL template, so manifest-derived text is escaped and
 *                       only references are allowed to interpolate;
 *   - config parsing    bounded, typed reads of `spec.config` (an allowlist;
 *                       nothing in `config` is copied into a fragment);
 *   - tag lookup        find a node's object by the Zenith tags through the
 *                       Resource Groups Tagging API (never by name alone);
 *   - observe / runtime guards and the verification builder, so each driver's
 *                       reads stay short and every failure is classified
 *                       (AccessDenied → inaccessible, NotFound → missing,
 *                       throttling/other → unknown) instead of thrown;
 *   - discovery helpers (`tagMap`, zenith tagging, bounded tag reads).
 *
 * Nothing here can return a secret value: the drivers never call an API that
 * returns one, and `boundNative` redacts secret-looking keys as a backstop.
 */
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import type { DiscoveredResource, VerificationCheck, VerificationResult } from "@/lib/drivers/types";
import type { HealthState, Observation, ObservedValue, ResourceNode, RuntimeState } from "@/lib/resources/types";
import {
  boundNative,
  classifyAwsError as classifyAwsErrorBase,
  DriverCompileError,
  failedObservation,
  knownValue,
  nowIso,
  paginate,
  runtimeState,
  scopeTagValues,
  TAG_ENVIRONMENT,
  TAG_RESOURCE,
  TAG_WORKSPACE,
  throwIfAborted,
  unknownAttributes,
  unknownReasonOf,
  unknownValue,
  type AwsDriverContext,
  type AwsFailure,
} from "./_shared";

export type { AwsDriverContext } from "./_shared";

/* ----------------------------- error classification ------------------------ */

/**
 * The shared classifier plus the names this group meets that it does not know:
 * SQS's legacy `AWS.SimpleQueueService.NonExistentQueue` is "not found", not a
 * generic error. (Proposed for the shared NOT_FOUND pattern; kept here until then.)
 */
export function classifyAwsError(error: unknown, signal?: AbortSignal): AwsFailure {
  const f = classifyAwsErrorBase(error, signal);
  if (f.kind === "error" && /NonExistentQueue$/.test(f.code)) return { ...f, kind: "missing" };
  return f;
}

/* ------------------------------ abort-aware send --------------------------- */

/** Run one SDK call with `ctx.signal` attached; throws `AbortError` first if it already fired. */
export async function call<T>(ctx: AwsDriverContext, fn: (options: { abortSignal: AbortSignal }) => Promise<T>): Promise<T> {
  throwIfAborted(ctx.signal);
  return fn({ abortSignal: ctx.signal });
}

/* ----------------------------- template safety ----------------------------- */

/**
 * Escape text so HCL renders it literally (`${` becomes `$${`, `%{` becomes `%%{`).
 * The replacements are functions on purpose: in a replacement STRING `$$` means a
 * single `$`, so `"$${"` would silently turn `${` back into `${`.
 */
export const escapeTemplate = (s: string): string => s.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");

/**
 * Tags for a compiled resource with every key and value escaped. `tags` comes
 * from `resourceTags`; values originate in the orchestrator (workspace and
 * environment ids) and the node address, none of which is trusted to be free
 * of template openers.
 */
export function safeTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [escapeTemplate(k), escapeTemplate(v)]));
}

/** `${expr}` for a bare traversal. The expression must be generator-owned, never manifest text. */
export const interp = (expr: string): string => `\${${expr}}`;

/* ------------------------------ spec / config ------------------------------ */

export type ConfigValue = string | number | boolean;

export function configOf(node: ResourceNode): Record<string, ConfigValue> {
  const raw = (node.spec as { config?: unknown }).config;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** A finite integer within [min, max] from `config[key]` (numeric strings allowed), or `undefined` when absent. Refuses, never clamps. */
export function configInt(node: ResourceNode, key: string, min: number, max: number): number | undefined {
  const v = configOf(node)[key];
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new DriverCompileError("invalid_spec", node.address, `config.${key} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

/** One of `allowed` from `config[key]`, or `undefined` when absent. */
export function configEnum<T extends string>(node: ResourceNode, key: string, allowed: readonly T[]): T | undefined {
  const v = configOf(node)[key];
  if (v === undefined) return undefined;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new DriverCompileError("invalid_spec", node.address, `config.${key} must be one of ${allowed.join(", ")}.`);
}

/** A required member of a closed set from the spec (not `config`). Fails closed on anything else. */
export function specEnum<T extends string>(node: ResourceNode, key: string, allowed: readonly T[], fallback?: T): T {
  const v = (node.spec as Record<string, unknown>)[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new DriverCompileError("invalid_spec", node.address, `spec.${key} must be one of ${allowed.join(", ")}.`);
}

export function specBool(node: ResourceNode, key: string, fallback: boolean): boolean {
  const v = (node.spec as Record<string, unknown>)[key];
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  throw new DriverCompileError("invalid_spec", node.address, `spec.${key} must be true or false.`);
}

export const SIZES = ["nano", "small", "standard", "performance"] as const;
export type Size = (typeof SIZES)[number];

export function sizeOf(node: ResourceNode, fallback?: Size): Size | undefined {
  const v = (node.spec as { size?: unknown }).size;
  if (typeof v === "string" && (SIZES as readonly string[]).includes(v)) return v as Size;
  return fallback;
}

/** Managed-data deletion policy → does the backing service get deletion protection / force_destroy. */
export const DELETION_POLICIES = ["deny", "approval", "allow"] as const;
export type DeletionPolicy = (typeof DELETION_POLICIES)[number];
export const BACKUPS = ["none", "daily", "hourly"] as const;
export type BackupPolicy = (typeof BACKUPS)[number];

/** Only `managed` nodes are compiled; `referenced`/`external` nodes contribute no resource blocks. */
export const isManaged = (node: ResourceNode): boolean => node.ownership === "managed";

export const EMPTY_FRAGMENT = { addresses: [] as string[] };

/** Keep `value` only when it matches `pattern`; used before any id is sent to an API. */
export function validId(value: string | undefined, pattern: RegExp): string | undefined {
  return value !== undefined && pattern.test(value) ? value : undefined;
}

/* --------------------------------- tags ------------------------------------ */

export interface KeyValue {
  Key?: string;
  Value?: string;
}

/** `[{Key,Value}]` or `{k:v}` → sorted `{k:v}`. */
export function tagMap(input: KeyValue[] | Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(input)) {
    for (const t of input) if (typeof t.Key === "string") out[t.Key] = t.Value ?? "";
  } else if (input) {
    for (const [k, v] of Object.entries(input)) out[k] = v ?? "";
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Tags identify exactly this node in this workspace and environment. */
export function tagsMatchNode(tags: Record<string, string>, ctx: AwsDriverContext, node: ResourceNode): boolean {
  const want = scopeTagValues(ctx);
  return tags[TAG_RESOURCE] === node.address && tags[TAG_ENVIRONMENT] === want.environment && tags[TAG_WORKSPACE] === want.workspace;
}

/** What discovery reports in `attributes`: only scalars, bounded. */
export type Scalar = string | number | boolean;
export function scalars(values: Record<string, Scalar | undefined | null>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 199)}…` : v;
  }
  return out;
}

export interface TaggedArn {
  arn: string;
  tags: Record<string, string>;
}

/**
 * The objects of `resourceType` that carry this node's Zenith tags
 * (workspace + environment + resource address), through the Resource Groups
 * Tagging API. Used only when the node has no known `externalId`.
 *
 * Honest limit: the tagging index is eventually consistent, so an object
 * created a moment ago can be absent. Callers report that as `missing` with a
 * note, never as a confident "does not exist". IAM roles are indexed in
 * us-east-1 (`region` override).
 */
export async function findByTags(ctx: AwsDriverContext, node: ResourceNode, resourceType: string, opts: { region?: string } = {}): Promise<{ matches: TaggedArn[]; truncated: boolean }> {
  const client = ctx.session.client(ResourceGroupsTaggingAPIClient, opts.region ? { region: opts.region } : undefined);
  const want = scopeTagValues(ctx);
  const { items, truncated } = await paginate(
    async (token) => {
      const out = await call(ctx, (o) =>
        client.send(
          new GetResourcesCommand({
            TagFilters: [
              { Key: TAG_ENVIRONMENT, Values: [want.environment] },
              { Key: TAG_RESOURCE, Values: [node.address] },
              { Key: TAG_WORKSPACE, Values: [want.workspace] },
            ],
            ResourceTypeFilters: [resourceType],
            ResourcesPerPage: 100,
            ...(token ? { PaginationToken: token } : {}),
          }),
          o
        )
      );
      const items: TaggedArn[] = [];
      for (const m of out.ResourceTagMappingList ?? []) if (m.ResourceARN) items.push({ arn: m.ResourceARN, tags: tagMap(m.Tags) });
      return { items, next: out.PaginationToken || undefined };
    },
    { maxPages: 5, signal: ctx.signal }
  );
  return { matches: items, truncated };
}

/* ----------------------------- observe / runtime --------------------------- */

export type ReadResult =
  | { kind: "present"; externalId: string; attributes: Record<string, ObservedValue>; native: Record<string, unknown> }
  | { kind: "missing"; externalId?: string; detail?: string }
  | { kind: "ambiguous"; detail: string };

/**
 * Run a driver's read. A thrown SDK error is classified, never rethrown —
 * except an abort, which is never an observation result.
 *
 * @param names every attribute the driver reports; the ones a failed or
 *        missing read could not produce are marked `unknown` with the reason.
 */
export async function guardObserve(
  ctx: AwsDriverContext,
  node: ResourceNode,
  source: string,
  names: readonly string[],
  hint: string | undefined,
  read: () => Promise<ReadResult>,
  priority: readonly string[] = ["tags"]
): Promise<Observation> {
  try {
    const r = await read();
    const base = { address: node.address, observedAt: nowIso(ctx), source, simulated: false };
    if (r.kind === "present") {
      return { ...base, externalId: r.externalId, presence: "present", attributes: r.attributes, native: boundNative(r.native, { priority }) };
    }
    if (r.kind === "missing") {
      return {
        ...base,
        ...(r.externalId ?? hint ? { externalId: (r.externalId ?? hint) as string } : {}),
        presence: "missing",
        attributes: unknownAttributes(names, "not_applicable", r.detail ?? "the provider reports the object does not exist"),
        ...(r.detail ? { error: r.detail } : {}),
      };
    }
    return { ...base, ...(hint ? { externalId: hint } : {}), presence: "unknown", attributes: unknownAttributes(names, "error", r.detail), error: r.detail };
  } catch (err) {
    const failure = classifyAwsError(err, ctx.signal);
    if (failure.kind === "aborted") throw err;
    return failedObservation(ctx, node, source, names, failure, hint);
  }
}

/** Mark `names` unknown after a failed sub-read; `failure` decides the reason. */
export function failAttributes(out: Record<string, ObservedValue>, names: readonly string[], failure: AwsFailure): void {
  for (const n of names) out[n] = unknownValue(unknownReasonOf(failure), failure.summary);
}

/** Collects `known` attributes against one clock reading. */
export class Attributes {
  readonly out: Record<string, ObservedValue> = {};
  constructor(private readonly ctx: { now(): Date }) {}
  /**
   * `null` is a KNOWN answer ("read, and absent"); `undefined` means the
   * provider did not return the field, which is `unknown`/`not_applicable`,
   * never a silent match.
   */
  set(name: string, value: unknown): void {
    this.out[name] = value === undefined ? unknownValue("not_applicable", "the provider did not return this field") : knownValue(this.ctx, value);
  }
  unknown(name: string, reason: "not_supported" | "not_inspected" | "access_denied" | "error" | "not_applicable", detail?: string): void {
    this.out[name] = unknownValue(reason, detail);
  }
  /** Fill every name in `names` that was never touched with `not_inspected`. */
  finish(names: readonly string[]): Record<string, ObservedValue> {
    for (const n of names) if (!(n in this.out)) this.out[n] = unknownValue("not_inspected");
    return this.out;
  }
}

export type RuntimeRead = { health: HealthState; counts: Record<string, number>; signals: string[] } | "missing";

export async function guardRuntime(ctx: AwsDriverContext, node: ResourceNode, source: string, read: () => Promise<RuntimeRead>): Promise<RuntimeState> {
  try {
    const r = await read();
    if (r === "missing") return runtimeState(ctx, node, source, "unhealthy", {}, ["missing"]);
    return runtimeState(ctx, node, source, r.health, r.counts, r.signals);
  } catch (err) {
    const failure = classifyAwsError(err, ctx.signal);
    if (failure.kind === "aborted") throw err;
    if (failure.kind === "missing") return runtimeState(ctx, node, source, "unhealthy", {}, ["missing"]);
    return runtimeState(ctx, node, source, "unknown", {}, [`read_failed:${failure.kind}:${failure.code}`]);
  }
}

/* ------------------------------ verification ------------------------------- */

const isScalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Cloud APIs answer "3" for 3 and "true" for true: compare scalars by text, structures canonically (the drift rule). */
export const sameValue = (a: unknown, b: unknown): boolean => (isScalar(a) && isScalar(b) ? String(a) === String(b) : canonicalJson(a) === canonicalJson(b));

/** A check on one observed attribute; `unknown` when it was not read. */
export function attrCheck(obs: Observation, id: string, description: string, name: string, ok: (value: unknown) => boolean): VerificationCheck {
  const v = obs.attributes[name];
  if (!v || v.state !== "known") return { id, description, passed: "unknown", detail: `${name} was not read` };
  const passed = ok(v.value);
  return { id, description, passed, detail: `${name} = ${isScalar(v.value) ? String(v.value) : canonicalJson(v.value).slice(0, 120)}` };
}

/**
 * The desired attributes of `node` in observe's units, or `{}` when there are
 * none to compare: Zenith defines no desired configuration for a `referenced`
 * node (it only reads it), and a spec the driver would refuse to compile has no
 * defined expectation. It must never throw: drift calls it for every node, and
 * one unreadable spec must not take the whole report down.
 */
export function expectedFor(node: ResourceNode, build: () => Record<string, unknown>): Record<string, unknown> {
  if (!isManaged(node)) return {};
  try {
    return build();
  } catch (err) {
    if (err instanceof DriverCompileError) return {};
    throw err;
  }
}

/**
 * Every known observed attribute that has an expected value must equal it.
 * Names only; values could be long. `undefined` when there is nothing expected,
 * so a `referenced` node is not reported `unknown` for lack of a desired state.
 */
export function matchesExpectedCheck(expected: Record<string, unknown>, obs: Observation): VerificationCheck | undefined {
  if (Object.keys(expected).length === 0) return undefined;
  const differing: string[] = [];
  let compared = 0;
  for (const [name, want] of Object.entries(expected)) {
    const seen = obs.attributes[name];
    if (want === undefined || !seen || seen.state !== "known") continue;
    compared++;
    if (!sameValue(want, seen.value)) differing.push(name);
  }
  if (compared === 0) return { id: "configuration_matches", description: "observed configuration matches the desired spec", passed: "unknown", detail: "no expected attribute was read" };
  return {
    id: "configuration_matches",
    description: "observed configuration matches the desired spec",
    passed: differing.length === 0,
    detail: differing.length === 0 ? `${compared} attribute(s) compared` : `differs on ${differing.sort().join(", ")}`,
  };
}

export function verificationOf(ctx: { now(): Date }, node: ResourceNode, obs: Observation, optionalChecks: (VerificationCheck | undefined)[]): VerificationResult {
  const checks = optionalChecks.filter((c): c is VerificationCheck => c !== undefined);
  const base = { address: node.address, checkedAt: nowIso(ctx), simulated: false };
  const exists: VerificationCheck = {
    id: "exists",
    description: "the object exists and was readable",
    passed: obs.presence === "present" ? true : obs.presence === "missing" ? false : "unknown",
    detail: `presence = ${obs.presence}`,
  };
  if (obs.presence !== "present") {
    return { ...base, status: obs.presence === "missing" ? "failed" : "unknown", checks: [exists] };
  }
  const all = [exists, ...checks];
  const status = all.some((c) => c.passed === false) ? "failed" : all.some((c) => c.passed === "unknown") ? "unknown" : "passed";
  return { ...base, status, checks: all };
}

/* -------------------------------- discovery -------------------------------- */

export function candidate(
  ctx: AwsDriverContext,
  c: Omit<DiscoveredResource, "provider" | "region" | "zenithTagged"> & { tags?: Record<string, string>; region?: string }
): DiscoveredResource {
  const { tags, region, ...rest } = c;
  const want = scopeTagValues(ctx);
  const zenithTagged = tags !== undefined && tags["zenith:managed"] === "true" && tags[TAG_ENVIRONMENT] === want.environment && tags[TAG_WORKSPACE] === want.workspace;
  return { provider: "aws", region: region ?? ctx.region, zenithTagged, ...rest };
}

/** Upper bound on per-candidate tag reads in `discover`; beyond it `zenithTagged` is false (unread), not guessed. */
export const MAX_TAG_READS = 50;

