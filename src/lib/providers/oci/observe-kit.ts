/**
 * Shared machinery for the OCI drivers' read-only operations (observe,
 * runtime, verify, discover), so each driver is only "which calls, which
 * fields" and the honesty rules live in one place.
 *
 * Rules enforced here (DRIVER-CONVENTIONS "Observe / runtime / verify"):
 *   - read-only: only GET calls are ever built by the helpers;
 *   - find by externalId when known, else by the Zenith tags
 *     (`zenith_environment` + `zenith_resource`); never by name alone;
 *   - presence is `present` / `missing` / `inaccessible` / `unknown`, and
 *     `missing` needs POSITIVE evidence. OCI answers 404 `NotAuthorizedOrNotFound`
 *     for both "absent" and "not allowed to see", so a 404 on a GET by id is
 *     not enough: the compartment-scoped list must succeed and contain nothing
 *     (and must not have been truncated by the page bound);
 *   - throttling (429), 5xx and transport failures are `unknown` with the
 *     reason, never `missing`; 401/403 are `inaccessible`;
 *   - only attributes actually read are `known`; everything else is
 *     `unknown` with a reason;
 *   - `native` is a bounded (≤ 4 KiB), allowlisted, redacted bag; its `tags`
 *     speak the platform vocabulary (`zenith:environment`) so drift's
 *     "extra" detection works unchanged.
 */
import { canonical } from "@/lib/controlplane/digest";
import type { DiscoveredResource, DriverContext, VerificationCheck, VerificationResult } from "@/lib/drivers/types";
import type { HealthState, Observation, ObservedValue, PortableKind, Presence, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { isPointerKey, looksSecretKey } from "@/lib/resources/secrets";
import { TAG_ENV, TAG_RESOURCE, TAG_MANAGED, zenithTagKey } from "./naming";
import { isOcid, type OciServiceId } from "./services";
import { ociCall, type OciApiRequest, type OciResult, type OciSession } from "./transport";

export type OciContext = DriverContext<OciSession>;

export const MAX_LIST_PAGES = 8;
export const MAX_NATIVE_BYTES = 4096;

/* ------------------------------- value helpers ------------------------------ */

export const known = <T>(value: T, at: string): ObservedValue<T> => ({ state: "known", value, observedAt: at });
export const unknownValue = (reason: Extract<ObservedValue, { state: "unknown" }>["reason"], detail?: string): ObservedValue => ({ state: "unknown", reason, ...(detail ? { detail } : {}) });

/** `undefined` members become `unknown`, everything else `known`. */
export function attributesOf(at: string, values: Record<string, unknown>, missingReason: "not_inspected" | "not_supported" = "not_inspected"): Record<string, ObservedValue> {
  const out: Record<string, ObservedValue> = {};
  for (const [k, v] of Object.entries(values)) out[k] = v === undefined ? unknownValue(missingReason) : known(v, at);
  return out;
}

export const asRecord = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
export const asString = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
export const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function tagsOf(item: unknown): Record<string, string> {
  const t = asRecord(asRecord(item)?.freeformTags);
  const out: Record<string, string> = {};
  if (t) for (const [k, v] of Object.entries(t)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Zenith's tags, in the platform's vocabulary, for drift's `extra` detection. */
export function platformTags(item: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tagsOf(item))) if (k.startsWith("zenith_")) out[zenithTagKey(k)] = v;
  return out;
}

const DEAD_STATES = new Set(["TERMINATED", "DELETED", "DELETING", "SCHEDULING_DELETION", "PENDING_DELETION", "SCHEDULING_DELETION_FAILED"]);
const GONE_STATES = new Set(["TERMINATED", "DELETED"]);

export const stateOf = (item: unknown): string | undefined => asString(asRecord(item)?.lifecycleState);
export const isGone = (item: unknown): boolean => GONE_STATES.has(stateOf(item) ?? "");
export const isDying = (item: unknown): boolean => DEAD_STATES.has(stateOf(item) ?? "");

/** Allowlisted, redacted, size-bounded copy of native fields. */
export function boundNative(native: Record<string, unknown>, max = MAX_NATIVE_BYTES): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(native)) {
    if (v === undefined) continue;
    if (looksSecretKey(k) && !isPointerKey(k)) continue;
    out[k] = v;
  }
  let keys = Object.keys(out);
  while (keys.length > 0 && Buffer.byteLength(JSON.stringify(out)) > max) {
    // drop the largest member first so the small, most useful fields survive
    const biggest = keys.reduce((a, b) => (JSON.stringify(out[a]).length >= JSON.stringify(out[b]).length ? a : b));
    delete out[biggest];
    keys = Object.keys(out);
  }
  return out;
}

/* --------------------------------- locating -------------------------------- */

export interface LocateDef {
  service: OciServiceId;
  /** GET by id; absent when the service cannot GET by the externalId we hold */
  get?(id: string): Pick<OciApiRequest, "path" | "query">;
  /** compartment-scoped list (paginated through `opc-next-page`) */
  list(compartmentOcid: string, session: OciSession): Pick<OciApiRequest, "path" | "query"> & { service?: OciServiceId };
  /** collection body → items */
  items(body: unknown): unknown[];
  idOf(item: unknown): string | undefined;
  /** accept an externalId that is not an OCID (bucket names) */
  validId?(id: string): boolean;
}

export interface Located {
  presence: Presence;
  item?: Record<string, unknown>;
  externalId?: string;
  requestIds: string[];
  error?: string;
  /** every tag-matching object, when more than one matched (ambiguity) */
  matches?: number;
}

export interface Listed {
  ok: true;
  items: unknown[];
  truncated: boolean;
  requestIds: string[];
}
export type ListOutcome = Listed | { ok: false; failure: Extract<OciResult, { ok: false }>; requestIds: string[] };

export async function listAll(
  ctx: OciContext,
  base: OciApiRequest,
  items: (body: unknown) => unknown[],
  maxPages = MAX_LIST_PAGES
): Promise<ListOutcome> {
  const all: unknown[] = [];
  const requestIds: string[] = [];
  let page: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const r = await ociCall(ctx, { ...base, query: { ...base.query, ...(page ? { page } : {}) } });
    if (r.requestId) requestIds.push(r.requestId);
    if (!r.ok) return { ok: false, failure: r, requestIds };
    all.push(...items(r.body));
    page = r.headers["opc-next-page"];
    if (!page) return { ok: true, items: all, truncated: false, requestIds };
  }
  return { ok: true, items: all, truncated: true, requestIds };
}

/** presence for a failed read: denied → inaccessible; the rest → unknown */
const presenceOfFailure = (f: Extract<OciResult, { ok: false }>): Presence => (f.outcome === "denied" ? "inaccessible" : "unknown");

export const isZenithObject = (item: unknown, environmentId: string, address: string): boolean => {
  const t = tagsOf(item);
  return t[TAG_ENV] === environmentId && t[TAG_RESOURCE] === address;
};

export async function locate(ctx: OciContext, node: ResourceNode, externalId: string | undefined, def: LocateDef): Promise<Located> {
  const region = node.region || ctx.region;
  const requestIds: string[] = [];

  if (externalId !== undefined && def.get) {
    const valid = def.validId ? def.validId(externalId) : isOcid(externalId);
    if (!valid) return { presence: "unknown", requestIds, error: "The recorded external id is not a valid identifier for this resource type; it was not used." };
    const r = await ociCall(ctx, { service: def.service, region, method: "GET", ...def.get(externalId) });
    if (r.requestId) requestIds.push(r.requestId);
    if (r.ok) {
      const item = asRecord(r.body);
      if (item && !isGone(item)) return { presence: "present", item, externalId: def.idOf(item) ?? externalId, requestIds };
      // a terminated object is "gone": corroborate with the compartment list below
    } else if (r.outcome !== "not_found") {
      return { presence: presenceOfFailure(r), requestIds, error: r.message };
    }
  }

  const listReq = def.list(ctx.session.compartmentOcid, ctx.session);
  const listed = await listAll(ctx, { service: listReq.service ?? def.service, region, method: "GET", path: listReq.path, query: listReq.query }, def.items);
  requestIds.push(...listed.requestIds);
  if (!listed.ok) {
    const f = listed.failure;
    // A 404 on the list means OCI hid the compartment from us: that is "cannot see", not "absent".
    if (f.outcome === "not_found") return { presence: "inaccessible", requestIds, error: `${f.message} (OCI reports 404 for unauthorized reads too, so absence cannot be concluded)` };
    return { presence: presenceOfFailure(f), requestIds, error: f.message };
  }

  const matches = listed.items.filter((i) => !isGone(i) && isZenithObject(i, ctx.environmentId, node.address));
  if (matches.length === 1) {
    const item = asRecord(matches[0])!;
    return { presence: "present", item, externalId: def.idOf(item), requestIds };
  }
  if (matches.length > 1) {
    return { presence: "unknown", requestIds, matches: matches.length, error: `${matches.length} objects carry this node's Zenith tags; refusing to pick one.` };
  }
  if (listed.truncated) {
    return { presence: "unknown", requestIds, error: `Not found in the first ${MAX_LIST_PAGES} pages of the compartment listing; absence cannot be concluded.` };
  }
  return { presence: "missing", requestIds };
}

/* ------------------------------- observations ------------------------------ */

export function observationOf(
  ctx: OciContext,
  node: ResourceNode,
  source: string,
  located: Located,
  attributes: Record<string, ObservedValue> = {},
  native?: Record<string, unknown>
): Observation {
  const at = ctx.now().toISOString();
  const base: Observation = {
    address: node.address,
    presence: located.presence,
    attributes: located.presence === "present" ? attributes : {},
    observedAt: at,
    source,
    simulated: false,
  };
  if (located.externalId) base.externalId = located.externalId;
  if (located.error) base.error = located.error;
  if (native && located.presence === "present") base.native = boundNative({ ...native, tags: platformTags(located.item), requestIds: located.requestIds.slice(0, 6) });
  return base;
}

/** An Observation for a node Zenith must not (or cannot) read yet. */
export function unreadableObservation(ctx: OciContext, node: ResourceNode, source: string, reason: string, presence: Presence = "unknown"): Observation {
  return { address: node.address, presence, attributes: {}, observedAt: ctx.now().toISOString(), source, simulated: false, error: reason };
}

export function runtimeOf(ctx: OciContext, node: ResourceNode, source: string, health: HealthState, counts: Record<string, number>, signals: string[]): RuntimeState {
  return { address: node.address, health, counts, signals: signals.slice(0, 20), observedAt: ctx.now().toISOString(), source, simulated: false };
}

/* --------------------------------- verification ---------------------------- */

const isScalar = (v: unknown): v is string | number | boolean => ["string", "number", "boolean"].includes(typeof v);
export const sameValue = (a: unknown, b: unknown): boolean => (isScalar(a) && isScalar(b) ? String(a) === String(b) : canonical(a) === canonical(b));

export interface VerifyArgs {
  node: ResourceNode;
  observation: Observation;
  expected: Record<string, unknown>;
  runtime?: RuntimeState;
  /** extra driver-specific checks */
  extra?: VerificationCheck[];
  now: Date;
}

/**
 * exists → configuration matches expected attributes → serving. A missing
 * object fails; an unreadable one is `unknown`, never `passed`.
 */
export function verifyWith(a: VerifyArgs): VerificationResult {
  const checks: VerificationCheck[] = [];
  const obs = a.observation;
  const exists: VerificationCheck = {
    id: "exists",
    description: `${a.node.address} exists in OCI`,
    passed: obs.presence === "present" ? true : obs.presence === "missing" ? false : "unknown",
    ...(obs.presence === "present" ? {} : { detail: obs.presence === "missing" ? "OCI reports no such object." : `presence is ${obs.presence}${obs.error ? `: ${obs.error.slice(0, 160)}` : ""}` }),
  };
  checks.push(exists);

  if (obs.presence === "present") {
    for (const attribute of Object.keys(a.expected).sort()) {
      const want = a.expected[attribute];
      if (want === undefined) continue;
      const seen = obs.attributes[attribute];
      if (!seen || seen.state !== "known") {
        checks.push({ id: `config:${attribute}`, description: `${attribute} matches the desired value`, passed: "unknown", detail: "not observed" });
        continue;
      }
      const ok = sameValue(want, seen.value);
      checks.push({
        id: `config:${attribute}`,
        description: `${attribute} matches the desired value`,
        passed: ok,
        ...(ok ? {} : { detail: `desired ${shortValue(want)}, observed ${shortValue(seen.value)}` }),
      });
    }
    if (a.runtime) {
      checks.push({
        id: "serving",
        description: `${a.node.address} is healthy / serving`,
        passed: a.runtime.health === "healthy" ? true : a.runtime.health === "unknown" ? "unknown" : false,
        ...(a.runtime.health === "healthy" ? {} : { detail: `health ${a.runtime.health}${a.runtime.signals.length ? ` (${a.runtime.signals.slice(0, 4).join(", ")})` : ""}` }),
      });
    }
    checks.push(...(a.extra ?? []));
  }

  const status = checks.some((c) => c.passed === false) ? "failed" : checks.some((c) => c.passed === "unknown") ? "unknown" : "passed";
  return { address: a.node.address, status, checks, checkedAt: a.now.toISOString(), simulated: false };
}

function shortValue(v: unknown): string {
  const s = isScalar(v) ? String(v) : canonical(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/* --------------------------------- discovery ------------------------------- */

export interface DiscoverDef extends Omit<LocateDef, "get" | "validId"> {
  kind: PortableKind;
  nativeType: string;
  nameOf(item: Record<string, unknown>): string;
  attributes(item: Record<string, unknown>): Record<string, string | number | boolean>;
}

/** Candidates only; `zenithTagged` is a hint, never adoption. */
export async function discoverWith(ctx: OciContext, def: DiscoverDef): Promise<DiscoveredResource[]> {
  const req = def.list(ctx.session.compartmentOcid, ctx.session);
  const listed = await listAll(ctx, { service: req.service ?? def.service, region: ctx.region, method: "GET", path: req.path, query: req.query }, def.items);
  if (!listed.ok) return [];
  const out: DiscoveredResource[] = [];
  for (const raw of listed.items) {
    const item = asRecord(raw);
    if (!item || isGone(item)) continue;
    const id = def.idOf(item);
    if (!id) continue;
    const tags = tagsOf(item);
    out.push({
      provider: "oci",
      kind: def.kind,
      nativeType: def.nativeType,
      externalId: id,
      name: def.nameOf(item).slice(0, 200),
      region: ctx.region,
      zenithTagged: tags[TAG_MANAGED] === "true" && typeof tags[TAG_ENV] === "string",
      attributes: def.attributes(item),
    });
  }
  return out.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

/** Collection bodies: a bare array (Core, Load Balancer, Identity) or `{ items: [...] }`. */
export const arrayOrItems = (body: unknown): unknown[] => (Array.isArray(body) ? body : asArray(asRecord(body)?.items));
