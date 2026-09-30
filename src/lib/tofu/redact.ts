/**
 * Output redaction for everything the tofu engine returns.
 *
 * NOTE: a local minimal redactor. `src/lib/credentials/redact.ts`
 * (`redactCredentials`) does not exist on this branch yet; once it lands, the
 * pattern half of `redactOutput` should delegate to it and this file should
 * keep only `redactExact`/`secretValuesOf`. The integration point is
 * `redactOutput` — nothing else in `src/lib/tofu` matches patterns itself.
 *
 * Two layers, both applied to anything that leaves the runner:
 *   1. exact values — every secret the runner itself put in the child
 *      environment (`AWS_SECRET_ACCESS_KEY`, session tokens, …) is removed
 *      wherever it appears, including inside longer strings;
 *   2. patterns — key ids, bearer/JWT tokens, PEM private keys, URL userinfo
 *      and `secret = value` style assignments, for secrets tofu learned some
 *      other way (state, data sources, provider errors).
 *
 * This is best-effort defence in depth, not a guarantee: a secret in an
 * arbitrary shape that is neither in the environment nor matches a pattern is
 * not caught. The primary control is that plan values are masked from
 * `before_sensitive`/`after_sensitive`, not from text scanning.
 */

export const REDACTED = "[REDACTED]";

const NAME_HINT = "secret|passw(?:or)?d|passwd|pwd|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth(?:orization)?|signature|session[_-]?token|security[_-]?token";

const PATTERNS: { re: RegExp; replace: string | ((m: string, ...g: string[]) => string) }[] = [
  // PEM blocks first (multi-line, would otherwise be split by line-based rules)
  { re: /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/g, replace: "[REDACTED:pem]" },
  // AWS access key ids (long-lived and temporary)
  { re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, replace: "[REDACTED:aws-key-id]" },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, replace: "[REDACTED:jwt]" },
  // Authorization-style bearer/basic values
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_m, scheme) => `${scheme} ${REDACTED}` },
  // provider/vendor token shapes
  { re: /\bya29\.[A-Za-z0-9_-]{20,}/g, replace: "[REDACTED:google-token]" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: "[REDACTED:github-token]" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: "[REDACTED:slack-token]" },
  // URL userinfo: scheme://user:password@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, replace: (_m, a, b) => `${a}${REDACTED}${b}` },
  // name = value / name: value / "name": "value" where the name looks secret-ish
  {
    re: new RegExp(`((?:[A-Za-z0-9_.-]*(?:${NAME_HINT})[A-Za-z0-9_.-]*)["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;}\\]"']+)`, "gi"),
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
];

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove every occurrence of each exact secret value (≥ 6 chars). */
export function redactExact(text: string, secrets: readonly string[]): string {
  let out = text;
  // longest first so a secret that contains another is removed whole
  const usable = [...new Set(secrets.filter((s) => s.length >= 6))].sort((a, b) => b.length - a.length);
  for (const s of usable) out = out.replace(new RegExp(escapeRegExp(s), "g"), REDACTED);
  return out;
}

/**
 * Values of environment entries that look like secrets, for exact redaction of
 * the child's own credentials. Non-secret entries (region, flags) are not
 * redacted so logs stay readable.
 */
export function secretValuesOf(env: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (new RegExp(NAME_HINT, "i").test(k) || /(?:^|_)KEY(?:$|_)/i.test(k)) out.push(v);
  }
  return out;
}

export function redactOutput(text: string, secrets: readonly string[] = []): string {
  let out = redactExact(text, secrets);
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace as never);
  }
  return out;
}
