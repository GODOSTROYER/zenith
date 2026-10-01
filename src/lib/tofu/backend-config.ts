/**
 * Non-secret state locations, validated before serialization. Authentication
 * comes exclusively from the runner's scoped environment. OCI compatibility
 * flags are backend-only and the endpoint is confined to Oracle's S3 service.
 * These blocks are contract evidence; live cloud IAM/locking is unverified.
 */
import type { TofuWorkspace } from "@/lib/tofu/types";
import { stableJson } from "@/lib/tofu/stable";
import { TofuWorkspaceError } from "@/lib/tofu/workspace-error";

export type BackendConfig =
  | { kind: "local"; path?: string }
  | {
      kind: "s3";
      bucket: string;
      region?: string;
      /** Client-side state AND plan encryption through OpenTofu aws_kms. */
      encryptionKmsKeyArn?: string;
      /** Server-side state encryption only. */
      sseKmsKeyId?: string;
      /** OCI S3-compatible endpoint; arbitrary endpoints are refused. */
      endpoint?: string;
      usePathStyle?: boolean;
      skipRegionValidation?: boolean;
      skipCredentialsValidation?: boolean;
      skipRequestingAccountId?: boolean;
      skipS3Checksum?: boolean;
      skipMetadataApiCheck?: boolean;
    }
  | {
      kind: "gcs";
      bucket: string;
      /** State is stored at <prefix>/default.tfstate; fallback is stateKey. */
      prefix?: string;
      /** Server-side Cloud KMS encryption; no raw encryption key. */
      kmsEncryptionKey?: string;
    }
  | {
      kind: "azurerm";
      storageAccountName: string;
      containerName: string;
      /** When omitted, OpenTofu reads ARM_USE_OIDC from the session. */
      useOidc?: boolean;
    }
  | { kind: "http"; address: string; lockAddress?: string; unlockAddress?: string };

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{3,40}$/;
const STATE_KEY = /^[A-Za-z0-9!_.*'()/=+@:-]+$/;
const ARN = /^arn:[a-z-]+:kms:[a-z0-9-]+:\d{12}:(?:key|alias)\/[A-Za-z0-9/_-]+$/;
const KEY_ID = /^(?:[0-9a-f-]{36}|mrk-[0-9a-f]{32}|alias\/[A-Za-z0-9/_-]+|arn:[a-z-]+:kms:[a-z0-9-]+:\d{12}:(?:key|alias)\/[A-Za-z0-9/_-]+)$/;
const GCP_KMS = /^projects\/(?:[a-z][a-z0-9-]{4,61}[a-z0-9]|\d{1,20})\/locations\/[a-z0-9-]{2,40}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}$/;
const STORAGE_ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const OCI_ENDPOINT = /^https:\/\/([a-z0-9]{1,63})\.compat\.objectstorage\.([a-z0-9-]{3,40})\.oraclecloud\.com\/?$/;
const FLAGS = {
  usePathStyle: "use_path_style",
  skipRegionValidation: "skip_region_validation",
  skipCredentialsValidation: "skip_credentials_validation",
  skipRequestingAccountId: "skip_requesting_account_id",
  skipS3Checksum: "skip_s3_checksum",
  skipMetadataApiCheck: "skip_metadata_api_check",
} as const;
const FIELDS: Record<BackendConfig["kind"], readonly string[]> = {
  local: ["kind", "path"],
  http: ["kind", "address", "lockAddress", "unlockAddress"],
  s3: ["kind", "bucket", "region", "encryptionKmsKeyArn", "sseKmsKeyId", "endpoint", ...Object.keys(FLAGS)],
  gcs: ["kind", "bucket", "prefix", "kmsEncryptionKey"],
  azurerm: ["kind", "storageAccountName", "containerName", "useOidc"],
};

function invalid(message: string): never {
  throw new TofuWorkspaceError("invalid_input", message);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

export function assertStateKey(key: unknown): asserts key is string {
  if (!matches(key, STATE_KEY) || key.length > 1024 || key.includes("..") || key.startsWith("/") || key.endsWith("/") || key.includes("//")) {
    invalid("The backend needs a stateKey/prefix of safe characters, without traversal or empty path segments.");
  }
}

function bucketName(value: unknown): void {
  if (!matches(value, BUCKET) || value.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(value)) invalid("Invalid state bucket name.");
}

function httpsAddress(value: unknown): void {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) invalid("http backend address must be an https URL.");
  let url: URL;
  try { url = new URL(value); } catch { return invalid("http backend address is not a URL."); }
  if (url.username || url.password || url.search || url.hash) invalid("http backend URLs must not embed credentials, queries or fragments; use the runner environment.");
  if (url.protocol !== "https:") invalid("http backend address must be https.");
}

export function backendFile(backend: BackendConfig, region: string, stateKey: string | undefined): { file: Record<string, unknown>; kind: TofuWorkspace["backend"] } {
  if (backend === null || typeof backend !== "object" || !Object.hasOwn(FIELDS, backend.kind)) invalid("Unsupported state backend.");
  if (Object.keys(backend).some((key) => !FIELDS[backend.kind].includes(key))) {
    throw new TofuWorkspaceError("forbidden_construct", "Backend argument is outside the non-secret allowlist.");
  }
  if (backend.kind === "local") {
    if (backend.path !== undefined && (typeof backend.path !== "string" || backend.path.length > 4096 || /[\u0000-\u001f\u007f]/.test(backend.path))) invalid("Invalid local state path.");
    return { file: { terraform: { backend: { local: { path: backend.path ?? "terraform.tfstate" } } } }, kind: "local" };
  }
  if (backend.kind === "http") {
    httpsAddress(backend.address);
    const block: Record<string, unknown> = { address: backend.address };
    if (backend.lockAddress !== undefined) { httpsAddress(backend.lockAddress); block.lock_address = backend.lockAddress; }
    if (backend.unlockAddress !== undefined) { httpsAddress(backend.unlockAddress); block.unlock_address = backend.unlockAddress; }
    return { file: { terraform: { backend: { http: block } } }, kind: "http" };
  }
  if (backend.kind === "gcs") {
    bucketName(backend.bucket);
    const prefix = backend.prefix === undefined ? stateKey : backend.prefix;
    assertStateKey(prefix);
    const gcs: Record<string, unknown> = { bucket: backend.bucket, prefix };
    if (backend.kmsEncryptionKey !== undefined) {
      if (!matches(backend.kmsEncryptionKey, GCP_KMS)) invalid("Invalid GCS Cloud KMS key resource name.");
      gcs.kms_encryption_key = backend.kmsEncryptionKey;
    }
    return { file: { terraform: { backend: { gcs } } }, kind: "gcs" };
  }
  assertStateKey(stateKey);
  if (backend.kind === "azurerm") {
    if (!matches(backend.storageAccountName, STORAGE_ACCOUNT)) invalid("Invalid Azure state storage account name.");
    if (!matches(backend.containerName, CONTAINER) || backend.containerName.includes("--")) invalid("Invalid Azure state container name.");
    if (backend.useOidc !== undefined && backend.useOidc !== true) invalid("Azure state authentication must use session OIDC.");
    return {
      kind: "azurerm",
      file: { terraform: { backend: { azurerm: {
        storage_account_name: backend.storageAccountName, container_name: backend.containerName,
        key: stateKey, use_azuread_auth: true, use_cli: false,
        ...(backend.useOidc === undefined ? {} : { use_oidc: true }),
      } } } },
    };
  }
  bucketName(backend.bucket);
  const bucketRegion = backend.region === undefined ? region : backend.region;
  if (!matches(bucketRegion, REGION)) invalid("Invalid backend region.");
  const s3: Record<string, unknown> = { bucket: backend.bucket, key: stateKey, region: bucketRegion, encrypt: true, use_lockfile: true };
  if (backend.endpoint !== undefined) {
    if (typeof backend.endpoint !== "string") invalid("Invalid OCI S3 backend endpoint.");
    const match = OCI_ENDPOINT.exec(backend.endpoint);
    if (!match || match[2] !== bucketRegion) invalid("OCI S3 backend endpoint must match its Oracle region.");
    if (backend.encryptionKmsKeyArn !== undefined || backend.sseKmsKeyId !== undefined) invalid("AWS KMS is unavailable for the OCI state backend.");
    s3.endpoints = { s3: backend.endpoint };
    // OCI uses bucket encryption; an AWS SSE header is not required.
    s3.encrypt = false;
  }
  for (const [field, attribute] of Object.entries(FLAGS)) {
    const v = backend[field as keyof typeof FLAGS];
    if (v === undefined) continue;
    if (typeof v !== "boolean" || backend.endpoint === undefined) invalid("S3 compatibility flags require an OCI endpoint and boolean values.");
    s3[attribute] = v;
  }
  if (backend.sseKmsKeyId !== undefined) {
    if (!matches(backend.sseKmsKeyId, KEY_ID)) invalid("sseKmsKeyId is not a KMS key id, alias or ARN.");
    s3.kms_key_id = backend.sseKmsKeyId;
  }
  const terraform: Record<string, unknown> = { backend: { s3 } };
  if (backend.encryptionKmsKeyArn !== undefined) {
    if (!matches(backend.encryptionKmsKeyArn, ARN)) invalid("encryptionKmsKeyArn is not a KMS key or alias ARN.");
    terraform.encryption = {
      key_provider: { aws_kms: { zenith: { kms_key_id: backend.encryptionKmsKeyArn, region: bucketRegion, key_spec: "AES_256" } } },
      method: { aes_gcm: { zenith: { keys: "key_provider.aws_kms.zenith" } } },
      state: { method: "method.aes_gcm.zenith", enforced: true },
      plan: { method: "method.aes_gcm.zenith", enforced: true },
    };
  }
  return { file: { terraform }, kind: "s3" };
}

/** Recheck backend arguments on serialized, matching-digest workspaces too. */
export function assertBackendBlock(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("State backend block must be an object.");
  const entries = Object.entries(value);
  if (entries.length !== 1 || !Object.hasOwn(FIELDS, entries[0][0])) invalid("State backend block must select one supported kind.");
  const [kind, raw] = entries[0];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid("State backend arguments must be an object.");
  const block = raw as Record<string, unknown>;
  const names: Record<string, string> = {
    path: "path", address: "address", lock_address: "lockAddress", unlock_address: "unlockAddress",
    bucket: "bucket", prefix: "prefix", kms_encryption_key: "kmsEncryptionKey", region: "region",
    kms_key_id: "sseKmsKeyId", storage_account_name: "storageAccountName", container_name: "containerName", use_oidc: "useOidc",
    ...Object.fromEntries(Object.entries(FLAGS).map(([field, attribute]) => [attribute, field])),
  };
  const config: Record<string, unknown> = { kind };
  for (const [key, v] of Object.entries(block)) {
    if (Object.hasOwn(names, key)) config[names[key]] = v;
    else if (!["key", "endpoints", "encrypt", "use_lockfile", "use_azuread_auth", "use_cli"].includes(key)) {
      throw new TofuWorkspaceError("forbidden_construct", "Serialized backend argument is outside the non-secret allowlist.");
    }
  }
  if (block.endpoints !== undefined) {
    const endpoints = block.endpoints;
    if (endpoints === null || typeof endpoints !== "object" || Array.isArray(endpoints) || Object.keys(endpoints).length !== 1 || !Object.hasOwn(endpoints, "s3")) invalid("Invalid serialized S3 endpoint block.");
    config.endpoint = (endpoints as Record<string, unknown>).s3;
  }
  const assembled = backendFile(config as BackendConfig, "ap-south-1", block.key as string | undefined).file;
  const expected = (assembled.terraform as Record<string, unknown>).backend;
  // Generated security defaults (Entra only, no CLI fallback, native locking)
  // must survive serialization; reject hidden or missing attributes.
  if (stableJson(expected) !== stableJson(value)) invalid("Serialized backend differs from the validated state contract.");
}
