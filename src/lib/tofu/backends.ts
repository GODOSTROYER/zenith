/**
 * Customer state locations derived from non-secret connection identifiers.
 * Tenant/path checks happen before assembly; no credentials enter this module.
 * GCS stateKey names the actual default-workspace object, not just its prefix.
 * OCI requires a customer-runner S3 secret key; native principals cannot
 * authenticate its S3 backend. No live cloud backend has been verified here.
 */
import type { ProviderConnection } from "@/lib/credentials/types";
import { backendFile, type BackendConfig } from "@/lib/tofu/backend-config";
import { TofuWorkspaceError } from "@/lib/tofu/workspace-error";

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OCI_NAMESPACE = /^[a-z0-9]{1,63}$/;
const REGION = /^[a-z0-9-]{3,40}$/;

function refuse(message: string): never {
  throw new TofuWorkspaceError("invalid_input", message);
}

export function backendForConnection(
  connection: ProviderConnection,
  scope: { workspaceId: string; environmentId: string },
): { backend: BackendConfig; stateKey: string } {
  if (typeof scope.workspaceId !== "string" || typeof scope.environmentId !== "string" || !SCOPE_ID.test(scope.workspaceId) || !SCOPE_ID.test(scope.environmentId)) refuse("State scope identifiers must be safe, bounded path segments.");
  if (connection.workspaceId !== scope.workspaceId) refuse("State connection does not belong to this workspace.");
  const config = connection.config;
  if (config.provider === "kubernetes") refuse("Kubernetes connections need an explicit durable OpenTofu state backend override.");
  if (typeof config.region !== "string" || !REGION.test(config.region)) refuse("Invalid state connection region.");
  const prefix = `zenith/${scope.workspaceId}/${scope.environmentId}`;
  let stateKey = `${prefix}/terraform.tfstate`;
  let backend: BackendConfig;
  switch (config.provider) {
    case "aws":
      if (!config.stateBucket) refuse("The AWS connection has no state bucket; record the customer bootstrap output on the connection.");
      backend = {
        kind: "s3", bucket: config.stateBucket, region: config.region,
        ...(config.stateKmsKeyArn === undefined ? {} : { encryptionKmsKeyArn: config.stateKmsKeyArn }),
      };
      break;
    case "gcp":
      if (!config.stateBucket) refuse("The GCP connection has no state bucket; record the customer bootstrap output on the connection.");
      backend = { kind: "gcs", bucket: config.stateBucket, prefix, ...(config.stateKmsKey === undefined ? {} : { kmsEncryptionKey: config.stateKmsKey }) };
      stateKey = `${prefix}/default.tfstate`;
      break;
    case "azure":
      if (!config.stateStorageAccount || !config.stateContainer) refuse("The Azure connection needs stateStorageAccount and stateContainer from the customer bootstrap.");
      backend = {
        kind: "azurerm", storageAccountName: config.stateStorageAccount, containerName: config.stateContainer,
        ...(config.mode === "oidc_web_identity" ? { useOidc: true } : {}),
      };
      break;
    case "oci":
      if (!config.stateBucket || !config.stateNamespace) refuse("The OCI connection needs stateBucket and stateNamespace from the customer bootstrap; S3 credentials stay on its runner.");
      if (typeof config.stateNamespace !== "string" || !OCI_NAMESPACE.test(config.stateNamespace)) refuse("Invalid OCI state namespace.");
      backend = {
        kind: "s3", bucket: config.stateBucket, region: config.region,
        endpoint: `https://${config.stateNamespace}.compat.objectstorage.${config.region}.oraclecloud.com`,
        usePathStyle: true, skipRegionValidation: true, skipCredentialsValidation: true,
        skipRequestingAccountId: true, skipS3Checksum: true, skipMetadataApiCheck: true,
      };
      break;
    default:
      return refuse("No state backend is supported for this connection provider.");
  }
  // A connection resolver is not a validation boundary: check the same strict
  // fields the assembler checks, even when this helper is called on its own.
  backendFile(backend, config.region, stateKey);
  return { backend, stateKey };
}
