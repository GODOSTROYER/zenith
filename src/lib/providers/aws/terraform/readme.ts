/**
 * The README that ships inside the export bundle — what the operator reads
 * before their first `terraform apply`. Split out of the single-file exporter;
 * the code is unchanged.
 */
import { bindingEnv, findNode } from "@/lib/domain/graph";
import { hclComment } from "./hcl";
import { managed, namePrefix, projectSlug, routeBindings } from "./naming";
import { containerEnv } from "./container-env";
import type { Environment, Manifest } from "@/lib/domain/types";

/* --------------------------------- readme --------------------------------- */

export function terraformReadme(env: Environment, m: Manifest): string {
  const rb = routeBindings(m);
  const svcs = managed(m.services);
  // Markdown is not executed, but a newline still wrecks a table row and a
  // pipe still splits a cell, so manifest text is flattened here too.
  const cell = (s: unknown) => hclComment(s).replace(/\|/g, "\\|");
  const notes = [
    ...new Set(svcs.flatMap((s) => containerEnv(m, s, env).notes.map((n) => hclComment(n)))),
  ];
  const bindingTable = m.bindings
    .filter((b) => m.services.some((s) => s.id === b.from))
    .map((b) => {
      const from = m.services.find((s) => s.id === b.from)!;
      const to = findNode(m, b.to);
      const keys = bindingEnv(m, b).map((k) => `\`${cell(k.key)}\``).join(", ");
      return `| ${cell(from.name)} | ${cell(to?.node.name ?? b.to)} | ${cell(b.capability)} | ${keys || "—"} |`;
    })
    .join("\n");

  const prefix = hclComment(namePrefix(env));

  return `# ${cell(projectSlug(env))} — ${cell(env.name)} infrastructure

This is your infrastructure, not Zenith's. Everything here is standard
Terraform against the \`hashicorp/aws\` provider (\`~> 5.0\`); OpenTofu works
too. You can run it, read it, fork it, or delete Zenith entirely and keep
operating. Nothing in this bundle calls back to Zenith.

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
terraform plan -out plan.tfplan   # read this. it is the same discipline as Zenith's Changes drawer
terraform apply plan.tfplan
\`\`\`

The first apply takes roughly 10–15 minutes; RDS and ACM validation dominate.
When it finishes, \`terraform output\` prints the load balancer DNS name${rb.length ? " and the public URL for each route" : ""}.

### State

State is local by default. \`backend.tf\` ships the S3 backend block already
filled in for this environment, commented out. Create a versioned bucket you
own, uncomment it, and run \`terraform init -migrate-state\` before a second
person touches this bundle.

## How Zenith's model maps onto AWS

| Zenith | AWS |
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

A Zenith server can hold secret values — encrypted at rest, under its own
\`ZENITH_SECRET_KEY\` — but **an export never contains one**, whether or not
the store has it. A bundle you can commit, mail or paste is the wrong place
for a credential, and there is no flag to change that.

So what \`secrets.tf\` does instead is create every parameter the task
definitions reference, holding the placeholder \`PLACEHOLDER\`. That is what
stops the first apply from succeeding and then failing at task start, unable
to resolve the \`secrets\` block.

The values are yours to move across, once, with the command below. Zenith's
copy stays where it is and the two do not sync: after this, SSM is what the
running tasks read, and rotating a secret in Zenith does not rotate it here.

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

Resources marked *referenced* in Zenith already exist in your account, and
this bundle declares none of them — that is the whole point of the
distinction. Their hostnames and identifiers come from \`var.ref_*\` in
\`terraform.tfvars\`, and their credentials from the SSM parameters above.
\`imports.tf\` carries a commented \`import\` block per referenced resource for
the day you decide Terraform should own one.

`
    : ""
}
## Operating without Zenith

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

Re-exporting from Zenith regenerates these files from the current manifest. If
you have edited them by hand, diff before overwriting — your edits are yours.
`;
}
