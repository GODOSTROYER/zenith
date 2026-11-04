/**
 * The Fargate task plumbing shared by `aws:ecs_service` and
 * `aws:ecs_scheduled_task`: cluster, security group, execution role, image
 * source, container definition and task definition.
 *
 * Decisions (each one also appears in the drivers' documentation):
 *
 *  CLUSTER      One `aws_ecs_cluster` per workload node, Container Insights on.
 *               The brief asked for one cluster per environment owned by "the
 *               lexicographically first" workload, but `CompileContext` gives a
 *               driver no way to enumerate its siblings, and such an owner rule
 *               would REPLACE the cluster (and every service in it) the moment
 *               the first workload is renamed or removed. A cluster is free, so
 *               each node owns its own and deleting a node deletes exactly its
 *               own objects.
 *
 *  SIZE         vcpu/memory are rounded UP to a valid Fargate combination
 *               (`fargateSize`); the drift expectation uses the rounded values.
 *
 *  IMAGE        `artifact.type "image"`: the literal, validated reference.
 *               `artifact.type "built"`: the OpenTofu contract has no variables
 *               (TofuFragment has no `variable` key and TF_VAR_* is refused by
 *               the runner), so the image that a build produced cannot be
 *               passed in as a variable. Instead the image reference lives in an
 *               SSM parameter ("image pointer", `/zenith<suffix>/image-pointer/<environment>/<node>/image`):
 *               tofu creates it once with a bootstrap value and then ignores its
 *               value; the deploy workflow's `deployImage` writes the new
 *               digest there, and the task definition reads it through a data
 *               source. So `tofu apply` (an env-var change, a cpu bump…) always
 *               renders the task definition with the image that is deployed
 *               now instead of reverting it. Until the first deploy the
 *               bootstrap value names a tag that does not exist, so a built
 *               service's first tasks fail to pull — the workflow builds and
 *               deploys right after applying infrastructure.
 *
 *  SECRETS      `EnvEntry.secretRef` becomes `secrets: [{ name, valueFrom: <ARN> }]`
 *               (ARN of the secret node, via `ctx.ref`); the execution role may
 *               read exactly those ARNs. No value is ever in a fragment.
 *
 *  IAM          execution role: `ecr:GetAuthorizationToken` on `*` (AWS defines
 *               no resource-level permission for it: the single documented
 *               wildcard resource), ECR pull on exactly the repository, log
 *               stream writes on exactly this container's streams, and
 *               GetSecretValue on exactly the referenced secrets. Roles carry
 *               the `ZenithWorkloadBoundary` permissions boundary. The task
 *               role is the `identity/<n>` node's role, referenced not created.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { ContainerServiceSpec, EnvEntry, IdentitySpec, ScheduledJobSpec } from "@/lib/resources/specs";
import { addSecurityGroup, cloudName, nodeName, securityGroupLabel, subnetsOf, tfLabel } from "@/lib/providers/aws/drivers/shared";
import { dependencies, requireOne } from "./support/refs";
import { fargateSize, type FargateSize } from "./support/fargate";
import { ecrCoordinates, parseImageRef } from "./support/image";
import {
  ComputeCompileError,
  Frag,
  TfCat,
  TfRef,
  arnOf,
  assumeRoleJson,
  attr,
  boundaryArn,
  cat,
  environmentData,
  policyJson,
  rawRef,
  refOf,
  renderJsonText,
  tagsFor,
  type Env,
  type PolicyStatement,
} from "./support/tf";

export type WorkloadSpec = ContainerServiceSpec | (ScheduledJobSpec & { port?: undefined });

/** The awslogs stream prefix; streams are `ecs/<container>/<task id>`. */
export const LOG_STREAM_PREFIX = "ecs";

/** What the image pointer holds before the first deploy (a tag that does not exist). */
export const BOOTSTRAP_TAG = "zenith-bootstrap";

/** SSM parameter holding the deployed image of a built workload. */
export function imagePointerName(environmentId: string, address: string, bootstrapNameSuffix = ""): string {
  // Dedicated sub-path: the bootstrap grants SSM access to exactly /zenith<suffix>/image-pointer/*, so no other
  // parameter under /zenith (workload-read config or secrets) is reachable through that grant.
  return `/zenith${bootstrapNameSuffix}/image-pointer/${environmentId}/${address}/image`;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_VALUE = 4096;

export interface TaskResources {
  label: string;
  name: string;
  size: FargateSize;
  cluster: TfRef;
  taskDefinition: TfRef;
  execRole: TfRef;
  securityGroup: TfRef;
  /** objects the workload needs in place before its first task starts: its policy and its egress rule */
  prerequisites: string[];
  subnets: TfRef[];
  env: Env;
  spec: WorkloadSpec;
  /** the container ports declared by the task definition */
  ports: number[];
}

function plainEnv(spec: WorkloadSpec): { name: string; value: string }[] {
  const out = new Map<string, string>();
  for (const e of spec.env ?? []) {
    if (!("value" in e)) continue;
    if (!ENV_KEY.test(e.key)) throw new ComputeCompileError("invalid_spec", `environment variable name "${e.key.slice(0, 40)}" is not a valid identifier.`);
    if (typeof e.value !== "string" || e.value.length > MAX_ENV_VALUE) throw new ComputeCompileError("invalid_spec", `environment variable ${e.key} must be a string of at most ${MAX_ENV_VALUE} characters.`);
    if (out.has(e.key)) throw new ComputeCompileError("invalid_spec", `environment variable ${e.key} is declared twice.`);
    out.set(e.key, e.value);
  }
  if (spec.port !== undefined && !out.has("PORT")) out.set("PORT", String(spec.port));
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => ({ name, value }));
}

/** env key → the secret node that holds its value, read from this workload's identity grants. */
function secretNodes(ctx: CompileContext, node: ResourceNode, env: EnvEntry[]): { key: string; secret: ResourceNode }[] {
  const refs = env.filter((e): e is { key: string; secretRef: string } => "secretRef" in e);
  if (refs.length === 0) return [];
  const identity = dependencies(ctx, node, "identity")[0];
  const grants = identity ? (identity.spec as Partial<IdentitySpec>).grants ?? [] : [];
  const out: { key: string; secret: ResourceNode }[] = [];
  for (const e of [...refs].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (!ENV_KEY.test(e.key)) throw new ComputeCompileError("invalid_spec", `environment variable name "${e.key.slice(0, 40)}" is not a valid identifier.`);
    const grant = grants.find((g) => g.via.includes(`env:${e.key}`) && g.target.startsWith("secret/"));
    const secret = grant ? ctx.node(grant.target) : undefined;
    if (!grant || !secret || secret.kind !== "secret") {
      throw new ComputeCompileError("missing_neighbour", `environment variable ${e.key} is a secret reference but its identity has no grant naming a secret node for it (expected a grant via "env:${e.key}").`);
    }
    out.push({ key: e.key, secret });
  }
  if (new Set(out.map((o) => o.key)).size !== out.length) throw new ComputeCompileError("invalid_spec", "an environment variable is declared twice.");
  return out;
}

interface ImageSource {
  /** the image expression for the container definition */
  image: string | TfRef;
  /** ECR repository ARN the execution role may pull from (absent for public images) */
  pullFrom?: TfRef | TfCat;
}

function emitImage(b: Frag, node: ResourceNode, ctx: CompileContext, label: string, spec: WorkloadSpec, env: Env): ImageSource {
  const artifact = spec.artifact;
  if (!artifact) throw new ComputeCompileError("invalid_spec", "the workload has no artifact.");
  if (artifact.type === "blueprint") throw new ComputeCompileError("unsupported", `blueprint source "${artifact.blueprint}" runs only on the sandbox provider; give ${node.address} an image or git source.`);
  if (artifact.type === "image") {
    const parsed = parseImageRef(artifact.ref);
    const ecr = ecrCoordinates(parsed);
    return { image: parsed.ref, ...(ecr ? { pullFrom: cat("arn:", env.partition, ":ecr:", ecr.region, ":", ecr.account, `:repository/${ecr.repository}`) } : {}) };
  }
  // built: the registry node supplies the repository; the image pointer supplies the deployed reference
  if (!artifact.registry) throw new ComputeCompileError("invalid_spec", "a built workload needs a container_registry to pull from.");
  const registry = ctx.node(artifact.registry);
  if (!registry || registry.kind !== "container_registry") throw new ComputeCompileError("missing_neighbour", `registry ${artifact.registry} is not a container_registry node of this graph.`);
  if (!/^[A-Za-z0-9_.-]+$/.test(ctx.environmentId)) throw new ComputeCompileError("invalid_spec", "the environment id cannot be used in an SSM parameter name.");
  const repoUrl = refOf(ctx, registry.address, "repository_url");
  const pointer = b.resource("aws_ssm_parameter", `${label}_image`, {
    name: imagePointerName(ctx.environmentId, node.address, ctx.awsBootstrap?.bootstrapNameSuffix),
    // Plain String on purpose: the image reference is not a secret, and the deploy role may only touch SSM under the pointer prefix.
    type: "String",
    description: `Deployed image of ${node.address}. Written by Zenith deployments; tofu never overwrites it.`,
    insecure_value: cat(repoUrl, `:${BOOTSTRAP_TAG}`),
    tags: tagsFor(ctx, node),
    lifecycle: { ignore_changes: ["insecure_value"] },
  });
  const read = b.data("aws_ssm_parameter", `${label}_image`, { name: attr(pointer, "name"), with_decryption: false, depends_on: [pointer.expr] });
  return { image: attr(read, "insecure_value"), pullFrom: refOf(ctx, registry.address, "arn") };
}

function execPolicy(env: Env, image: ImageSource, logGroupName: TfRef, containerName: string, secrets: { secret: ResourceNode; arn: TfRef }[]): PolicyStatement[] {
  const statements: PolicyStatement[] = [];
  if (image.pullFrom) {
    statements.push({ Sid: "RegistryToken", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"], wildcard: "registry_token" });
    statements.push({ Sid: "PullImage", Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource: [image.pullFrom] });
  }
  statements.push({
    Sid: "WriteLogs",
    Effect: "Allow",
    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
    Resource: [arnOf(env, "logs", ["log-group:", logGroupName, `:log-stream:${LOG_STREAM_PREFIX}/${containerName}/*`])],
    wildcard: "log_stream",
  });
  if (secrets.length > 0) {
    statements.push({ Sid: "ReadReferencedSecrets", Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: secrets.map((s) => s.arn) });
  }
  return statements;
}

/**
 * Emit everything a Fargate task needs into `b`. Nothing here is specific to
 * a long-running service or a scheduled job; the callers add the service /
 * rule around it.
 */
export function emitTask(b: Frag, node: ResourceNode, ctx: CompileContext, spec: WorkloadSpec, extraPorts: number[] = []): TaskResources {
  const label = tfLabel(node.address);
  const name = nodeName(node.address);
  const size = fargateSize(spec.vcpu, spec.memoryMb);
  const env = environmentData(b, label, ctx.region);

  const logGroup = requireOne(ctx, node, "log_group", "the awslogs destination");
  const logGroupName = refOf(ctx, logGroup.address, "name");
  const identity = dependencies(ctx, node, "identity")[0];
  const subnets = subnetsOf(node, ctx, "private");
  if (subnets.length === 0) throw new ComputeCompileError("missing_neighbour", `${node.address} needs at least one private subnet in its dependsOn.`);

  const secrets = secretNodes(ctx, node, spec.env ?? []).map((s) => ({ ...s, arn: refOf(ctx, s.secret.address, "arn") }));
  const image = emitImage(b, node, ctx, label, spec, env);

  // cluster
  const clusterName = cloudName(ctx.namePrefix, name, 255);
  const cluster = b.resource("aws_ecs_cluster", label, {
    name: clusterName,
    setting: [{ name: "containerInsights", value: "enabled" }],
    tags: tagsFor(ctx, node, clusterName),
  });

  // security group: owned by this node (shared contract), baseline egress 443
  addSecurityGroup(b.inner, node, ctx);
  const securityGroup = rawRef(`aws_security_group.${securityGroupLabel(node.address)}.id`);

  // execution role + its policy
  const execName = `${cloudName(ctx.namePrefix, name, 64 - "-exec".length)}-exec`;
  const execRole = b.resource("aws_iam_role", `${label}_exec`, {
    name: execName,
    assume_role_policy: assumeRoleJson("ecs-tasks.amazonaws.com", ctx),
    permissions_boundary: boundaryArn(env, "app", ctx),
    tags: tagsFor(ctx, node, execName),
  });
  const execPolicyResource = b.resource("aws_iam_role_policy", `${label}_exec`, {
    name: "execution",
    role: attr(execRole, "name"),
    policy: policyJson(execPolicy(env, image, logGroupName, name, secrets), `${node.address} execution role`),
  });

  // task definition
  const ports = [...new Set([...(spec.port !== undefined ? [spec.port] : []), ...extraPorts])].sort((a, c) => a - c);
  const container: Record<string, unknown> = {
    name,
    image: image.image,
    essential: true,
    ...(ports.length ? { portMappings: ports.map((p) => ({ containerPort: p, protocol: "tcp" })) } : {}),
    environment: plainEnv(spec),
    secrets: secrets.map((s) => ({ name: s.key, valueFrom: s.arn })),
    // documented choice: the image's filesystem stays writable; many stock images write to /tmp or /var
    readonlyRootFilesystem: false,
    logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": logGroupName, "awslogs-region": ctx.region, "awslogs-stream-prefix": LOG_STREAM_PREFIX } },
  };
  const family = cloudName(ctx.namePrefix, name, 255);
  const taskDefinition = b.resource("aws_ecs_task_definition", label, {
    family,
    network_mode: "awsvpc",
    requires_compatibilities: ["FARGATE"],
    cpu: String(size.cpu),
    memory: String(size.memoryMb),
    execution_role_arn: attr(execRole, "arn"),
    ...(identity ? { task_role_arn: refOf(ctx, identity.address, "arn") } : {}),
    runtime_platform: [{ operating_system_family: "LINUX", cpu_architecture: "X86_64" }],
    container_definitions: renderJsonText([container]),
    tags: tagsFor(ctx, node, family),
    // a replaced revision is created first so the service can switch before the old one is deregistered
    lifecycle: { create_before_destroy: true },
  });

  return {
    label,
    name,
    size,
    cluster,
    taskDefinition,
    execRole,
    securityGroup,
    prerequisites: [execPolicyResource.expr, `aws_vpc_security_group_egress_rule.${securityGroupLabel(node.address)}_https`],
    subnets: subnets.map((s) => refOf(ctx, s.address, "id")),
    env,
    spec,
    ports,
  };
}
