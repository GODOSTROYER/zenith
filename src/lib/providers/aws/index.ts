/**
 * AWS provider — Preview.
 *
 * What "preview" honestly means here: Orrery produces a real ECS/Fargate-shaped
 * plan and generates genuinely runnable Terraform for the whole system, both
 * from your manifest alone. It never calls AWS — it cannot apply the plan, and
 * it cannot read your account either. `executeStep`, `observe` and `discover`
 * therefore refuse, loudly and with the alternative named, and the access this
 * connection asks for is nothing at all (`PREVIEW_ACCESS`).
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
import { configured } from "@/lib/env";
import { fargateSpec, terraformFiles, terraformReadme } from "@/lib/providers/aws/terraform";

/**
 * Terraform identifiers cannot hold a dash, so the exporter rewrites them.
 * The plan must name the SAME address the export emits — "my-api" planning as
 * `aws_ecs_service.my-api` and exporting as `aws_ecs_service.my_api` sends you
 * looking for a resource that is not in the file. Same rule as terraform.ts.
 */
const tfName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");

/** The exact message the Engine surfaces when someone tries to apply. */
export const AWS_PREVIEW_MESSAGE =
  "AWS execution requires credentials. Orrery Preview generates and exports the full Terraform for this system — run it with your own tooling, or connect credentials in a later release.";

/**
 * What this connection can actually do — derived from the code below, not from
 * the capability we intend to build.
 *
 * There used to be an IAM role here: create a cross-account role, trust
 * Orrery's principal with an ExternalId, and Orrery would assume it for
 * read-only inventory and cost. Not one line of that was implemented.
 * `preflight` reads `process.env.AWS_ACCESS_KEY_ID` and makes no AWS call;
 * `observe` and `discover` refuse by design; `executeStep` throws. So the
 * guidance asked for standing trust in the user's account that bought them
 * nothing — a permanent grant against a promise.
 *
 * The rule this list now follows: every line must be true of what runs today.
 * When a read path is implemented and verified, the permission it needs gets
 * added here in the same change — never before it.
 */
const PREVIEW_ACCESS = [
  "No AWS access at all. No role to create, no key to grant, no trust to extend — Orrery makes no AWS API call in Preview",
  "No credentials are stored or transmitted. AWS_ACCESS_KEY_ID on the Orrery server, if set, is reported as present and is never used to call AWS",
  "Reads nothing from your account: no inventory, no cost, no drift, no discovery — those surfaces refuse rather than invent an answer",
  "Writes nothing to your account: Preview never applies. Changes reach AWS only through the Terraform you export and run yourself",
  "Generates that Terraform on this server, from your manifest",
];

function planSteps(env: Environment, next: Manifest, previous?: Manifest): ProviderPlanStep[] {
  const steps: ProviderPlanStep[] = [];
  const managed = <T extends { ownership: string }>(xs: T[]) =>
    xs.filter((x) => x.ownership === "managed");
  const had = (nodeId: string) =>
    !!previous && [...previous.services, ...previous.resources].some((n) => n.id === nodeId);

  // The plan describes what `terraform apply` does when YOU run the export, so
  // it names no role for Orrery to assume: there is no cross-account trust in
  // this provider, and a step called "assume deployment role" implied one.
  steps.push({
    phase: "prepare",
    title: "Read account inventory with your own credentials",
    targetId: "",
    estMs: 4000,
    detail: "ecs:ListClusters, rds:DescribeDBInstances",
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
      detail: `aws_ecr_repository.${tfName(s.name)} + docker push`,
    });
    steps.push({
      phase: "provision",
      title: `Register task definition for ${s.name} (${spec.cpu} CPU / ${spec.memory} MB)`,
      targetId: s.id,
      estMs: 4000,
      detail: `aws_ecs_task_definition.${tfName(s.name)}`,
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
      detail: `${info.addr}.${tfName(r.name)}`,
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
        detail: `aws s3 sync → aws_s3_bucket.site_${tfName(s.name)}`,
      });
      continue;
    }
    if (s.kind === "cron") {
      steps.push({
        phase: "release",
        title: `Schedule ${s.name} on EventBridge`,
        targetId: s.id,
        estMs: 6000,
        detail: `aws_cloudwatch_event_rule.${tfName(s.name)}`,
      });
      continue;
    }
    steps.push({
      phase: "release",
      title: `Roll out ${s.name} (${s.replicas} task${s.replicas === 1 ? "" : "s"})`,
      targetId: s.id,
      estMs: 120000,
      detail: `aws_ecs_service.${tfName(s.name)} — rolling update, minimumHealthyPercent 100`,
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

/**
 * The exact message the drift and discovery surfaces show for AWS.
 *
 * These two methods exist, and refuse, on purpose. Omitting them would say
 * "not built yet", which is what a Planned provider says. The truth here is
 * sharper and worth stating: reading an account is built — it is deliberately
 * not wired to anything, because no credential path exists. So the refusal is
 * the feature, and it names the tool that answers the question today.
 */
export const AWS_NO_READ_MESSAGE =
  "Orrery does not read your AWS account. The AWS provider is Preview: it plans and exports Terraform, and no code path in Orrery calls AWS — so it cannot report drift or discover existing resources, and will not invent either. To see real drift today, export the bundle from Settings → Export and run `terraform plan` against it with your own credentials.";

async function observe(): Promise<never> {
  throw new Error(AWS_NO_READ_MESSAGE);
}

async function discover(): Promise<never> {
  throw new Error(AWS_NO_READ_MESSAGE);
}

async function preflight(conn: CloudConnection): Promise<PreflightReport> {
  const hasCreds = configured().awsCredentials;
  const region = conn.region || "us-east-1";

  if (hasCreds) {
    return {
      ok: true,
      checks: [
        {
          // Honest label: this checks that a variable is set, nothing more.
          // Nothing here calls sts:GetCallerIdentity, so the key could be junk.
          id: "aws.credentials",
          label: "AWS_ACCESS_KEY_ID is set on this server",
          status: "warn",
          detail: `A value is present in this server's environment (region ${region}). Orrery has not called AWS with it, so this says nothing about whether the key is valid or what it can reach.`,
          fix: "Nothing to do — Preview never uses these credentials. Validation against sts:GetCallerIdentity arrives with apply support.",
        },
        {
          id: "aws.apply",
          label: "Apply is disabled in Preview",
          status: "warn",
          detail:
            "Credentials detected but apply is disabled in Preview. Orrery will plan and export, never mutate your account.",
          fix: "Export the Terraform from Source → Export and run `terraform apply` yourself.",
        },
        {
          id: "aws.export",
          label: "Terraform export available",
          status: "pass",
          detail: "The full system exports as runnable HCL, including variables and a tfvars example.",
        },
      ],
      permissions: PREVIEW_ACCESS,
    };
  }

  return {
    // Usable for everything this provider does in Preview — plan and export
    // need no credentials. Reporting "not ok" implied a broken connection when
    // nothing was broken, and pushed the connection to `degraded` for good.
    ok: true,
    checks: [
      {
        // Not a failure: AWS in Preview needs no credentials for anything it
        // actually does. Saying "fail" implied a capability that unblocking it
        // would unlock, and there is none — nothing in Orrery reads AWS today.
        id: "aws.credentials",
        label: "No AWS credentials on this server",
        status: "warn",
        detail:
          "Orrery never calls AWS in Preview, so nothing here needs credentials. Setting them would not unlock reads, plans or applies today.",
        fix: "Export the Terraform from Settings → Export and run it with your own credentials. Setting AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY on the Orrery server changes nothing today: the AWS provider plans and exports only, and no code path reads your account.",
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
    permissions: PREVIEW_ACCESS,
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
      "This connection grants Orrery no access to your AWS account, because Orrery does not call AWS in Preview. Create no IAM role and extend no trust: there is nothing here to use it. Orrery plans your system and generates real Terraform from your manifest, on this server; you run that Terraform with your own credentials, and that is the only way anything reaches your account. When a read path exists, the exact permission it needs will be listed here — and not one line before it works.",
    permissions: PREVIEW_ACCESS,
  }),

  preflight,
  planSteps,
  executeStep,
  observe,
  discover,
  exportBundle,
};
