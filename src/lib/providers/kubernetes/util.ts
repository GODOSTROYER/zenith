/**
 * Small pure helpers shared across the Kubernetes provider: JSON
 * normalization of client-library models, quantity parsing, redaction and
 * bounded-size bags. Nothing here performs I/O.
 */

/** API results are class instances with `Date`s; drivers and diffing work on plain JSON. */
export function plain<T = Record<string, unknown>>(value: unknown): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** `get(obj, "spec", "template", "spec")` without throwing on a missing link. */
export function dig(value: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (!isRecord(cur)) return undefined;
      cur = cur[key];
    }
  }
  return cur;
}

/* ------------------------------- quantities ------------------------------- */

/** CPU quantity → millicores (`500m` → 500, `1` → 1000, `0.25` → 250). */
export function cpuToMillicores(q: unknown): number | undefined {
  if (typeof q === "number") return Math.round(q * 1000);
  if (typeof q !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(q.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Math.round(m[2] === "m" ? n : n * 1000);
}

const BIN: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
const DEC: Record<string, number> = { k: 1e3, M: 1e6, G: 1e9, T: 1e12 };

/** Memory/storage quantity → MiB, rounded (`512Mi` → 512, `1Gi` → 1024, `500M` → 477). */
export function quantityToMiB(q: unknown): number | undefined {
  if (typeof q === "number") return Math.round(q / 1024 ** 2);
  if (typeof q !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(q.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const bytes = unit === undefined ? n : (BIN[unit] ?? DEC[unit] ?? 1) * n;
  return Math.round(bytes / 1024 ** 2);
}

/* -------------------------------- redaction -------------------------------- */

const SECRETISH: { re: RegExp; to: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, to: "[redacted]" },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: "Bearer [redacted]" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, to: "[redacted]" },
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, to: "[redacted]" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, to: "[redacted]" },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, to: "[redacted]" },
  {
    re: /((?:pass(?:word)?|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]{3,}/gi,
    to: "$1[redacted]",
  },
  { re: /(:\/\/[^\s:/@]+:)[^\s@/]{3,}(@)/g, to: "$1[redacted]$2" },
];

/** Defense in depth for free text that may carry a credential (logs, event messages, error bodies). */
export function redactText(text: string): string {
  let out = text;
  for (const { re, to } of SECRETISH) out = out.replace(re, to);
  return out;
}

/** Remove every occurrence of the given secret values (exact match), however short. */
export function scrubValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 3) out = out.split(s).join("[redacted]");
  }
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/* --------------------------------- bounding -------------------------------- */

/**
 * Keep a `native` bag within `maxBytes` of JSON by dropping the largest
 * top-level entries until it fits (drivers promise ≤ 4 KiB).
 */
export function boundBag(bag: Record<string, unknown>, maxBytes = 4096): Record<string, unknown> {
  const out = { ...bag };
  const size = (o: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(o), "utf8");
  while (size(out) > maxBytes && Object.keys(out).length > 0) {
    let biggest = "";
    let biggestSize = -1;
    for (const k of Object.keys(out)) {
      const s = Buffer.byteLength(JSON.stringify(out[k]) ?? "", "utf8");
      if (s > biggestSize) {
        biggest = k;
        biggestSize = s;
      }
    }
    delete out[biggest];
  }
  return out;
}

/** Structural equality on JSON-ish values (key order irrelevant, arrays ordered). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export function sortedUnique<T extends string | number>(xs: readonly T[]): T[] {
  return [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
