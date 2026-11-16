/**
 * Public surface of the GCP provider package (WS-GCP).
 *
 *   createGcpSession        Zenith OIDC → STS → service-account impersonation
 *   gcpDrivers / registerGcpDrivers   the resource drivers
 *   syncSecretValue         write a secret VALUE into Secret Manager (container is tofu's)
 *   startBuild / getBuild   ADR-0016 source builds in the customer project
 *   createGcpObservabilitySource   Cloud Logging + Monitoring queries (ObservabilitySource)
 *
 * Evidence for everything here is `contract`: no GCP account was available,
 * so nothing has run against Google.
 */
export { createGcpSession, assertGoogleApisUrl, subjectAudience, stsAudience, MAX_SESSION_LIFETIME_SEC, type CreateGcpSessionInput } from "./credentials";
export { GcpAuthError, GcpCompileError, GcpSessionError, scrub } from "./errors";
export { gcpDrivers, registerGcpDrivers } from "./drivers";
export { syncSecretValue, crc32c, type SyncSecretInput, type SyncSecretResult } from "./drivers/data/secret-manager-secret";
export { getBuild, startBuild, validateBuildInput, type BuildResult, type BuildStatus, type StartBuildInput } from "./drivers/build/build-api";
export { createGcpObservabilitySource, METRIC_TABLE, filterLiteral, type GcpObservabilityOptions, type GcpResourceRef } from "./observability";
export { gcpLabels, networkTag } from "./naming";
export type { GcpSessionHandle, GcpDriverContext } from "./types";
