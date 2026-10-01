/**
 * Redaction for everything a machine returns or records.
 *
 * Machine output is untrusted data that may contain credentials (a log line
 * with a bearer token, a config file with a password, `env` output). Before any
 * `MachineResult` leaves the service, and before anything reaches the evidence
 * log, string values are passed through the shared credential-pattern redactor.
 *
 * This is a thin adapter: the pattern set lives in `@/lib/tofu/redact` today
 * and moves to `@/lib/credentials/redact` when that module lands; only the
 * import below changes. It is best-effort defence in depth, not a guarantee:
 * a secret in a shape no pattern matches is not caught, which is why
 * `file.read` and the exec capabilities are gated by policy as well.
 */
import { redactOutput } from "@/lib/tofu/redact";

export interface Redacted {
  text: string;
  /** true when the redactor changed anything */
  redacted: boolean;
}

export function redactText(text: string): Redacted {
  const out = redactOutput(text);
  return { text: out, redacted: out !== text };
}

/** Redact every string leaf of a JSON-like value (depth-bounded); reports whether anything changed. */
export function redactDeep<T>(value: T, state: { changed: boolean } = { changed: false }, depth = 0): T {
  if (typeof value === "string") {
    const r = redactText(value);
    if (r.redacted) state.changed = true;
    return r.text as T;
  }
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, state, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, state, depth + 1);
  return out as T;
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // back up over continuation bytes (10xxxxxx) so the cut lands on a boundary
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** Keep at most the LAST `maxBytes` UTF-8 bytes (newest log lines) without splitting a code point. */
export function keepTailUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return { text: buf.subarray(start).toString("utf8"), truncated: true };
}
