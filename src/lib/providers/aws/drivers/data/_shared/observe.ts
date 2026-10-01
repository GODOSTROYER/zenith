/**
 * Helpers for building honest `Observation`s and `RuntimeState`s.
 *
 * Rules these helpers make easy to follow (DRIVER-CONVENTIONS, spec §8, §42):
 *   - only attributes actually read are `known`; every other expected attribute
 *     is `unknown` with a reason — a failed read never becomes "matches";
 *   - `presence` is `missing` / `inaccessible` only when the API said so;
 *   - `native` is a bounded (≤ 4 KiB), scrubbed bag: secret-looking keys are
 *     redacted, long strings and arrays are cut, and the keys named in
 *     `priority` (provider identifiers, `tags`) are the last to be dropped;
 *   - `externalId` is always the provider identifier when the object was found,
 *     and `native.tags` carries the provider tags so drift can see
 *     `zenith:managed` / `zenith:environment` on objects Zenith did not create.
 */
import type { AwsSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { HealthState, Observation, ObservedValue, Presence, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { presenceOfFailure, scrubErrorText, unknownReasonOf, type AwsFailure } from "./errors";

export type AwsDriverContext = DriverContext<AwsSession>;

export const MAX_NATIVE_BYTES = 4096;

export const nowIso = (ctx: { now(): Date }): string => ctx.now().toISOString();

export function knownValue<T>(ctx: { now(): Date }, value: T): ObservedValue<T> {
  return { state: "known", value, observedAt: nowIso(ctx) };
}

export function unknownValue(reason: Extract<ObservedValue, { state: "unknown" }>["reason"], detail?: string): ObservedValue {
  return detail === undefined ? { state: "unknown", reason } : { state: "unknown", reason, detail: scrubErrorText(detail, 200) };
}

/**
 * One `ObservedValue` per name in `names`: `known` when `values` has an own
 * property of that name (even with value `null` — "read, and absent"), else
 * `unknown` / `not_inspected`. Names not in `names` are dropped: `observe` must
 * report exactly what `expectedAttributes` names.
 */
export function attributesOf(ctx: { now(): Date }, names: readonly string[], values: Record<string, unknown>): Record<string, ObservedValue> {
  const out: Record<string, ObservedValue> = {};
  for (const name of names) {
    out[name] = Object.prototype.hasOwnProperty.call(values, name) && values[name] !== undefined ? knownValue(ctx, values[name]) : unknownValue("not_inspected");
  }
  return out;
}

export function unknownAttributes(names: readonly string[], reason: Extract<ObservedValue, { state: "unknown" }>["reason"], detail?: string): Record<string, ObservedValue> {
  return Object.fromEntries(names.map((n) => [n, unknownValue(reason, detail)]));
}

/** An Observation for a read that failed outright: presence from the error class, every attribute unknown. */
export function failedObservation(ctx: AwsDriverContext, node: ResourceNode, source: string, names: readonly string[], failure: AwsFailure, externalId?: string): Observation {
  const presence: Presence = presenceOfFailure(failure);
  return {
    address: node.address,
    ...(externalId !== undefined ? { externalId } : {}),
    presence,
    attributes: unknownAttributes(names, presence === "missing" ? "not_applicable" : unknownReasonOf(failure), failure.summary),
    observedAt: nowIso(ctx),
    source,
    simulated: false,
    error: failure.summary,
  };
}

/* ---------------------------------- native --------------------------------- */

const SECRET_KEY = /(secret|passw(or)?d|token|private[_-]?key|credential|api[_-]?key|authorization)/i;
const MAX_STRING = 300;
const MAX_ARRAY = 50;
const MAX_DEPTH = 4;

function sanitize(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}…` : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = SECRET_KEY.test(k) ? "[redacted]" : sanitize(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined; // functions, symbols, bigint: not JSON
}

const sizeOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

function shrink(value: unknown): unknown {
  if (Array.isArray(value) && value.length > 1) return value.slice(0, Math.ceil(value.length / 2));
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1) return Object.fromEntries(entries.slice(0, Math.ceil(entries.length / 2)));
  }
  return "[truncated]";
}

/**
 * Bound a native-response bag to `maxBytes` of JSON. Redacts secret-looking
 * keys, cuts long strings/arrays, then drops the largest non-priority key until
 * it fits; priority keys are halved only as a last resort. `_truncated: true`
 * marks any loss.
 */
export function boundNative(native: Record<string, unknown>, opts: { maxBytes?: number; priority?: readonly string[] } = {}): Record<string, unknown> {
  const maxBytes = opts.maxBytes ?? MAX_NATIVE_BYTES;
  const priority = new Set(opts.priority ?? []);
  const bag = sanitize(native, 0) as Record<string, unknown>;
  let truncated = false;
  const fits = () => sizeOf(truncated ? { ...bag, _truncated: true } : bag) <= maxBytes;
  while (!fits()) {
    truncated = true;
    const droppable = Object.keys(bag)
      .filter((k) => !priority.has(k))
      .sort((a, b) => sizeOf(bag[b]) - sizeOf(bag[a]));
    if (droppable.length > 0) {
      delete bag[droppable[0]];
      continue;
    }
    const keys = Object.keys(bag).sort((a, b) => sizeOf(bag[b]) - sizeOf(bag[a]));
    if (keys.length === 0) break;
    const next = shrink(bag[keys[0]]);
    if (next === "[truncated]" && bag[keys[0]] === "[truncated]") delete bag[keys[0]];
    else bag[keys[0]] = next;
  }
  return truncated ? { ...bag, _truncated: true } : bag;
}

/* --------------------------------- runtime --------------------------------- */

export function runtimeState(ctx: { now(): Date }, node: ResourceNode, source: string, health: HealthState, counts: Record<string, number>, signals: string[]): RuntimeState {
  return { address: node.address, health, counts, signals, observedAt: nowIso(ctx), source, simulated: false };
}
