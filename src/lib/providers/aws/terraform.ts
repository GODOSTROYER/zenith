/**
 * Manifest → real Terraform. This is the no-lock-in guarantee: the HCL this
 * module emits is meant to be run with `terraform apply` and your own
 * credentials, with or without Orrery in the picture.
 *
 * Design choices that keep the bundle applyable into a fresh account:
 *  - the account's default VPC/subnets are read through data sources rather
 *    than a bespoke network module you would then have to own;
 *  - every generated credential lands in SSM Parameter Store (SecureString)
 *    and reaches containers through the task definition's `secrets` block,
 *    never as a plaintext env var;
 *  - S3 and SQS access comes from per-service task roles, not access keys.
 *
 * Workstream A.
 */
import { bindingEnv, findNode } from "@/lib/domain/graph";
import { SIZE_SPECS } from "@/lib/cost/pricing";
import type {
  Environment,
  Manifest,
  Route,
  Service,
  ServiceSize,
} from "@/lib/domain/types";
import type { ExportFile } from "@/lib/providers/types";

/* --------------------------------- helpers -------------------------------- */

/** A safe Terraform block label. */
const tf = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");

/** Fargate only accepts a fixed CPU/memory lattice; clamp SIZE_SPECS onto it. */
export function fargateSpec(size: ServiceSize): { cpu: number; memory: number } {
  const { vcpu, memoryMb } = SIZE_SPECS[size];
  const cpu = Math.max(256, Math.round(vcpu * 1024));
  const floor: Record<number, number> = { 256: 512, 512: 1024, 1024: 2048, 2048: 4096 };
  return { cpu, memory: Math.max(memoryMb, floor[cpu] ?? 512) };
}

const DB_CLASS: Record<ServiceSize, string> = {
  nano: "db.t4g.micro",
  small: "db.t4g.small",
  standard: "db.t4g.medium",
  performance: "db.m6g.large",
};

const CACHE_CLASS: Record<ServiceSize, string> = {
  nano: "cache.t4g.micro",
  small: "cache.t4g.small",
  standard: "cache.t4g.medium",
  performance: "cache.m6g.large",
};

const DB_STORAGE: Record<ServiceSize, number> = {
  nano: 20,
  small: 20,
  standard: 50,
  performance: 200,
};

const managed = <T extends { ownership: string }>(xs: T[]) =>
  xs.filter((x) => x.ownership === "managed");

/**
 * A `referenced` node exists in the customer's account and this bundle must
 * never declare it as a resource. Its attributes come from variables the user
 * fills instead, so the HCL still validates and still plans.
 */
const refVar = (nodeName: string, field: string) => `ref_${tf(nodeName)}_${field}`;

/** SSM parameter names accept only these characters. */
const ssmSafe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "-");

/** A `variable` block the bundle must declare. */
interface TfVariable {
  name: string;
  description: string;
  /** HCL default. Omitted = the user must supply it. */
  default?: string;
}

/**
 * A SecureString parameter the bundle creates so the first `terraform apply`
 * does not fail when ECS resolves the task definition's `secrets` block.
 */
interface SecretParam {
  /** terraform resource label */
  label: string;
  /** name under /${var.name_prefix}/ */
  path: string;
  /** key into var.secret_values */
  key: string;
  description: string;
}

/** Route serving this service, if any. */
function routeOf(m: Manifest, serviceId: string): Route | undefined {
  const b = m.bindings.find(
    (x) => x.capability === "http" && x.to === serviceId && m.routes.some((r) => r.id === x.from)
  );
  return b ? m.routes.find((r) => r.id === b.from) : undefined;
}

const projectSlug = (env: Environment) => env.baseDomain.split(".")[0] || "orrery";

/* ------------------------- container env derivation ------------------------ */

interface ContainerEnv {
  env: { name: string; expr: string }[];
  secrets: { name: string; expr: string }[];
  /** SSM parameters this service's bindings require us to create */
  params: SecretParam[];
  /** variables referenced (non-managed) targets require the user to fill */
  vars: TfVariable[];
  /** IAM statements the service's task role needs */
  statements: string[];
  notes: string[];
}

/**
 * Translate a service's manifest env + bindings into ECS task-definition
 * environment/secrets entries. The right-hand sides are HCL expressions, so
 * they resolve to real endpoints at apply time.
 */
export function containerEnv(m: Manifest, s: Service, _env: Environment): ContainerEnv {
  const out: ContainerEnv = {
    env: [],
    secrets: [],
    params: [],
    vars: [],
    statements: [],
    notes: [],
  };

  if (s.port) out.env.push({ name: "PORT", expr: `"${s.port}"` });

  for (const e of s.env) {
    if (e.key === "ORRERY_CHAOS") continue; // sandbox-only failure injection
    if (e.value !== undefined) {
      out.env.push({ name: e.key, expr: JSON.stringify(e.value) });
    } else if (e.secretRef) {
      const p: SecretParam = {
        label: `secret_${tf(e.secretRef)}`,
        path: `secrets/${ssmSafe(e.secretRef)}`,
        key: e.secretRef,
        description: `Manifest secretRef "${e.secretRef}".`,
      };
      out.params.push(p);
      // Point at the parameter this bundle creates, so ECS cannot start
      // before it exists — a bare ARN string would fail at task start.
      out.secrets.push({ name: e.key, expr: `aws_ssm_parameter.${p.label}.arn` });
      out.notes.push(
        `${s.name}.${e.key} reads SSM parameter /<name_prefix>/${p.path}, which this bundle creates as a placeholder. Set the real value with \`aws ssm put-parameter --overwrite\` — the parameter ignores later value changes, so Terraform will not revert it.`
      );
    }
  }

  for (const b of m.bindings.filter((x) => x.from === s.id)) {
    const target = findNode(m, b.to);
    if (!target) continue;
    const keys = bindingEnv(m, b).map((k) => k.key);
    const P = target.node.name.replace(/-/g, "_").toUpperCase();
    const t = tf(target.node.name);
    const name = target.node.name;

    // Referenced targets are not declared anywhere in this bundle, so every
    // attribute has to come from a variable rather than a resource address.
    if (target.node.ownership !== "managed" && b.capability !== "http") {
      const ext = target.type === "resource" ? target.node.externalRef : undefined;
      const v = (field: string, description: string, dflt?: string): string => {
        const n = refVar(name, field);
        out.vars.push({ name: n, description, default: dflt });
        return `var.${n}`;
      };
      const secretParam = (field: string, description: string): SecretParam => {
        const p: SecretParam = {
          // tf() the whole label: a hyphen is legal in a block label but makes
          // `aws_ssm_parameter.ref_x_smtp-password` parse as subtraction.
          label: tf(`ref_${name}_${field}`),
          path: `refs/${ssmSafe(name)}/${field}`,
          key: `refs/${ssmSafe(name)}/${field}`,
          description,
        };
        out.params.push(p);
        return p;
      };
      const why = `Referenced ${target.node.kind} "${name}" — Orrery never provisions or mutates it`;

      if (b.capability === "sql") {
        out.env.push(
          { name: `${P}_HOST`, expr: v("host", `${why}. Hostname of the database.`, ext) },
          { name: `${P}_PORT`, expr: v("port", `${why}. Port.`, "5432") },
          { name: `${P}_USER`, expr: v("user", `${why}. Login role for ${s.name}.`) },
          { name: `${P}_DATABASE`, expr: v("database", `${why}. Database name.`, tf(name).toLowerCase()) }
        );
        const p = secretParam("password", `${why}. Password for ${s.name}'s login role.`);
        out.secrets.push({ name: `${P}_PASSWORD`, expr: `aws_ssm_parameter.${p.label}.arn` });
        const u = secretParam("url", `${why}. Full connection URL, if your app wants one.`);
        out.secrets.push({ name: `${P}_URL`, expr: `aws_ssm_parameter.${u.label}.arn` });
      } else if (b.capability === "cache") {
        out.env.push({
          name: `${P}_URL`,
          expr: v("url", `${why}. Redis URL, e.g. "redis://host:6379".`, ext),
        });
      } else if (b.capability === "blob") {
        const bucket = v("bucket", `${why}. Existing S3 bucket name.`, ext);
        out.env.push(
          { name: `${P}_BUCKET`, expr: bucket },
          { name: `${P}_ENDPOINT`, expr: `"https://s3.\${var.region}.amazonaws.com"` }
        );
        out.statements.push(
          `  statement {\n    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]\n    resources = ["arn:aws:s3:::\${${bucket}}", "arn:aws:s3:::\${${bucket}}/*"]\n  }`
        );
      } else if (b.capability === "queue_publish" || b.capability === "queue_consume") {
        out.env.push({ name: `${P}_URL`, expr: v("queue_url", `${why}. Existing SQS queue URL.`, ext) });
        const arn = v("queue_arn", `${why}. Existing SQS queue ARN, for the task role policy.`);
        const actions =
          b.capability === "queue_publish"
            ? `["sqs:SendMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]`
            : `["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]`;
        out.statements.push(
          `  statement {\n    actions   = ${actions}\n    resources = [${arn}]\n  }`
        );
      } else if (b.capability === "smtp") {
        out.env.push(
          { name: `${P}_HOST`, expr: v("smtp_host", `${why}. SMTP hostname.`, ext) },
          { name: `${P}_PORT`, expr: v("smtp_port", `${why}. SMTP port.`, "587") },
          { name: `${P}_USER`, expr: v("smtp_user", `${why}. SMTP username.`) }
        );
        const p = secretParam("smtp-password", `${why}. SMTP password.`);
        out.secrets.push({ name: `${P}_PASSWORD`, expr: `aws_ssm_parameter.${p.label}.arn` });
      }

      out.notes.push(
        `${name} is referenced, not managed. This bundle declares no resource for it — fill \`${refVar(name, "…")}\` in terraform.tfvars and put its credentials in SSM (see secrets.tf). \`imports.tf\` shows how to hand it to Terraform later if you change your mind.`
      );
      continue;
    }

    if (b.capability === "sql") {
      out.env.push(
        { name: `${P}_HOST`, expr: `aws_db_instance.${t}.address` },
        { name: `${P}_PORT`, expr: `tostring(aws_db_instance.${t}.port)` },
        { name: `${P}_USER`, expr: `aws_db_instance.${t}.username` },
        { name: `${P}_DATABASE`, expr: `aws_db_instance.${t}.db_name` }
      );
      out.secrets.push(
        { name: `${P}_PASSWORD`, expr: `aws_ssm_parameter.${t}_password.arn` },
        { name: `${P}_URL`, expr: `aws_ssm_parameter.${t}_url.arn` }
      );
    } else if (b.capability === "cache") {
      out.env.push({
        name: `${P}_URL`,
        expr: `"redis://\${aws_elasticache_cluster.${t}.cache_nodes[0].address}:6379"`,
      });
    } else if (b.capability === "blob") {
      out.env.push(
        { name: `${P}_BUCKET`, expr: `aws_s3_bucket.${t}.bucket` },
        { name: `${P}_ENDPOINT`, expr: `"https://s3.\${var.region}.amazonaws.com"` }
      );
      out.statements.push(
        `  statement {\n    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]\n    resources = [aws_s3_bucket.${t}.arn, "\${aws_s3_bucket.${t}.arn}/*"]\n  }`
      );
      if (keys.includes(`${P}_ACCESS_KEY`))
        out.notes.push(
          `${s.name} reaches ${target.node.name} through its task role, so ${P}_ACCESS_KEY / ${P}_SECRET_KEY are deliberately not injected — the AWS SDK picks the role up automatically.`
        );
    } else if (b.capability === "queue_publish" || b.capability === "queue_consume") {
      out.env.push({ name: `${P}_URL`, expr: `aws_sqs_queue.${t}.url` });
      const actions =
        b.capability === "queue_publish"
          ? `["sqs:SendMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]`
          : `["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]`;
      out.statements.push(
        `  statement {\n    actions   = ${actions}\n    resources = [aws_sqs_queue.${t}.arn]\n  }`
      );
    } else if (b.capability === "smtp") {
      out.env.push(
        { name: `${P}_HOST`, expr: `"email-smtp.\${var.region}.amazonaws.com"` },
        { name: `${P}_PORT`, expr: `"587"` },
        { name: `${P}_USER`, expr: `aws_iam_access_key.ses_smtp.id` }
      );
      out.secrets.push({
        name: `${P}_PASSWORD`,
        expr: `aws_ssm_parameter.ses_smtp_password.arn`,
      });
    } else if (b.capability === "http") {
      const peer = m.services.find((x) => x.id === b.to);
      const r = peer ? routeOf(m, peer.id) : undefined;
      if (r) {
        out.env.push({ name: `${P}_URL`, expr: `"${r.tls ? "https" : "http"}://${r.host}"` });
      } else if (peer) {
        out.notes.push(
          `${s.name} → ${peer.name} is an internal HTTP binding. ${P}_URL is not injected because ${peer.name} has no public route; add ECS Service Connect (or a private ALB) and set ${P}_URL yourself.`
        );
      }
    }
  }

  return out;
}

/** Services that get a container. Static sites are S3, not ECS. */
const containerServices = (m: Manifest) =>
  managed(m.services).filter((s) => s.kind !== "static");

/**
 * Everything the manifest forces the bundle to declare beyond its own managed
 * resources: variables for referenced targets, and SSM parameters for secrets.
 * Collected once so `variables.tf`/`secrets.tf` and the task definitions can
 * never drift apart — that drift is exactly what made the export fail
 * `terraform validate`.
 */
function scaffold(m: Manifest, env: Environment): {
  vars: TfVariable[];
  secrets: SecretParam[];
} {
  const vars = new Map<string, TfVariable>();
  const secrets = new Map<string, SecretParam>();
  for (const s of containerServices(m)) {
    const c = containerEnv(m, s, env);
    for (const v of c.vars) if (!vars.has(v.name)) vars.set(v.name, v);
    for (const p of c.params) if (!secrets.has(p.label)) secrets.set(p.label, p);
  }
  return { vars: [...vars.values()], secrets: [...secrets.values()] };
}

function envJson(c: ContainerEnv): string {
  const lines = c.env.map((e) => `        { name = "${e.name}", value = ${e.expr} }`);
  return lines.length ? `[\n${lines.join(",\n")}\n      ]` : "[]";
}

function secretsJson(c: ContainerEnv): string {
  const lines = c.secrets.map((e) => `        { name = "${e.name}", valueFrom = ${e.expr} }`);
  return lines.length ? `[\n${lines.join(",\n")}\n      ]` : "[]";
}

/* --------------------------------- files ---------------------------------- */

function providersTf(): string {
  return `terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Origin      = "orrery-export"
    }
  }
}

data "aws_caller_identity" "current" {}
`;
}

function variablesTf(env: Environment, m: Manifest, hasRoutes: boolean, hasEmail: boolean): string {
  // "" means "use the ECR repository this bundle creates for the service".
  const images = containerServices(m)
    .map(
      (s) => `    "${s.name}" = "${s.source.type === "image" ? s.source.image : ""}"`
    )
    .join("\n");

  const { vars, secrets } = scaffold(m, env);

  const refVars = vars
    .map(
      (v) => `
variable "${v.name}" {
  description = ${JSON.stringify(v.description)}
  type        = string${v.default !== undefined ? `\n  default     = ${JSON.stringify(v.default)}` : ""}
}
`
    )
    .join("");

  const secretVar = secrets.length
    ? `
# Placeholders only. Orrery never held these values, so it cannot put them here.
# After the first apply, set each real value out-of-band:
#   aws ssm put-parameter --overwrite --type SecureString \\
#     --name "/<name_prefix>/<path>" --value "<value>"
# The parameters ignore later value changes, so Terraform will not revert you.
variable "secret_values" {
  description = "Initial value per secret. Anything left as PLACEHOLDER must be set with aws ssm put-parameter before the service can start."
  type        = map(string)
  sensitive   = true

  default = {
${secrets.map((p) => `    ${JSON.stringify(p.key)} = "PLACEHOLDER"`).join("\n")}
  }
}
`
    : "";

  const zoneVar = hasRoutes
    ? `
variable "route53_zone_name" {
  description = "Public hosted zone that owns the route hostnames, e.g. \\"example.com\\". Must already exist."
  type        = string
}
`
    : "";

  const mailVar = hasEmail
    ? `
variable "mail_domain" {
  description = "Domain to verify with SES for outbound mail."
  type        = string
}
`
    : "";

  return `variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "${env.region.startsWith("sim-") ? "us-east-1" : env.region}"
}

variable "project_name" {
  description = "Project name, used for tagging."
  type        = string
  default     = "${projectSlug(env)}"
}

variable "environment" {
  description = "Environment name, used for tagging."
  type        = string
  default     = "${env.name}"
}

variable "name_prefix" {
  description = "Prefix for every resource name. Keep it short: ALB target group names cap at 32 characters."
  type        = string
  default     = "${projectSlug(env)}-${env.name}"
}
${
  images
    ? `
variable "container_images" {
  description = "Image reference per service. Leave a service empty to use the ECR repository this bundle creates for it (push a :latest tag there first)."
  type        = map(string)

  default = {
${images}
  }
}
`
    : ""
}${zoneVar}${mailVar}${secretVar}${refVars}`;
}

/**
 * SecureString parameters for every `secretRef` and every referenced-resource
 * credential. Without these the first apply succeeds and then ECS fails at
 * task start, unable to resolve the `secrets` block — the worst possible time
 * to find out.
 */
function secretsTf(m: Manifest, env: Environment): string {
  const { secrets } = scaffold(m, env);
  if (!secrets.length) return "";
  return (
    `# Created empty on purpose: Orrery never holds secret values. Each parameter
# starts at the placeholder in var.secret_values and then ignores value
# changes, so \`aws ssm put-parameter --overwrite\` is the only writer.
` +
    secrets
      .map(
        (p) => `
resource "aws_ssm_parameter" "${p.label}" {
  name        = "/\${var.name_prefix}/${p.path}"
  description = ${JSON.stringify(p.description)}
  type        = "SecureString"
  value       = lookup(var.secret_values, ${JSON.stringify(p.key)}, "PLACEHOLDER")

  lifecycle {
    ignore_changes = [value]
  }
}
`
      )
      .join("")
  );
}

/**
 * Referenced resources have no `resource` block by design. If the owner later
 * wants Terraform to manage one, these are the import blocks to uncomment —
 * commented so the bundle still validates as shipped.
 */
function importsTf(m: Manifest): string {
  const refs = m.resources.filter((r) => r.ownership === "referenced");
  if (!refs.length) return "";
  const addr: Record<string, string> = {
    postgres: "aws_db_instance",
    redis: "aws_elasticache_cluster",
    object_store: "aws_s3_bucket",
    queue: "aws_sqs_queue",
    email: "aws_ses_domain_identity",
  };
  return `# Referenced resources: this bundle reads them through variables and never
# declares them. To hand one to Terraform, uncomment its import block, add a
# matching \`resource\` block that describes the live settings, then run
# \`terraform plan\` and reconcile until the plan is empty.
#
# Import is one-way in practice: once Terraform owns the resource, a
# \`terraform destroy\` will delete it.
${refs
  .map(
    (r) => `
# ${r.name} (${r.kind})${r.externalRef ? ` — externalRef ${r.externalRef}` : " — no externalRef recorded in the manifest"}
# import {
#   to = ${addr[r.kind] ?? "aws_resource"}.${tf(r.name)}
#   id = "${r.externalRef ?? "CHANGE_ME"}"
# }
`
  )
  .join("")}`;
}

/** Commented remote-state backend. Local state is the default; this is the fix. */
function backendTf(env: Environment): string {
  const prefix = `${projectSlug(env)}-${env.name}`;
  const region = env.region.startsWith("sim-") ? "us-east-1" : env.region;
  return `# State is on local disk until you move it. Before a second person touches
# this bundle, create a versioned S3 bucket you own, uncomment the block below,
# and run \`terraform init -migrate-state\`.
#
# \`use_lockfile\` needs Terraform >= 1.10 or OpenTofu >= 1.10. On older
# versions drop it and add \`dynamodb_table = "your-lock-table"\` instead.
#
# terraform {
#   backend "s3" {
#     bucket       = "CHANGE_ME-terraform-state"
#     key          = "${prefix}/terraform.tfstate"
#     region       = "${region}"
#     encrypt      = true
#     use_lockfile = true
#   }
# }
`;
}

function networkTf(m: Manifest, hasRoutes: boolean): string {
  const ports = [
    ...new Set(managed(m.services).map((s) => s.port).filter((p): p is number => !!p)),
  ];
  const albSg = hasRoutes
    ? `
resource "aws_security_group" "alb" {
  name        = "\${var.name_prefix}-alb"
  description = "Public ingress to the load balancer."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`
    : "";

  const serviceIngress = hasRoutes
    ? ports
        .map(
          (p) => `
  ingress {
    description     = "Load balancer to container port ${p}"
    from_port       = ${p}
    to_port         = ${p}
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
`
        )
        .join("")
    : "";

  const dataPorts: number[] = [];
  if (m.resources.some((r) => r.kind === "postgres")) dataPorts.push(5432);
  if (m.resources.some((r) => r.kind === "redis")) dataPorts.push(6379);

  const dataSg = dataPorts.length
    ? `
resource "aws_security_group" "data" {
  name        = "\${var.name_prefix}-data"
  description = "Managed data stores. Reachable only from the task security group."
  vpc_id      = data.aws_vpc.default.id
${dataPorts
  .map(
    (p) => `
  ingress {
    description     = "Tasks to port ${p}"
    from_port       = ${p}
    to_port         = ${p}
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
`
  )
  .join("")}
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`
    : "";

  return `# The default VPC is used on purpose: this bundle applies cleanly into a fresh
# account with no prerequisites. Replace these two data sources with your own
# VPC (or a module) when you want private subnets and NAT.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
${albSg}
resource "aws_security_group" "service" {
  name        = "\${var.name_prefix}-service"
  description = "Fargate tasks."
  vpc_id      = data.aws_vpc.default.id
${serviceIngress}
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
${dataSg}`;
}

/** AWS EventBridge cron wants six fields and rejects `*` in both day slots. */
function awsCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return `cron(0 * * * ? *)`;
  const [min, hour, dom, month, dow] = f;
  const useDow = dow !== "*";
  return `cron(${min} ${hour} ${useDow ? "?" : dom} ${month} ${useDow ? dow : "?"} *)`;
}

function ecsTf(m: Manifest, env: Environment): string {
  const services = containerServices(m);
  if (!services.length) return "";

  const anySecrets = services.some((s) => containerEnv(m, s, env).secrets.length > 0);

  let out = `resource "aws_ecs_cluster" "main" {
  name = "\${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "\${var.name_prefix}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
`;

  if (anySecrets)
    out += `
# The execution role is what pulls SecureString parameters at task start.
data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:\${var.region}:\${data.aws_caller_identity.current.account_id}:parameter/\${var.name_prefix}/*"]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "\${var.name_prefix}-execution-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}
`;

  for (const s of services) {
    const t = tf(s.name);
    const c = containerEnv(m, s, env);
    const spec = fargateSpec(s.size);
    const route = routeOf(m, s.id);

    out += `
# A registry per service, so \`container_images["${s.name}"] = ""\` resolves to
# somewhere you can actually push. Deleting the repo deletes its images.
resource "aws_ecr_repository" "${t}" {
  name                 = "\${var.name_prefix}/${s.name}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "${t}" {
  name              = "/ecs/\${var.name_prefix}/${s.name}"
  retention_in_days = 30
}

resource "aws_iam_role" "task_${t}" {
  name               = "\${var.name_prefix}-${s.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
`;

    if (c.statements.length)
      out += `
data "aws_iam_policy_document" "task_${t}" {
${c.statements.join("\n\n")}
}

resource "aws_iam_role_policy" "task_${t}" {
  name   = "\${var.name_prefix}-${s.name}"
  role   = aws_iam_role.task_${t}.id
  policy = data.aws_iam_policy_document.task_${t}.json
}
`;

    const portMappings = s.port
      ? `\n      portMappings = [\n        { containerPort = ${s.port}, hostPort = ${s.port}, protocol = "tcp" }\n      ]`
      : "";

    out += `
resource "aws_ecs_task_definition" "${t}" {
  family                   = "\${var.name_prefix}-${s.name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "${spec.cpu}"
  memory                   = "${spec.memory}"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task_${t}.arn

  container_definitions = jsonencode([
    {
      name      = "${s.name}"
      image     = coalesce(lookup(var.container_images, "${s.name}", ""), "\${aws_ecr_repository.${t}.repository_url}:latest")
      essential = true${portMappings}
      environment = ${envJson(c)}
      secrets = ${secretsJson(c)}
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.${t}.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "${s.name}"
        }
      }
    }
  ])
}
`;

    if (s.kind === "cron") {
      out += `
# ${s.name} runs on a schedule instead of staying up.
resource "aws_iam_role" "events_${t}" {
  name = "\${var.name_prefix}-${s.name}-events"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "sts:AssumeRole"
        Principal = {
          Service = "events.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "events_${t}" {
  name = "\${var.name_prefix}-${s.name}-events"
  role = aws_iam_role.events_${t}.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = ["\${aws_ecs_task_definition.${t}.arn_without_revision}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.task_execution.arn, aws_iam_role.task_${t}.arn]
      }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "${t}" {
  name                = "\${var.name_prefix}-${s.name}"
  description         = "Schedule for ${s.name} (manifest: ${s.schedule ?? "unset"})"
  schedule_expression = "${awsCron(s.schedule ?? "0 * * * *")}"
}

resource "aws_cloudwatch_event_target" "${t}" {
  rule     = aws_cloudwatch_event_rule.${t}.name
  arn      = aws_ecs_cluster.main.arn
  role_arn = aws_iam_role.events_${t}.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.${t}.arn
    task_count          = 1
    launch_type         = "FARGATE"

    network_configuration {
      subnets          = data.aws_subnets.default.ids
      security_groups  = [aws_security_group.service.id]
      assign_public_ip = true
    }
  }
}
`;
      continue;
    }

    const lb = route
      ? `
  load_balancer {
    target_group_arn = aws_lb_target_group.${t}.arn
    container_name   = "${s.name}"
    container_port   = ${s.port ?? 80}
  }

  depends_on = [aws_lb_listener.${route.tls ? "https" : "http"}]
`
      : "";

    out += `
resource "aws_ecs_service" "${t}" {
  name            = "\${var.name_prefix}-${s.name}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.${t}.arn
  desired_count   = ${s.replicas}
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = true
  }
${lb}}
`;
  }
  return out;
}

function rdsTf(m: Manifest): string {
  const dbs = managed(m.resources).filter((r) => r.kind === "postgres");
  if (!dbs.length) return "";
  let out = `resource "aws_db_subnet_group" "main" {
  name       = "\${var.name_prefix}-db"
  subnet_ids = data.aws_subnets.default.ids
}
`;
  for (const r of dbs) {
    const t = tf(r.name);
    const dbName = tf(r.name).toLowerCase();
    out += `
resource "random_password" "${t}" {
  length  = 32
  special = false
}

resource "aws_db_instance" "${t}" {
  identifier                  = "\${var.name_prefix}-${r.name}"
  engine                      = "postgres"
  engine_version              = "${String(r.config.version ?? "16")}"
  instance_class              = "${DB_CLASS[r.size]}"
  allocated_storage           = ${DB_STORAGE[r.size]}
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "${dbName}"
  username                    = "orrery"
  password                    = random_password.${t}.result
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.data.id]
  backup_retention_period     = 7
  auto_minor_version_upgrade  = true
  deletion_protection         = false
  skip_final_snapshot         = true
  apply_immediately           = true
}

resource "aws_ssm_parameter" "${t}_password" {
  name  = "/\${var.name_prefix}/${r.name}/password"
  type  = "SecureString"
  value = random_password.${t}.result
}

resource "aws_ssm_parameter" "${t}_url" {
  name  = "/\${var.name_prefix}/${r.name}/url"
  type  = "SecureString"
  value = "postgres://\${aws_db_instance.${t}.username}:\${random_password.${t}.result}@\${aws_db_instance.${t}.endpoint}/\${aws_db_instance.${t}.db_name}"
}
`;
  }
  return out;
}

function elasticacheTf(m: Manifest): string {
  const caches = managed(m.resources).filter((r) => r.kind === "redis");
  if (!caches.length) return "";
  let out = `resource "aws_elasticache_subnet_group" "main" {
  name       = "\${var.name_prefix}-cache"
  subnet_ids = data.aws_subnets.default.ids
}
`;
  for (const r of caches) {
    const t = tf(r.name);
    out += `
resource "aws_elasticache_cluster" "${t}" {
  cluster_id           = "\${var.name_prefix}-${r.name}"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "${CACHE_CLASS[r.size]}"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.data.id]
}
`;
  }
  return out;
}

function s3Tf(m: Manifest): string {
  const buckets = managed(m.resources).filter((r) => r.kind === "object_store");
  const sites = managed(m.services).filter((s) => s.kind === "static");
  if (!buckets.length && !sites.length) return "";
  // S3 bucket names are global, so "<prefix>-uploads" collides with every other
  // account that tried the same obvious name. The suffix is generated once and
  // kept in state: it is stable across applies unless you taint this resource.
  let out = `resource "random_id" "bucket_suffix" {
  byte_length = 3
}

`;
  for (const r of buckets) {
    const t = tf(r.name);
    out += `resource "aws_s3_bucket" "${t}" {
  bucket = "\${var.name_prefix}-${r.name}-\${random_id.bucket_suffix.hex}"
}

resource "aws_s3_bucket_public_access_block" "${t}" {
  bucket                  = aws_s3_bucket.${t}.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "${t}" {
  bucket = aws_s3_bucket.${t}.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "${t}" {
  bucket = aws_s3_bucket.${t}.id

  versioning_configuration {
    status = "Enabled"
  }
}

`;
  }
  for (const s of sites) {
    const t = tf(s.name);
    out += `# Static site "${s.name}". Upload your build output here, then front it with
# CloudFront if you need a custom domain and TLS.
#
# This bucket is deliberately world-readable: a website bucket with the default
# private settings answers 403 to every visitor. Everything you put in it is
# public. Do not upload anything you would not publish.
resource "aws_s3_bucket" "site_${t}" {
  bucket = "\${var.name_prefix}-${s.name}-site-\${random_id.bucket_suffix.hex}"
}

resource "aws_s3_bucket_website_configuration" "site_${t}" {
  bucket = aws_s3_bucket.site_${t}.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "site_${t}" {
  bucket                  = aws_s3_bucket.site_${t}.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "site_${t}" {
  bucket = aws_s3_bucket.site_${t}.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadForWebsite"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "\${aws_s3_bucket.site_${t}.arn}/*"
      }
    ]
  })

  # The access block must land first, or S3 rejects the policy.
  depends_on = [aws_s3_bucket_public_access_block.site_${t}]
}

`;
  }
  return out;
}

function sqsTf(m: Manifest): string {
  const queues = managed(m.resources).filter((r) => r.kind === "queue");
  if (!queues.length) return "";
  return queues
    .map((r) => {
      const t = tf(r.name);
      return `resource "aws_sqs_queue" "${t}_dlq" {
  name                      = "\${var.name_prefix}-${r.name}-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "${t}" {
  name                       = "\${var.name_prefix}-${r.name}"
  visibility_timeout_seconds = ${Number(r.config.visibilityTimeout ?? 30)}
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.${t}_dlq.arn
    maxReceiveCount     = 5
  })
}
`;
    })
    .join("\n");
}

function sesTf(m: Manifest): string {
  const mail = managed(m.resources).filter((r) => r.kind === "email");
  if (!mail.length) return "";
  return `resource "aws_ses_domain_identity" "main" {
  domain = var.mail_domain
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

# SMTP credentials for the services bound to this sender.
resource "aws_iam_user" "ses_smtp" {
  name = "\${var.name_prefix}-ses-smtp"
}

resource "aws_iam_user_policy" "ses_smtp" {
  name = "\${var.name_prefix}-ses-send"
  user = aws_iam_user.ses_smtp.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ses:SendRawEmail", "ses:SendEmail"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_access_key" "ses_smtp" {
  user = aws_iam_user.ses_smtp.name
}

resource "aws_ssm_parameter" "ses_smtp_password" {
  name  = "/\${var.name_prefix}/ses/smtp-password"
  type  = "SecureString"
  value = aws_iam_access_key.ses_smtp.ses_smtp_password_v4
}
`;
}

interface RouteBinding {
  route: Route;
  service: Service;
}

function routeBindings(m: Manifest): RouteBinding[] {
  const out: RouteBinding[] = [];
  for (const b of m.bindings) {
    if (b.capability !== "http") continue;
    const route = m.routes.find((r) => r.id === b.from);
    const service = m.services.find((s) => s.id === b.to);
    if (route && service && service.ownership === "managed") out.push({ route, service });
  }
  return out;
}

function albTf(m: Manifest): string {
  const rb = routeBindings(m);
  if (!rb.length) return "";
  const anyTls = rb.some((x) => x.route.tls);
  const plain = rb.filter((x) => !x.route.tls);

  let out = `resource "aws_lb" "main" {
  name               = "\${var.name_prefix}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids
}
`;

  const seen = new Set<string>();
  for (const { service } of rb) {
    const t = tf(service.name);
    if (seen.has(t)) continue;
    seen.add(t);
    out += `
resource "aws_lb_target_group" "${t}" {
  name        = "\${var.name_prefix}-${service.name}"
  port        = ${service.port ?? 80}
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"

  health_check {
    path                = "${service.healthPath ?? "/"}"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}
`;
  }

  out += `
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
${
  anyTls
    ? `    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }`
    : `    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "No route matched."
      status_code  = "404"
    }`
}
  }
}
`;

  if (anyTls)
    out += `
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "No route matched."
      status_code  = "404"
    }
  }
}
`;

  rb.forEach(({ route, service }, i) => {
    const t = tf(`${route.host}_${route.pathPrefix}`);
    const listener = route.tls ? "https" : "http";
    out += `
resource "aws_lb_listener_rule" "${t}" {
  listener_arn = aws_lb_listener.${listener}.arn
  priority     = ${100 + i}

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${tf(service.name)}.arn
  }

  condition {
    host_header {
      values = ["${route.host}"]
    }
  }

  condition {
    path_pattern {
      values = ["${route.pathPrefix === "/" ? "/*" : `${route.pathPrefix.replace(/\/$/, "")}/*`}"]
    }
  }
}
`;
  });

  if (plain.length)
    out += `
# Routes exported without TLS (tls = false in the manifest) stay on the :80
# listener. Turn TLS on in Orrery and re-export to move them behind ACM.
`;

  return out;
}

function acmTf(m: Manifest): string {
  const rb = routeBindings(m).filter((x) => x.route.tls);
  if (!rb.length) return "";
  const hosts = [...new Set(rb.map((x) => x.route.host))];
  const [primary, ...sans] = hosts;

  return `resource "aws_acm_certificate" "main" {
  domain_name               = "${primary}"
  subject_alternative_names = [${sans.map((h) => `"${h}"`).join(", ")}]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}
`;
}

function route53Tf(m: Manifest): string {
  const rb = routeBindings(m);
  if (!rb.length) return "";
  const hosts = [...new Set(rb.map((x) => x.route.host))];
  return `data "aws_route53_zone" "main" {
  name         = var.route53_zone_name
  private_zone = false
}
${hosts
  .map(
    (h) => `
resource "aws_route53_record" "${tf(h)}" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${h}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
`
  )
  .join("")}`;
}

function outputsTf(m: Manifest): string {
  const parts: string[] = [];
  const rb = routeBindings(m);
  if (rb.length) {
    parts.push(`output "load_balancer_dns" {
  description = "Public DNS name of the application load balancer."
  value       = aws_lb.main.dns_name
}

output "urls" {
  description = "Public URL per route."
  value = [
${[...new Set(rb.map((x) => `    "${x.route.tls ? "https" : "http"}://${x.route.host}${x.route.pathPrefix === "/" ? "" : x.route.pathPrefix}"`))].join(",\n")}
  ]
}`);
  }
  for (const r of managed(m.resources)) {
    const t = tf(r.name);
    if (r.kind === "postgres")
      parts.push(`output "${t}_endpoint" {
  description = "Endpoint for ${r.name}. The password lives in SSM at /<name_prefix>/${r.name}/password."
  value       = aws_db_instance.${t}.endpoint
}`);
    if (r.kind === "redis")
      parts.push(`output "${t}_endpoint" {
  description = "Primary node address for ${r.name}."
  value       = aws_elasticache_cluster.${t}.cache_nodes[0].address
}`);
    if (r.kind === "object_store")
      parts.push(`output "${t}_bucket" {
  description = "Bucket name for ${r.name}."
  value       = aws_s3_bucket.${t}.bucket
}`);
    if (r.kind === "queue")
      parts.push(`output "${t}_queue_url" {
  description = "Queue URL for ${r.name}."
  value       = aws_sqs_queue.${t}.url
}`);
  }
  for (const s of managed(m.services).filter((x) => x.kind === "static")) {
    const t = tf(s.name);
    parts.push(`output "${t}_site_endpoint" {
  description = "Public website endpoint for ${s.name}. Upload your build output to the bucket in the value below."
  value       = aws_s3_bucket_website_configuration.site_${t}.website_endpoint
}

output "${t}_site_bucket" {
  description = "Bucket holding ${s.name}'s built files."
  value       = aws_s3_bucket.site_${t}.bucket
}`);
  }
  const svcs = containerServices(m);
  if (svcs.length) {
    parts.push(`output "ecs_cluster" {
  description = "ECS cluster running the services."
  value       = aws_ecs_cluster.main.name
}`);
    parts.push(`output "ecr_repositories" {
  description = "Push an image here for any service left empty in container_images, then apply again."
  value = {
${svcs.map((s) => `    "${s.name}" = aws_ecr_repository.${tf(s.name)}.repository_url`).join("\n")}
  }
}`);
  }
  return parts.join("\n\n") + (parts.length ? "\n" : "");
}

function tfvarsExample(env: Environment, m: Manifest, hasRoutes: boolean, hasEmail: boolean): string {
  const images = containerServices(m)
    .map(
      (s) =>
        `  "${s.name}" = "${s.source.type === "image" ? s.source.image : ""}"${s.source.type === "image" ? "" : `  # empty = push to the ECR repo this bundle creates for ${s.name}`}`
    )
    .join("\n");
  const hosts = [...new Set(routeBindings(m).map((x) => x.route.host))];
  const guessZone = hosts[0]?.split(".").slice(-2).join(".") ?? "example.com";
  const { vars } = scaffold(m, env);

  const refBlock = vars.length
    ? `
# Referenced resources. Orrery never provisions or mutates these; fill in where
# they already live. Anything left empty will fail at plan or at task start.
${vars.map((v) => `${v.name} = ${JSON.stringify(v.default ?? "")}  # ${v.description}`).join("\n")}
`
    : "";

  return `# Copy to terraform.tfvars and edit before the first apply.
region       = "${env.region.startsWith("sim-") ? "us-east-1" : env.region}"
project_name = "${projectSlug(env)}"
environment  = "${env.name}"
name_prefix  = "${projectSlug(env)}-${env.name}"
${hasRoutes ? `\n# Must be an existing public hosted zone you control.\nroute53_zone_name = "${guessZone}"\n` : ""}${hasEmail ? `\nmail_domain = "${guessZone}"\n` : ""}${
    images
      ? `
container_images = {
${images}
}
`
      : ""
  }${refBlock}`;
}

/* ------------------------------ bundle assembly ---------------------------- */

/**
 * Align `=` within each run of simple attribute lines, the way `terraform fmt`
 * would. Cheaper than shipping a formatter, and it means the bundle is already
 * canonical when someone runs `terraform fmt -check` in CI.
 */
function alignEq(src: string): string {
  const re = /^(\s*)([A-Za-z_"][^=]*?)\s*=\s(.*)$/;
  const out = src.split("\n");
  let group: { i: number; indent: string; key: string; val: string }[] = [];
  const flush = () => {
    if (group.length > 1) {
      const w = Math.max(...group.map((g) => g.key.length));
      for (const g of group) out[g.i] = `${g.indent}${g.key.padEnd(w)} = ${g.val}`;
    }
    group = [];
  };
  out.forEach((line, i) => {
    const m = re.exec(line);
    // A line that opens a nested block or collection ends the run.
    if (!m || /[[{(]$/.test(m[3].trim())) return flush();
    if (group.length && group[0].indent !== m[1]) flush();
    group.push({ i, indent: m[1], key: m[2], val: m[3] });
  });
  flush();
  return out.join("\n");
}

export function terraformFiles(env: Environment, m: Manifest): ExportFile[] {
  const hasRoutes = routeBindings(m).length > 0;
  const hasEmail = managed(m.resources).some((r) => r.kind === "email");

  const candidates: [string, string][] = [
    ["providers.tf", providersTf()],
    ["backend.tf", backendTf(env)],
    ["variables.tf", variablesTf(env, m, hasRoutes, hasEmail)],
    ["network.tf", networkTf(m, hasRoutes)],
    ["ecs.tf", ecsTf(m, env)],
    ["secrets.tf", secretsTf(m, env)],
    ["imports.tf", importsTf(m)],
    ["rds.tf", rdsTf(m)],
    ["elasticache.tf", elasticacheTf(m)],
    ["s3.tf", s3Tf(m)],
    ["sqs.tf", sqsTf(m)],
    ["ses.tf", sesTf(m)],
    ["alb.tf", albTf(m)],
    ["acm.tf", acmTf(m)],
    ["route53.tf", route53Tf(m)],
    ["outputs.tf", outputsTf(m)],
    ["terraform.tfvars.example", tfvarsExample(env, m, hasRoutes, hasEmail)],
  ];

  return candidates
    .filter(([, content]) => content.trim().length > 0)
    .map(([path, content]) => ({ path, content: alignEq(content) }));
}

/* --------------------------------- readme --------------------------------- */

export function terraformReadme(env: Environment, m: Manifest): string {
  const rb = routeBindings(m);
  const svcs = managed(m.services);
  const notes = [
    ...new Set(svcs.flatMap((s) => containerEnv(m, s, env).notes)),
  ];
  const bindingTable = m.bindings
    .filter((b) => m.services.some((s) => s.id === b.from))
    .map((b) => {
      const from = m.services.find((s) => s.id === b.from)!;
      const to = findNode(m, b.to);
      const keys = bindingEnv(m, b).map((k) => `\`${k.key}\``).join(", ");
      return `| ${from.name} | ${to?.node.name ?? b.to} | ${b.capability} | ${keys || "—"} |`;
    })
    .join("\n");

  const prefix = `${projectSlug(env)}-${env.name}`;

  return `# ${projectSlug(env)} — ${env.name} infrastructure

This is your infrastructure, not Orrery's. Everything here is standard
Terraform against the \`hashicorp/aws\` provider (\`~> 5.0\`); OpenTofu works
too. You can run it, read it, fork it, or delete Orrery entirely and keep
operating. Nothing in this bundle calls back to Orrery.

Generated from revision-level manifest: ${svcs.length} service(s),
${managed(m.resources).length} managed resource(s), ${m.routes.length} route(s).

## Prerequisites

1. Terraform >= 1.6 (or OpenTofu >= 1.6).
2. AWS credentials with permission to create ECS, IAM, RDS, ElastiCache, S3,
   SQS, SES, ELB, ACM and Route 53 resources. Administrator access is the
   simple answer; the least-privilege answer is the summary shown on the
   provider's connect screen.
3. A container image per service. This bundle creates an ECR repository per
   service; leave that service empty in \`container_images\` and push a
   \`:latest\` tag there, or point the entry at any registry ECS can pull from
   (Docker Hub, GHCR). A service with an empty entry and an empty repository
   will start and then fail to pull — apply once, read
   \`terraform output ecr_repositories\`, push, apply again.
${rb.length ? `4. A **public Route 53 hosted zone** you control, matching your route hostnames. ACM DNS validation writes records into it.\n` : ""}
## First apply

\`\`\`sh
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars: region, name_prefix, images${rb.length ? ", route53_zone_name" : ""}
terraform init
terraform plan -out plan.tfplan   # read this. it is the same discipline as Orrery's Changes drawer
terraform apply plan.tfplan
\`\`\`

The first apply takes roughly 10–15 minutes; RDS and ACM validation dominate.
When it finishes, \`terraform output\` prints the load balancer DNS name${rb.length ? " and the public URL for each route" : ""}.

### State

State is local by default. \`backend.tf\` ships the S3 backend block already
filled in for this environment, commented out. Create a versioned bucket you
own, uncomment it, and run \`terraform init -migrate-state\` before a second
person touches this bundle.

## How Orrery's model maps onto AWS

| Orrery | AWS |
| --- | --- |
| service (web / worker) | ECS Fargate task definition + service |
| service (cron) | ECS task definition + EventBridge rule |
| service (static) | S3 bucket with website configuration |
| service size | Fargate CPU / memory (clamped to a valid Fargate pair) |
| replicas | \`desired_count\` on the ECS service |
| postgres | RDS PostgreSQL instance + SSM SecureString credentials |
| redis | ElastiCache Redis cluster |
| object_store | S3 bucket (versioned, encrypted, private) |
| queue | SQS queue + dead-letter queue |
| email | SES domain identity + SMTP IAM user |
| route → service | ALB target group + listener rule + ACM cert + Route 53 alias |
| binding | env vars / secrets on the task definition + IAM on the task role |
| managed node | a \`resource\` block Terraform creates, updates and destroys |
| referenced node | **no resource block** — a \`var.ref_*\` you fill, plus SSM for its credentials. See \`imports.tf\` to take one over. |
| secretRef | \`aws_ssm_parameter\` (SecureString) created empty, in \`secrets.tf\` |

## Environment injection

Each service's container gets three sources of configuration, all visible in
\`ecs.tf\` inside the \`container_definitions\` block:

1. **Literal env vars** from the manifest, as \`environment\` entries.
2. **Binding-derived env vars**, wired to the real resource attributes — e.g.
   \`aws_db_instance.<name>.address\` rather than a hardcoded hostname.
3. **Secrets**, as \`secrets\` entries pointing at SSM Parameter Store ARNs.
   The ECS *execution* role reads them at task start; they never appear in the
   task definition, in state output, or in the console.

${bindingTable ? `| service | target | capability | injected |\n| --- | --- | --- | --- |\n${bindingTable}\n` : "No bindings in this manifest.\n"}
${
  notes.length
    ? `### Notes on this manifest\n\n${notes.map((n) => `- ${n}`).join("\n")}\n`
    : ""
}
### Secrets

An Orrery server can hold secret values — encrypted at rest, under its own
\`ORRERY_SECRET_KEY\` — but **an export never contains one**, whether or not
the store has it. A bundle you can commit, mail or paste is the wrong place
for a credential, and there is no flag to change that.

So what \`secrets.tf\` does instead is create every parameter the task
definitions reference, holding the placeholder \`PLACEHOLDER\`. That is what
stops the first apply from succeeding and then failing at task start, unable
to resolve the \`secrets\` block.

The values are yours to move across, once, with the command below. Orrery's
copy stays where it is and the two do not sync: after this, SSM is what the
running tasks read, and rotating a secret in Orrery does not rotate it here.

Set the real values once, after the first apply:

\`\`\`sh
aws ssm put-parameter --overwrite --type SecureString \\
  --name "/${prefix}/secrets/<ref>" --value "<value>"
\`\`\`

Each parameter carries \`ignore_changes = [value]\`, so a later
\`terraform apply\` will not revert you. Restart the service (force a new
deployment) to pick a changed value up.

${
  m.resources.some((r) => r.ownership === "referenced")
    ? `### Referenced resources

Resources marked *referenced* in Orrery already exist in your account, and
this bundle declares none of them — that is the whole point of the
distinction. Their hostnames and identifiers come from \`var.ref_*\` in
\`terraform.tfvars\`, and their credentials from the SSM parameters above.
\`imports.tf\` carries a commented \`import\` block per referenced resource for
the day you decide Terraform should own one.

`
    : ""
}
## Operating without Orrery

- **Deploy a new version.** Push a new image tag, update \`container_images\`,
  \`terraform apply\`. ECS performs a rolling replacement.
- **Scale.** Change \`desired_count\` on the service (or the \`replicas\` value
  you exported from) and apply.
- **Resize.** Change \`cpu\`/\`memory\` on the task definition, or
  \`instance_class\` on RDS, and apply.
- **Roll back.** \`git revert\` the change to this directory and apply. Your
  version control is the revision history; Terraform state is the truth.
- **Read logs.** \`aws logs tail /ecs/${prefix}/<service> --follow\`.
- **Tear down.** \`terraform destroy\`. RDS has \`skip_final_snapshot = true\`
  for demo convenience — flip it to \`false\` before you have data you care
  about.

## Deliberate simplifications

These are the corners this generator cuts, and what to do about each:

- **Default VPC, public subnets.** Tasks get public IPs so they can pull
  images without a NAT gateway. For production, add private subnets + NAT (or
  VPC endpoints) and set \`assign_public_ip = false\`.
- **\`skip_final_snapshot = true\` and \`deletion_protection = false\` on RDS.**
  Invert both once the database matters.
- **No autoscaling.** \`desired_count\` is fixed. Add
  \`aws_appautoscaling_target\` + policy when you need it.
- **Static sites are public S3 website buckets.** They carry a
  \`s3:GetObject\` policy for \`Principal = "*"\` because a private website
  bucket answers 403 to everyone. Everything you upload is public. Add
  CloudFront + an ACM cert in us-east-1 for a custom domain and TLS.
- **Bucket names carry a random suffix.** S3's namespace is global, so
  \`<name_prefix>-uploads\` is almost certainly taken. The suffix lives in
  state and is stable across applies.
- **Service-to-service HTTP** relies on public routes. Add ECS Service Connect
  or an internal ALB for private traffic.
- **ALB target group names** are \`<name_prefix>-<service>\` and AWS caps them
  at 32 characters. Shorten \`name_prefix\` if a plan complains.

Re-exporting from Orrery regenerates these files from the current manifest. If
you have edited them by hand, diff before overwriting — your edits are yours.
`;
}
