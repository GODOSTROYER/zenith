/**
 * Secret-shape heuristics shared by manifest validation and expansion.
 *
 * The rule the whole platform leans on (ARCHITECTURE invariant 3): a manifest,
 * a graph, a diff, an audit row never holds a secret VALUE, only a reference.
 * Nothing here can prove a string is not secret — these are tripwires that turn
 * the common mistakes into a loud, early, named error, and they are documented
 * as heuristics so nobody mistakes them for a guarantee.
 */

/**
 * Env var keys / config field names that usually hold a credential. Mirrors the
 * importers' `SECRET_KEY_RE` so "looks secret" means one thing across Zenith;
 * kept as its own copy because `resources` (L0) must not import `importers`.
 */
export const SECRET_KEY_PATTERN = /(password|passwd|secret|token|api_?key|access_?key|private_?key|credential|dsn|_pw$)/i;

export const looksSecretKey = (key: string): boolean => SECRET_KEY_PATTERN.test(key);

/**
 * Field-name endings that make a secret-ish key a POINTER rather than a value:
 * `passwordSecretRef`, `secretName`, `tokenArn`, `credentialsPath`…
 */
const POINTER_SUFFIX = /(ref|reference|name|arn|id|path|version|type|enabled|required|rotation|url)$/i;

export const isPointerKey = (key: string): boolean => POINTER_SUFFIX.test(key);

const MAX_DEPTH = 12;

/**
 * Paths inside a native `config` whose key looks like a credential and whose
 * value is an inline string (or number): a value where a `{ secretRef }` should
 * be. Objects and arrays are walked; pointer-shaped keys are exempt.
 */
export function findInlineSecretPaths(value: unknown, base: string[] = [], depth = 0): string[] {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return [];
  const out: string[] = [];
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries) {
    const path = [...base, k];
    if (
      !Array.isArray(value) &&
      looksSecretKey(k) &&
      !isPointerKey(k) &&
      (typeof v === "string" || typeof v === "number") &&
      String(v).length > 0
    )
      out.push(path.join("."));
    else out.push(...findInlineSecretPaths(v, path, depth + 1));
  }
  return out.sort();
}

/** Replace a value the caller must not echo; used when a finding names an attribute. */
export const REDACTED = "[redacted]";

/**
 * Credentials embedded in a URL: `https://user:pass@host`, `https://token@host`,
 * `postgres://user:pass@host`. A bare `git@host` / `ssh://git@host` login is a
 * username, not a secret, and is left alone.
 */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@\s]*@)(.*)$/i;

export function urlHasCredentials(value: string): boolean {
  const m = URL_USERINFO.exec(value);
  if (!m) return false;
  return /^https?:\/\//i.test(m[1]) || m[2].includes(":");
}

/** The URL without its userinfo, and whether anything was removed. */
export function stripUrlCredentials(value: string): { value: string; stripped: boolean } {
  const m = URL_USERINFO.exec(value);
  return m && urlHasCredentials(value) ? { value: `${m[1]}${m[3]}`, stripped: true } : { value, stripped: false };
}
