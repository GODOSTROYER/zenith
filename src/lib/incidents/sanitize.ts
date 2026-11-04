/**
 * Sanitizing untrusted text before it becomes evidence (spec §21, ADR-0014).
 *
 * Log lines, event messages, provider error strings and change summaries are
 * DATA that customers' applications and clouds wrote. They arrive with ANSI
 * escapes, terminal control bytes, right-to-left overrides, prompt-injection
 * prose, megabyte lines and credentials nobody meant to log. Everything that
 * ends up in an `Evidence` passes through here first:
 *
 *   1. hard input cap        - a 1 MB line is cut to `MAX_INPUT_CHARS` BEFORE any
 *                              pattern runs, so no regex can be made to stall;
 *   2. control stripping     - ANSI CSI/OSC/other escapes, C0/C1 controls and
 *                              bidi/zero-width characters, so the text cannot
 *                              repaint a terminal, hide itself or reorder;
 *   3. secret redaction      - recognizable credentials by SHAPE and by KEY NAME;
 *   4. whitespace collapse   - one line, single spaces;
 *   5. clip                  - at most `MAX_EXCERPT_CHARS` (300) characters.
 *
 * Honest limits: redaction is pattern-based defence in depth, not the
 * mechanism that keeps secrets out. The mechanism is that the engine never
 * reads secret values (it reads presence only) and only ever quotes a log
 * line that matched a fixed signature. A secret with no recognizable shape or
 * key name inside a line that matches a signature can still be quoted; the
 * excerpt is bounded to 300 characters to limit that. Every pattern here is
 * linear-time (no nested unbounded quantifiers) and runs on capped input.
 */

export const REDACTED = "[REDACTED]";
export const MAX_INPUT_CHARS = 4096;
export const MAX_EXCERPT_CHARS = 300;
export const MAX_FINDING_CHARS = 400;
const ELLIPSIS = "…";

/* -------------------------------- control text ------------------------------ */

// CSI: ESC [ params intermediates final. OSC: ESC ] ... BEL | ESC \ (bounded). Other 2-byte escapes.
const ANSI_CSI = /\u001b\[[0-?]{0,32}[ -/]{0,8}[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]{0,512}(?:\u0007|\u001b\\)?/g;
const ANSI_OTHER = /\u001b[@-Z\\-_]/g;
// remaining C0 (except tab/newline handled by whitespace collapse), DEL and C1 controls
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// zero-width, bidi embedding/override/isolate, BOM, line/paragraph separators
const INVISIBLE = /[\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** Strip escapes and control characters. The result is printable text. */
export function stripControl(text: string): string {
  return text
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_OTHER, "")
    .replace(CONTROL, " ")
    .replace(INVISIBLE, "");
}

/* --------------------------------- redaction -------------------------------- */

const SENSITIVE_KEY =
  "pass(?:word|wd|phrase)|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|signature|session[_-]?key|signing[_-]?key|conn(?:ection)?[_-]?str(?:ing)?|cookie|pwd";

// value after key= / "key": — quoted, scheme-prefixed, or bare
const KV_VALUE = String.raw`(?!\[REDACTED)(?:"[^"\n]{0,512}"|'[^'\n]{0,512}'|(?:Bearer|Basic|Digest|Token)[ \t]+[^\s,;"'\]}]{1,512}|[^\s,;&"'}\]]{1,512})`;

interface Rule {
  re: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

const RULES: readonly Rule[] = [
  { re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,4000}?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g, replace: "[REDACTED PRIVATE KEY]" },
  { re: /\beyJ[A-Za-z0-9_-]{4,512}\.[A-Za-z0-9_-]{4,512}\.[A-Za-z0-9_-]{0,512}/g, replace: "[REDACTED JWT]" },
  // scheme://userinfo@host — the whole userinfo goes (user:pass or a bare token)
  { re: /\b([a-z][a-z0-9+.-]{0,20}:\/\/)(?!\[REDACTED\]@)[^\s/?#"'<>@]{1,256}@/gi, replace: (_m, scheme) => `${scheme}${REDACTED}@` },
  // key=value for secret-looking keys. The lookbehind spares ARNs like `…:secret:name`; the lookahead
  // spares the IAM action prefix `secretsmanager:GetSecretValue`, which is a name, not a key with a value.
  {
    re: new RegExp(String.raw`(?<![:\w])(?!secretsmanager:)((?:[A-Za-z0-9_.-]{0,40})(?:${SENSITIVE_KEY})[A-Za-z0-9_.-]{0,20})(["']?[ \t]{0,4}[:=][ \t]{0,4})${KV_VALUE}`, "gi"),
    replace: (_m, key, sep) => `${key}${sep}${REDACTED}`,
  },
  { re: /\b(Bearer)([ \t]+)(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,512}/gi, replace: (_m, scheme, ws) => `${scheme}${ws}${REDACTED}` },
  { re: /\b(?:AKIA|ASIA|ABIA|ACCA|AIDA|AROA)[A-Z0-9]{16}\b/g, replace: REDACTED },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  { re: /\bz(?:rt|a)_[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  // a 40-char mixed-case base64 run: an AWS secret access key, not a git SHA
  {
    re: /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=]))(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[0-9/+])[A-Za-z0-9/+]{40}/g,
    replace: REDACTED,
  },
  { re: /(?<![A-Za-z0-9/+=_-])[A-Za-z0-9/+_-]{120,}={0,2}/g, replace: "[REDACTED BLOB]" },
];

/** Mask recognizable credentials. Input is capped first; pure and idempotent. */
export function redactSecrets(text: string): string {
  let out = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, rule.replace as never);
  }
  return out;
}

/* ---------------------------------- bounding -------------------------------- */

/** Clip to at most `max` characters, ending in an ellipsis when cut. Never splits a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - ELLIPSIS.length);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + ELLIPSIS;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Untrusted text → one safe line: capped, control-stripped, redacted,
 * collapsed, clipped. Order matters: controls come out BEFORE redaction so an
 * escape inside a key (`pass\\x1b[0mword=…`) cannot split a pattern.
 */
export function sanitizeText(raw: unknown, max: number = MAX_EXCERPT_CHARS): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const capped = raw.length > MAX_INPUT_CHARS ? raw.slice(0, MAX_INPUT_CHARS) : raw;
  return clip(collapse(redactSecrets(stripControl(capped))), max);
}

/** A finding sentence Zenith composed that embeds untrusted values (host names, statuses). */
export const sanitizeFinding = (raw: string): string => sanitizeText(raw, MAX_FINDING_CHARS);

/**
 * A log excerpt around the first match of `locate` in an already
 * control-stripped line: redact the whole (capped) line first so a secret cut
 * by the window is never half visible, then take a window of at most 300
 * characters around where the signature matches in the REDACTED text (a
 * redaction can shift offsets, so the pattern is re-run rather than reusing an
 * index). When it no longer matches, the window starts at the line head.
 */
export function excerptAround(stripped: string, locate: RegExp, max: number = MAX_EXCERPT_CHARS): string {
  const capped = stripped.length > MAX_INPUT_CHARS ? stripped.slice(0, MAX_INPUT_CHARS) : stripped;
  const redacted = collapse(redactSecrets(capped));
  if (redacted.length <= max) return redacted;
  const probe = new RegExp(locate.source, locate.flags.replace("g", "").replace("y", ""));
  const at = probe.exec(redacted)?.index ?? 0;
  const room = max - 2 * ELLIPSIS.length; // both ends may carry an ellipsis
  const start = Math.max(0, Math.min(at - 80, redacted.length - room));
  const window = redacted.slice(start, start + room);
  return `${start > 0 ? ELLIPSIS : ""}${window}${start + room < redacted.length ? ELLIPSIS : ""}`;
}

/* ------------------------------- structured data ---------------------------- */

const MAX_DEPTH = 4;
const MAX_KEYS = 24;
const MAX_ITEMS = 20;

const SECRETISH_KEY = new RegExp(SENSITIVE_KEY, "i");
/** keys that hold a NAME, a reference, an id or a count are not values: `secretRef`, `signatureId`, `tokenCount` */
const NAMING_SUFFIX = /(?:ref|name|arn|ids?|kinds?|count|at)$/i;

/** Does this attribute/key name suggest its value is a credential? (`password`, `apiToken`, `signature`; not `secretRef`) */
export const isSecretKeyName = (key: string): boolean => SECRETISH_KEY.test(key) && !NAMING_SUFFIX.test(key);

/**
 * Bound and scrub a JSON-like value going into `Evidence.data`: strings are
 * sanitized (`max` chars), arrays/objects are cut to a few dozen members and
 * four levels, secret-named keys are masked outright, non-JSON values become
 * null. Returns a fresh structure; the input is never mutated.
 */
export function sanitizeData(value: unknown, max: number = MAX_EXCERPT_CHARS, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeText(value, max);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => sanitizeData(v, max, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      const key = sanitizeText(k, 64);
      out[key] = isSecretKeyName(k) ? REDACTED : sanitizeData(v, max, depth + 1);
    }
    return out;
  }
  return null;
}
