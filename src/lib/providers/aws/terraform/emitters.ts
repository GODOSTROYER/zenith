/**
 * One function per emitted `.tf` file. Each takes the manifest (and, where the
 * environment shapes the output, the environment) and returns HCL, or "" when
 * it has nothing to say. Split out of the single-file exporter; the code is
 * unchanged.
 */
import { hclBody, hclComment, hclNum, hclString, validPort } from "./hcl";
import {
  CACHE_CLASS,
  DB_CLASS,
  DB_STORAGE,
  exportRegion,
  fargateSpec,
  hasEmail,
  hasRoutes,
  managed,
  namePrefix,
  projectSlug,
  resLabel,
  routeBindings,
  routeOf,
  svcLabel,
  tf,
  uniqueLabel,
} from "./naming";
import { containerEnv, containerServices, envJson, scaffold, secretsJson } from "./container-env";
import type { Environment, Manifest } from "@/lib/domain/types";

/* --------------------------------- files ---------------------------------- */

export function providersTf(): string {
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
      Origin      = "zenith-export"
    }
  }
}

data "aws_caller_identity" "current" {}
`;
}

export function variablesTf(env: Environment, m: Manifest): string {
  // "" means "use the ECR repository this bundle creates for the service".
  const images = containerServices(m)
    .map(
      (s) =>
        `    ${hclString(s.name)} = ${hclString(s.source.type === "image" ? s.source.image : "")}`
    )
    .join("\n");

  const { vars, secrets } = scaffold(m, env);

  const refVars = vars
    .map(
      (v) => `
variable "${tf(v.name)}" {
  description = ${hclString(v.description)}
  type        = string${v.default !== undefined ? `\n  default     = ${hclString(v.default)}` : ""}
}
`
    )
    .join("");

  const secretVar = secrets.length
    ? `
# Placeholders only. Zenith never held these values, so it cannot put them here.
# After the first apply, set each real value out-of-band:
#   aws ssm put-parameter --overwrite --type SecureString \\
#     --name "/<name_prefix>/<path>" --value "<value>"
# The parameters ignore later value changes, so Terraform will not revert you.
variable "secret_values" {
  description = "Initial value per secret. Anything left as PLACEHOLDER must be set with aws ssm put-parameter before the service can start."
  type        = map(string)
  sensitive   = true

  default = {
${secrets.map((p) => `    ${hclString(p.key)} = "PLACEHOLDER"`).join("\n")}
  }
}
`
    : "";

  const zoneVar = hasRoutes(m)
    ? `
variable "route53_zone_name" {
  description = "Public hosted zone that owns the route hostnames, e.g. \\"example.com\\". Must already exist."
  type        = string
}
`
    : "";

  const mailVar = hasEmail(m)
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
  default     = ${hclString(exportRegion(env))}
}

variable "project_name" {
  description = "Project name, used for tagging."
  type        = string
  default     = ${hclString(projectSlug(env))}
}

variable "environment" {
  description = "Environment name, used for tagging."
  type        = string
  default     = ${hclString(env.name)}
}

variable "name_prefix" {
  description = "Prefix for every resource name. Keep it short: ALB target group names cap at 32 characters."
  type        = string
  default     = ${hclString(namePrefix(env))}
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
export function secretsTf(m: Manifest, env: Environment): string {
  const { secrets } = scaffold(m, env);
  if (!secrets.length) return "";
  return (
    `# Created empty on purpose: Zenith never holds secret values. Each parameter
# starts at the placeholder in var.secret_values and then ignores value
# changes, so \`aws ssm put-parameter --overwrite\` is the only writer.
` +
    secrets
      .map(
        (p) => `
resource "aws_ssm_parameter" "${tf(p.label)}" {
  name        = "/\${var.name_prefix}/${hclBody(p.path)}"
  description = ${hclString(p.description)}
  type        = "SecureString"
  value       = lookup(var.secret_values, ${hclString(p.key)}, "PLACEHOLDER")

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
export function importsTf(m: Manifest): string {
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
# ${hclComment(`${r.name} (${r.kind})${r.externalRef ? ` — externalRef ${r.externalRef}` : " — no externalRef recorded in the manifest"}`)}
# import {
#   to = ${addr[r.kind] ?? "aws_resource"}.${resLabel(m, r)}
#   id = ${hclString(r.externalRef ?? "CHANGE_ME")}
# }
`
  )
  .join("")}`;
}

/** Commented remote-state backend. Local state is the default; this is the fix. */
export function backendTf(env: Environment): string {
  // Both sit inside a quoted string inside a comment: escaping keeps them on
  // one line, which is what keeps the block commented.
  const prefix = hclBody(namePrefix(env));
  const region = hclBody(exportRegion(env));
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

export function networkTf(m: Manifest): string {
  // Ports land in unquoted attributes, where nothing can be escaped, so a
  // non-numeric one is dropped rather than written out.
  const ports = [
    ...new Set(
      managed(m.services)
        .map((s) => validPort(s.port))
        .filter((p): p is number => p !== undefined)
    ),
  ];
  const albSg = hasRoutes(m)
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

  const serviceIngress = hasRoutes(m)
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

/** The alphabet of a cron field. Anything else is not a schedule. */
export const CRON_FIELD = /^[0-9*?,/#LW-]+$/;

/**
 * AWS EventBridge cron wants six fields and rejects `*` in both day slots.
 *
 * The field check is not politeness: `schedule` is free text in the manifest,
 * and a field like `*"` would otherwise close the quoted
 * `schedule_expression` and leave the rest of the value as configuration. An
 * unparseable schedule falls back to hourly, which is what a missing one
 * already did.
 */
export function awsCron(expr: string): string {
  const f = String(expr ?? "").trim().split(/\s+/);
  if (f.length !== 5 || !f.every((x) => CRON_FIELD.test(x))) return `cron(0 * * * ? *)`;
  const [min, hour, dom, month, dow] = f;
  const useDow = dow !== "*";
  return `cron(${min} ${hour} ${useDow ? "?" : dom} ${month} ${useDow ? dow : "?"} *)`;
}

export function ecsTf(m: Manifest, env: Environment): string {
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
    const t = svcLabel(m, s);
    // `n` is the escaped body, for the names that splice the service name next
    // to an interpolation this file writes; `nq` is the standalone literal.
    const n = hclBody(s.name);
    const nq = hclString(s.name);
    const c = containerEnv(m, s, env);
    const spec = fargateSpec(s.size);
    const route = routeOf(m, s.id);
    const port = validPort(s.port);

    out += `
# A registry per service, so \`container_images[${hclComment(nq)}] = ""\` resolves
# to somewhere you can actually push. Deleting the repo deletes its images.
resource "aws_ecr_repository" "${t}" {
  name                 = "\${var.name_prefix}/${n}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "${t}" {
  name              = "/ecs/\${var.name_prefix}/${n}"
  retention_in_days = 30
}

resource "aws_iam_role" "task_${t}" {
  name               = "\${var.name_prefix}-${n}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
`;

    if (c.statements.length)
      out += `
data "aws_iam_policy_document" "task_${t}" {
${c.statements.join("\n\n")}
}

resource "aws_iam_role_policy" "task_${t}" {
  name   = "\${var.name_prefix}-${n}"
  role   = aws_iam_role.task_${t}.id
  policy = data.aws_iam_policy_document.task_${t}.json
}
`;

    const portMappings =
      port !== undefined
        ? `\n      portMappings = [\n        { containerPort = ${port}, hostPort = ${port}, protocol = "tcp" }\n      ]`
        : "";

    out += `
resource "aws_ecs_task_definition" "${t}" {
  family                   = "\${var.name_prefix}-${n}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "${hclNum(spec.cpu, 256)}"
  memory                   = "${hclNum(spec.memory, 512)}"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task_${t}.arn

  container_definitions = jsonencode([
    {
      name      = ${nq}
      image     = coalesce(lookup(var.container_images, ${nq}, ""), "\${aws_ecr_repository.${t}.repository_url}:latest")
      essential = true${portMappings}
      environment = ${envJson(c)}
      secrets = ${secretsJson(c)}
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.${t}.name
          awslogs-region        = var.region
          awslogs-stream-prefix = ${nq}
        }
      }
    }
  ])
}
`;

    if (s.kind === "cron") {
      out += `
# ${hclComment(s.name)} runs on a schedule instead of staying up.
resource "aws_iam_role" "events_${t}" {
  name = "\${var.name_prefix}-${n}-events"

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
  name = "\${var.name_prefix}-${n}-events"
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
  name                = "\${var.name_prefix}-${n}"
  description         = ${hclString(`Schedule for ${s.name} (manifest: ${s.schedule ?? "unset"})`)}
  schedule_expression = ${hclString(awsCron(s.schedule ?? "0 * * * *"))}
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
    container_name   = ${nq}
    container_port   = ${port ?? 80}
  }

  depends_on = [aws_lb_listener.${route.tls ? "https" : "http"}]
`
      : "";

    out += `
resource "aws_ecs_service" "${t}" {
  name            = "\${var.name_prefix}-${n}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.${t}.arn
  desired_count   = ${hclNum(s.replicas, 1)}
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

export function rdsTf(m: Manifest): string {
  const dbs = managed(m.resources).filter((r) => r.kind === "postgres");
  if (!dbs.length) return "";
  let out = `resource "aws_db_subnet_group" "main" {
  name       = "\${var.name_prefix}-db"
  subnet_ids = data.aws_subnets.default.ids
}
`;
  for (const r of dbs) {
    const t = resLabel(m, r);
    const n = hclBody(r.name);
    const dbName = tf(r.name).toLowerCase();
    out += `
resource "random_password" "${t}" {
  length  = 32
  special = false
}

resource "aws_db_instance" "${t}" {
  identifier                  = "\${var.name_prefix}-${n}"
  engine                      = "postgres"
  engine_version              = ${hclString(r.config.version ?? "16")}
  instance_class              = ${hclString(DB_CLASS[r.size] ?? DB_CLASS.small)}
  allocated_storage           = ${hclNum(DB_STORAGE[r.size], 20)}
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = ${hclString(dbName)}
  username                    = "zenith"
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
  name  = "/\${var.name_prefix}/${n}/password"
  type  = "SecureString"
  value = random_password.${t}.result
}

resource "aws_ssm_parameter" "${t}_url" {
  name  = "/\${var.name_prefix}/${n}/url"
  type  = "SecureString"
  value = "postgres://\${aws_db_instance.${t}.username}:\${random_password.${t}.result}@\${aws_db_instance.${t}.endpoint}/\${aws_db_instance.${t}.db_name}"
}
`;
  }
  return out;
}

export function elasticacheTf(m: Manifest): string {
  const caches = managed(m.resources).filter((r) => r.kind === "redis");
  if (!caches.length) return "";
  let out = `resource "aws_elasticache_subnet_group" "main" {
  name       = "\${var.name_prefix}-cache"
  subnet_ids = data.aws_subnets.default.ids
}
`;
  for (const r of caches) {
    const t = resLabel(m, r);
    out += `
resource "aws_elasticache_cluster" "${t}" {
  cluster_id           = "\${var.name_prefix}-${hclBody(r.name)}"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = ${hclString(CACHE_CLASS[r.size] ?? CACHE_CLASS.small)}
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

export function s3Tf(m: Manifest): string {
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
    const t = resLabel(m, r);
    out += `resource "aws_s3_bucket" "${t}" {
  bucket = "\${var.name_prefix}-${hclBody(r.name)}-\${random_id.bucket_suffix.hex}"
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
    const t = svcLabel(m, s);
    out += `# Static site "${hclComment(s.name)}". Upload your build output here, then front it with
# CloudFront if you need a custom domain and TLS.
#
# This bucket is deliberately world-readable: a website bucket with the default
# private settings answers 403 to every visitor. Everything you put in it is
# public. Do not upload anything you would not publish.
resource "aws_s3_bucket" "site_${t}" {
  bucket = "\${var.name_prefix}-${hclBody(s.name)}-site-\${random_id.bucket_suffix.hex}"
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

export function sqsTf(m: Manifest): string {
  const queues = managed(m.resources).filter((r) => r.kind === "queue");
  if (!queues.length) return "";
  return queues
    .map((r) => {
      const t = resLabel(m, r);
      const n = hclBody(r.name);
      return `resource "aws_sqs_queue" "${t}_dlq" {
  name                      = "\${var.name_prefix}-${n}-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "${t}" {
  name                       = "\${var.name_prefix}-${n}"
  visibility_timeout_seconds = ${hclNum(r.config.visibilityTimeout, 30)}
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

export function sesTf(m: Manifest): string {
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

export function albTf(m: Manifest): string {
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

  // Two distinct services can sanitise to one label ("api.v1" and "api-v1" both
  // become "api_v1"). Skipping the second used to look like deduplication, but
  // it silently pointed both routes at the *first* service's target group. Keep
  // one target group per service, keyed by id, and disambiguate the label.
  const emitted = new Set<string>();
  for (const { service } of rb) {
    if (emitted.has(service.id)) continue; // several routes, one service
    emitted.add(service.id);
    const t = svcLabel(m, service);
    out += `
resource "aws_lb_target_group" "${t}" {
  name        = "\${var.name_prefix}-${hclBody(service.name)}"
  port        = ${validPort(service.port) ?? 80}
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"

  health_check {
    path                = ${hclString(service.healthPath ?? "/")}
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

  const ruleSeen = new Set<string>();
  rb.forEach(({ route, service }, i) => {
    // Host+path sanitise many-to-one too ("/x.y" and "/x-y" both become
    // "_x_y"), and duplicate block labels are a Terraform *parse* error — the
    // export would not even plan.
    const t = uniqueLabel(ruleSeen, tf(`${route.host}_${route.pathPrefix}`));
    const listener = route.tls ? "https" : "http";
    out += `
resource "aws_lb_listener_rule" "${t}" {
  listener_arn = aws_lb_listener.${listener}.arn
  priority     = ${100 + i}

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${svcLabel(m, service)}.arn
  }

  condition {
    host_header {
      values = [${hclString(route.host)}]
    }
  }

  condition {
    path_pattern {
      values = [${hclString(
        route.pathPrefix === "/" ? "/*" : `${String(route.pathPrefix ?? "/").replace(/\/+$/, "")}/*`
      )}]
    }
  }
}
`;
  });

  if (plain.length)
    out += `
# Routes exported without TLS (tls = false in the manifest) stay on the :80
# listener. Turn TLS on in Zenith and re-export to move them behind ACM.
`;

  return out;
}

export function acmTf(m: Manifest): string {
  const rb = routeBindings(m).filter((x) => x.route.tls);
  if (!rb.length) return "";
  const hosts = [...new Set(rb.map((x) => x.route.host))];
  const [primary, ...sans] = hosts;

  return `resource "aws_acm_certificate" "main" {
  domain_name               = ${hclString(primary)}
  subject_alternative_names = [${sans.map((h) => hclString(h)).join(", ")}]
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

export function route53Tf(m: Manifest): string {
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
  name    = ${hclString(h)}
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

export function outputsTf(m: Manifest): string {
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
${[
  ...new Set(
    rb.map(
      (x) =>
        `    ${hclString(
          `${x.route.tls ? "https" : "http"}://${x.route.host}${
            x.route.pathPrefix === "/" ? "" : x.route.pathPrefix
          }`
        )}`
    )
  ),
].join(",\n")}
  ]
}`);
  }
  for (const r of managed(m.resources)) {
    const t = resLabel(m, r);
    if (r.kind === "postgres")
      parts.push(`output "${t}_endpoint" {
  description = ${hclString(
    `Endpoint for ${r.name}. The password lives in SSM at /<name_prefix>/${r.name}/password.`
  )}
  value       = aws_db_instance.${t}.endpoint
}`);
    if (r.kind === "redis")
      parts.push(`output "${t}_endpoint" {
  description = ${hclString(`Primary node address for ${r.name}.`)}
  value       = aws_elasticache_cluster.${t}.cache_nodes[0].address
}`);
    if (r.kind === "object_store")
      parts.push(`output "${t}_bucket" {
  description = ${hclString(`Bucket name for ${r.name}.`)}
  value       = aws_s3_bucket.${t}.bucket
}`);
    if (r.kind === "queue")
      parts.push(`output "${t}_queue_url" {
  description = ${hclString(`Queue URL for ${r.name}.`)}
  value       = aws_sqs_queue.${t}.url
}`);
  }
  for (const s of managed(m.services).filter((x) => x.kind === "static")) {
    const t = svcLabel(m, s);
    parts.push(`output "${t}_site_endpoint" {
  description = ${hclString(
    `Public website endpoint for ${s.name}. Upload your build output to the bucket in the value below.`
  )}
  value       = aws_s3_bucket_website_configuration.site_${t}.website_endpoint
}

output "${t}_site_bucket" {
  description = ${hclString(`Bucket holding ${s.name}'s built files.`)}
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
${svcs
  .map((s) => `    ${hclString(s.name)} = aws_ecr_repository.${svcLabel(m, s)}.repository_url`)
  .join("\n")}
  }
}`);
  }
  return parts.join("\n\n") + (parts.length ? "\n" : "");
}

export function tfvarsExample(env: Environment, m: Manifest): string {
  // terraform.tfvars is loaded and executed like any other HCL, so it gets the
  // same encoding as the .tf files — including the trailing `#` comments,
  // where a newline would turn the rest of a description into an assignment.
  const images = containerServices(m)
    .map(
      (s) =>
        `  ${hclString(s.name)} = ${hclString(s.source.type === "image" ? s.source.image : "")}${s.source.type === "image" ? "" : `  # empty = push to the ECR repo this bundle creates for ${hclComment(s.name)}`}`
    )
    .join("\n");
  const hosts = [...new Set(routeBindings(m).map((x) => x.route.host))];
  const guessZone = String(hosts[0] ?? "").split(".").slice(-2).join(".") || "example.com";
  const { vars } = scaffold(m, env);

  const refBlock = vars.length
    ? `
# Referenced resources. Zenith never provisions or mutates these; fill in where
# they already live. Anything left empty will fail at plan or at task start.
${vars
  .map((v) => `${tf(v.name)} = ${hclString(v.default ?? "")}  # ${hclComment(v.description)}`)
  .join("\n")}
`
    : "";

  return `# Copy to terraform.tfvars and edit before the first apply.
region       = ${hclString(exportRegion(env))}
project_name = ${hclString(projectSlug(env))}
environment  = ${hclString(env.name)}
name_prefix  = ${hclString(namePrefix(env))}
${hasRoutes(m) ? `\n# Must be an existing public hosted zone you control.\nroute53_zone_name = ${hclString(guessZone)}\n` : ""}${hasEmail(m) ? `\nmail_domain = ${hclString(guessZone)}\n` : ""}${
    images
      ? `
container_images = {
${images}
}
`
      : ""
  }${refBlock}`;
}
