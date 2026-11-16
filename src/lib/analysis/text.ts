/**
 * Small, linear-time text helpers for reading untrusted repository files.
 *
 * Every pattern used against repository text in this module follows three
 * rules: no nested or overlapping quantifiers, bounded repetition wherever a
 * group can repeat, and input is length-capped per line before it is matched
 * (`MAX_LINE`). That keeps every scan O(n) in the size of the file, so a
 * hostile file can cost time proportional to its size and nothing more.
 */
import type { Confidence } from "./types";

/** Lines longer than this are truncated before matching (minified bundles). */
export const MAX_LINE = 1_000;
/** Files with more lines than this are scanned only up to here. */
export const MAX_LINES = 20_000;
/** Config-format files (JSON/YAML/TOML) larger than this are not parsed. */
export const MAX_PARSE_BYTES = 512 * 1024;

export interface Line {
  /** 1-based */
  n: number;
  text: string;
}

/** Split into capped, 1-based lines. `\r` is stripped. */
export function lines(content: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  let n = 1;
  while (start <= content.length && n <= MAX_LINES) {
    let end = content.indexOf("\n", start);
    if (end === -1) end = content.length;
    let text = content.slice(start, Math.min(end, start + MAX_LINE));
    if (text.endsWith("\r")) text = text.slice(0, -1);
    out.push({ n, text });
    start = end + 1;
    n++;
  }
  return out;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON.parse with a size cap; `undefined` on any failure. */
export function parseJson(content: string): unknown {
  if (content.length > MAX_PARSE_BYTES) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/** Own string-valued entries of a record, sorted by key (deterministic). */
export function stringEntries(v: unknown): [string, string][] {
  if (!isRecord(v)) return [];
  const out: [string, string][] = [];
  for (const k of Object.keys(v).sort()) {
    const value = v[k];
    if (typeof value === "string") out.push([k, value]);
  }
  return out;
}

/** 1-based line of the first occurrence of `needle`, or undefined. */
export function lineOf(content: string, needle: string): number | undefined {
  const at = content.indexOf(needle);
  if (at === -1) return undefined;
  let n = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < at; i = content.indexOf("\n", i + 1)) n++;
  return n;
}

/* ------------------------------- sanitising ------------------------------ */

/** Collapse control characters and whitespace runs to single spaces, cap length. */
export function sanitizeInline(s: string, max = 200): string {
  let out = "";
  let lastSpace = false;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const isSpace = code < 0x20 || code === 0x7f || ch === " " || code === 0x2028 || code === 0x2029;
    if (isSpace) {
      if (!lastSpace && out.length > 0) out += " ";
      lastSpace = true;
    } else {
      out += ch;
      lastSpace = false;
    }
    if (out.length >= max) break;
  }
  return out.trimEnd();
}

/** For messages that name repository-controlled text: JSON-quoted, one line, capped. */
export const quoteUntrusted = (s: string, max = 120): string => JSON.stringify(sanitizeInline(s, max));

/** A path safe to print in a diagnostic: printable ASCII only, capped. */
export function displayPath(p: string, max = 120): string {
  let out = "";
  for (const ch of p) {
    out += /[A-Za-z0-9._\-/@+ ~]/.test(ch) ? ch : "?";
    if (out.length >= max) return `${out}…`;
  }
  return out;
}

/* --------------------------------- env names ----------------------------- */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const isEnvName = (s: string): boolean => ENV_NAME.test(s);

/** Prefixes frameworks bake into the client bundle: public by design. */
const CLIENT_PUBLIC = /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_)/;

const STRONG_SECRET =
  /(?:^|_)(?:SECRET|PASSWORD|PASSWD|PWD|TOKEN|DSN|CREDENTIALS?|SALT|SIGNING|PRIVATE|AUTH)(?:_|$)|API_?KEY|ACCESS_?KEY|SECRET_?KEY|PRIVATE_?KEY|_PW$/i;
const KEY_SUFFIX = /(?:^|_)KEY$/i;
const CONNECTION_URL = /^(?:DATABASE|DB|POSTGRES(?:QL)?|PG|MYSQL|MONGO(?:DB)?|REDIS|AMQP|RABBITMQ|BROKER|CELERY_BROKER|CELERY_RESULT_BACKEND|CACHE|QUEUE|SENTRY)(?:_[A-Z0-9]+)*_(?:URL|URI)$/i;

/**
 * Likely-secret by NAME. Errs toward secret: treating a config value as a
 * secret costs one vault entry; treating a secret as config puts it in a
 * manifest. Client-public prefixes (`NEXT_PUBLIC_…`) are config unless they
 * also carry a strong secret word.
 */
export function isSecretName(name: string): boolean {
  if (STRONG_SECRET.test(name)) return true;
  if (CONNECTION_URL.test(name)) return true;
  if (KEY_SUFFIX.test(name)) return !CLIENT_PUBLIC.test(name);
  return false;
}

/** Names the platform or runtime sets; never reported as application config. */
export const RUNTIME_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "PWD",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "HOSTNAME",
  "TZ",
  "CI",
]);

/* ------------------------------ value screening -------------------------- */

const SECRET_PREFIXES =
  /^(?:sk_(?:live|test)_|pk_live_|rk_live_|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abprs]-|AKIA|ASIA|AIza|eyJ|-----BEGIN)/;
const USERINFO_URL = /:\/\/[^\s/@:]{1,64}:[^\s/@]{1,128}@/;

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const PLAIN_URL = /^[a-z][a-z0-9+.-]{1,20}:\/\/[^\s]{1,200}$/i;

/**
 * Heuristic: does this string look like a credential rather than configuration?
 * Errs toward "yes": a default that is wrongly refused is listed for the user to
 * supply, a credential that is wrongly carried lands in a manifest.
 */
export function looksLikeSecretValue(v: string): boolean {
  if (SECRET_PREFIXES.test(v)) return true;
  if (USERINFO_URL.test(v)) return true;
  if (v.length >= 20 && /^[A-Za-z0-9+/=_.-]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) return true;
  if (!/\s/.test(v) && !PLAIN_URL.test(v) && !v.startsWith("/")) {
    // mixed case plus digits in one unbroken token reads as a password or key
    if (v.length >= 12 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v)) return true;
    // a long, random-looking token
    if (v.length >= 16 && entropy(v) > 3.7) return true;
  }
  return false;
}

/** A literal default that is safe to carry into a manifest as a plain value. */
export function isPlainDefault(v: string): boolean {
  if (v.length === 0 || v.length > 100) return false;
  if (/[\r\n\u0000]/.test(v)) return false;
  if (/\$\{|\$\(|<%|{{|`/.test(v)) return false;
  return !looksLikeSecretValue(v);
}

/* ---------------------------------- misc --------------------------------- */

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
export const maxConfidence = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);
export const minConfidence = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);
export const confidenceRank = (c: Confidence): number => RANK[c];
export const lowerConfidence = (c: Confidence): Confidence => (c === "high" ? "medium" : "low");

export const dirname = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};
export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const joinPath = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------- TOML (lite) ----------------------------- */

export interface TomlSection {
  name: string;
  lines: Line[];
}

/**
 * Split a TOML-ish file into `[section]` groups. Not a TOML parser: it exists
 * so dependency tables can be read without evaluating anything. Comment and
 * blank lines are dropped.
 */
export function tomlSections(content: string): TomlSection[] {
  const out: TomlSection[] = [{ name: "", lines: [] }];
  for (const line of lines(content)) {
    const t = line.text.trim();
    if (t === "" || t.startsWith("#")) continue;
    const header = /^\[{1,2}\s*([^\]]{1,120}?)\s*\]{1,2}$/.exec(t);
    if (header) {
      out.push({ name: header[1], lines: [] });
      continue;
    }
    out[out.length - 1].lines.push({ n: line.n, text: t });
  }
  return out;
}

/** Quoted strings inside a line (`"a", 'b'`). Bounded, linear. */
export function quotedStrings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"\n]{1,200})"|'([^'\n]{1,200})'/g)) out.push(m[1] ?? m[2]);
  return out;
}

/* ------------------------------ command ports ----------------------------- */

const PORT_FLAG = /(?:--port[ =]|(?:^|\s)-p[ =]?|\bPORT=|\b0\.0\.0\.0:|--bind[ =]\S{0,40}:)(\d{2,5})\b/;

/** A port a launch command names (`--port 8080`, `-p 3000`, `PORT=80`, `0.0.0.0:8000`). Text only; nothing runs. */
export function portFromCommand(command: string): number | undefined {
  const m = PORT_FLAG.exec(command);
  const port = m ? Number(m[1]) : undefined;
  return port !== undefined && port >= 1 && port <= 65535 ? port : undefined;
}
