/**
 * Text that came from outside Zenith (a thrown provider error, a driver's
 * `error` string) is scrubbed before it is persisted or echoed.
 *
 * This is a tripwire, not a guarantee: it recognises the common shapes of a
 * credential (AWS key ids, JWTs, bearer tokens, `password=…` pairs, PEM
 * blocks, credentials inside a URL, long opaque blobs) and replaces them. The
 * primary mechanism is structural, not textual: a session is never stored, an
 * event carries no attribute VALUES, and nothing here builds a command from
 * the text. Redaction is defense in depth (ARCHITECTURE invariant 3).
 */

const REPLACEMENTS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted-private-key]"],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, "[redacted-key-id]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@"],
  [
    /(["']?[A-Za-z_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)[A-Za-z_-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    "$1[redacted]",
  ],
  [/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g, "[redacted-blob]"],
];

/** Scrub credential-shaped substrings, collapse whitespace/control characters and bound the length. */
export function redactText(text: string, maxChars = 240): string {
  let out = text;
  for (const [re, to] of REPLACEMENTS) out = out.replace(re, to);
  out = out.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

const asText = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** `Code: scrubbed message`. Never the stack, never a nested cause, never request bodies. */
export function describeError(err: unknown): string {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err === "string") return redactText(err);
  if (typeof err !== "object") return redactText(String(err));
  const e = err as ErrorLike;
  const label = asText(e.code) ?? asText(e.name) ?? "Error";
  const message = asText(e.message);
  return message ? `${redactText(label, 60)}: ${redactText(message)}` : redactText(label, 60);
}

const DENIED_NAMES =
  /^(?:AccessDenied(?:Exception)?|UnauthorizedOperation|UnauthorizedAccess|Unauthorized|Forbidden|AuthFailure|InvalidClientTokenId|UnrecognizedClientException|ExpiredToken(?:Exception)?|InvalidToken|credential_denied|permission_denied|PERMISSION_DENIED|UNAUTHENTICATED|AuthorizationFailed|InvalidAuthenticationToken)$/i;
const DENIED_MESSAGE = /\b(?:access ?denied|not authori[sz]ed|unauthori[sz]ed|forbidden|permission denied|expired token|invalid (?:client )?token)\b/i;

/**
 * Could the thing not be read because Zenith is not ALLOWED to (`inaccessible`),
 * or for any other reason (`unknown`)? Name, code and HTTP status decide; the
 * message is consulted only as a last resort and only as a classifier — it is
 * never executed, parsed for instructions or echoed unscrubbed.
 */
export function isAccessDenied(err: unknown): boolean {
  if (err === null || typeof err !== "object") return typeof err === "string" && DENIED_MESSAGE.test(err);
  const e = err as ErrorLike;
  for (const v of [e.code, e.name]) if (typeof v === "string" && DENIED_NAMES.test(v)) return true;
  for (const v of [e.status, e.statusCode, e.$metadata?.httpStatusCode]) if (v === 401 || v === 403) return true;
  return typeof e.message === "string" && DENIED_MESSAGE.test(e.message);
}
