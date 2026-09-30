/**
 * The Azure driver kit: one factory that turns a small declarative definition
 * into a full `ResourceDriver<AzureSession>` (observe, runtime, verify,
 * discover, expectedAttributes, operations), so the ~20 Azure drivers differ
 * only in what is genuinely Azure-specific: the tofu they compile, the ARM
 * type/api-version they read, and how properties map to portable attributes.
 *
 * Finding the object (DRIVER-CONVENTIONS): by `externalId` when known, else by
 * the Zenith tags `zenith:environment` + `zenith:resource` via the ARM
 * subscription-level tag filter — never by name alone. Non-taggable children
 * (subnets, NSG rules, record sets…) supply their own `locate` that finds the
 * taggable PARENT by tags and then reads the child by its prefix-free scoped
 * name (see `naming.scopedName`).
 *
 * Honesty rules enforced here, once, for every driver:
 *   - an attribute is `known` only if `read()` returned it; everything else is
 *     `unknown` with a reason; a missing/inaccessible/unknown object yields
 *     unknown attributes, never guesses;
 *   - presence: present / missing (HTTP 404 or no tagged match) / inaccessible
 *     (401/403) / unknown (throttling, 5xx, network, ambiguity, abort);
 *   - `native` is bounded to 4 KiB and redacted by key name and value shape;
 *   - all calls are read-only GETs/LISTs; evidence is `contract` until a live
 *     acceptance run says otherwise.
 *
 * Reads never include secret values: ARM redacts them itself for the types we
 * read, and `redactDeep` removes anything secret-shaped that still appears.
 */
import type { AzureSession } from "@/lib/credentials/types";
import type {
  CompileContext,
  DiscoveredResource,
  DriverContext,
  EvidenceLevel,
  NativeOperation,
  ResourceDriver,
  TofuFragment,
  VerificationCheck,
  VerificationResult,
} from "@/lib/drivers/types";
import type { HealthState, Observation, ObservedValue, PortableKind, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { armClient, ArmError, inSubscription, parseArmId, RESOURCES_API, safeText, sameArmType, armTypeOf, type ArmClient, type ArmResource, type Json } from "@/lib/providers/azure/arm";

export type AzureCtx = DriverContext<AzureSession>;

/* ----------------------------- unknown sentinel ----------------------------- */

/** Returned from `read()` for an attribute that could not be read, with the reason. */
export interface UnknownRead {
  readonly __unknown: true;
  readonly reason: "not_supported" | "not_inspected" | "access_denied" | "error" | "not_applicable";
  readonly detail?: string;
}
export const unknownRead = (reason: UnknownRead["reason"], detail?: string): UnknownRead => ({ __unknown: true, reason, detail });
const isUnknownRead = (v: unknown): v is UnknownRead => typeof v === "object" && v !== null && (v as UnknownRead).__unknown === true;

/* -------------------------------- location ---------------------------------- */

export interface ArmType {
  /** e.g. `Microsoft.Network/virtualNetworks` */
  type: string;
  apiVersion: string;
}

export type Located =
  | { state: "found"; resource: ArmResource }
  | { state: "missing" }
  | { state: "inaccessible"; detail: string }
  | { state: "unknown"; detail: string };

/** Translate a failed ARM call into a non-found `Located`. `not_found` only when the caller asked for one specific id. */
export function locatedFromError(e: unknown, notFoundIsMissing: boolean): Located {
  if (e instanceof ArmError) {
    if (e.kind === "not_found" && notFoundIsMissing) return { state: "missing" };
    if (e.kind === "forbidden") return { state: "inaccessible", detail: e.message };
    return { state: "unknown", detail: e.message };
  }
  return { state: "unknown", detail: e instanceof Error ? safeText(e.message) : "unexpected error" };
}

const odataString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function expectedEnvironment(ctx: AzureCtx): string {
  return ctx.tags["zenith:environment"] ?? ctx.environmentId;
}

/** Is `id` an ARM id of `t` in the session's subscription? */
function ownsId(ctx: AzureCtx, id: string, t: ArmType): boolean {
  const ty = armTypeOf(id);
  return Boolean(ty && sameArmType(ty, t.type) && inSubscription(id, ctx.session.subscriptionId));
}

/** GET a resource by id, mapping failures to `Located`. */
export async function getById(arm: ArmClient, id: string, apiVersion: string, query?: Record<string, string>): Promise<Located> {
  try {
    const r = await arm.get<ArmResource>(id, { apiVersion, query });
    // a 200 that is not a resource (no id) is a malformed answer, not an object to read attributes from
    if (typeof r.body?.id !== "string") return { state: "unknown", detail: "the response was not a resource (no id)" };
    return { state: "found", resource: r.body };
  } catch (e) {
    return locatedFromError(e, true);
  }
}

/** Tag-filtered search: every resource of `type` carrying the Zenith tags of the node at `address` in this environment. */
export async function findTagged(ctx: AzureCtx, address: string, arm: ArmClient, type: string): Promise<{ matches: ArmResource[] } | Located> {
  const filter = `tagName eq ${odataString("zenith:resource")} and tagValue eq ${odataString(address)}`;
  try {
    const { items } = await arm.list<ArmResource>(`/subscriptions/${ctx.session.subscriptionId}/resources`, { apiVersion: RESOURCES_API, query: { $filter: filter } }, 5);
    const env = expectedEnvironment(ctx);
    const matches = items.filter(
      (i) => typeof i.id === "string" && typeof i.type === "string" && sameArmType(i.type, type) && i.tags?.["zenith:resource"] === address && (i.tags?.["zenith:environment"] ?? env) === env
    );
    return { matches };
  } catch (e) {
    return locatedFromError(e, false);
  }
}

/** Default `locate`: explicit id, else tag search, then a full GET for properties. */
export async function locateByTags(ctx: AzureCtx, node: ResourceNode, t: ArmType, externalId?: string): Promise<Located> {
  const arm = armClient(ctx.session, ctx.signal);
  if (externalId) {
    if (!ownsId(ctx, externalId, t)) return { state: "unknown", detail: `externalId is not a ${t.type} in this subscription` };
    return getById(arm, externalId, t.apiVersion);
  }
  const found = await findTagged(ctx, node.address, arm, t.type);
  if (!("matches" in found)) return found;
  if (found.matches.length === 0) return { state: "missing" };
  if (found.matches.length > 1) return { state: "unknown", detail: `ambiguous: ${found.matches.length} ${t.type} resources carry this node's tags` };
  return getById(arm, found.matches[0].id, t.apiVersion);
}

/* --------------------------- bounded, redacted native ----------------------- */

const SECRET_KEY = /(secret|passw(or)?d|token|api[_-]?key|access[_-]?key|primary[_-]?key|secondary[_-]?key|connection[_-]?string|credential|sas|signature|shared[_-]?key|certificate[_-]?password|^value$)/i;
const SECRET_VALUE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|(?:AccountKey|SharedAccessKey|Password)=[^;\s]+|[?&]sig=[^&\s]+/g;

export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]").slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redactDeep(v, depth + 1);
    return out;
  }
  return value;
}

/** ≤ 4 KiB of redacted JSON; whole keys are dropped (largest first) until it fits. */
export function boundNative(native: Record<string, unknown> | undefined, maxBytes = 4096): Record<string, unknown> | undefined {
  if (!native) return undefined;
  const red = redactDeep(native) as Record<string, unknown>;
  let keys = Object.keys(red);
  while (keys.length > 0 && Buffer.byteLength(JSON.stringify(red)) > maxBytes) {
    const biggest = keys.reduce((a, b) => (JSON.stringify(red[a]).length >= JSON.stringify(red[b]).length ? a : b));
    delete red[biggest];
    keys = keys.filter((k) => k !== biggest);
  }
  return red;
}

/* -------------------------------- comparison -------------------------------- */

const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return typeof v === "string" ? JSON.stringify(v.toLowerCase()) : JSON.stringify(v) ?? "null";
};
export const sameValue = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

/* --------------------------------- runtime ---------------------------------- */

export interface RuntimeRead {
  health: HealthState;
  counts: Record<string, number>;
  signals: string[];
}

/* --------------------------------- driver ----------------------------------- */

export interface AzureDriverDef {
  /** `azure.<suffix>@1` */
  id: string;
  kind: PortableKind;
  nativeType: string;
  /** primary ARM type, for the default locate and for discovery */
  arm?: ArmType;
  locate?: (ctx: AzureCtx, node: ResourceNode, externalId?: string) => Promise<Located>;
  compile: (node: ResourceNode, ctx: CompileContext) => TofuFragment;
  /** desired → comparable values, exactly the keys `read` produces */
  expected: (node: ResourceNode) => Record<string, unknown>;
  /** ARM properties → portable attribute values (same names and units as `expected`) */
  read: (res: ArmResource, node: ResourceNode) => Record<string, unknown | UnknownRead>;
  native?: (res: ArmResource) => Record<string, unknown>;
  /** only for resources that run something; reads counts and health */
  runtime?: (ctx: AzureCtx, node: ResourceNode, res: ArmResource, arm: ArmClient) => Promise<RuntimeRead>;
  /** extra verify checks beyond exists / provisioned / config */
  checks?: (ctx: AzureCtx, node: ResourceNode, res: ArmResource, arm: ArmClient) => Promise<VerificationCheck[]> | VerificationCheck[];
  /** the kind is a serving workload: verify also requires runtime health */
  serving?: boolean;
  operations?: Record<string, NativeOperation<AzureSession>>;
  /** evidence overrides; default is `contract` for everything the driver has */
  evidence?: Record<string, EvidenceLevel>;
  /** attributes of a discovered candidate, from the generic list item */
  discoverAttributes?: (item: ArmResource) => Record<string, string | number | boolean>;
}

function unknownAttributes(keys: string[], reason: Extract<ObservedValue, { state: "unknown" }>["reason"], detail?: string): Record<string, ObservedValue> {
  return Object.fromEntries(keys.map((k) => [k, { state: "unknown", reason, ...(detail ? { detail } : {}) } as ObservedValue]));
}

export function defineAzureDriver(def: AzureDriverDef): ResourceDriver<AzureSession> {
  const locate = def.locate ?? (def.arm ? (ctx: AzureCtx, node: ResourceNode, externalId?: string) => locateByTags(ctx, node, def.arm!, externalId) : undefined);
  const operations = def.operations ? Object.keys(def.operations).sort() : [];
  const evidence: Record<string, EvidenceLevel> = { compile: "contract", observe: "contract", verify: "contract" };
  if (def.runtime) evidence.runtime = "contract";
  if (def.arm) evidence.discover = "contract";
  for (const op of operations) evidence[op] = "contract";
  Object.assign(evidence, def.evidence ?? {});

  const driver: ResourceDriver<AzureSession> = {
    id: def.id,
    provider: "azure",
    kind: def.kind,
    nativeType: def.nativeType,
    capabilities: { compile: true, observe: Boolean(locate), runtime: Boolean(def.runtime), verify: Boolean(locate), discover: Boolean(def.arm), operations, evidence },
    compile: def.compile,
    expectedAttributes: def.expected,
  };
  if (def.operations) driver.operations = def.operations;

  if (locate) {
    driver.observe = async (ctx, node, externalId) => {
      const observedAt = ctx.now().toISOString();
      const keys = Object.keys(def.expected(node));
      const base = { address: node.address, observedAt, source: def.id, simulated: false };
      const located = await locate(ctx, node, externalId);
      switch (located.state) {
        case "missing":
          return { ...base, presence: "missing", attributes: unknownAttributes(keys, "not_applicable", "the object does not exist") };
        case "inaccessible":
          return { ...base, presence: "inaccessible", attributes: unknownAttributes(keys, "access_denied"), error: located.detail };
        case "unknown":
          return { ...base, presence: "unknown", attributes: unknownAttributes(keys, "error", located.detail), error: located.detail };
        case "found": {
          let read: Record<string, unknown | UnknownRead>;
          try {
            read = def.read(located.resource, node);
          } catch (e) {
            const detail = e instanceof Error ? safeText(e.message) : "could not interpret the response";
            return { ...base, externalId: located.resource.id, presence: "present", attributes: unknownAttributes(keys, "error", detail), error: detail };
          }
          const attributes: Record<string, ObservedValue> = {};
          for (const k of keys) {
            const v = read[k];
            if (v === undefined) attributes[k] = { state: "unknown", reason: "not_inspected" };
            else if (isUnknownRead(v)) attributes[k] = { state: "unknown", reason: v.reason, ...(v.detail ? { detail: v.detail } : {}) };
            else attributes[k] = { state: "known", value: v, observedAt };
          }
          const native = boundNative({ location: located.resource.location, sku: located.resource.sku, tags: located.resource.tags, ...(def.native ? def.native(located.resource) : {}) });
          return { ...base, externalId: located.resource.id, presence: "present", attributes, ...(native ? { native } : {}) } satisfies Observation;
        }
      }
    };
  }

  if (def.runtime && locate) {
    driver.runtime = async (ctx, node, externalId): Promise<RuntimeState> => {
      const observedAt = ctx.now().toISOString();
      const base = { address: node.address, observedAt, source: def.id, simulated: false };
      const located = await locate(ctx, node, externalId);
      if (located.state !== "found") {
        const signal = located.state === "missing" ? "not_found" : located.state === "inaccessible" ? "access_denied" : "read_failed";
        return { ...base, health: "unknown", counts: {}, signals: [signal] };
      }
      try {
        const r = await def.runtime!(ctx, node, located.resource, armClient(ctx.session, ctx.signal));
        return { ...base, health: r.health, counts: r.counts, signals: r.signals };
      } catch (e) {
        const kind = e instanceof ArmError ? e.kind : "error";
        return { ...base, health: "unknown", counts: {}, signals: [kind === "forbidden" ? "access_denied" : kind === "throttled" ? "throttled" : "read_failed"] };
      }
    };
  }

  if (locate) {
    driver.verify = async (ctx, node, observation, runtime): Promise<VerificationResult> => {
      const checks: VerificationCheck[] = [];
      const present = observation.presence === "present";
      checks.push({
        id: "exists",
        description: `${def.nativeType} exists`,
        passed: present ? true : observation.presence === "missing" ? false : "unknown",
        ...(present ? {} : { detail: observation.error ?? observation.presence }),
      });
      if (present) {
        const expected = def.expected(node);
        const mismatches: string[] = [];
        let compared = 0;
        for (const [k, want] of Object.entries(expected)) {
          const got = observation.attributes[k];
          if (!got || got.state !== "known") continue;
          compared++;
          if (!sameValue(got.value, want)) mismatches.push(k);
        }
        checks.push({
          id: "configuration",
          description: "observed configuration matches the desired spec",
          passed: compared === 0 ? "unknown" : mismatches.length === 0,
          detail: compared === 0 ? "no attribute could be compared" : mismatches.length ? `differs: ${mismatches.join(", ")}` : `${compared} attribute${compared === 1 ? "" : "s"} compared`,
        });
        if (def.checks || def.serving) {
          const located = await locate(ctx, node, observation.externalId);
          if (located.state === "found") {
            const state = (located.resource.properties as Json | undefined)?.provisioningState;
            if (typeof state === "string") {
              checks.push({ id: "provisioned", description: "provisioning completed", passed: state === "Succeeded" || state === "Provisioned" || state === "Ready", detail: `provisioningState=${safeText(state, 40)}` });
            }
            if (def.checks) {
              try {
                checks.push(...(await def.checks(ctx, node, located.resource, armClient(ctx.session, ctx.signal))));
              } catch (e) {
                checks.push({ id: "extra_checks", description: "additional checks", passed: "unknown", detail: e instanceof Error ? safeText(e.message) : "failed" });
              }
            }
          } else {
            checks.push({ id: "provisioned", description: "provisioning completed", passed: "unknown", detail: located.state });
          }
        }
        if (def.serving) {
          checks.push({
            id: "serving",
            description: "the workload is running and healthy",
            passed: !runtime || runtime.health === "unknown" ? "unknown" : runtime.health === "healthy",
            detail: runtime ? `health=${runtime.health}${runtime.signals.length ? ` signals=${runtime.signals.join(",")}` : ""}` : "runtime was not read",
          });
        }
      }
      const status: VerificationResult["status"] = checks.some((c) => c.passed === false) ? "failed" : checks.some((c) => c.passed === "unknown") ? "unknown" : "passed";
      return { address: node.address, status, checks, checkedAt: ctx.now().toISOString(), simulated: false };
    };
  }

  if (def.arm) {
    const t = def.arm;
    driver.discover = async (ctx): Promise<DiscoveredResource[]> => {
      const arm = armClient(ctx.session, ctx.signal);
      const { items } = await arm.list<ArmResource>(`/subscriptions/${ctx.session.subscriptionId}/resources`, {
        apiVersion: RESOURCES_API,
        query: { $filter: `resourceType eq ${odataString(t.type)}` },
      }, 5);
      const env = expectedEnvironment(ctx);
      const out: DiscoveredResource[] = [];
      for (const item of items.slice(0, 500)) {
        if (typeof item.id !== "string" || typeof item.name !== "string" || !sameArmType(item.type ?? "", t.type)) continue;
        if (!inSubscription(item.id, ctx.session.subscriptionId)) continue;
        const parsed = parseArmId(item.id);
        out.push({
          provider: "azure",
          kind: def.kind,
          nativeType: def.nativeType,
          externalId: item.id,
          name: item.name,
          region: item.location ?? ctx.region,
          zenithTagged: item.tags?.["zenith:managed"] === "true" && item.tags?.["zenith:environment"] === env,
          attributes: { ...(parsed?.resourceGroup ? { resourceGroup: parsed.resourceGroup } : {}), ...(def.discoverAttributes ? def.discoverAttributes(item) : {}) },
        });
      }
      return out.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
    };
  }

  return driver;
}

/* ------------------------------- read helpers -------------------------------- */

/** `res.properties` as a record (never undefined). */
export const props = (res: ArmResource): Json => (res.properties ?? {}) as Json;

export function pick<T = unknown>(obj: unknown, ...path: string[]): T | undefined {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur as T | undefined;
}
