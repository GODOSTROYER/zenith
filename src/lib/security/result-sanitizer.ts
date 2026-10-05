/**
 * Model-visible result sanitization (PROD-MACH-05).
 *
 * Everything a model can read (MCP tool results, errors, runner/zenithd output
 * echoed through a tool) passes through `sanitizeForModel` on its way out. It
 * is the single structured secret detector for those paths:
 *
 *  - VALUE rules: credential shapes in any string (PEM private keys, JWTs, cloud
 *    key ids and secrets, bearer/basic values, URL passwords, vendor token
 *    prefixes, `name = value` assignments) plus the shared credential redactor;
 *  - MEMBER rules: a member whose NAME is a secret (`password`, `accessToken`,
 *    `clientSecret`, `authorization`, ...) has every string leaf below it
 *    replaced, unless the value is a reference (`vault:`, ARN, `ref:`);
 *  - EXACT values: known secrets the caller holds (for example the credentials a
 *    local runner used) are removed wherever they appear, in keys too.
 *
 * Every replacement is an explicit `[REDACTED:<kind>]` marker, never silent
 * deletion, and the returned report says how many values were replaced and of
 * which kinds. The report ALWAYS carries `completeness: "best_effort"`: pattern
 * and name detection cannot recognise an arbitrary secret with no shape, so this
 * layer never claims a result is secret-free. The primary controls are that
 * credentials never reach the control plane and that dispatch uses local
 * custody; this is the backstop. Work is bounded; whatever cannot be scanned
 * (too large, too deep) is replaced by a marker rather than passed through.
 *
 * Pure and synchronous; never throws.
 */
import { credentialPatternsIn, redactCredentials } from "@/lib/credentials/redact";

export const MAX_SANITIZE_NODES = 50_000;
export const MAX_SANITIZE_DEPTH = 24;
export const MAX_SANITIZE_STRING = 2_000_000;

export const SANITIZER_NOTE =
  "Automated redaction is best-effort pattern and name detection. Redacted values are shown as [REDACTED:<kind>] markers; a secret in an unrecognised shape can remain, so treat this output as potentially sensitive.";

export interface SanitizeReport {
  /** always true: the sanitizer ran over this value */
  applied: true;
  /** number of values replaced by a marker */
  redactions: number;
  /** distinct marker kinds, sorted */
  kinds: string[];
  /** up to 20 paths of redacted members, with unsafe characters removed (never values) */
  paths: string[];
  /** part of the value was not scanned (limits) and was replaced by a marker */
  scanLimited: boolean;
  /** never "complete": see the module comment */
  completeness: "best_effort";
}

export interface SanitizeOptions {
  /** exact secret strings (at least 6 characters) to remove wherever they occur */
  knownSecrets?: readonly string[];
  /** do not treat member names as secrets (value rules only); default false */
  valueRulesOnly?: boolean;
}

export const marker = (kind: string): string => `[REDACTED:${kind}]`;

interface ValueRule {
  kind: string;
  re: RegExp;
  replace?: (match: string, ...groups: string[]) => string;
}

const AWS_PREFIX = "AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|AIPA|ABIA|ACCA";
const BENIGN_ASSIGNED = /^(?:null|true|false|none|undefined|\(sensitive.*\)|<sensitive>|\(known after apply\)|bearer)$/i;
const REFERENCE_PREFIXES = ["vault:", "arn:", "secretsmanager:", "ssm:", "ref:"];

function isReferenceValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.length === 0 || v.startsWith("[redacted") || REFERENCE_PREFIXES.some((p) => v.startsWith(p)) || BENIGN_ASSIGNED.test(v);
}

const VALUE_RULES: readonly ValueRule[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  { kind: "aws-access-key-id", re: new RegExp(`\\b(?:${AWS_PREFIX})[A-Z0-9]{16}\\b`, "g") },
  { kind: "aws-session-token", re: /\b(?:IQoJ|FwoG|AQoD|FQoG|AgoJ)[A-Za-z0-9/+=]{60,}/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "payment-secret-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "model-api-key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google-token", re: /\b(?:ya29\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35})\b/g },
  { kind: "zenith-token", re: /\bz(?:rt|a)_[A-Za-z0-9_-]{16,}/g },
  {
    kind: "azure-storage-key",
    re: /\b(AccountKey|SharedAccessKey)=[A-Za-z0-9+/=%&;_.-]{16,}/gi,
    replace: (_m, name) => `${name}=${marker("azure-storage-key")}`,
  },
  { kind: "bearer", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_m, scheme) => `${scheme} ${marker("bearer")}` },
  {
    kind: "url-password",
    re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
    replace: (_m, head, at) => `${head}${marker("url-password")}${at}`,
  },
  {
    kind: "secret-assignment",
    re: /((?:["']?[A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)[A-Za-z0-9_.-]*["']?)\s*[:=]\s*)("[^"\r\n]{6,}"|'[^'\r\n]{6,}'|[^\s,;}\]"']{6,})/gi,
    replace: (m, head, value) => {
      const raw = String(value);
      const bare = raw.replace(/^["']|["']$/g, "");
      // Placeholders such as "(known after apply)" are not values; a secret-named MEMBER is held to the stricter reference check.
      if (isReferenceValue(bare) || bare.startsWith("(") || bare.startsWith("<")) return m;
      const quote = /^["']/.test(raw) ? raw[0] : "";
      return `${head}${quote}${marker("secret-assignment")}${quote}`;
    },
  },
];

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");
const SECRET_KEY_SUFFIXES = [
  "password", "passwd", "passphrase", "secret", "token", "apikey", "accesskey", "secretkey", "privatekey",
  "credential", "credentials", "authorization", "cookie", "setcookie", "bearer", "sessionkey",
];
const NOT_SECRET_KEYS: ReadonlySet<string> = new Set(["nexttoken", "pagetoken", "nextpagetoken", "continuationtoken", "paginationtoken", "tokentype"]);

/** True when a member name is a secret by name (suffix match, so `tokenCount` and `maxTokens` are not). */
export function isSecretMemberName(key: string): boolean {
  const n = normalizeKey(key);
  if (!n || NOT_SECRET_KEYS.has(n)) return false;
  // `hasPassword` / `isSecret` / `has_token` are flags about a secret, not a secret.
  if (/^(?:has|is)(?:[A-Z_]|$)/.test(key)) return false;
  return SECRET_KEY_SUFFIXES.some((s) => n === s || n.endsWith(s));
}

class Counter {
  count = 0;
  kinds = new Set<string>();
  paths: string[] = [];
  scanLimited = false;
  nodes = 0;
  hit(kind: string, path?: string, n = 1): void {
    this.count += n;
    this.kinds.add(kind);
    if (path !== undefined && this.paths.length < 20) {
      const safe = path.replace(/[^A-Za-z0-9_.[\]<>-]/g, "?").slice(0, 160) || "<root>";
      if (!this.paths.includes(safe)) this.paths.push(safe);
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactRegex(secrets: readonly string[] | undefined): RegExp | undefined {
  const usable = [...new Set((secrets ?? []).filter((s) => typeof s === "string" && s.length >= 6))].sort((a, b) => b.length - a.length);
  return usable.length ? new RegExp(usable.map(escapeRe).join("|"), "g") : undefined;
}

function scanString(text: string, c: Counter, path: string, exact: RegExp | undefined): string {
  let out = text;
  let tail = "";
  if (out.length > MAX_SANITIZE_STRING) {
    out = out.slice(0, MAX_SANITIZE_STRING);
    tail = marker("unscanned-tail");
    c.scanLimited = true;
    c.hit("unscanned-tail", path);
  }
  if (exact) {
    exact.lastIndex = 0;
    out = out.replace(exact, () => {
      c.hit("known-secret", path);
      return marker("known-secret");
    });
  }
  for (const rule of VALUE_RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, args.length - 2) as string[];
      const replaced = rule.replace ? rule.replace(match, ...groups) : marker(rule.kind);
      if (replaced !== match) c.hit(rule.kind, path);
      return replaced;
    });
  }
  // Shared credential redactor as a backstop for shapes the rules above do not name.
  const remaining = credentialPatternsIn(out);
  if (remaining.length > 0) {
    const swept = redactCredentials(out);
    if (swept !== out) {
      for (const name of remaining) c.hit(name, path);
      out = swept;
    }
  }
  return out + tail;
}

/** Sanitize `value` for a model. Returns a deep copy and a report. Never throws. */
export function sanitizeForModel<T>(value: T, options: SanitizeOptions = {}): { value: T; report: SanitizeReport } {
  const c = new Counter();
  const exact = exactRegex(options.knownSecrets);
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string, depth: number, forced: boolean): unknown => {
    if (++c.nodes > MAX_SANITIZE_NODES || depth > MAX_SANITIZE_DEPTH) {
      c.scanLimited = true;
      c.hit("unscanned", path);
      return marker("unscanned");
    }
    if (typeof node === "string") {
      if (forced && !isReferenceValue(node)) {
        c.hit("secret-member", path);
        return marker("secret-member");
      }
      return scanString(node, c, path, exact);
    }
    if (node === null || node === undefined || typeof node === "number" || typeof node === "boolean") return node;
    if (typeof node === "bigint") return node.toString();
    if (typeof node === "function" || typeof node === "symbol") return undefined;
    if (node instanceof Date) return Number.isNaN(node.getTime()) ? null : node.toISOString();
    if (node instanceof Uint8Array || node instanceof ArrayBuffer) {
      c.hit("binary", path);
      return marker("binary");
    }
    const obj = node as object;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    if (obj instanceof Error) return { name: scanString(obj.name, c, path, exact), message: scanString(obj.message, c, `${path}.message`, exact) };
    if (obj instanceof Map) return walk(Object.fromEntries(obj), path, depth, forced);
    if (obj instanceof Set) return walk([...obj], path, depth, forced);
    if (Array.isArray(obj)) return obj.map((item, i) => walk(item, `${path}[${i}]`, depth + 1, forced));
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj as Record<string, unknown>)) {
      let safeKey = scanString(key, c, `${path}<key>`, exact);
      if (safeKey !== key) {
        // A secret used as a key: keep members distinct and visibly redacted.
        const base = safeKey;
        let n = 1;
        while (Object.prototype.hasOwnProperty.call(out, safeKey)) safeKey = `${base}#${++n}`;
      }
      const childPath = path ? `${path}.${key}` : key;
      const secretByName = !options.valueRulesOnly && isSecretMemberName(key);
      out[safeKey] = walk(child, childPath, depth + 1, forced || secretByName);
    }
    return out;
  };

  let result: unknown;
  try {
    result = walk(value, "", 0, false);
  } catch {
    // Fail closed: if scanning itself fails nothing from the original is returned.
    c.scanLimited = true;
    c.hit("unscanned", "<root>");
    result = marker("unscanned");
  }
  return {
    value: result as T,
    report: { applied: true, redactions: c.count, kinds: [...c.kinds].sort(), paths: c.paths, scanLimited: c.scanLimited, completeness: "best_effort" },
  };
}

/** Text form: same rules over one string. */
export function sanitizeText(text: string, options: SanitizeOptions = {}): { text: string; report: SanitizeReport } {
  const { value, report } = sanitizeForModel(text, options);
  return { text: typeof value === "string" ? value : marker("unscanned"), report };
}

/** One-line statement for a result's notes; undefined when nothing was replaced (no claim is made either way). */
export function redactionNote(report: SanitizeReport): string | undefined {
  if (report.redactions === 0 && !report.scanLimited) return undefined;
  return `${report.redactions} value(s) were replaced by [REDACTED:<kind>] markers (${report.kinds.join(", ") || "none"}). ${SANITIZER_NOTE}`;
}

const NON_SHAPE_KINDS = new Set(["secret-assignment", "secret-member", "unscanned", "unscanned-tail", "binary", "known-secret", "long-base64", "aws-secret-access-key", "authorization-header"]);

/**
 * High-confidence credential shapes (private key, cloud key id, JWT, vendor token) found in `value`,
 * as kind names. For detection at a trust boundary; never returns matched text.
 */
export function detectCredentialShapes(value: unknown, options: Pick<SanitizeOptions, "knownSecrets"> = {}): string[] {
  const { report } = sanitizeForModel(value, { ...options, valueRulesOnly: true });
  return report.kinds.filter((k) => !NON_SHAPE_KINDS.has(k));
}
