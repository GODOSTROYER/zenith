/**
 * Errors and scrubbing shared by the GCP provider package.
 *
 * Invariant: no error message produced here can contain a credential. Every
 * message built from a remote response or from caller input passes through
 * `scrub()`, which removes (a) exact secret strings the caller hands it (the
 * subject JWT, STS token, access token) and (b) anything shaped like a Google
 * access token, JWT, bearer header or PEM block. Scrubbing is defense in
 * depth: the primary control is that credentials are never interpolated into
 * messages in the first place.
 */

const EXACT_MIN = 6;

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/g, "[REDACTED:pem]"],
  [/\bya29\.[A-Za-z0-9_-]{10,}/g, "[REDACTED:google-token]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED:jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(access_token|accessToken|subject_?token|subjectToken|id_token|refresh_token|client_secret|private_key)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, "$1$2[REDACTED]"],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove exact secret values and known credential shapes; bound the length. */
export function scrub(text: string, exact: readonly string[] = [], max = 400): string {
  let out = String(text);
  for (const s of [...new Set(exact.filter((x) => typeof x === "string" && x.length >= EXACT_MIN))].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRegExp(s), "g"), "[REDACTED]");
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export type GcpAuthErrorCode =
  | "invalid_connection"
  | "unsupported_mode"
  | "subject_token_unavailable"
  | "sts_exchange_failed"
  | "sts_unavailable"
  | "impersonation_failed"
  | "impersonation_unavailable"
  | "malformed_response";

/** Failure while turning a Zenith OIDC token into a Google access token. */
export class GcpAuthError extends Error {
  readonly code: GcpAuthErrorCode;
  readonly status?: number;
  constructor(code: GcpAuthErrorCode, message: string, status?: number) {
    super(message);
    this.name = "GcpAuthError";
    this.code = code;
    this.status = status;
  }
}

export type GcpSessionErrorCode = "session_closed" | "session_expired" | "host_not_allowed" | "redirect_refused" | "invalid_request";

/** Misuse of a live session: expired, closed, or a request to a non-Google host. */
export class GcpSessionError extends Error {
  readonly code: GcpSessionErrorCode;
  constructor(code: GcpSessionErrorCode, message: string) {
    super(message);
    this.name = "GcpSessionError";
    this.code = code;
  }
}

/** A manifest/spec the GCP drivers cannot realize safely. Thrown by compile(), loudly. */
export class GcpCompileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GcpCompileError";
    this.code = code;
  }
}
