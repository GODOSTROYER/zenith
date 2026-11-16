/**
 * Read-side driver engine: `observe`, `runtime`, `verify`, `discover` from a
 * small declarative `ReadSpec`, so every GCP driver reports absent / missing /
 * inaccessible / unknown the same way (DRIVER-CONVENTIONS "Observe / runtime /
 * verify / discover").
 *
 * Rules enforced here for all drivers:
 *   - read-only: only GET (and list) calls; never a write, never a secret read;
 *   - an object is found by `externalId` when one is given (validated: it must
 *     resolve to a URL inside the session's project), else by the Zenith
 *     labels `zenith_environment` + `zenith_resource`, never by name alone;
 *     zero matches → `missing`, several → `unknown` (ambiguity is reported,
 *     not guessed);
 *   - only attributes the driver's `extract` actually produced are `known`;
 *     everything else is `unknown` with a reason;
 *   - `native` is a bounded (≤ 4 KiB), driver-chosen bag: drivers never put
 *     environment values, payloads or tokens in it;
 *   - `missing` = the API said 404 (or the tag search found nothing);
 *     `inaccessible` = 401/403; `unknown` = throttling, 5xx, network, bad data.
 */
import type {
  DiscoveredResource,
  DriverContext,
  ResourceDriver,
  VerificationCheck,
  VerificationResult,
} from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { HealthState, ObservedValue, Observation, PortableKind, Presence, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { sortKeysDeep } from "@/lib/tofu/stable";
import { labelsMatch, nodeLabels, zenithTagged } from "./naming";
import { gcpGet, gcpList, type Outcome } from "./rest";

type Ctx = DriverContext<GcpSession>;

export interface Extracted {
  externalId: string;
  /** portable attribute name → value, in the same units `expectedAttributes` uses */
  attributes: Record<string, unknown>;
  native?: Record<string, unknown>;
  /** display name for discovery; defaults to the last path segment of externalId */
  name?: string;
}

export interface RuntimeParts {
  health: HealthState;
  counts?: Record<string, number>;
  signals?: string[];
}

export interface ListSpec {
  url(ctx: Ctx): string;
  itemsKey: string;
  pageTokenParam?: string;
  /** labels (or description-parsed tags) of a list item */
  labelsOf(item: Record<string, unknown>): Record<string, unknown> | undefined;
}

export interface ReadSpec {
  driverId: string;
  nativeType: string;
  kind: PortableKind;
  /** every attribute name `observe` can report */
  attributes: readonly string[];
  /** the GET URL for an externalId, validated against the session project; or why it is invalid */
  resolve(ctx: Ctx, externalId: string): { url: string; externalId: string } | { error: string };
  list?: ListSpec;
  extract(obj: Record<string, unknown>, ctx: Ctx, node: ResourceNode): Extracted;
  runtime?(obj: Record<string, unknown>, node: ResourceNode, ctx: Ctx): RuntimeParts;
  /** checks beyond existence / configuration / serving, from what was observed */
  checks?(node: ResourceNode, observation: Observation, runtime?: RuntimeState): VerificationCheck[];
}

export const NATIVE_MAX_BYTES = 4096;

/** Keep the native bag within 4 KiB by dropping the largest members first. */
export function boundedNative(native: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!native) return undefined;
  let bag: Record<string, unknown> = { ...native };
  const size = (o: unknown) => Buffer.byteLength(JSON.stringify(o));
  while (size(bag) > NATIVE_MAX_BYTES && Object.keys(bag).length > 0) {
    const biggest = Object.entries(bag).sort((a, b) => size(b[1]) - size(a[1]))[0][0];
    delete bag[biggest];
    bag = { ...bag, truncated: true };
    if (size(bag) <= NATIVE_MAX_BYTES) break;
  }
  return bag;
}

export type Fetched =
  | { kind: "found"; obj: Record<string, unknown>; externalId?: string; requestId?: string }
  | { kind: "none"; outcome: Exclude<Outcome, "ok">; detail?: string }
  | { kind: "invalid"; error: string };

export async function fetchObject(spec: ReadSpec, ctx: Ctx, node: ResourceNode, externalId?: string): Promise<Fetched> {
  if (externalId) {
    const r = spec.resolve(ctx, externalId);
    if ("error" in r) return { kind: "invalid", error: r.error };
    const res = await gcpGet(ctx, r.url);
    if (res.outcome === "ok") return { kind: "found", obj: res.json, externalId: r.externalId, requestId: res.requestId };
    return { kind: "none", outcome: res.outcome, detail: res.detail };
  }
  if (!spec.list) return { kind: "invalid", error: `No externalId is recorded for ${node.address} and ${spec.nativeType} cannot be found by label.` };
  const expected = nodeLabels(ctx.tags, node);
  if (expected.zenith_environment === undefined) return { kind: "invalid", error: "The driver context carries no zenith:environment tag, so the object cannot be found by label." };
  const list = await gcpList(ctx, spec.list.url(ctx), spec.list.itemsKey, { pageTokenParam: spec.list.pageTokenParam });
  if (list.outcome !== "ok") return { kind: "none", outcome: list.outcome, detail: list.detail };
  const matches = list.items.filter((it) => labelsMatch(spec.list!.labelsOf(it), expected));
  if (matches.length === 0) {
    if (list.truncated) return { kind: "invalid", error: "Label search hit the page bound before finding the object; record an externalId." };
    return { kind: "none", outcome: "missing", detail: "no object carries this environment's Zenith labels" };
  }
  if (matches.length > 1) return { kind: "invalid", error: `${matches.length} objects carry the same Zenith labels; refusing to guess which one is ${node.address}.` };
  return { kind: "found", obj: matches[0], requestId: list.requestId };
}

const presenceOf = (o: Exclude<Outcome, "ok">): Presence => (o === "missing" ? "missing" : o === "inaccessible" ? "inaccessible" : "unknown");

function unknownFill(spec: ReadSpec, reason: Extract<ObservedValue, { state: "unknown" }>["reason"], detail?: string): Record<string, ObservedValue> {
  const out: Record<string, ObservedValue> = {};
  for (const a of spec.attributes) out[a] = { state: "unknown", reason, ...(detail ? { detail } : {}) };
  return out;
}

function equalValues(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

export interface Readers {
  observe: NonNullable<ResourceDriver<GcpSession>["observe"]>;
  runtime: NonNullable<ResourceDriver<GcpSession>["runtime"]>;
  verify: NonNullable<ResourceDriver<GcpSession>["verify"]>;
  discover?: NonNullable<ResourceDriver<GcpSession>["discover"]>;
}

export function makeReaders(spec: ReadSpec, expectedAttributes: (node: ResourceNode) => Record<string, unknown>, opts: { serving?: boolean } = {}): Readers {
  const observe: Readers["observe"] = async (ctx, node, externalId) => {
    const at = ctx.now().toISOString();
    const base = { address: node.address, observedAt: at, source: spec.driverId, simulated: false as const };
    const f = await fetchObject(spec, ctx, node, externalId);
    if (f.kind === "invalid") return { ...base, presence: "unknown", attributes: unknownFill(spec, "error", f.error), error: f.error };
    if (f.kind === "none") {
      const reason = f.outcome === "inaccessible" ? "access_denied" : f.outcome === "missing" ? "not_applicable" : "error";
      return {
        ...base,
        presence: presenceOf(f.outcome),
        attributes: unknownFill(spec, reason, f.detail),
        ...(f.outcome === "missing" ? {} : { error: f.detail ?? f.outcome }),
        ...(externalId ? { externalId } : {}),
      };
    }
    let ex: Extracted;
    try {
      ex = spec.extract(f.obj, ctx, node);
    } catch (e) {
      const msg = `Could not interpret the ${spec.nativeType} response: ${e instanceof Error ? e.message : "unexpected shape"}`;
      return { ...base, presence: "unknown", attributes: unknownFill(spec, "error", msg), error: msg };
    }
    const attributes: Record<string, ObservedValue> = {};
    for (const a of spec.attributes) {
      const v = ex.attributes[a];
      attributes[a] = v === undefined ? { state: "unknown", reason: "not_inspected" } : { state: "known", value: v, observedAt: at };
    }
    const native = boundedNative(ex.native);
    return { ...base, externalId: ex.externalId, presence: "present", attributes, ...(native ? { native } : {}) };
  };

  const runtime: Readers["runtime"] = async (ctx, node, externalId) => {
    const at = ctx.now().toISOString();
    const base = { address: node.address, observedAt: at, source: spec.driverId, simulated: false as const };
    if (!spec.runtime) return { ...base, health: "unknown", counts: {}, signals: ["runtime_not_supported"] };
    const f = await fetchObject(spec, ctx, node, externalId);
    if (f.kind === "invalid") return { ...base, health: "unknown", counts: {}, signals: ["unresolvable"] };
    if (f.kind === "none") {
      const signal = f.outcome === "missing" ? "not_found" : f.outcome === "inaccessible" ? "access_denied" : f.outcome === "throttled" ? "throttled" : "read_error";
      return { ...base, health: f.outcome === "missing" ? "unhealthy" : "unknown", counts: {}, signals: [signal] };
    }
    const r = spec.runtime(f.obj, node, ctx);
    return { ...base, health: r.health, counts: r.counts ?? {}, signals: r.signals ?? [] };
  };

  const verify: Readers["verify"] = async (ctx, node, observation, rt) => {
    const checks: VerificationCheck[] = [];
    checks.push({
      id: "exists",
      description: `${spec.nativeType} exists`,
      passed: observation.presence === "present" ? true : observation.presence === "missing" ? false : "unknown",
      ...(observation.presence === "present" ? {} : { detail: observation.error ?? `presence is ${observation.presence}` }),
    });
    for (const [attr, want] of Object.entries(expectedAttributes(node)).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const got = observation.attributes[attr];
      if (!got || got.state === "unknown") {
        checks.push({ id: `attr:${attr}`, description: `${attr} matches the desired value`, passed: "unknown", detail: got?.state === "unknown" ? `not read (${got.reason})` : "not read" });
      } else {
        const ok = equalValues(got.value, want);
        checks.push({ id: `attr:${attr}`, description: `${attr} matches the desired value`, passed: ok, ...(ok ? {} : { detail: `desired ${JSON.stringify(want)}, observed ${JSON.stringify(got.value)}` }) });
      }
    }
    if (opts.serving) {
      checks.push({
        id: "serving",
        description: "resource is healthy and serving",
        passed: !rt ? "unknown" : rt.health === "healthy" ? true : rt.health === "unknown" ? "unknown" : false,
        ...(rt && rt.health !== "healthy" ? { detail: `health ${rt.health}${rt.signals.length ? ` (${rt.signals.join(", ")})` : ""}` } : {}),
      });
    }
    if (spec.checks) checks.push(...spec.checks(node, observation, rt));
    const status: VerificationResult["status"] = checks.some((c) => c.passed === false) ? "failed" : checks.some((c) => c.passed === "unknown") ? "unknown" : "passed";
    return { address: node.address, status, checks, checkedAt: ctx.now().toISOString(), simulated: false };
  };

  let discover: Readers["discover"];
  const listSpec = spec.list;
  if (listSpec) {
    discover = async (ctx) => {
      const list = await gcpList(ctx, listSpec.url(ctx), listSpec.itemsKey, { pageTokenParam: listSpec.pageTokenParam });
      if (list.outcome !== "ok") return [];
      const out: DiscoveredResource[] = [];
      for (const item of list.items.slice(0, 200)) {
        let ex: Extracted;
        try {
          ex = spec.extract(item, ctx, { address: "", kind: spec.kind, provider: "gcp", region: ctx.region, nativeType: spec.nativeType, ownership: "managed", spec: {}, origin: [], dependsOn: [], specDigest: "", labels: {} });
        } catch {
          continue;
        }
        const attributes: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(ex.attributes)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") attributes[k] = v;
        out.push({
          provider: "gcp",
          kind: spec.kind,
          nativeType: spec.nativeType,
          externalId: ex.externalId,
          name: ex.name ?? ex.externalId.split("/").pop() ?? ex.externalId,
          region: ctx.region,
          zenithTagged: zenithTagged(listSpec.labelsOf(item)),
          attributes,
        });
      }
      return out;
    };
  }

  return { observe, runtime, verify, ...(discover ? { discover } : {}) };
}

/* ------------------------- small extraction helpers ------------------------ */

export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
export const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
export const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const tail = (s: string | undefined): string | undefined => (s ? s.split("/").pop() : undefined);

/** Strip a compute self-link to `projects/<p>/…`. */
export function computePath(externalId: string): string {
  const m = /^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/v1\/(projects\/.+)$/.exec(externalId);
  return m ? m[1] : externalId.replace(/^\/+/, "");
}
