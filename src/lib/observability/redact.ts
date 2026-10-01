/**
 * Defensive redaction and bounding of untrusted signal text (spec §20, ADR-0011).
 *
 * Log lines, event messages and provider error strings are DATA that customers'
 * applications and clouds wrote. They routinely contain things nobody meant to
 * log: cloud keys, bearer tokens, `password=` pairs, connection strings. This
 * module masks the recognizable ones before anything leaves the fabric.
 *
 * What this is and is not:
 *   - It is defense in depth (architecture invariant 3). The mechanism that
 *     keeps secrets out of results is that Zenith never holds customer secret
 *     values; redaction only catches what an application leaked into its own
 *     logs.
 *   - It is pattern-based. It recognizes secrets by SHAPE (AWS key IDs, JWTs,
 *     private-key blocks, well-known token prefixes, `scheme://user:pass@`) and
 *     by KEY NAME (`password=…`, `"api_key": "…"`, `Authorization: Basic …`).
 *     A secret with no recognizable shape or key name, a value containing
 *     spaces after an unquoted `password=`, or a PEM body split across
 *     separate log events is NOT caught. Documented, not hidden.
 *   - Every regex here is linear-time (no nested unbounded quantifiers) and
 *     input is capped before matching, so a hostile log line cannot stall it.
 *
 * Output is bounded: messages to 4 KiB, attribute/native strings to 1 KiB,
 * native bags to a few dozen keys at limited depth.
 */
import type { NormalizedEvent, NormalizedLog } from "./types";

export const REDACTED = "[REDACTED]";
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_ATTRIBUTE_BYTES = 1024;
const MAX_REDACT_INPUT_CHARS = 65_536;
const TRUNCATION_MARKER = "…[truncated]";
const MAX_NATIVE_KEYS = 40;
const MAX_NATIVE_ARRAY = 40;
const MAX_NATIVE_DEPTH = 4;

/* --------------------------------- patterns -------------------------------- */

/** Key-name fragments that mark a value as secret. Matched as a key SUFFIX (`db_password`, `clientSecret`). */
const SENSITIVE_KEY_SOURCE =
  "pass(?:word|wd|phrase)|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|signature|session[_-]?key|signing[_-]?key|conn(?:ection)?[_-]?str(?:ing)?|cookie";

const SENSITIVE_KEY = new RegExp(SENSITIVE_KEY_SOURCE, "i");

/** A value after `key=` / `"key":` — quoted, escaped-quoted (JSON inside JSON), scheme-prefixed, or bare. */
const KV_VALUE = String.raw`(?!\[REDACTED)(?:\\{1,2}"[^"\\]*\\{1,2}"|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|(?:Bearer|Basic|Digest|Negotiate|Token)[ \t]+[^\s,;"'\]}]+|[^\s,;&"'}\]]+)`;

interface Rule {
  re: RegExp;
  replace: string | ((substring: string, ...groups: string[]) => string);
}

const RULES: Rule[] = [
  // PEM private keys, through END or — for a truncated block — to the end of the text.
  {
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: "[REDACTED PRIVATE KEY]",
  },
  // JWTs: header.payload.signature, header starts with base64 of `{"`
  { re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, replace: "[REDACTED JWT]" },
  // scheme://userinfo@host — the whole userinfo goes (it may be `user:pass` or a bare token)
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)(?!\[REDACTED\]@)[^\s/?#"'<>]+@/gi, replace: (_m, scheme) => `${scheme}${REDACTED}@` },
  // key=value / "key": "value" for secret-looking keys; `(?<!:)` spares ARNs like `…:secret:name`
  {
    re: new RegExp(String.raw`(?<!:)(${SENSITIVE_KEY_SOURCE})((?:\\{0,2}["'])?[ \t]*[:=][ \t]*)${KV_VALUE}`, "gi"),
    replace: (_m, key, sep) => `${key}${sep}${REDACTED}`,
  },
  // ODBC-style `;Pwd=…` (bare `pwd=` is too common as a shell variable to mask)
  // Consume the prefix forwards: a variable-length whitespace lookbehind here
  // scans backwards at every input position, making all-space input quadratic.
  { re: /(;[ \t]*pwd)([ \t]*=[ \t]*)(?!\[REDACTED)[^\s;"']+/gi, replace: (_m, key, sep) => `${key}${sep}${REDACTED}` },
  { re: /\b(Bearer)([ \t]+)(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_m, scheme, ws) => `${scheme}${ws}${REDACTED}` },
  // AWS access key IDs (long-term AKIA, temporary ASIA, and the rarer ABIA/ACCA)
  { re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, replace: REDACTED },
  // vendor token shapes
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replace: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: REDACTED },
  { re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
];

/* --------------------------------- text ----------------------------------- */

export interface Redacted<T> {
  value: T;
  /** true when anything was masked */
  redacted: boolean;
}

/** Mask recognizable secrets in `input`. Pure; idempotent (`redactText(redactText(x)) === redactText(x)`). */
export function redactText(input: string): { text: string; redacted: boolean } {
  let text = input;
  let redacted = false;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, (...args: unknown[]) => {
      redacted = true;
      const [m, ...rest] = args as string[];
      return typeof rule.replace === "string" ? rule.replace : rule.replace(m, ...rest);
    });
  }
  return { text, redacted };
}

/** Truncate to at most `maxBytes` UTF-8 bytes (marker included), never splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const marker = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const bytes = Buffer.from(text, "utf8");
  let end = Math.max(0, maxBytes - marker);
  // step back off a UTF-8 continuation byte so the cut lands on a code point boundary
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8") + TRUNCATION_MARKER, truncated: true };
}

/** Redact, then bound to 4 KiB. Redaction runs first so a secret cut by the bound is never half-visible. */
export function sanitizeMessage(message: string): { message: string; redacted: boolean; truncated: boolean } {
  const capped = message.length > MAX_REDACT_INPUT_CHARS ? message.slice(0, MAX_REDACT_INPUT_CHARS) : message;
  const r = redactText(capped);
  const t = truncateUtf8(r.text, MAX_MESSAGE_BYTES);
  return { message: t.text, redacted: r.redacted, truncated: t.truncated || capped.length !== message.length };
}

/** For provider error strings and other short free text surfaced as `unavailable[].reason`. */
export function sanitizeReason(reason: string, maxBytes = 512): string {
  const r = redactText(reason.length > 4096 ? reason.slice(0, 4096) : reason);
  return truncateUtf8(r.text.replace(/\s+/g, " ").trim(), maxBytes).text;
}

/* ------------------------------ structured data ---------------------------- */

const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

function sanitizeString(value: string): Redacted<string> {
  const r = redactText(value.length > MAX_ATTRIBUTE_BYTES * 4 ? value.slice(0, MAX_ATTRIBUTE_BYTES * 4) : value);
  return { value: truncateUtf8(r.text, MAX_ATTRIBUTE_BYTES).text, redacted: r.redacted };
}

/** Attribute bag: scalar values only; secret-named keys are masked outright, strings are pattern-redacted. */
export function sanitizeAttributes(attrs: Record<string, string | number | boolean>): Redacted<Record<string, string | number | boolean>> {
  const out: Record<string, string | number | boolean> = {};
  let redacted = false;
  for (const [key, value] of Object.entries(attrs).slice(0, MAX_NATIVE_KEYS)) {
    if (key === "redacted" || key === "truncated") {
      out[key] = value;
      continue;
    }
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      redacted = true;
    } else if (typeof value === "string") {
      const s = sanitizeString(value);
      out[key] = s.value;
      redacted ||= s.redacted;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return { value: out, redacted };
}

/**
 * Provider-native bag: JSON-shaped, bounded (depth 4, 40 keys, 40 array items,
 * 1 KiB strings). Secret-named keys are masked, strings pattern-redacted;
 * functions, symbols and cycles are dropped.
 */
export function sanitizeNative(native: Record<string, unknown>): Redacted<Record<string, unknown>> {
  const state = { redacted: false };
  const value = sanitizeValue(native, 0, state);
  return { value: (value ?? {}) as Record<string, unknown>, redacted: state.redacted };
}

function sanitizeValue(value: unknown, depth: number, state: { redacted: boolean }): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = sanitizeString(value);
    state.redacted ||= s.redacted;
    return s.value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth >= MAX_NATIVE_DEPTH) return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_NATIVE_ARRAY).map((v) => sanitizeValue(v, depth + 1, state) ?? null);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_NATIVE_KEYS)) {
      if (isSensitiveKey(key) && v !== null && v !== undefined) {
        out[key] = REDACTED;
        state.redacted = true;
        continue;
      }
      const sv = sanitizeValue(v, depth + 1, state);
      if (sv !== undefined) out[key] = sv;
    }
    return out;
  }
  return undefined;
}

/* -------------------------------- records --------------------------------- */

const ID_LIKE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Sanitize a normalized log: message redacted and bounded, attributes and
 * native bag redacted and bounded, trace/span ids kept only if they look like
 * ids. Sets `attributes.redacted = true` when anything was masked and
 * `attributes.truncated = true` when the message was cut. Idempotent.
 */
export function sanitizeLog(log: NormalizedLog): NormalizedLog {
  const m = sanitizeMessage(log.message);
  const a = sanitizeAttributes(log.attributes);
  const n = sanitizeNative(log.native);
  const redacted = m.redacted || a.redacted || n.redacted || a.value.redacted === true;
  const attributes = { ...a.value };
  if (redacted) attributes.redacted = true;
  if (m.truncated) attributes.truncated = true;
  const out: NormalizedLog = { ...log, message: m.message, attributes, native: n.value };
  if (log.traceId !== undefined && !ID_LIKE.test(log.traceId)) delete out.traceId;
  if (log.spanId !== undefined && !ID_LIKE.test(log.spanId)) delete out.spanId;
  return out;
}

/** Sanitize an event: message redacted and bounded, native bag redacted and bounded. */
export function sanitizeEvent(event: NormalizedEvent): NormalizedEvent {
  const m = sanitizeMessage(event.message);
  const n = sanitizeNative(event.native);
  const native = n.value;
  if (m.redacted || n.redacted) native.redacted = true;
  return { ...event, message: m.message, native };
}
