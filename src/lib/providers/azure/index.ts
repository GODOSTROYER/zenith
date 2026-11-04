/**
 * Azure provider public surface.
 *
 *   credentials    `createAzureSession` — federated (keyless) sessions
 *   drivers        `AZURE_DRIVERS`, `registerAzureDrivers()`
 *   helpers        `syncSecretValue` (Key Vault), `runAcrBuild` (ACR Tasks),
 *                  `bindManagedCertificate`, `assertUniqueRulePriorities`
 *   observability  Log Analytics and Azure Monitor sources for the fabric
 *
 * See the module docs of each file for invariants and honest limits; nothing
 * here has been run against a live Azure subscription.
 */
export { createAzureSession, FEDERATION_AUDIENCE, AzureTokenError, AzureRequestRefusedError, audienceForHost, checkAuthorizedUrl, type AzureSessionHandle, type CreateAzureSessionOptions } from "@/lib/providers/azure/credentials";
export { AZURE_DRIVERS, registerAzureDrivers } from "@/lib/providers/azure/drivers";
export { syncSecretValue, SecretSyncError, type SyncSecretInput, type SyncSecretResult } from "@/lib/providers/azure/secrets";
export { runAcrBuild, AcrBuildError, type AcrBuildInput, type AcrBuildResult } from "@/lib/providers/azure/acr-build";
export { bindManagedCertificate, type BindCertificateInput, type BindCertificateResult } from "@/lib/providers/azure/certificates";
export { assertUniqueRulePriorities } from "@/lib/providers/azure/drivers/network/firewall";
export { AzureCompileError } from "@/lib/providers/azure/compile-util";
export { createAzureLogsSource, createAzureMetricsSource, AZURE_METRIC_TABLE, type AzureObservabilityConfig } from "@/lib/providers/azure/observability";
