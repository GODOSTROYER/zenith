/**
 * Redaction for everything a machine returns or records.
 *
 * Machine output is untrusted data that may contain credentials (a log line
 * with a bearer token, a config file with a password, `env` output). Before any
 * `MachineResult` leaves the service, and before anything reaches the evidence
 * log, string values are passed through the shared credential-pattern redactor.
 *
 * The shared credential redactor runs first; the tofu redactor additionally
 * masks certificate blocks and provider key-id shapes. This is best-effort defence in depth:
 * a secret in a shape no pattern matches is not caught, which is why
 * `file.read` and the exec capabilities are gated by policy as well.
 */
import { redactOutput } from "@/lib/tofu/redact";
import { redactCredentials } from "@/lib/credentials/redact";

export interface Redacted {
  text: string;
  /** true when the redactor changed anything */
  redacted: boolean;
}

export function redactText(text: string): Redacted {
  const out = redactOutput(redactCredentials(text));
  return { text: out, redacted: out !== text };
}

const secretFlag = /^--?[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)[A-Za-z0-9_.-]*$/i;

/** Retain argv structure for audit without leaking separate credential flag values. */
export function redactArgv(argv: readonly string[], state: { changed: boolean } = { changed: false }): string[] {
  return argv.map((item, i) => {
    const r = i > 0 && secretFlag.test(argv[i - 1]) ? { text: "[REDACTED]", redacted: true } : redactText(item);
    if (r.redacted) state.changed = true;
    return r.text;
  });
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
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = k === "argv" && Array.isArray(v) && v.every((a) => typeof a === "string") ? redactArgv(v, state) : redactDeep(v, state, depth + 1);
  }
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
