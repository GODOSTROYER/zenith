/**
 * Credential redaction — defence in depth, never the primary control.
 *
 * The primary control is that credentials never reach a place text can be
 * written (ADR-0006). This module is the backstop other modules apply to
 * strings that cross a trust boundary (log lines, error messages, evidence
 * summaries, model-visible text, tofu output).
 *
 * `redactCredentials(text)` masks:
 *   - AWS access key ids (AKIA/ASIA/…) and secret access keys (40-char base64
 *     with mixed case, so git SHAs and hex digests are not touched)
 *   - session tokens (known AWS prefixes, `SessionToken`/`aws_session_token`
 *     assignments, X-Amz-Security-Token) and any base64-ish run of ≥160 chars
 *   - JWTs, `Bearer …` tokens and `Authorization:` header values
 *   - PEM blocks (`-----BEGIN …`) — private keys are removed whole
 *   - Zenith registration/integration tokens (`zrt_…`, `za_…`)
 * `vault:…` references, ARNs and secret NAMES are references, not secrets, and
 * are deliberately left alone.
 *
 * It is a heuristic filter: a determined encoding defeats it. Do not use it to
 * make a leaky value safe to store — remove the value instead.
 */

interface Rule {
  name: string;
  pattern: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

const AWS_KEY_PREFIXES = "AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ABIA|ACCA|A3T[A-Z0-9]";

const RULES: readonly Rule[] = [
  // PEM first: a private key contains base64 that later rules would chew up.
  {
    name: "pem-private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: "[REDACTED PEM PRIVATE KEY]",
  },
  {
    name: "pem-block",
    pattern: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
    replace: "[REDACTED PEM BLOCK]",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
    replace: "[REDACTED JWT]",
  },
  {
    name: "authorization-header",
    pattern: /\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED]`,
  },
  {
    name: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: "Bearer [REDACTED]",
  },
  {
    name: "aws-secret-assignment",
    pattern:
      /(["']?(?:aws_secret_access_key|secretaccesskey|secret_access_key|aws_session_token|sessiontoken|session_token|x-amz-security-token)["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=_%-]{8,}/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED]`,
  },
  {
    name: "aws-access-key-id",
    pattern: new RegExp(`\\b(?:${AWS_KEY_PREFIXES})[A-Z0-9]{16}\\b`, "g"),
    replace: (m) => `${m.slice(0, 4)}****************`,
  },
  {
    name: "aws-session-token",
    pattern: /\b(?:IQoJ|FwoG|AQoD|FQoG|AgoJ)[A-Za-z0-9/+=]{60,}/g,
    replace: "[REDACTED SESSION TOKEN]",
  },
  {
    name: "zenith-token",
    pattern: /\bz(?:rt|a)_[A-Za-z0-9_-]{16,}/g,
    replace: "[REDACTED ZENITH TOKEN]",
  },
  {
    // 40 chars of base64 that mix upper, lower and a digit/symbol: a secret
    // access key, not a 40-hex git SHA. Lookarounds avoid slicing longer runs.
    name: "aws-secret-access-key",
    pattern: /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=]))(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[0-9/+])[A-Za-z0-9/+]{40}/g,
    replace: "[REDACTED SECRET]",
  },
  {
    name: "long-base64",
    pattern: /(?<![A-Za-z0-9/+=_-])[A-Za-z0-9/+_-]{160,}={0,2}/g,
    replace: "[REDACTED BLOB]",
  },
];

/** Mask credential-looking material in `text`. Non-strings are returned unchanged. */
export function redactCredentials(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace as never);
  }
  return out;
}

/** The names of the rules that match `text` (for tests and leak reports; never returns matched text). */
export function credentialPatternsIn(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits: string[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) hits.push(rule.name);
    rule.pattern.lastIndex = 0;
  }
  return hits;
}

/** Deeply redact every string in a JSON-like value (returns a copy; cycles become "[Circular]"). */
export function redactDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactCredentials(v);
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (v instanceof Error) return { name: v.name, message: redactCredentials(v.message) };
    if (Array.isArray(v)) return v.map(walk);
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [redactCredentials(k), walk(val)]));
  };
  return walk(value) as T;
}

export class CredentialLeakError extends Error {
  constructor(
    readonly path: string,
    readonly pattern: string
  ) {
    // The message names WHERE and WHICH pattern, never the offending value.
    super(`Credential-looking value found at ${path} (${pattern}).`);
    this.name = "CredentialLeakError";
  }
}

export interface LeakScanOptions {
  /** exact secret strings that must appear nowhere (e.g. the fake keys a test handed out) */
  secrets?: readonly string[];
  /** patterns to ignore, by rule name */
  allow?: readonly string[];
  /** traversal limit */
  maxDepth?: number;
}

/**
 * Test/diagnostic helper: throw if `value` — at any depth, in keys or values,
 * including Error messages/stacks/causes, Maps, Sets and non-enumerable own
 * properties — contains a known secret or credential-looking material. The
 * thrown error never contains the value.
 */
export function assertNoCredentialLeak(value: unknown, options: LeakScanOptions = {}): void {
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 4);
  const allow = new Set(options.allow ?? []);
  const maxDepth = options.maxDepth ?? 12;
  const seen = new WeakSet<object>();

  const checkString = (s: string, path: string): void => {
    for (const secret of secrets) {
      if (s.includes(secret)) throw new CredentialLeakError(path, "known-secret");
    }
    for (const name of credentialPatternsIn(s)) {
      if (!allow.has(name)) throw new CredentialLeakError(path, name);
    }
  };

  const walk = (v: unknown, path: string, depth: number): void => {
    if (typeof v === "string") return checkString(v, path);
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return;
    if (typeof v === "function" || typeof v === "symbol") return;
    if (depth > maxDepth) throw new CredentialLeakError(path, "max-depth-exceeded");
    const obj = v as object;
    if (seen.has(obj)) return;
    seen.add(obj);
    if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) {
      checkString(Buffer.from(obj as Uint8Array).toString("latin1"), `${path}<bytes>`);
      checkString(Buffer.from(obj as Uint8Array).toString("base64"), `${path}<bytes>`);
      return;
    }
    if (obj instanceof Error) {
      checkString(obj.message, `${path}.message`);
      if (obj.stack) checkString(obj.stack, `${path}.stack`);
      if ("cause" in obj) walk((obj as { cause?: unknown }).cause, `${path}.cause`, depth + 1);
    }
    if (obj instanceof Map) {
      let i = 0;
      for (const [k, val] of obj) {
        walk(k, `${path}<key${i}>`, depth + 1);
        walk(val, `${path}<value${i}>`, depth + 1);
        i++;
      }
      return;
    }
    if (obj instanceof Set) {
      let i = 0;
      for (const val of obj) walk(val, `${path}<item${i++}>`, depth + 1);
      return;
    }
    for (const key of Reflect.ownKeys(obj)) {
      const name = typeof key === "symbol" ? key.toString() : key;
      checkString(name, `${path}<key>`);
      let child: unknown;
      try {
        child = (obj as Record<string | symbol, unknown>)[key];
      } catch {
        continue;
      }
      walk(child, `${path}.${name}`, depth + 1);
    }
  };

  walk(value, "$", 0);
  // Also scan what a naive serialiser would emit, in case toJSON() differs from own properties.
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") checkString(json, "$<json>");
  } catch {
    /* not serialisable: nothing further to scan */
  }
}
