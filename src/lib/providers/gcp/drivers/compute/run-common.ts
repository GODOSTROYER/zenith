/**
 * Pieces shared by Cloud Run services and jobs: sizing, image, environment
 * (plain values and Secret Manager references), the runtime service account,
 * and Direct VPC egress.
 *
 * Direct VPC egress (chosen over a Serverless VPC Access connector): the
 * revision gets network interfaces in a private subnet of the environment's
 * VPC with `egress = PRIVATE_RANGES_ONLY` — private (RFC 1918 and PSA)
 * destinations go through the VPC, everything else leaves directly, so no
 * connector instances and no NAT are needed. The interface carries a network
 * tag derived from the node address so `gcp:firewall_rule` can allow exactly
 * this workload to reach a database. If a node has no private subnet among
 * its dependencies the revision gets no VPC access; the plan shows that, and
 * the service cannot reach private addresses.
 *
 * Secrets: `{ key, secretRef }` entries become `secret_key_ref` (version
 * `latest`). The reference resolves to a `secret` node among the node's
 * dependencies whose `spec.secretRef` matches (→ that node's Secret Manager
 * secret), or is used as-is when it already is a Secret Manager resource name
 * (`projects/<p>/secrets/<id>[/versions/<v>]`). A `vault:` reference that
 * matches no dependency is refused: the value would have nowhere to be read
 * from.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { EnvEntry, IdentitySpec, SecretSpec, SubnetSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, networkTag, tagDescription, tfSub } from "../../naming";
import { depsOfKind, expr, lit, ref } from "../../hcl";

/* -------------------------------- sizing ----------------------------------- */

const CPU_STEPS = [1, 2, 4, 6, 8];

/** Cloud Run CPU value for a portable vCPU count: fractions < 1 stay fractional, ≥ 1 rounds up to a supported step. */
export function runCpu(vcpu: number): number {
  if (!Number.isFinite(vcpu) || vcpu <= 0) throw new GcpCompileError("invalid_spec", "vcpu must be a positive number.");
  if (vcpu < 1) return Math.max(0.08, Math.round(vcpu * 100) / 100);
  return CPU_STEPS.find((c) => c >= vcpu) ?? 8;
}

/** Memory (MiB) at least what the CPU count requires and Cloud Run's 128 MiB floor. */
export function runMemoryMb(memoryMb: number, cpu: number): number {
  if (!Number.isFinite(memoryMb) || memoryMb <= 0) throw new GcpCompileError("invalid_spec", "memoryMb must be a positive number.");
  const floor = cpu >= 6 ? 4096 : cpu >= 4 ? 2048 : cpu >= 2 ? 512 : 128;
  return Math.max(Math.round(memoryMb), floor);
}

/** The API string for a CPU count: `1`, `2`, `500m`. */
export const cpuString = (cpu: number): string => (cpu >= 1 ? String(cpu) : `${Math.round(cpu * 1000)}m`);

/** Parse a Cloud Run CPU quantity (`1`, `0.5`, `500m`) to cores. */
export function parseCpu(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(s.trim());
  if (!m) return undefined;
  return m[2] === "m" ? Number(m[1]) / 1000 : Number(m[1]);
}

/** Parse a memory quantity (`512Mi`, `1Gi`, `512M`) to MiB. */
export function parseMemoryMb(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  const factor: Record<string, number> = { "": 1 / (1024 * 1024), Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576, T: 1e12 / 1048576 };
  return Math.round(n * factor[unit]);
}

/* ------------------------------- artifact ---------------------------------- */

export function imageOf(artifact: unknown, where: string): string {
  const a = artifact as { type?: string; ref?: string } | undefined;
  if (a?.type === "image" && typeof a.ref === "string" && a.ref !== "") return lit(a.ref);
  throw new GcpCompileError(
    "unresolved_artifact",
    `${where}: artifact of type "${String(a?.type)}" has no image reference yet. A built or blueprint artifact must be resolved to { type: "image", ref } (an Artifact Registry digest) after the build and before compile (ADR-0016).`
  );
}

/* ----------------------------- environment --------------------------------- */

const RESERVED_ENV = /^(PORT|K_SERVICE|K_REVISION|K_CONFIGURATION|CLOUD_RUN_JOB|CLOUD_RUN_EXECUTION|CLOUD_RUN_TASK_INDEX|CLOUD_RUN_TASK_ATTEMPT|CLOUD_RUN_TASK_COUNT)$/;
const SECRET_NAME = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/secrets\/[A-Za-z0-9_-]{1,255}(?:\/versions\/(?:latest|\d+))?$/;

export interface EnvBlock {
  name: string;
  value?: string;
  value_source?: { secret_key_ref: { secret: string; version: string }[] }[];
}

function secretFor(entry: { key: string; secretRef: string }, node: ResourceNode, ctx: CompileContext): { secret: string; version: string } {
  for (const dep of depsOfKind(node, ctx, "secret")) {
    if ((dep.spec as unknown as SecretSpec).secretRef === entry.secretRef) return { secret: ref(ctx, dep.address, "id"), version: "latest" };
  }
  if (SECRET_NAME.test(entry.secretRef)) {
    const [base, version] = entry.secretRef.split("/versions/");
    return { secret: base, version: version ?? "latest" };
  }
  throw new GcpCompileError(
    "unresolved_secret_ref",
    `${node.address}: env ${lit(entry.key)} references a secret that is neither a dependency secret node nor a Secret Manager name; its value has nowhere to be read from.`
  );
}

export function envBlocks(env: EnvEntry[] | undefined, node: ResourceNode, ctx: CompileContext): EnvBlock[] {
  const seen = new Set<string>();
  const out: EnvBlock[] = [];
  for (const e of env ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key)) throw new GcpCompileError("invalid_env", `${node.address}: "${lit(e.key).slice(0, 40)}" is not a valid environment variable name.`);
    if (RESERVED_ENV.test(e.key) || e.key.startsWith("K_") || e.key.startsWith("X_GOOGLE_")) throw new GcpCompileError("reserved_env", `${node.address}: ${e.key} is reserved by Cloud Run.`);
    if (seen.has(e.key)) throw new GcpCompileError("duplicate_env", `${node.address}: ${e.key} is defined twice.`);
    seen.add(e.key);
    if ("secretRef" in e) {
      const s = secretFor(e, node, ctx);
      out.push({ name: e.key, value_source: [{ secret_key_ref: [{ secret: s.secret, version: s.version }] }] });
    } else {
      out.push({ name: e.key, value: lit(String(e.value)) });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/* --------------------------- identity and network -------------------------- */

/**
 * The runtime service account reference for a workload: the `identity` node
 * whose `workload` is this node, else a dedicated, permission-less service
 * account created alongside (never the Compute Engine default account, which
 * carries the project Editor role).
 */
export function runtimeIdentity(node: ResourceNode, ctx: CompileContext): { email: string; extra?: { type: string; label: string; body: Record<string, unknown> } } {
  for (const dep of depsOfKind(node, ctx, "identity")) {
    const w = (dep.spec as unknown as IdentitySpec).workload;
    if (w === node.address || w === node.address.split("/").slice(1).join("/")) return { email: ref(ctx, dep.address, "email") };
  }
  const sub = tfSub(node.address, "run");
  return {
    email: expr(`google_service_account.${sub}.email`),
    extra: {
      type: "google_service_account",
      label: sub,
      body: {
        account_id: cloudName(ctx.namePrefix, node.address, { max: 30, min: 6, suffix: "run" }),
        display_name: "Zenith runtime identity",
        description: tagDescription(ctx.tags, node, "runtime identity, no roles", 256),
      },
    },
  };
}

export interface VpcAccess {
  egress: "PRIVATE_RANGES_ONLY";
  network_interfaces: { network: string; subnetwork: string; tags: string[] }[];
}

/** Direct VPC egress into the node's first private subnet, or undefined when it has none. */
export function directVpcEgress(node: ResourceNode, ctx: CompileContext): VpcAccess | undefined {
  const subnet = depsOfKind(node, ctx, "subnet").find((s) => (s.spec as unknown as SubnetSpec).tier === "private");
  if (!subnet) return undefined;
  const s = subnet.spec as unknown as SubnetSpec;
  return {
    egress: "PRIVATE_RANGES_ONLY",
    network_interfaces: [{ network: ref(ctx, s.network, "name"), subnetwork: ref(ctx, subnet.address, "name"), tags: [networkTag(node.address)] }],
  };
}

/** Annotation keys Zenith's day-two operations write; tofu must not revert them. */
export const RESTART_ANNOTATION = "zenith.dev/restart-token";
export const FENCE_ANNOTATION = "zenith.dev/fence-token";
export const SCALE_ANNOTATION = "zenith.dev/scale-operation";

export const IGNORED_OPERATION_ANNOTATIONS = [RESTART_ANNOTATION, FENCE_ANNOTATION, SCALE_ANNOTATION].map((k) => `template[0].annotations["${k}"]`);
