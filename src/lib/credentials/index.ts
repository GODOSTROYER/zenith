/**
 * Credential broker module (ADR-0006). Public surface:
 *
 *  - contracts:        `./types` (CredentialBroker, AwsSession, ProviderConnection, …)
 *  - AWS broker:       `AwsCredentialBroker` — `withSession` / `verifyConnection`
 *  - OIDC issuer:      `mintWorkloadToken`, `workloadSubject`, `discoveryDocument`
 *  - grants:           `signCapabilityGrant`, `verifyCapabilityGrant`
 *  - signers/keys:     `getOidcSigner`, `getControlSigner`, `generateSigningJwk`
 *  - redaction:        `redactCredentials`, `assertNoCredentialLeak`
 *
 * Environment is read in one place: `loadCredentialsConfig` (./config).
 */
export * from "./types";
export * from "./errors";
export { loadCredentialsConfig, resolveIssuer, normalizeIssuer, type CredentialsConfig } from "./config";
export { SecretString } from "./secret";
export * from "./signing";
export {
  AWS_STS_AUDIENCE,
  MAX_WORKLOAD_TOKEN_TTL_SEC,
  discoveryDocument,
  jwksDocument,
  mintWorkloadToken,
  workloadSubject,
  type WorkloadTokenInput,
} from "./oidc/issuer";
export { discoveryResponse, jwksResponse } from "./oidc/http";
export {
  GRANT_TYP,
  MAX_GRANT_LIFETIME_SEC,
  signCapabilityGrant,
  verifyCapabilityGrant,
  type VerifyGrantOptions,
} from "./grants";
export * from "./aws";
export { CredentialLeakError, assertNoCredentialLeak, credentialPatternsIn, redactCredentials, redactDeep } from "./redact";
