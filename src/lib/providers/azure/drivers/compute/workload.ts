/**
 * The compile pieces a Container App and a Container Apps job share: image
 * resolution, registry pull, environment and secret wiring, sizing.
 *
 * Secrets are NEVER inlined. A `{ key, secretRef }` env entry becomes
 *   secret { name, key_vault_secret_id = <versionless Key Vault secret URI>, identity = <user-assigned identity id> }
 *   env    { name = KEY, secret_name = <that secret's name> }
 * so the platform resolves the value from Key Vault at runtime with the
 * workload's own identity, and no secret value exists in tofu config, plan or
 * state. The Key Vault secret itself is written by `syncSecretValue`.
 *
 * Image rules:
 *   - `image` artifacts are used as given. A `*.azurecr.io` image gets a
 *     registry block pulling with the workload identity (which needs AcrPull:
 *     granted only for registries in the graph). Private non-ACR registries
 *     would need a password secret and are not supported.
 *   - `built` artifacts start with a fixed public bootstrap image. Release
 *     builds in ACR and replaces it with the verified digest. The app/job
 *     compiler ignores that image and the responder's bootstrap argv, so later
 *     infrastructure applies preserve the deployed digest and entrypoint.
 *     Bootstrap is not release readiness.
 *   - `blueprint` artifacts only exist on the sandbox provider: compile error.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { ArtifactSpec, EnvEntry } from "@/lib/resources/specs";
import { AzureCompileError, dependencies, requireNode } from "@/lib/providers/azure/compile-util";
import { exportRef } from "@/lib/providers/azure/exports";
import { cloudName, hash6, nodeNameOf, slug } from "@/lib/providers/azure/naming";
import { ANY_ACR_LOGIN_SERVER as ANY_ACR_HOST } from "@/lib/providers/azure/cloud";
import { acaMemory, acaSize, type AcaSize } from "@/lib/providers/azure/platform";

export const CONTAINER_APP_NAME_MAX = 32;

/** Fixed linux/amd64 HashiCorp HTTP responder; never evidence of a built release.
 * https://hub.docker.com/layers/hashicorp/http-echo/1.0.0/images/sha256-2c213d6c05a0f68adfe9c7fe1a78a314e5c4fee783e2ee8592d49f10d0c4513f
 * Public image pull and Azure execution have not been live-verified here.
 */
export const BOOTSTRAP_IMAGE = "docker.io/hashicorp/http-echo@sha256:2c213d6c05a0f68adfe9c7fe1a78a314e5c4fee783e2ee8592d49f10d0c4513f";
export const RELEASE_IMAGE_PATH = "template[0].container[0].image";
export const RELEASE_ARGS_PATH = "template[0].container[0].args";

/** Match the app's declared probe port/path during infrastructure creation.
 * argv is passed literally, never through a shell, and removed on digest rollout.
 */
export function bootstrapArgs(port?: number): string[] {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new AzureCompileError("the workload port must be an integer from 1 to 65535.");
  return ["-listen", `:${port ?? 5678}`, "-text", "Zenith awaiting built release"];
}

/** Container App / job name: lowercase alnum and hyphens, ≤ 32, deterministic. */
export const workloadName = (ctx: Pick<CompileContext, "namePrefix">, address: string): string => cloudName(ctx, address, { max: CONTAINER_APP_NAME_MAX });

const KV_SECRET_URI = /^https:\/\/[a-z0-9][a-z0-9-]{1,22}[a-z0-9]\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]{1,127}(\/[0-9a-f]{32})?$/;

/** A Container Apps secret name: lowercase, alnum/hyphen, unique per env key. */
export const acaSecretName = (envKey: string): string => `${slug(envKey).slice(0, 40)}-${hash6(envKey)}`;

export interface WorkloadParts {
  name: string;
  containerName: string;
  /** Literal artifact image or the fixed built-workload bootstrap image. */
  image: string;
  /** the literal image reference when it is known at compile time (image artifacts) */
  literalImage?: string;
  size: AcaSize;
  cpu: number;
  memory: string;
  identityId?: string;
  identityBlock?: { type: "UserAssigned"; identity_ids: string[] };
  registry: { server: string; identity: string }[];
  secrets: { name: string; identity: string; key_vault_secret_id: string }[];
  env: { name: string; value?: string; secret_name?: string }[];
}

interface WorkloadSpecLike {
  vcpu: number;
  memoryMb: number;
  artifact: ArtifactSpec;
  env: EnvEntry[];
}

function findIdentity(node: ResourceNode, ctx: CompileContext): ResourceNode | undefined {
  return dependencies(node, ctx, (n) => n.kind === "identity" && n.spec.workload === node.address)[0];
}

function secretUriFor(node: ResourceNode, ctx: CompileContext, ref: string, key: string): string {
  const secret = dependencies(node, ctx, (n) => n.kind === "secret" && n.spec.secretRef === ref)[0];
  if (!secret) throw new AzureCompileError(`env ${key} references a secret that is not in the graph as a dependency.`, node.address);
  if (secret.ownership === "managed") return exportRef(secret.address, "secret_uri");
  const external = secret.externalRef ?? "";
  if (!KV_SECRET_URI.test(external)) {
    throw new AzureCompileError(`env ${key} references a secret that Zenith does not own and that is not an Azure Key Vault secret URI; only Key Vault secrets can be wired into Azure workloads.`, node.address);
  }
  return external;
}

export function buildWorkload(node: ResourceNode, ctx: CompileContext, spec: WorkloadSpecLike): WorkloadParts {
  const a = node.address;
  const size = acaSize(spec.vcpu, spec.memoryMb, a);
  const identity = findIdentity(node, ctx);
  const identityId = identity ? exportRef(identity.address, "id") : undefined;

  const secrets: WorkloadParts["secrets"] = [];
  const env: WorkloadParts["env"] = [];
  for (const e of [...spec.env].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))) {
    if ("secretRef" in e) {
      if (!identityId) throw new AzureCompileError(`env ${e.key} is a secret reference but the workload has no identity node to read Key Vault with.`, a);
      const name = acaSecretName(e.key);
      secrets.push({ name, identity: identityId, key_vault_secret_id: secretUriFor(node, ctx, e.secretRef, e.key) });
      env.push({ name: e.key, secret_name: name });
    } else {
      env.push({ name: e.key, value: e.value });
    }
  }

  const registry: WorkloadParts["registry"] = [];
  let image: string;
  let literalImage: string | undefined;
  const artifact = spec.artifact;
  if (artifact.type === "blueprint") {
    throw new AzureCompileError(`blueprint artifact "${artifact.blueprint}" can only run on the sandbox provider.`, a);
  } else if (artifact.type === "image") {
    literalImage = artifact.ref;
    image = artifact.ref;
    const host = artifact.ref.split("/")[0];
    if (ANY_ACR_HOST.test(host.toLowerCase())) {
      if (!identityId) throw new AzureCompileError(`image ${artifact.ref} is in an Azure Container Registry but the workload has no identity to pull with.`, a);
      registry.push({ server: host.toLowerCase(), identity: identityId });
    }
  } else {
    if (!artifact.registry) throw new AzureCompileError("a built artifact needs a container registry.", a);
    const registryNode = requireNode(ctx, artifact.registry, "the image registry", a);
    if (registryNode.kind !== "container_registry" || registryNode.provider !== "azure" || registryNode.region !== node.region) throw new AzureCompileError("a built artifact needs an Azure container registry in this region.", a);
    if (!identityId) throw new AzureCompileError("a built artifact is pulled from ACR with the workload identity, but the workload has no identity node.", a);
    const login = exportRef(artifact.registry, "login_server");
    image = BOOTSTRAP_IMAGE;
    registry.push({ server: login, identity: identityId });
  }

  return {
    name: workloadName(ctx, a),
    containerName: slug(nodeNameOf(a)).slice(0, 63),
    image,
    literalImage,
    size,
    cpu: size.cpu,
    memory: acaMemory(size.memoryGi),
    identityId,
    identityBlock: identityId ? { type: "UserAssigned", identity_ids: [identityId] } : undefined,
    registry,
    secrets,
    env,
  };
}

/** Is this node the target of a route of the environment's load balancer (=> external ingress)? */
export function isRouted(node: ResourceNode, ctx: CompileContext): boolean {
  const lb = ctx.node("load_balancer/public");
  if (!lb || lb.kind !== "load_balancer" || lb.provider !== "azure") return false;
  const routes = lb.spec.routes;
  return Array.isArray(routes) && routes.some((r) => (r as { target?: unknown }).target === node.address);
}

/** Parse Container Apps memory strings (`1Gi`, `512Mi`, `0.5Gi`) to megabytes. */
export function memoryToMb(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)(Gi|Mi|G|M)$/i.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return unit === "gi" || unit === "g" ? Math.round(n * 1024) : Math.round(n);
}
