/**
 * AWS provider — Preview.
 *
 * What "preview" honestly means here: Orrery can read your account posture,
 * produce a real ECS/Fargate-shaped plan, and generate genuinely runnable
 * Terraform for the whole system. It cannot apply that plan for you yet.
 * `executeStep` therefore refuses, loudly and with the alternative named.
 *
 * Workstream A.
 */
import type { CloudConnection, Environment, Manifest } from "@/lib/domain/types";
import type {
  ExportBundle,
  PreflightReport,
  ProviderAdapter,
  ProviderPlanStep,
  StepRuntime,
} from "@/lib/providers/types";
import { fargateSpec, terraformFiles, terraformReadme } from "@/lib/providers/aws/terraform";

/** The exact message the Engine surfaces when someone tries to apply. */
export const AWS_PREVIEW_MESSAGE =
  "AWS execution requires credentials. Orrery Preview generates and exports the full Terraform for this system — run it with your own tooling, or connect credentials in a later release.";

const IAM_PERMISSIONS = [
  "sts:AssumeRole on a role in YOUR account that YOU create (cross-account trust to Orrery's principal, guarded by a unique ExternalId)",
  "Read-only inventory: ecs:Describe*/List*, rds:Describe*, elasticache:Describe*, s3:ListAllMyBuckets, s3:GetBucketLocation, sqs:ListQueues, elasticloadbalancing:Describe*, route53:List*, acm:List*",
  "Cost visibility: ce:GetCostAndUsage (account totals only, no line-item export)",
  "Identity: sts:GetCallerIdentity, iam:GetRole on the assumed role itself",
];

function planSteps(env: Environment, next: Manifest, previous?: Manifest): ProviderPlanStep[] {
  const steps: ProviderPlanStep[] = [];
  const managed = <T extends { ownership: string }>(xs: T[]) =>
    xs.filter((x) => x.ownership === "managed");
  const had = (nodeId: string) =>
    !!previous && [...previous.services, ...previous.resources].some((n) => n.id === nodeId);

  steps.push({
    phase: "prepare",
    title: "Assume deployment role and read account inventory",
    targetId: "",
    estMs: 4000,
    detail: "sts:AssumeRole + ecs:ListClusters, rds:DescribeDBInstances",
  });
  steps.push({
    phase: "prepare",
    title: "Resolve VPC, subnets and security groups",
    targetId: "",
    estMs: 3000,
    detail: "data.aws_vpc.default, data.aws_subnets.default",
  });

  for (const s of managed(next.services)) {
    if (s.kind === "static") continue;
    const spec = fargateSpec(s.size);
    steps.push({
      phase: "prepare",
      title: `Push image for ${s.name} to ECR`,
      targetId: s.id,
      estMs: 45000,
      detail: `aws_ecr_repository.${s.name} + docker push`,
    });
    steps.push({
      phase: "provision",
      title: `Register task definition for ${s.name} (${spec.cpu} CPU / ${spec.memory} MB)`,
      targetId: s.id,
      estMs: 4000,
      detail: `aws_ecs_task_definition.${s.name}`,
    });
  }

  for (const r of managed(next.resources)) {
    const map: Record<string, { label: string; addr: string; ms: number }> = {
      postgres: { label: "RDS PostgreSQL instance", addr: "aws_db_instance", ms: 480000 },
      redis: { label: "ElastiCache Redis cluster", addr: "aws_elasticache_cluster", ms: 300000 },
      object_store: { label: "S3 bucket", addr: "aws_s3_bucket", ms: 6000 },
      queue: { label: "SQS queue + DLQ", addr: "aws_sqs_queue", ms: 6000 },
      email: { label: "SES domain identity", addr: "aws_ses_domain_identity", ms: 20000 },
    };
    const info = map[r.kind];
    steps.push({
      phase: "provision",
      title: `${had(r.id) ? "Update" : "Create"} ${info.label} for "${r.name}"`,
      targetId: r.id,
      estMs: info.ms,
      detail: `${info.addr}.${r.name}`,
    });
  }

  if (next.routes.length) {
    steps.push({
      phase: "provision",
      title: "Create application load balancer and target groups",
      targetId: "",
      estMs: 180000,
      detail: "aws_lb.main, aws_lb_target_group.*",
    });
    for (const route of next.routes) {
      if (route.tls)
        steps.push({
          phase: "provision",
          title: `Request and validate ACM certificate for ${route.host}`,
          targetId: route.id,
          estMs: 300000,
          detail: "aws_acm_certificate + DNS validation via Route 53",
        });
      steps.push({
        phase: "provision",
        title: `Point ${route.host} at the load balancer`,
        targetId: route.id,
        estMs: 60000,
        detail: "aws_route53_record (A alias)",
      });
    }
  }

  for (const s of managed(next.services)) {
    if (s.kind === "static") {
      steps.push({
        phase: "release",
        title: `Sync ${s.name} to its S3 website bucket`,
        targetId: s.id,
        estMs: 15000,
        detail: `aws s3 sync → aws_s3_bucket.site_${s.name}`,
      });
      continue;
    }
    if (s.kind === "cron") {
      steps.push({
        phase: "release",
        title: `Schedule ${s.name} on EventBridge`,
        targetId: s.id,
        estMs: 6000,
        detail: `aws_cloudwatch_event_rule.${s.name}`,
      });
      continue;
    }
    steps.push({
      phase: "release",
      title: `Roll out ${s.name} (${s.replicas} task${s.replicas === 1 ? "" : "s"})`,
      targetId: s.id,
      estMs: 120000,
      detail: `aws_ecs_service.${s.name} — rolling update, minimumHealthyPercent 100`,
    });
  }

  for (const s of managed(next.services)) {
    if (s.kind !== "web") continue;
    steps.push({
      phase: "verify",
      title: `Wait for ${s.name} targets to pass health checks`,
      targetId: s.id,
      estMs: 90000,
      detail: "elasticloadbalancing:DescribeTargetHealth until healthy",
    });
  }
  steps.push({
    phase: "verify",
    title: "Confirm services stable and record outputs",
    targetId: "",
    estMs: 30000,
    detail: "ecs:DescribeServices --wait services-stable",
  });

  return steps;
}

/**
 * Last-resort guard. `deploy.plan` / `deploy.apply` read `availability` and
 * refuse before a revision is snapshotted (actions/defs/deploy.ts →
 * providerBlock), so in normal operation nothing reaches this.
 */
async function executeStep(_rt: StepRuntime): Promise<void> {
  throw new Error(AWS_PREVIEW_MESSAGE);
}

async function preflight(conn: CloudConnection): Promise<PreflightReport> {
  const hasCreds = !!process.env.AWS_ACCESS_KEY_ID;
  const region = conn.region || "us-east-1";

  if (hasCreds) {
    return {
      ok: true,
      checks: [
        {
          id: "aws.credentials",
          label: "Credentials detected",
          status: "pass",
          detail: `AWS_ACCESS_KEY_ID is present in this server's environment (region ${region}).`,
        },
        {
          id: "aws.apply",
          label: "Apply is disabled in Preview",
          status: "warn",
          detail:
            "Credentials detected but apply is disabled in Preview. Orrery will plan and export, never mutate your account.",
          fix: "Export the Terraform from Environment → Export and run `terraform apply` yourself.",
        },
        {
          id: "aws.export",
          label: "Terraform export available",
          status: "pass",
          detail: "The full system exports as runnable HCL, including variables and a tfvars example.",
        },
      ],
      permissions: IAM_PERMISSIONS,
    };
  }

  return {
    ok: false,
    checks: [
      {
        id: "aws.credentials",
        label: "No AWS credentials found",
        status: "fail",
        detail: "This server has no AWS_ACCESS_KEY_ID, so Orrery cannot read your account inventory.",
        fix: "Export the Terraform from Environment → Export and run it with your own credentials — or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY on the Orrery server to enable read-only inventory.",
      },
      {
        id: "aws.apply",
        label: "Apply is disabled in Preview",
        status: "warn",
        detail: "The AWS provider plans and exports in Preview. It never applies.",
        fix: "Deploy to a Sandbox environment to watch the full flow, then export Terraform for AWS.",
      },
      {
        id: "aws.export",
        label: "Terraform export available",
        status: "pass",
        detail: "Export works without credentials — it is generated from your manifest.",
      },
    ],
    permissions: IAM_PERMISSIONS,
  };
}

function exportBundle(env: Environment, manifest: Manifest): ExportBundle {
  return {
    files: terraformFiles(env, manifest),
    readme: terraformReadme(env, manifest),
  };
}

export const awsProvider: ProviderAdapter = {
  id: "aws",
  displayName: "Amazon Web Services",
  availability: "preview",
  tagline:
    "Preview: Orrery plans your system as ECS/Fargate and exports real, runnable Terraform. It does not apply changes to your account yet.",
  regions: [
    { id: "us-east-1", label: "US East (N. Virginia)" },
    { id: "us-west-2", label: "US West (Oregon)" },
    { id: "eu-west-1", label: "Europe (Ireland)" },
    { id: "eu-central-1", label: "Europe (Frankfurt)" },
    { id: "ap-south-1", label: "Asia Pacific (Mumbai)" },
    { id: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
  ],

  accessExplanation: () => ({
    summary:
      "You create an IAM role in your own account and trust Orrery's principal with a unique ExternalId. Orrery assumes it for short-lived STS sessions (1 hour, no stored keys) and, in Preview, only ever reads. There is no policy here that can create, modify or delete a resource — the Terraform export is how changes reach your account, run by you.",
    permissions: IAM_PERMISSIONS,
  }),

  preflight,
  planSteps,
  executeStep,
  exportBundle,
};
