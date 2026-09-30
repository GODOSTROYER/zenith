/**
 * Defence in depth against secret material entering (or leaving) the broker.
 *
 * The rule (ARCHITECTURE invariant 3) is that a value never gets here: callers
 * pass references (`vault:…`, ARNs, secret names). This module is the last line,
 * not the mechanism, and it is deliberately conservative in two ways:
 *
 *  - `findSecret` — refuses a proposal whose free-form `input`/`constraints`
 *    carry a literal secret *shape* (PEM key, JWT, AWS access key id, bearer
 *    credential, `scheme://user:password@host`, well-known token prefixes) or a
 *    member with a strongly secret-looking NAME holding a non-reference string.
 *  - `scrubSecrets` — for values the broker did not author but must echo
 *    (an executor's `result`/`error`): replaces secret shapes with `[redacted]`
 *    so a leaky executor cannot make the ledger, an event or a response carry
 *    one. It never throws.
 *
 * Neither proves absence: a high-entropy string with no recognisable shape
 * passes. Findings name the PATH of the offending member, never its value, and
 * the path itself is sanitised (it is client-controlled text).
 */

const MAX_DEPTH = 16;
const MAX_NODES = 20_000;
const MAX_STRING_SCAN = 200_000;

interface ValuePattern {
  what: string;
  re: RegExp;
}

const VALUE_PATTERNS: readonly ValuePattern[] = [
  { what: "a PEM private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { what: "a JWT-shaped credential", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { what: "an AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { what: "a bearer credential", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { what: "a URL with an embedded password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@[^\s/]+/i },
  { what: "a GitHub token", re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}\b/ },
  { what: "a GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { what: "a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { what: "a payment provider secret key", re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { what: "a model provider API key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { what: "a Zenith agent credential", re: /\bza_[A-Za-z0-9_-]{43}\b/ },
];

const GLOBAL_PATTERNS = VALUE_PATTERNS.map((p) => new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`));

/**
 * Member names that are secrets by name. Exact (after lower-casing and dropping
 * punctuation), not substring: `tokenCount` and `maxTokens` are not secrets.
 */
const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "passphrase",
  "privatekey",
  "secretkey",
  "secretaccesskey",
  "sessiontoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "accesskey",
  "clientsecret",
  "authorization",
  "bearer",
  "secret",
  "secretvalue",
  "token",
]);

const REFERENCE_PREFIXES = ["vault:", "arn:", "secretsmanager:", "ssm:", "ref:"];

function isReferenceValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.length === 0 || REFERENCE_PREFIXES.some((prefix) => v.startsWith(prefix));
}

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A path safe to put in an error: only characters that cannot smuggle text. */
function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9_.[\]-]/g, "?").slice(0, 200) || "<root>";
}

export interface SecretFinding {
  path: string;
  what: string;
}

/** First secret-shaped value or secret-named member in `value`, or undefined. Pure; never throws. */
export function findSecret(value: unknown, root = ""): SecretFinding | undefined {
  const state = { nodes: 0 };
  const walk = (node: unknown, path: string, depth: number): SecretFinding | undefined => {
    if (++state.nodes > MAX_NODES || depth > MAX_DEPTH) return { path: safePath(path), what: "a value that is too large or deeply nested to inspect" };
    if (typeof node === "string") {
      const text = node.length > MAX_STRING_SCAN ? node.slice(0, MAX_STRING_SCAN) : node;
      for (const pattern of VALUE_PATTERNS) if (pattern.re.test(text)) return { path: safePath(path), what: pattern.what };
      return undefined;
    }
    if (node === null || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const found = walk(node[i], `${path}[${i}]`, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof child === "string" && SECRET_KEY_NAMES.has(normalizeKey(key)) && !isReferenceValue(child)) {
        return { path: safePath(childPath), what: "a member named like a secret holding a literal value" };
      }
      const found = walk(child, childPath, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(value, root, 0);
}

export const REDACTED = "[redacted]";

/** A deep copy with every secret-shaped string replaced. Never throws; bounded work. */
export function scrubSecrets<T>(value: T): T {
  const state = { nodes: 0 };
  const walk = (node: unknown, depth: number): unknown => {
    if (++state.nodes > MAX_NODES || depth > MAX_DEPTH) return REDACTED;
    if (typeof node === "string") {
      let text = node.length > MAX_STRING_SCAN ? node.slice(0, MAX_STRING_SCAN) : node;
      for (const re of GLOBAL_PATTERNS) text = text.replace(re, REDACTED);
      return text;
    }
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = typeof child === "string" && SECRET_KEY_NAMES.has(normalizeKey(key)) && !isReferenceValue(child) ? REDACTED : walk(child, depth + 1);
    }
    return out;
  };
  return walk(value, 0) as T;
}
