/**
 * Safe construction of provider query fragments from untrusted text.
 *
 * Rule (spec §20, invariant 9): user- or log-derived text is data. It is never
 * concatenated into CloudWatch filter patterns, Logs Insights queries, LogQL or
 * PromQL as raw text — it goes in as one quoted string literal or one quoted
 * label value, escaped for that language, and identifiers (label names) are
 * validated against the language's identifier grammar or dropped.
 *
 * Every function here returns a *complete* quoted literal, so the caller cannot
 * forget the quotes. Tests attack each with quotes, backslashes, backticks,
 * pipes, braces and newlines.
 */

/** C0 controls, DEL, C1 controls and the Unicode line/paragraph separators. */
const CONTROL_CHAR_SOURCE = `[\x00-\x1f\x7f-\x9f${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`;
const CONTROL_CHARS = new RegExp(CONTROL_CHAR_SOURCE, "g");
const IS_CONTROL_CHAR = new RegExp(`^${CONTROL_CHAR_SOURCE}$`);

/** Replace control characters (newlines included) with a single space each. */
export function flattenControl(text: string): string {
  return text.replace(CONTROL_CHARS, " ");
}

/**
 * A CloudWatch Logs filter pattern that matches events containing `text` as a
 * literal phrase: one double-quoted term.
 *
 * Inside a quoted term nothing but `\` and `"` is special. Both are
 * backslash-escaped; the backslash is escaped first, so the escape can never be
 * consumed by a preceding user backslash. CloudWatch filter terms have no way
 * to express a newline, so control characters become spaces (a documented
 * loss of precision, not of safety). The result is capped at CloudWatch's
 * 1024-character pattern limit.
 */
export function cloudWatchFilterPattern(text: string): string {
  const flat = [...flattenControl(text)].slice(0, 400).join("");
  return `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A Logs Insights string literal for `like "<substring>"`. Same quoting rules
 * as `cloudWatchFilterPattern`; kept separate because the two languages may
 * diverge and each needs its own tests.
 */
export function insightsStringLiteral(text: string): string {
  return cloudWatchFilterPattern(text);
}

const LOGQL_SIMPLE_ESCAPES: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/**
 * A LogQL / PromQL double-quoted string literal (Go string syntax).
 *
 * `\`, `"`, newline, CR and tab get their short escapes; every other control
 * character becomes `\u00XX`, so no byte the parser could treat specially
 * survives unescaped. Backticks, pipes, braces and `=~` are inert inside a
 * double-quoted literal and are left alone.
 */
export function logqlStringLiteral(text: string): string {
  let out = '"';
  for (const ch of text) {
    const simple = LOGQL_SIMPLE_ESCAPES[ch];
    if (simple !== undefined) out += simple;
    else if (IS_CONTROL_CHAR.test(ch)) out += `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** PromQL uses the same string-literal grammar as LogQL. */
export const promqlStringLiteral = logqlStringLiteral;

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isLabelName(name: string): boolean {
  return LABEL_NAME.test(name);
}

/**
 * Map an arbitrary key (`app.kubernetes.io/name`) to a Prometheus/Loki label
 * name (`app_kubernetes_io_name`), or undefined if nothing usable remains.
 * Names starting with `__` are reserved by Prometheus and refused.
 */
export function toLabelName(key: string): string | undefined {
  const name = key.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^([0-9])/, "_$1");
  if (name === "" || name.startsWith("__") || !isLabelName(name)) return undefined;
  return name;
}

/** `name="escaped value"` — an equality matcher, or undefined for an unusable name. */
export function equalityMatcher(name: string, value: string): string | undefined {
  if (!isLabelName(name) || name.startsWith("__")) return undefined;
  return `${name}=${logqlStringLiteral(value)}`;
}

/**
 * `{a="1",b="2"}` from a label map. Names are sanitized, values escaped, and
 * unusable entries dropped; returns undefined when no matcher survives, because
 * `{}` selects everything (and Loki rejects it).
 */
export function streamSelector(labels: Record<string, string>, max = 8): string | undefined {
  return joinMatchers(matchersFrom(labels, max));
}

export function matchersFrom(labels: Record<string, string>, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of Object.keys(labels).sort()) {
    const name = toLabelName(key);
    const value = labels[key];
    if (name === undefined || seen.has(name) || typeof value !== "string" || value === "") continue;
    const m = equalityMatcher(name, value);
    if (m === undefined) continue;
    seen.add(name);
    out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

export function joinMatchers(matchers: string[]): string | undefined {
  return matchers.length === 0 ? undefined : `{${matchers.join(",")}}`;
}

/** A Loki line filter `|= "…"`: substring, case-sensitive, text escaped as a literal. */
export function lokiLineFilter(text: string): string {
  return `|= ${logqlStringLiteral(text)}`;
}
