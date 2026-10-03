/**
 * Pure logical planning data. This module neither grants authority nor makes a
 * mixed graph executable. graph.ts remains the execution gate. Inputs must come
 * from a trusted planner; current broker authorization and artifact custody are
 * separate, required execution boundaries, not assertions this API can prove.
 */
import { digest } from "@/lib/controlplane/digest";
import { isProxy } from "node:util/types";
import { isBootstrapNameSuffix } from "@/lib/aws-bootstrap-input";
import { isExternalId, parseRoleArn } from "@/lib/credentials/aws/arn";
import type { ProviderConnection } from "@/lib/credentials/types";
import { PORTABLE_KINDS, type ResourceGraph, type ResourceNode } from "@/lib/resources/types";
import { isPointerKey, looksSecretKey, urlHasCredentials } from "@/lib/resources/secrets";
import { assertStateKey, backendFile, type BackendConfig } from "@/lib/tofu/backend-config";

export const MIXED_PARTITION_LIMITS = Object.freeze({
  nodes: 256, edges: 1024, bindings: 32, references: 512,
  jsonDepth: 20, jsonValues: 65536, jsonBytes: 1048576, stringBytes: 16384,
});

export type MixedProvider = "aws" | "gcp" | "azure" | "oci";
export type PartitionValueType = "string" | "number" | "boolean" | "resource_id" | "endpoint" | "secret_ref";
export type UnavailableReason = "not_produced" | "partial_failure" | "timeout" | "expired" | "cancelled" | "outage" | "custody_unverified";

/** Explicit planning snapshots, with no caller-approved/verified authority bit. */
export interface PartitionBinding {
  id: string;
  connection: ProviderConnection;
  accountId: string;
  region: string;
  backend: BackendConfig;
  stateKey: string;
}

export interface ReferenceProvenance {
  workspaceId: string;
  environmentId: string;
  connectionId: string;
  provider: MixedProvider;
  accountId: string;
  region: string;
  producerAddress: string;
  producerSpecDigest: string;
  producerSubplanDigest: string;
  producerEffectDigest: string;
  /** Digests refer to independently verified completed-child receipts/artifacts. */
  receiptDigest: string;
  artifactDigest: string;
}

export type ReferenceMaterialization =
  | { state: "unavailable"; reason: UnavailableReason }
  | { state: "available"; valueDigest: string; provenance: ReferenceProvenance;
      secret?: { ref: string; versionDigest: string; workspaceId: string; environmentId: string; consumerConnectionId: string } };

export interface PartitionReference {
  id: string;
  scope: { workspaceId: string; environmentId: string };
  producer: { address: string; output: string; type: PartitionValueType };
  /** A compiler input name, never an instruction to overwrite a spec field. */
  consumer: { address: string; input: string; type: PartitionValueType };
  materialization: ReferenceMaterialization;
}

export interface MixedPartitionInput {
  workspaceId: string;
  graph: ResourceGraph;
  bindings: PartitionBinding[];
  assignments: { address: string; bindingId: string }[];
  /** Complete explicit cross-partition reference inventory for this candidate. */
  references: PartitionReference[];
}

export interface PartitionIdentity {
  bindingId: string;
  workspaceId: string;
  environmentId: string;
  connectionId: string;
  provider: MixedProvider;
  accountId: string;
  region: string;
  connectionIdentityDigest: string;
  backendKind: "s3" | "gcs" | "azurerm";
  backendDigest: string;
  stateLocationDigest: string;
  /** Union of effective state and lock objects; Azure leases its state blob. */
  backendObjectDigests: readonly string[];
}

export interface PartitionNodeIdentity {
  address: string;
  kind: ResourceNode["kind"];
  nativeType: string;
  ownership: ResourceNode["ownership"];
  specDigest: string;
  /** Pins origin, labels, external identity and field ownership without values. */
  sourceNodeDigest: string;
  dependsOn: readonly string[];
}

export interface PlannedPartition {
  id: string;
  identity: Readonly<PartitionIdentity>;
  nodes: readonly Readonly<PartitionNodeIdentity>[];
  dependsOn: readonly string[];
  /** Immutable desired child inputs, excluding subsequently produced values. */
  subplanDigest: string;
  /** Includes exact incoming custody/materialization; a change needs review. */
  effectDigest: string;
  blockedByReferences: readonly string[];
}

export interface PlannedReference {
  id: string;
  producerPartitionId: string;
  consumerPartitionId: string;
  contractDigest: string;
  materializationDigest: string;
  state: ReferenceMaterialization["state"];
  unavailableReason?: UnavailableReason;
}

export interface MixedPartitionPlan {
  version: 1;
  executionEnabled: false;
  workspaceId: string;
  environmentId: string;
  manifestDigest: string;
  graphDigest: string;
  /** Parent desired inputs; stable through output materialization. */
  desiredDigest: string;
  /** Parent candidate including exact child effects and artifact custody. */
  parentDigest: string;
  partitions: readonly Readonly<PlannedPartition>[];
  references: readonly Readonly<PlannedReference>[];
  executionOrder: readonly string[];
  teardownOrder: readonly string[];
}

export type MixedPartitionErrorCode = "bounds" | "invalid_input" | "secret_data" | "binding_mismatch" | "state_overlap" | "graph_integrity" | "dependency_cycle" | "reference_contract" | "provenance_mismatch";
const MESSAGES: Record<MixedPartitionErrorCode, string> = {
  bounds: "Mixed partition planning input exceeds a fixed bound.",
  invalid_input: "Mixed partition planning needs closed, plain JSON contracts.",
  secret_data: "Mixed partition planning refuses inline secret or credential data.",
  binding_mismatch: "A partition binding does not match its workspace, connection, account, provider or region.",
  state_overlap: "Distinct partitions must not overlap state or lock objects.",
  graph_integrity: "Graph identities, addresses or dependencies are inconsistent.",
  dependency_cycle: "The resource or partition dependency graph contains a cycle.",
  reference_contract: "A cross-partition reference lacks a matching typed, scoped dependency contract.",
  provenance_mismatch: "Materialization provenance does not match the immutable producer and consumer scope.",
};
export class MixedPartitionError extends Error {
  constructor(readonly code: MixedPartitionErrorCode) { super(MESSAGES[code]); this.name = "MixedPartitionError"; }
}
function refuse(code: MixedPartitionErrorCode): never { throw new MixedPartitionError(code); }
const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sorted = (items: Iterable<string>): string[] => [...items].sort(cmp);
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9_./:@*+-]{0,255}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_./:[\]-]{0,511}$/;
const REGION = /^[a-z0-9-]{3,40}$/;
const OCI_NAMESPACE = /^[a-z0-9]{1,63}$/;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TYPES: readonly string[] = ["string", "number", "boolean", "resource_id", "endpoint", "secret_ref"];
const REASONS: readonly string[] = ["not_produced", "partial_failure", "timeout", "expired", "cancelled", "outage", "custody_unverified"];
const RELATIONS: readonly string[] = ["routes_to", "connects_to", "resolves_to", "secures", "contains", "reads_secret", "publishes_to", "consumes_from", "depends_on"];
const plannedCandidates = new WeakSet<object>();

function matches(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.exec(value)?.[0] === value; }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid_input");
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) refuse("invalid_input");
}
function list(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value)) refuse("invalid_input");
  if (value.length > max) refuse("bounds");
}

/** Snapshot before processing; never invoke getters or custom JSON methods. */
function snapshot<T>(input: T): T {
  let values = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const walk = (value: unknown, depth: number): unknown => {
    if (++values > MIXED_PARTITION_LIMITS.jsonValues || depth > MIXED_PARTITION_LIMITS.jsonDepth) refuse("bounds");
    if (typeof value === "string") {
      const size = Buffer.byteLength(value);
      bytes += size;
      if (size > MIXED_PARTITION_LIMITS.stringBytes || bytes > MIXED_PARTITION_LIMITS.jsonBytes) refuse("bounds");
      return value;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || !value) refuse("invalid_input");
    if (isProxy(value)) refuse("invalid_input");
    if (ancestors.has(value)) refuse("invalid_input");
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) refuse("invalid_input");
    ancestors.add(value);
    if (Array.isArray(value) && value.length > MIXED_PARTITION_LIMITS.jsonValues) refuse("bounds");
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MIXED_PARTITION_LIMITS.jsonValues + (Array.isArray(value) ? 1 : 0)) refuse("bounds");
    if (ownKeys.some((key) => typeof key !== "string")) refuse("invalid_input");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => !(Array.isArray(value) && key === "length"));
    if (keys.some((key) => !descriptors[key].enumerable || !("value" in descriptors[key]))) refuse("invalid_input");
    let result: unknown;
    if (Array.isArray(value)) {
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) refuse("invalid_input");
      result = keys.map((key) => walk(descriptors[key].value, depth + 1));
    } else {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (key.length > 512) refuse("bounds");
        bytes += Buffer.byteLength(key);
        if (bytes > MIXED_PARTITION_LIMITS.jsonBytes) refuse("bounds");
        out[key] = walk(descriptors[key].value, depth + 1);
      }
      result = out;
    }
    ancestors.delete(value);
    return result;
  };
  return walk(input, 0) as T;
}

function assertNoSecrets(value: unknown): void {
  if (typeof value === "string") {
    if (urlHasCredentials(value) || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(value)) refuse("secret_data");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      let url: URL;
      try { url = new URL(value); } catch { return; }
      for (const key of url.searchParams.keys()) if (looksSecretKey(key) || /^(?:sig|signature|x-amz-signature|x-goog-signature)$/i.test(key)) refuse("secret_data");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(assertNoSecrets); return; }
  const object = value as Record<string, unknown>;
  if (typeof object.key === "string" && looksSecretKey(object.key) && Object.hasOwn(object, "value")) refuse("secret_data");
  for (const [key, child] of Object.entries(object)) {
    if (looksSecretKey(key) && !isPointerKey(key) && child !== null) {
      const isReference = (candidate: unknown): boolean => !!candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && Object.keys(candidate).length === 1 && typeof (candidate as Record<string, unknown>).secretRef === "string";
      if (Array.isArray(child) ? !child.every(isReference) : !isReference(child)) refuse("secret_data");
    }
    assertNoSecrets(child);
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function bindingIdentity(binding: PartitionBinding, workspaceId: string, environmentId: string): PartitionIdentity {
  record(binding, ["id", "connection", "accountId", "region", "backend", "stateKey"]);
  if (!matches(binding.id, ID) || !matches(binding.region, REGION)) refuse("binding_mismatch");
  const connection = binding.connection;
  record(connection, ["id", "workspaceId", "config", "status", "createdBy", "createdAt"], ["legacyConnectionId", "verifiedAt", "verificationDetail", "revokedAt"]);
  if (!matches(connection.id, ID) || connection.workspaceId !== workspaceId || connection.status !== "verified" || connection.revokedAt !== undefined) refuse("binding_mismatch");
  const config = connection.config;
  if (!config || typeof config !== "object" || Array.isArray(config) || !["aws", "gcp", "azure", "oci"].includes(config.provider)) refuse("binding_mismatch");
  if (!("region" in config) || config.region !== binding.region) refuse("binding_mismatch");
  if (!["oidc_web_identity", "aws_assume_role", "runner"].includes(config.mode)) refuse("binding_mismatch");
  assertNoSecrets(config);
  // Only these non-secret selectors enter identity digests. Arbitrary config,
  // credential refs/bytes, local paths, endpoint overrides and detail text do not.
  let selectors: Record<string, unknown>;
  const backend = binding.backend;
  if (!backend || typeof backend !== "object" || Array.isArray(backend)) refuse("binding_mismatch");
  if (Object.values(backend).some((value) => typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value))) refuse("binding_mismatch");
  let location: Record<string, unknown>;
  let lockLocation: Record<string, unknown>;
  const scopePrefix = `zenith/${workspaceId}/${environmentId}/`;
  try { assertStateKey(binding.stateKey); } catch { return refuse("binding_mismatch"); }
  if (/[\u0000-\u001f\u007f]/.test(binding.stateKey)) refuse("binding_mismatch");
  if (!binding.stateKey.startsWith(scopePrefix)) refuse("binding_mismatch");
  if (config.provider === "aws") {
    record(config, ["provider", "mode", "accountId", "observeRoleArn", "deployRoleArn", "region"], ["secretWriterRoleArn", "externalId", "bootstrapNameSuffix", "sessionDurationSec", "stateBucket", "stateKmsKeyArn", "permissionsBoundaryArn", "codeBuildRoleArn", "endpoint", "runnerId"]);
    if (!matches(config.accountId, /^\d{12}$/) || binding.accountId !== config.accountId || config.endpoint !== undefined || backend.kind !== "s3" || backend.endpoint !== undefined || backend.bucket !== config.stateBucket || backend.encryptionKmsKeyArn !== config.stateKmsKeyArn || backend.region !== undefined && backend.region !== binding.region) refuse("binding_mismatch");
    const cloudPartition = binding.region.startsWith("cn-") ? "aws-cn" : binding.region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
    const sameRole = (value: unknown): boolean => {
      const parsed = parseRoleArn(value);
      return !!parsed && parsed.partition === cloudPartition && parsed.accountId === config.accountId
        && value === `arn:${parsed.partition}:iam::${parsed.accountId}:role/${parsed.path}${parsed.name}`;
    };
    if (!sameRole(config.observeRoleArn) || !sameRole(config.deployRoleArn)) refuse("binding_mismatch");
    for (const candidate of [config.secretWriterRoleArn, config.codeBuildRoleArn]) {
      if (candidate !== undefined && !sameRole(candidate)) refuse("binding_mismatch");
    }
    if (!isBootstrapNameSuffix(config.bootstrapNameSuffix ?? "") || config.mode === "aws_assume_role" && !isExternalId(config.externalId)
      || config.externalId !== undefined && (!isExternalId(config.externalId) || /[\u0000-\u001f\u007f]/.test(config.externalId))
      || config.sessionDurationSec !== undefined && (!Number.isInteger(config.sessionDurationSec) || config.sessionDurationSec < 1 || config.sessionDurationSec > 3600)) refuse("binding_mismatch");
    if (config.permissionsBoundaryArn !== undefined && !matches(config.permissionsBoundaryArn, new RegExp(`^arn:${cloudPartition}:iam::${config.accountId}:policy/[A-Za-z0-9_+=,.@/-]{1,512}$`))) refuse("binding_mismatch");
    for (const key of [backend.encryptionKmsKeyArn, backend.sseKmsKeyId]) {
      if (key?.startsWith("arn:") && key.split(":")[4] !== binding.accountId) refuse("binding_mismatch");
    }
    selectors = { mode: config.mode, observeRoleArn: config.observeRoleArn, deployRoleArn: config.deployRoleArn,
      bootstrapNameSuffix: config.bootstrapNameSuffix ?? "",
      ...(config.secretWriterRoleArn !== undefined ? { secretWriterRoleArn: config.secretWriterRoleArn } : {}),
      ...(config.codeBuildRoleArn !== undefined ? { codeBuildRoleArn: config.codeBuildRoleArn } : {}),
      ...(config.permissionsBoundaryArn !== undefined ? { permissionsBoundaryArn: config.permissionsBoundaryArn } : {}),
      ...(config.externalId !== undefined ? { externalIdDigest: digest(config.externalId) } : {}),
      ...(config.sessionDurationSec !== undefined ? { sessionDurationSec: config.sessionDurationSec } : {}),
    };
    location = { service: "aws_s3", partition: cloudPartition, bucket: backend.bucket, key: binding.stateKey };
    lockLocation = { ...location, key: `${binding.stateKey}.tflock` };
  } else if (config.provider === "gcp") {
    record(config, ["provider", "mode", "projectId", "workloadIdentityProvider", "observeServiceAccount", "deployServiceAccount", "region"], ["stateBucket", "stateKmsKey", "runnerId"]);
    if (!["oidc_web_identity", "runner"].includes(config.mode) || !matches(config.projectId, /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/) || binding.accountId !== config.projectId || backend.kind !== "gcs" || backend.bucket !== config.stateBucket || backend.kmsEncryptionKey !== config.stateKmsKey) refuse("binding_mismatch");
    if (!matches(config.workloadIdentityProvider, /^projects\/\d{1,20}\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]{1,63}\/providers\/[A-Za-z0-9_-]{1,63}$/) || !matches(config.observeServiceAccount, /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/) || !matches(config.deployServiceAccount, /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/)) refuse("binding_mismatch");
    if (!config.observeServiceAccount.endsWith(`@${config.projectId}.iam.gserviceaccount.com`) || !config.deployServiceAccount.endsWith(`@${config.projectId}.iam.gserviceaccount.com`)) refuse("binding_mismatch");
    const prefix = backend.prefix ?? binding.stateKey;
    try { assertStateKey(prefix); } catch { return refuse("binding_mismatch"); }
    // OpenTofu GCS uses path.Join for both state and lock objects. Reject a
    // spelling it would clean, so raw location digests cannot hide an alias.
    if (prefix.split("/").includes(".")) refuse("binding_mismatch");
    if (prefix !== scopePrefix.slice(0, -1) && !prefix.startsWith(scopePrefix)) refuse("binding_mismatch");
    if (backend.kmsEncryptionKey !== undefined && backend.kmsEncryptionKey.split("/")[1] !== config.projectId) refuse("binding_mismatch");
    selectors = { mode: config.mode, workloadIdentityProvider: config.workloadIdentityProvider, observeServiceAccount: config.observeServiceAccount, deployServiceAccount: config.deployServiceAccount };
    location = { service: "gcs", bucket: backend.bucket, key: `${prefix}/default.tfstate` };
    lockLocation = { ...location, key: `${prefix}/default.tflock` };
  } else if (config.provider === "azure") {
    record(config, ["provider", "mode", "tenantId", "clientId", "subscriptionId", "region"], ["stateStorageAccount", "stateContainer", "sourceStorage", "runnerId"]);
    if (!["oidc_web_identity", "runner"].includes(config.mode) || !matches(config.tenantId, GUID) || !matches(config.subscriptionId, GUID) || !matches(config.clientId, GUID) || binding.accountId !== config.subscriptionId || backend.kind !== "azurerm" || backend.storageAccountName !== config.stateStorageAccount || backend.containerName !== config.stateContainer || config.mode === "oidc_web_identity" && backend.useOidc !== true) refuse("binding_mismatch");
    selectors = { mode: config.mode, tenantId: config.tenantId, clientId: config.clientId };
    location = { service: "azure_blob", account: backend.storageAccountName, container: backend.containerName, key: binding.stateKey };
    // The pinned Azure backend leases the same blob; it has no sibling lock file.
    lockLocation = location;
  } else if (config.provider === "oci") {
    record(config, ["provider", "mode", "tenancyOcid", "compartmentOcid", "region", "runnerId"], ["stateBucket", "stateNamespace"]);
    if (!matches(config.stateNamespace, OCI_NAMESPACE)) refuse("binding_mismatch");
    if (!matches(config.tenancyOcid, /^ocid1\.tenancy\.[A-Za-z0-9.-]{1,240}$/) || !matches(config.compartmentOcid, /^ocid1\.compartment\.[A-Za-z0-9.-]{1,240}$/) || binding.accountId !== config.tenancyOcid || config.mode !== "runner" || backend.kind !== "s3" || backend.bucket !== config.stateBucket || backend.endpoint !== `https://${config.stateNamespace}.compat.objectstorage.${config.region}.oraclecloud.com` || backend.region !== undefined && backend.region !== binding.region) refuse("binding_mismatch");
    selectors = { mode: config.mode, compartmentOcid: config.compartmentOcid };
    location = { service: "oci_object", endpoint: backend.endpoint, bucket: backend.bucket, key: binding.stateKey };
    lockLocation = { ...location, key: `${binding.stateKey}.tflock` };
  } else return refuse("binding_mismatch");
  if (config.mode === "runner") {
    if (!("runnerId" in config) || !matches(config.runnerId, ID)) refuse("binding_mismatch");
    selectors.runnerId = config.runnerId;
  }
  // Account/connection IDs and encryption do not distinguish a physical object.
  // Validate derived names too: the canonical key bound includes lock suffixes.
  try { assertStateKey(location.key); assertStateKey(lockLocation.key); }
  catch { return refuse("binding_mismatch"); }
  const backendObjectDigests = sorted(new Set([digest(location), digest(lockLocation)]));
  let validatedBackend: ReturnType<typeof backendFile>;
  try { validatedBackend = backendFile(backend, binding.region, binding.stateKey); } catch { return refuse("binding_mismatch"); }
  return {
    bindingId: binding.id, workspaceId, environmentId, connectionId: connection.id,
    provider: config.provider as MixedProvider, accountId: binding.accountId, region: binding.region,
    connectionIdentityDigest: digest({ connectionId: connection.id, workspaceId, provider: config.provider, accountId: binding.accountId, region: binding.region, selectors }),
    backendKind: backend.kind as PartitionIdentity["backendKind"],
    backendDigest: digest(validatedBackend.file), stateLocationDigest: digest(location), backendObjectDigests,
  };
}

/** Lexically deterministic Kahn order; edges are consumer -> dependency. */
function dependencyOrder(dependencies: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const remaining = new Map([...dependencies].map(([key, values]) => [key, new Set(values)]));
  const order: string[] = [];
  while (remaining.size) {
    const ready = sorted([...remaining].filter(([, values]) => values.size === 0).map(([key]) => key));
    if (!ready.length) refuse("dependency_cycle");
    for (const key of ready) { order.push(key); remaining.delete(key); }
    for (const values of remaining.values()) for (const key of ready) values.delete(key);
  }
  return order;
}

function contractOf(reference: PartitionReference): unknown {
  return { id: reference.id, scope: reference.scope, producer: reference.producer, consumer: reference.consumer };
}

/** Refuse contradictory account-bearing identities; never infer ownership of
 * unqualified names or OCIDs from their spelling. Those need provider evidence. */
function assertExternalAccount(node: ResourceNode, identity: PartitionIdentity): void {
  const ref = node.externalRef;
  if (ref === undefined) return;
  if (identity.provider === "aws" && ref.startsWith("arn:")) {
    const parts = ref.split(":");
    const partition = identity.region.startsWith("cn-") ? "aws-cn" : identity.region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
    if (parts.length < 6 || parts[1] !== partition || parts[4] !== "" && parts[4] !== identity.accountId || parts[3] !== "" && parts[3] !== identity.region) refuse("binding_mismatch");
  }
  if (identity.provider === "gcp") {
    const path = ref.replace(/^https:\/\/(?:www|compute)\.googleapis\.com\/(?:compute\/(?:v1|beta)\/)?/, "");
    const project = /^projects\/([^/]+)(?:\/|$)/.exec(path);
    if (project && project[1] !== identity.accountId) refuse("binding_mismatch");
    const match = /^projects\/([^/]+)\/(?:regions\/([^/]+)|zones\/([^/]+)|locations\/([^/]+)|global\/)/.exec(path);
    if (match && (match[1] !== identity.accountId || match[2] !== undefined && match[2] !== identity.region || match[3] !== undefined && match[3].replace(/-[a-z]$/, "") !== identity.region || match[4] !== undefined && match[4] !== "global" && match[4] !== identity.region)) refuse("binding_mismatch");
  }
  if (identity.provider === "azure") {
    const match = /^\/subscriptions\/([^/]+)(?:\/|$)/i.exec(ref);
    if (match && match[1].toLowerCase() !== identity.accountId) refuse("binding_mismatch");
  }
  if (identity.provider === "oci" && ref.startsWith("ocid1.tenancy.") && ref !== identity.accountId) refuse("binding_mismatch");
}

function buildMixedPlan(raw: MixedPartitionInput): MixedPartitionPlan {
  const input = snapshot(raw);
  record(input, ["workspaceId", "graph", "bindings", "assignments", "references"]);
  if (!matches(input.workspaceId, ID)) refuse("invalid_input");
  const graph = input.graph;
  record(graph, ["version", "environmentId", "manifestDigest", "nodes", "edges", "graphDigest", "notes"]);
  if (graph.version !== 1 || !matches(graph.environmentId, ID) || !matches(graph.manifestDigest, SHA) || !matches(graph.graphDigest, SHA)) refuse("graph_integrity");
  list(graph.nodes, MIXED_PARTITION_LIMITS.nodes); list(graph.edges, MIXED_PARTITION_LIMITS.edges);
  list(graph.notes, MIXED_PARTITION_LIMITS.nodes); list(input.bindings, MIXED_PARTITION_LIMITS.bindings);
  list(input.assignments, MIXED_PARTITION_LIMITS.nodes); list(input.references, MIXED_PARTITION_LIMITS.references);
  if (!graph.nodes.length || !input.bindings.length || graph.notes.some((note) => typeof note !== "string")) refuse("invalid_input");
  const nodes = new Map<string, ResourceNode>();
  const dependencies = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    record(node, ["address", "kind", "provider", "region", "nativeType", "ownership", "spec", "origin", "dependsOn", "specDigest", "labels"], ["externalRef"]);
    if (!matches(node.address, ADDRESS) || node.address.includes("..") || nodes.has(node.address) || !matches(node.region, REGION) || !["aws", "gcp", "azure", "oci"].includes(node.provider) || !matches(node.nativeType, /^[a-z]+:[A-Za-z0-9_]{1,128}$/) || !node.nativeType.startsWith(`${node.provider}:`) || !(PORTABLE_KINDS as readonly string[]).includes(node.kind) && node.kind !== "provider_native" || !["managed", "referenced", "external"].includes(node.ownership) || !matches(node.specDigest, SHA)) refuse("graph_integrity");
    if (!node.spec || typeof node.spec !== "object" || Array.isArray(node.spec) || !node.labels || typeof node.labels !== "object" || Array.isArray(node.labels) || Object.values(node.labels).some((value) => typeof value !== "string")) refuse("invalid_input");
    list(node.origin, MIXED_PARTITION_LIMITS.nodes); list(node.dependsOn, MIXED_PARTITION_LIMITS.nodes);
    if (node.origin.some((id) => !matches(id, ADDRESS)) || node.dependsOn.some((address) => !matches(address, ADDRESS)) || new Set(node.dependsOn).size !== node.dependsOn.length || new Set(node.origin).size !== node.origin.length || node.externalRef !== undefined && typeof node.externalRef !== "string") refuse("graph_integrity");
    assertNoSecrets(node.spec); assertNoSecrets(node.labels); assertNoSecrets(node.externalRef);
    const expectedSpecDigest = digest({ kind: node.kind, provider: node.provider, region: node.region, nativeType: node.nativeType, ownership: node.ownership, spec: node.spec });
    if (node.specDigest !== expectedSpecDigest) refuse("graph_integrity");
    nodes.set(node.address, node); dependencies.set(node.address, new Set(node.dependsOn));
  }
  const edgeKeys = new Set<string>();
  const edgeKey = (edge: ResourceGraph["edges"][number]): string => `${edge.from}\0${edge.to}\0${edge.relation}\0${edge.detail ?? ""}`;
  for (const edge of graph.edges) {
    record(edge, ["from", "to", "relation"], ["detail"]);
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || !RELATIONS.includes(edge.relation) || edge.detail !== undefined && typeof edge.detail !== "string" || edgeKeys.has(edgeKey(edge))) refuse("graph_integrity");
    assertNoSecrets(edge.detail); edgeKeys.add(edgeKey(edge));
    if (edge.relation === "depends_on") dependencies.get(edge.from)!.add(edge.to);
  }
  for (const [address, targets] of dependencies) if (targets.has(address) || [...targets].some((target) => !nodes.has(target))) refuse("graph_integrity");
  const orderedNodes = [...nodes.values()].sort((a, b) => cmp(a.address, b.address));
  const orderedEdges = [...graph.edges].sort((a, b) => cmp(edgeKey(a), edgeKey(b)));
  if (graph.graphDigest !== digest({ nodes: orderedNodes, edges: orderedEdges })) refuse("graph_integrity");
  dependencyOrder(dependencies);

  const identities = new Map<string, PartitionIdentity>();
  const connectionIdentities = new Map<string, string>();
  const stateLocations = new Set<string>();
  const partitionIds = new Map<string, string>();
  for (const binding of input.bindings) {
    const identity = bindingIdentity(binding, input.workspaceId, graph.environmentId);
    if (identities.has(binding.id)) refuse("binding_mismatch");
    const previousConnection = connectionIdentities.get(identity.connectionId);
    if (previousConnection !== undefined && previousConnection !== identity.connectionIdentityDigest) refuse("binding_mismatch");
    // Check cross-binding overlap only; a state's own Azure lease is the same
    // physical blob and was deduplicated in that binding's footprint.
    if (identity.backendObjectDigests.some(object => stateLocations.has(object))) refuse("state_overlap");
    identity.backendObjectDigests.forEach(object => stateLocations.add(object));
    connectionIdentities.set(identity.connectionId, identity.connectionIdentityDigest);
    identities.set(binding.id, identity); partitionIds.set(binding.id, `partition/${digest(identity)}`);
  }
  const assignment = new Map<string, string>();
  const groupedNodes = new Map<string, ResourceNode[]>([...identities.keys()].map((id) => [id, []]));
  for (const item of input.assignments) {
    record(item, ["address", "bindingId"]);
    const node = nodes.get(item.address);
    const identity = identities.get(item.bindingId);
    if (!node || !identity || assignment.has(item.address) || node.provider !== identity.provider || node.region !== identity.region) refuse("binding_mismatch");
    assertExternalAccount(node, identity);
    assignment.set(item.address, item.bindingId); groupedNodes.get(item.bindingId)!.push(node);
  }
  if (assignment.size !== nodes.size || [...groupedNodes.values()].some((group) => group.length === 0)) refuse("binding_mismatch");
  const partitionOf = (address: string): string => partitionIds.get(assignment.get(address)!)!;
  const partitionDependencies = new Map<string, Set<string>>([...partitionIds.values()].map((id) => [id, new Set()]));
  for (const [address, targets] of dependencies) for (const target of targets) {
    if (partitionOf(address) !== partitionOf(target)) partitionDependencies.get(partitionOf(address))!.add(partitionOf(target));
  }
  const executionOrder = dependencyOrder(partitionDependencies);

  const referenceIds = new Set<string>();
  const consumerInputs = new Set<string>();
  const producerTypes = new Map<string, PartitionValueType>();
  const references = [...input.references];
  for (const reference of references) {
    record(reference, ["id", "scope", "producer", "consumer", "materialization"]);
    record(reference.scope, ["workspaceId", "environmentId"]);
    record(reference.producer, ["address", "output", "type"]); record(reference.consumer, ["address", "input", "type"]);
    const producer = nodes.get(reference.producer.address);
    const consumer = nodes.get(reference.consumer.address);
    const inputKey = `${reference.consumer.address}\0${reference.consumer.input}`;
    const outputKey = `${reference.producer.address}\0${reference.producer.output}`;
    if (!matches(reference.id, ID) || referenceIds.has(reference.id) || !producer || !consumer || producer.ownership === "external" || consumer.ownership !== "managed" || partitionOf(producer.address) === partitionOf(consumer.address) || !matches(reference.producer.output, FIELD) || !matches(reference.consumer.input, FIELD) || !TYPES.includes(reference.producer.type) || reference.producer.type !== reference.consumer.type || reference.scope.workspaceId !== input.workspaceId || reference.scope.environmentId !== graph.environmentId || !dependencies.get(consumer.address)!.has(producer.address) || consumerInputs.has(inputKey) || producerTypes.has(outputKey) && producerTypes.get(outputKey) !== reference.producer.type) refuse("reference_contract");
    if ((looksSecretKey(reference.producer.output) || looksSecretKey(reference.consumer.input)) && reference.producer.type !== "secret_ref") refuse("secret_data");
    referenceIds.add(reference.id); consumerInputs.add(inputKey); producerTypes.set(outputKey, reference.producer.type);
  }
  references.sort((a, b) => cmp(a.id, b.id));
  // Incident edges do not become ordering edges. Cross-partition data/traffic
  // relations need a declaration; ordering-only dependencies need no value.
  for (const edge of graph.edges) {
    if (edge.relation === "depends_on" || partitionOf(edge.from) === partitionOf(edge.to)) continue;
    const matching = references.filter((reference) => reference.consumer.address === edge.from && reference.producer.address === edge.to || reference.consumer.address === edge.to && reference.producer.address === edge.from);
    if (!matching.length || edge.relation === "reads_secret" && !matching.some((reference) => reference.consumer.address === edge.from && reference.producer.address === edge.to && reference.producer.type === "secret_ref")) refuse("reference_contract");
  }

  const partitions: PlannedPartition[] = [];
  for (const bindingId of sorted(identities.keys())) {
    const id = partitionIds.get(bindingId)!;
    const nodeIdentities: PartitionNodeIdentity[] = groupedNodes.get(bindingId)!.sort((a, b) => cmp(a.address, b.address)).map((node) => ({
      address: node.address, kind: node.kind, nativeType: node.nativeType, ownership: node.ownership,
      specDigest: node.specDigest, sourceNodeDigest: digest(node), dependsOn: sorted(dependencies.get(node.address)!),
    }));
    const identity = identities.get(bindingId)!;
    const dependsOn = sorted(partitionDependencies.get(id)!);
    const contracts = references.filter((reference) => partitionOf(reference.producer.address) === id || partitionOf(reference.consumer.address) === id).map(contractOf);
    const internalEdges = orderedEdges.filter((edge) => partitionOf(edge.from) === id && partitionOf(edge.to) === id).map((edge) => digest(edge));
    const subplanDigest = digest({ version: 1, identity, nodes: nodeIdentities, dependsOn, contracts, internalEdges });
    partitions.push({ id, identity, nodes: nodeIdentities, dependsOn, subplanDigest, effectDigest: "", blockedByReferences: [] });
  }
  partitions.sort((a, b) => cmp(a.id, b.id));
  const partitionById = new Map(partitions.map((partition) => [partition.id, partition]));
  // Effects can be pinned without resolving/copying any value. The DAG ensures
  // producer effect identities exist before a dependent receipt is considered.
  for (const id of executionOrder) {
    const partition = partitionById.get(id)!;
    const incoming = references.filter((reference) => partitionOf(reference.consumer.address) === id);
    partition.effectDigest = digest({ subplanDigest: partition.subplanDigest, incoming: incoming.map((reference) => ({ id: reference.id, materializationDigest: digest(reference.materialization) })) });
    partition.blockedByReferences = sorted(new Set([
      ...incoming.filter((reference) => reference.materialization?.state === "unavailable").map((reference) => reference.id),
      ...partition.dependsOn.flatMap((dependency) => partitionById.get(dependency)!.blockedByReferences),
    ]));
  }
  const plannedReferences: PlannedReference[] = [];
  const producerMaterializations = new Map<string, string>();
  for (const reference of references) {
    const producerPartitionId = partitionOf(reference.producer.address);
    const consumerPartitionId = partitionOf(reference.consumer.address);
    const producer = partitionById.get(producerPartitionId)!;
    const consumer = partitionById.get(consumerPartitionId)!;
    const materialization = reference.materialization;
    if (!materialization || typeof materialization !== "object") refuse("reference_contract");
    if (materialization.state === "unavailable") {
      record(materialization, ["state", "reason"]);
      if (!REASONS.includes(materialization.reason)) refuse("reference_contract");
    } else if (materialization.state === "available") {
      record(materialization, ["state", "valueDigest", "provenance"], ["secret"]);
      const proof = materialization.provenance;
      record(proof, ["workspaceId", "environmentId", "connectionId", "provider", "accountId", "region", "producerAddress", "producerSpecDigest", "producerSubplanDigest", "producerEffectDigest", "receiptDigest", "artifactDigest"]);
      if (!matches(materialization.valueDigest, SHA) || !matches(proof.receiptDigest, SHA) || !matches(proof.artifactDigest, SHA) || proof.workspaceId !== input.workspaceId || proof.environmentId !== graph.environmentId || proof.connectionId !== producer.identity.connectionId || proof.provider !== producer.identity.provider || proof.accountId !== producer.identity.accountId || proof.region !== producer.identity.region || proof.producerAddress !== reference.producer.address || proof.producerSpecDigest !== nodes.get(reference.producer.address)!.specDigest || proof.producerSubplanDigest !== producer.subplanDigest || proof.producerEffectDigest !== producer.effectDigest || producer.blockedByReferences.length > 0) refuse("provenance_mismatch");
      if (reference.producer.type === "secret_ref") {
        const secret = materialization.secret;
        record(secret, ["ref", "versionDigest", "workspaceId", "environmentId", "consumerConnectionId"]);
        if (!secret || !matches(secret.ref, /^vault:[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/) || !matches(secret.versionDigest, SHA) || secret.workspaceId !== input.workspaceId || secret.environmentId !== graph.environmentId || secret.consumerConnectionId !== consumer.identity.connectionId) refuse("provenance_mismatch");
        if (materialization.valueDigest !== digest({ ref: secret.ref, versionDigest: secret.versionDigest })) refuse("provenance_mismatch");
      } else if (materialization.secret !== undefined) refuse("secret_data");
    } else refuse("reference_contract");
    const materializationDigest = digest(materialization);
    const outputKey = `${reference.producer.address}\0${reference.producer.output}`;
    // A producer output cannot simultaneously have different values, versions,
    // receipts or availability. Secret delivery scope may differ per consumer.
    const producerMaterialization = materialization.state === "available"
      ? digest({ valueDigest: materialization.valueDigest, provenance: materialization.provenance, ...(materialization.secret ? { secret: { ref: materialization.secret.ref, versionDigest: materialization.secret.versionDigest } } : {}) })
      : materializationDigest;
    if (producerMaterializations.has(outputKey) && producerMaterializations.get(outputKey) !== producerMaterialization) refuse("provenance_mismatch");
    producerMaterializations.set(outputKey, producerMaterialization);
    plannedReferences.push({ id: reference.id, producerPartitionId, consumerPartitionId, contractDigest: digest(contractOf(reference)), materializationDigest, state: materialization.state,
      ...(materialization.state === "unavailable" ? { unavailableReason: materialization.reason } : {}) });
  }
  const desiredDigest = digest({ version: 1, workspaceId: input.workspaceId, environmentId: graph.environmentId, manifestDigest: graph.manifestDigest, graphDigest: graph.graphDigest,
    children: partitions.map(({ id, subplanDigest }) => ({ id, subplanDigest })), contracts: plannedReferences.map(({ id, contractDigest }) => ({ id, contractDigest })), executionOrder });
  const parentDigest = digest({ desiredDigest, children: partitions.map(({ id, effectDigest }) => ({ id, effectDigest })), references: plannedReferences });
  const plan: MixedPartitionPlan = freeze({ version: 1, executionEnabled: false, workspaceId: input.workspaceId, environmentId: graph.environmentId, manifestDigest: graph.manifestDigest, graphDigest: graph.graphDigest,
    desiredDigest, parentDigest, partitions, references: plannedReferences, executionOrder, teardownOrder: [...executionOrder].reverse() });
  plannedCandidates.add(plan);
  return plan;
}

/** Public refusals never forward errors containing caller data. */
export function planMixedPartitions(raw: MixedPartitionInput): MixedPartitionPlan {
  try { return buildMixedPlan(raw); }
  catch (error) {
    if (error instanceof MixedPartitionError) throw error;
    return refuse("invalid_input");
  }
}

export interface MixedPlanChange {
  classification: "unchanged" | "review_required";
  reasons: readonly ("scope_changed" | "desired_inputs_changed" | "materialized_effects_changed" | "output_custody_changed")[];
  affectedPartitionIds: readonly string[];
  /** Exact candidate for future parent/child approval; this is not an approval. */
  requiredParentDigest: string;
  blockedPartitionIds: readonly string[];
}

/** Conservative classification: no caller boolean or wildcard preapproval. */
export function classifyMixedPlanChange(before: MixedPartitionPlan, after: MixedPartitionPlan): MixedPlanChange {
  if (!plannedCandidates.has(before) || !plannedCandidates.has(after)) refuse("invalid_input");
  const reasons: MixedPlanChange["reasons"][number][] = [];
  if (before.workspaceId !== after.workspaceId || before.environmentId !== after.environmentId) reasons.push("scope_changed");
  if (before.desiredDigest !== after.desiredDigest) reasons.push("desired_inputs_changed");
  const oldPartitions = new Map(before.partitions.map((partition) => [partition.id, partition]));
  const newPartitions = new Map(after.partitions.map((partition) => [partition.id, partition]));
  const affected = new Set([...oldPartitions.keys(), ...newPartitions.keys()].filter((id) => oldPartitions.get(id)?.effectDigest !== newPartitions.get(id)?.effectDigest));
  // Unknown upstream effects also affect dependent children that have not yet
  // materialized their own input. Include both old and new dependency graphs.
  for (let pass = 0; pass < MIXED_PARTITION_LIMITS.bindings; pass++) {
    const size = affected.size;
    for (const partition of [...before.partitions, ...after.partitions]) if (partition.dependsOn.some((id) => affected.has(id))) affected.add(partition.id);
    if (size === affected.size) break;
  }
  if (affected.size) reasons.push("materialized_effects_changed");
  if (digest(before.references) !== digest(after.references)) reasons.push("output_custody_changed");
  return freeze({ classification: reasons.length ? "review_required" : "unchanged", reasons, affectedPartitionIds: sorted(affected),
    requiredParentDigest: after.parentDigest, blockedPartitionIds: after.partitions.filter((partition) => partition.blockedByReferences.length > 0).map((partition) => partition.id) });
}
