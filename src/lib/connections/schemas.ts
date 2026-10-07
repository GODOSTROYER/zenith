/**
 * Input contracts for the connection administration lifecycle (PROD-LIFE-01).
 *
 * Pure and dependency-light on purpose: the same schemas validate the UI form
 * payload, the REST body, the action input and the CLI's local pre-check, so the
 * four surfaces cannot drift. Everything here is a NON-SECRET identifier. Secret
 * shaped fields are refused by `.strict()` and by the control store's own guard.
 *
 * Rotation patches never change the identity a connection is pinned to
 * (account, project, tenant, subscription, tenancy, API server). A patch swaps
 * only the access path to that same identity, which is what makes a promoted
 * rotation unable to redirect deploys to a different target.
 */
import { z } from "zod";
import type {
  AwsConnectionConfig, AzureConnectionConfig, ConnectionConfig, GcpConnectionConfig, KubernetesConnectionConfig, OciConnectionConfig,
} from "@/lib/credentials/types";
import { parseRoleArn } from "@/lib/credentials/aws/arn";
import { PROJECT_ID_RE, REGION_RE, SA_EMAIL_RE } from "@/lib/providers/gcp/validate";

export const LIFECYCLE_PROVIDERS = ["aws", "gcp", "azure", "oci", "kubernetes"] as const;
export type LifecycleProvider = (typeof LIFECYCLE_PROVIDERS)[number];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OCID = /^ocid1\.[a-z0-9_]+\.[a-z0-9]+\.[a-z0-9-]*\.[A-Za-z0-9]{6,120}$/;
const OCI_REGION = /^[a-z]{2}-[a-z0-9-]{3,30}-\d$/;
const AZURE_REGION = /^[a-z0-9]{2,40}$/;
const WIF_PROVIDER = /^projects\/\d{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;
const VAULT_REF = /^vault:[A-Za-z0-9_./:-]+$/;
const AGENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

const label = z.string().trim().min(1).max(120).optional();
const guid = (what: string) => z.string().refine((v) => GUID.test(v), `Use the ${what} GUID.`);
const runnerId = z.string().refine((v) => AGENT_ID.test(v), "Use a registered runner id.");

/* --------------------------------- creation -------------------------------- */

export const CreateGcpInput = z.object({
  label,
  region: z.string().refine((v) => REGION_RE.test(v), "Use a GCP region such as us-central1."),
  projectId: z.string().refine((v) => PROJECT_ID_RE.test(v), "Use a GCP project id."),
  workloadIdentityProvider: z.string().max(400).refine((v) => WIF_PROVIDER.test(v), "Use projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>."),
  observeServiceAccount: z.string().max(200).refine((v) => SA_EMAIL_RE.test(v), "Use a service account email."),
  deployServiceAccount: z.string().max(200).refine((v) => SA_EMAIL_RE.test(v), "Use a service account email."),
  stateBucket: z.string().refine((v) => BUCKET.test(v), "Use a GCS bucket name.").optional(),
  stateKmsKey: z.string().max(400).regex(/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/, "Use a Cloud KMS key resource name.").optional(),
}).strict();
export type CreateGcpInput = z.infer<typeof CreateGcpInput>;

export const CreateAzureInput = z.object({
  label,
  region: z.string().refine((v) => AZURE_REGION.test(v), "Use an Azure region name such as eastus."),
  tenantId: guid("tenant"),
  clientId: guid("federated application (client)"),
  subscriptionId: guid("subscription"),
  cloud: z.enum(["public", "usgov", "china"]).optional(),
  stateStorageAccount: z.string().regex(/^[a-z0-9]{3,24}$/, "Use a storage account name.").optional(),
  stateContainer: z.string().regex(/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/, "Use a blob container name.").optional(),
}).strict();
export type CreateAzureInput = z.infer<typeof CreateAzureInput>;

export const CreateOciInput = z.object({
  label,
  region: z.string().refine((v) => OCI_REGION.test(v), "Use an OCI region id such as us-ashburn-1."),
  tenancyOcid: z.string().max(300).refine((v) => OCID.test(v), "Use a tenancy OCID."),
  compartmentOcid: z.string().max(300).refine((v) => OCID.test(v), "Use a compartment OCID."),
  runnerId,
  stateBucket: z.string().refine((v) => BUCKET.test(v), "Use an Object Storage bucket name.").optional(),
  stateNamespace: z.string().regex(/^[A-Za-z0-9]{1,64}$/, "Use the Object Storage namespace.").optional(),
}).strict();
export type CreateOciInput = z.infer<typeof CreateOciInput>;

export function gcpConfig(input: CreateGcpInput): GcpConnectionConfig {
  const { label: _label, ...rest } = input;
  return { provider: "gcp", mode: "oidc_web_identity", ...rest };
}
export function azureConfig(input: CreateAzureInput): AzureConnectionConfig {
  const { label: _label, ...rest } = input;
  return { provider: "azure", mode: "oidc_web_identity", ...rest };
}
export function ociConfig(input: CreateOciInput): OciConnectionConfig {
  const { label: _label, ...rest } = input;
  return { provider: "oci", mode: "runner", ...rest };
}

/* --------------------------------- rotation -------------------------------- */

const roleArn = z.string().max(2048).refine((v) => !!parseRoleArn(v), "Use an IAM role ARN.");

const RotateAws = z.object({
  observeRoleArn: roleArn.optional(), deployRoleArn: roleArn.optional(), secretWriterRoleArn: roleArn.optional(), codeBuildRoleArn: roleArn.optional(),
  /** aws_assume_role only: mint a fresh Zenith-generated ExternalId. */
  rotateExternalId: z.literal(true).optional(),
  runnerId: runnerId.optional(),
}).strict();
const RotateGcp = z.object({
  workloadIdentityProvider: CreateGcpInput.shape.workloadIdentityProvider.optional(),
  observeServiceAccount: CreateGcpInput.shape.observeServiceAccount.optional(),
  deployServiceAccount: CreateGcpInput.shape.deployServiceAccount.optional(),
}).strict();
const RotateAzure = z.object({ clientId: CreateAzureInput.shape.clientId.optional() }).strict();
const RotateOci = z.object({ runnerId: runnerId.optional() }).strict();
const RotateKubernetes = z.object({
  credentialRef: z.string().min(7).max(200).refine((v) => VAULT_REF.test(v), "Use an existing tenant vault reference.").optional(),
  /** PROD-MACH-02: convert a legacy kubeconfig_ref connection to scoped_guest; credentialRef must name the new namespaced minter. */
  convertToScopedGuest: z.literal(true).optional(),
  /**
   * PROD-K8S-CONN: the separate DEPLOYER credential of a scoped_guest connection (deploy/observe path only). Must differ from
   * the minter reference. Setting it adds or replaces the deployer part; both parts are verified before promotion.
   */
  deployerCredentialRef: z.string().min(7).max(200).refine((v) => VAULT_REF.test(v), "Use an existing tenant vault reference.").optional(),
  /** Declared reach of the deployer: "namespaced" is verified to hold no cluster-wide power; "cluster" is allowed to. Default namespaced. */
  deployerScope: z.enum(["namespaced", "cluster"]).optional(),
  /**
   * With convertToScopedGuest: keep the legacy (broad) credential as the connection's deployer instead of dropping it, with the
   * declared scope. The new minter reference goes in credentialRef. One connection then serves guests and deploy/observe.
   */
  retainLegacyAsDeployer: z.enum(["namespaced", "cluster"]).optional(),
  /** Remove the deployer part (the connection serves guest sessions only again). */
  removeDeployer: z.literal(true).optional(),
}).strict();

export const ROTATION_PATCH_SCHEMAS = {
  aws: RotateAws, gcp: RotateGcp, azure: RotateAzure, oci: RotateOci, kubernetes: RotateKubernetes,
} as const;

/** The patch a caller sends for ANY provider; the live connection's provider selects the real schema. */
export const RotationPatchInput = z.record(z.string(), z.unknown());
export type RotationPatch = Record<string, unknown>;

export class LifecycleInputError extends Error {
  readonly code = "invalid_input";
}

function parsePatch<S extends z.ZodTypeAny>(schema: S, patch: RotationPatch): z.infer<S> {
  const parsed = schema.safeParse(patch);
  if (!parsed.success) throw new LifecycleInputError(parsed.error.issues.map((i) => `${i.path.join(".") || "patch"}: ${i.message}`).join("; "));
  if (Object.keys(parsed.data as object).length === 0) throw new LifecycleInputError("Name at least one value to rotate.");
  return parsed.data;
}

/** Input plus a freshly generated ExternalId, supplied by the caller so tests can pin it. */
export interface RotationOptions {
  newExternalId?: () => string;
}

/** Apply a validated patch to the live config. Never changes provider, mode or the pinned identity. */
export function applyRotationPatch(live: ConnectionConfig, rawPatch: RotationPatch, options: RotationOptions = {}): ConnectionConfig {
  switch (live.provider) {
    case "aws": {
      const patch = parsePatch(RotateAws, rawPatch);
      const next: AwsConnectionConfig = { ...live };
      for (const key of ["observeRoleArn", "deployRoleArn", "secretWriterRoleArn", "codeBuildRoleArn"] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        const parsed = parseRoleArn(value);
        if (!parsed || parsed.accountId !== live.accountId || parsed.partition !== "aws") throw new LifecycleInputError(`${key}: the role must be in AWS account ${live.accountId} (commercial partition).`);
        next[key] = value;
      }
      if (patch.rotateExternalId) {
        if (live.mode !== "aws_assume_role") throw new LifecycleInputError("rotateExternalId: only AssumeRole connections have an ExternalId; OIDC connections are pinned by subject.");
        if (!options.newExternalId) throw new LifecycleInputError("rotateExternalId: an ExternalId generator is required.");
        next.externalId = options.newExternalId();
      }
      if (patch.runnerId !== undefined) {
        if (live.mode !== "runner") throw new LifecycleInputError("runnerId: only runner-mode connections use a runner.");
        next.runnerId = patch.runnerId;
      }
      return next;
    }
    case "gcp": return { ...live, ...parsePatch(RotateGcp, rawPatch) } satisfies GcpConnectionConfig;
    case "azure": return { ...live, ...parsePatch(RotateAzure, rawPatch) } satisfies AzureConnectionConfig;
    case "oci": return { ...live, ...parsePatch(RotateOci, rawPatch) } satisfies OciConnectionConfig;
    case "kubernetes": {
      if (live.mode !== "kubeconfig_ref" && live.mode !== "scoped_guest") throw new LifecycleInputError("Only kubeconfig_ref and scoped_guest Kubernetes connections can rotate a vault reference.");
      const { convertToScopedGuest, retainLegacyAsDeployer, removeDeployer, ...patch } = parsePatch(RotateKubernetes, rawPatch);
      if (!convertToScopedGuest) {
        if (retainLegacyAsDeployer) throw new LifecycleInputError("retainLegacyAsDeployer: only valid together with convertToScopedGuest.");
        if (live.mode === "kubeconfig_ref" && (patch.deployerCredentialRef || patch.deployerScope || removeDeployer)) throw new LifecycleInputError("A legacy kubeconfig connection is its own deployer; convert it to scoped guest first (retainLegacyAsDeployer keeps its credential).");
        if (removeDeployer && (patch.deployerCredentialRef || patch.deployerScope)) throw new LifecycleInputError("removeDeployer cannot be combined with a new deployer credential or scope.");
        if (patch.deployerScope && !patch.deployerCredentialRef && !live.deployerCredentialRef) throw new LifecycleInputError("deployerScope: name the deployerCredentialRef too; this connection has no deployer.");
        const next: KubernetesConnectionConfig = { ...live, ...patch };
        if (removeDeployer) { delete next.deployerCredentialRef; delete next.deployerScope; }
        if (next.deployerCredentialRef) {
          if (next.deployerCredentialRef === next.credentialRef) throw new LifecycleInputError("deployerCredentialRef: the deployer must be a different vault reference than the guest minter.");
          next.deployerScope = next.deployerScope ?? "namespaced";
        }
        return next;
      }
      if (live.mode !== "kubeconfig_ref") throw new LifecycleInputError("convertToScopedGuest: this connection is already a scoped guest connection.");
      if (patch.deployerCredentialRef || patch.deployerScope || removeDeployer) throw new LifecycleInputError("convertToScopedGuest: use retainLegacyAsDeployer to keep the legacy credential as the deployer; a separate deployer reference can be added by a later rotation.");
      // The legacy credential is broad by definition: it can never become the minter.
      if (!patch.credentialRef || patch.credentialRef === live.credentialRef) throw new LifecycleInputError("convertToScopedGuest: name a different vault reference holding the namespaced minter credential.");
      if (!live.namespaces.length || live.namespaces.some((ns) => ["kube-system", "kube-public", "kube-node-lease"].includes(ns))) throw new LifecycleInputError("convertToScopedGuest: the namespace allowlist must be non-empty and exclude system namespaces.");
      const converted: KubernetesConnectionConfig = { ...live, ...patch, mode: "scoped_guest" };
      // The legacy credential keeps serving deploy/observe ONLY as the deployer part, with a declared scope; it can never be the minter.
      if (retainLegacyAsDeployer && live.credentialRef) { converted.deployerCredentialRef = live.credentialRef; converted.deployerScope = retainLegacyAsDeployer; }
      return converted;
    }
  }
}

/** The runner a config is bound to, if any. */
export function runnerOf(config: ConnectionConfig): string | undefined {
  return "runnerId" in config && typeof config.runnerId === "string" ? config.runnerId : undefined;
}

/* ------------------------------ shared id schema --------------------------- */

export const ConnectionRef = z.object({ connectionId: z.string().min(1).max(200) }).strict();
export type ConnectionRef = z.infer<typeof ConnectionRef>;

export const RevokeInput = z.object({
  connectionId: z.string().min(1).max(200),
  reason: z.string().trim().max(300).optional(),
  /** runner-mode only: also revoke the runner this connection used, when no other live connection uses it */
  revokeRunner: z.boolean().optional(),
}).strict();
export type RevokeInput = z.infer<typeof RevokeInput>;

export const RotateInput = z.object({
  connectionId: z.string().min(1).max(200),
  patch: RotationPatchInput,
  /** promote immediately when the candidate verifies; default is stage + verify only */
  promote: z.boolean().optional(),
  /** runner-mode only: after promotion, revoke the previous runner when no other live connection uses it */
  retirePreviousRunner: z.boolean().optional(),
}).strict();
export type RotateInput = z.infer<typeof RotateInput>;

export const RotationRef = z.object({
  connectionId: z.string().min(1).max(200),
  rotationId: z.string().min(1).max(200),
  retirePreviousRunner: z.boolean().optional(),
}).strict();
export type RotationRef = z.infer<typeof RotationRef>;
