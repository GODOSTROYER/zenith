/**
 * Error types for the credential module.
 *
 * Invariant: no message or property here ever contains key material, a token
 * or a signed value. Configuration errors name the VARIABLE and the problem
 * ("ZENITH_OIDC_SIGNING_JWK: not a private RSA JWK"), never the value — JSON
 * parser messages are deliberately not forwarded because they quote input.
 */

/** A `ZENITH_*` signing/issuer variable is missing, malformed or contradictory. */
export class CredentialConfigError extends Error {
  readonly code = "credential_config_invalid";
  constructor(
    readonly variable: string,
    problem: string
  ) {
    super(`${variable}: ${problem}`);
    this.name = "CredentialConfigError";
  }
}

/** A session (or a client built from it) was used after its callback settled or its credentials expired. */
export class SessionExpiredError extends Error {
  readonly code = "session_expired";
  constructor(message = "The credential session has ended; request a new one through the credential broker.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** `runner` mode without an injected transport (the runner workstream provides it). */
export class RunnerTransportUnavailableError extends Error {
  readonly code = "runner_transport_unavailable";
  constructor(
    message = "The runner AWS transport is not available in this process; runner-mode connections cannot build SDK clients here."
  ) {
    super(message);
    this.name = "RunnerTransportUnavailableError";
  }
}

export type GrantErrorCode =
  | "grant_malformed"
  | "grant_bad_header"
  | "grant_unknown_key"
  | "grant_bad_signature"
  | "grant_bad_claims"
  | "grant_expired"
  | "grant_not_yet_valid"
  | "grant_lifetime_invalid"
  | "grant_wrong_audience"
  | "grant_wrong_capability"
  | "grant_wrong_operation"
  | "grant_revoked"
  | "grant_no_keys";

/** A capability grant failed verification. `code` is stable; the message never echoes the token. */
export class GrantVerificationError extends Error {
  constructor(
    readonly code: GrantErrorCode,
    message: string
  ) {
    super(message);
    this.name = "GrantVerificationError";
  }
}

export type OidcErrorCode =
  | "oidc_issuer_unconfigured"
  | "oidc_signer_unconfigured"
  | "oidc_input_invalid"
  | "oidc_ttl_invalid"
  | "oidc_signer_algorithm";

export class OidcError extends Error {
  constructor(
    readonly code: OidcErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OidcError";
  }
}

export class SigningError extends Error {
  readonly code = "signing_failed";
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}
