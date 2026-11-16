/**
 * Client-safe text helpers for the platform components.
 *
 * Nothing here imports `node:` APIs, the control-plane digest module, the
 * resources barrel or any engine: components run in the browser bundle, so the
 * handful of things they need (short digests, sentence-casing a machine token,
 * comparing two JSON values, deciding whether a path looks secret) live here as
 * small pure functions with tests.
 *
 * Honesty notes:
 *  - `shortDigest` only shortens for display; callers keep the full digest for
 *    copying and comparison.
 *  - `isSecretishPath` mirrors the path filter `planView` applies server-side.
 *    It is defence in depth for values that reach a component by another route
 *    (an observation, a drift finding); it never makes a masked value visible.
 */

/** First `length` hex characters of a digest. The caller shows an ellipsis. */
export function shortDigest(digest: string, length = 12): string {
  const hex = digest.replace(/^sha256:/i, "");
  return hex.length <= length ? hex : hex.slice(0, length);
}

/** "1 resource", "3 resources". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * "target_unhealthy", "drift.repair", "maxLines" → "Target unhealthy",
 * "Drift repair", "Max lines". Used only as a fallback when a specific
 * sentence for a code is not known; the code itself stays available in a
 * disclosure.
 */
export function humanizeToken(token: string): string {
  const words = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._:/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : token;
}

/** Shorten long text with an ellipsis, never splitting the ellipsis into the limit. */
export function truncate(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

const SECRETISH_PATH =
  /(secret|passw(or)?d|passwd|token|private[_-]?key|access[_-]?key|credential|api[_-]?key|auth|certificate[_-]?key|connection[_-]?string)/i;

/** Does an attribute path look like it holds a secret? Mirrors `planView`. */
export function isSecretishPath(path: string): boolean {
  return SECRETISH_PATH.test(path);
}

/** A reference to a secret (vault ref or ARN) is not a secret value and may be shown. */
export function isSecretReference(value: unknown): boolean {
  return typeof value === "string" && /^(vault:|arn:|secretsmanager:|ssm:)/i.test(value);
}

/** Deterministic JSON: object keys sorted, `undefined` members dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/** Structural equality of two JSON values. */
export function sameValue(a: unknown, b: unknown): boolean {
  // `undefined` is "no value", which is not the same thing as a value of null
  if ((a === undefined) !== (b === undefined)) return false;
  return stableStringify(a) === stableStringify(b);
}

/**
 * A value as one line of text. Strings are shown as they are (an empty string
 * is shown as `""` so it cannot be mistaken for "nothing"); objects and arrays
 * as compact JSON, truncated.
 */
export function formatScalar(value: unknown, max = 160): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value === "" ? '""' : truncate(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return truncate(stableStringify(value), max);
}

/** Flatten nested plain objects to dotted paths; arrays and scalars are leaves. */
export function flattenObject(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
      Object.assign(out, flattenObject(v as Record<string, unknown>, path));
    } else {
      out[path] = v;
    }
  }
  return out;
}

/** Compact ISO-8601 "is this in the past" check that fails closed on garbage. */
export function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** Percentage for a 0..1 number; `undefined` when the number is not usable. */
export function toPercent(ratio: number): number | undefined {
  if (!Number.isFinite(ratio)) return undefined;
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

/**
 * "23 minutes", "1 hour 5 minutes", "under a minute". For a countdown the
 * caller pairs with "in …" or "… ago"; never more precise than a minute, because
 * the clock behind it ticks every 30 seconds.
 */
export function describeSpan(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 60_000);
  if (total < 1) return "under a minute";
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days) parts.push(plural(days, "day"));
  if (hours) parts.push(plural(hours, "hour"));
  if (minutes && days === 0) parts.push(plural(minutes, "minute"));
  return parts.join(" ");
}
