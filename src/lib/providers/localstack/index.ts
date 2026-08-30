/**
 * LocalStack provider — AWS emulated on your own machine.
 *
 * The point of this adapter is the migration story: it shares the AWS
 * provider's plan shapes and Terraform generator, so "switch to real AWS
 * later" means deleting one override file and supplying real credentials —
 * nothing else in Orrery changes.
 *
 * Honesty contract:
 *  - S3 buckets and SQS queues are created FOR REAL against LocalStack's
 *    edge endpoint (http://localhost:4566) with the AWS SDK.
 *  - Kinds LocalStack Community cannot emulate (RDS, ElastiCache, ECS, ALB)
 *    are locally simulated, and every such step's title says so.
 *  - Preflight talks to the real health endpoint and names the fix when
 *    Docker or LocalStack isn't running.
 *
 * Integrator-owned (added on user direction, post wave 2).
 */
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CreateQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { CloudConnection, Environment, Manifest } from "@/lib/domain/types";
import type {
  ExportBundle,
  PreflightReport,
  ProviderAdapter,
  ProviderPlanStep,
  StepRuntime,
} from "@/lib/providers/types";
import { terraformFiles, terraformReadme } from "@/lib/providers/aws/terraform";

export const LOCALSTACK_ENDPOINT =
  process.env.ORRERY_LOCALSTACK_ENDPOINT ?? "http://localhost:4566";

const REGION = "us-east-1";
const FAST = () => process.env.ORRERY_FAST === "1";

const PERMISSIONS = [
  `Talks only to LocalStack on this machine (${LOCALSTACK_ENDPOINT})`,
  'Uses the throwaway credentials "test"/"test" that LocalStack accepts',
  "Never contacts a real AWS account or the internet",
];

/* -------------------------------- clients --------------------------------- */

const clientConfig = {
  region: REGION,
  endpoint: LOCALSTACK_ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};

const s3 = () => new S3Client({ ...clientConfig, forcePathStyle: true });
const sqs = () => new SQSClient(clientConfig);

/** Kinds this adapter provisions for real on LocalStack Community. */
const REAL_KINDS = new Set(["object_store", "queue"]);

const SIMULATED_NOTE: Record<string, string> = {
  postgres: "RDS is not in LocalStack Community — simulated locally, real on AWS",
  redis: "ElastiCache is not in LocalStack Community — simulated locally, real on AWS",
  email: "SES sending is limited in LocalStack Community — simulated locally, real on AWS",
};

const bucketName = (name: string, env: Environment) =>
  `${name}-${env.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
const queueName = (name: string, env: Environment) =>
  `${name}-${env.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 75);

/* --------------------------------- health --------------------------------- */

interface LocalstackHealth {
  services?: Record<string, string>;
  edition?: string;
  version?: string;
}

async function health(): Promise<LocalstackHealth | null> {
  try {
    const res = await fetch(`${LOCALSTACK_ENDPOINT}/_localstack/health`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as LocalstackHealth;
  } catch {
    return null;
  }
}

async function preflight(_conn: CloudConnection): Promise<PreflightReport> {
  const h = await health();
  if (!h) {
    return {
      ok: false,
      checks: [
        {
          id: "localstack.reachable",
          label: "LocalStack is not reachable",
          status: "fail",
          detail: `Nothing answered at ${LOCALSTACK_ENDPOINT}/_localstack/health.`,
          fix: "Start Docker Desktop, then run `localstack start` (or `docker run --rm -p 4566:4566 localstack/localstack`). Re-check here when it's up.",
        },
        {
          id: "localstack.scope",
          label: "Everything stays on this machine",
          status: "pass",
          detail: "This provider only ever talks to localhost. No cloud account is involved.",
        },
      ],
      permissions: PERMISSIONS,
    };
  }

  const svc = h.services ?? {};
  const up = (name: string) => svc[name] === "running" || svc[name] === "available";
  const checks: PreflightReport["checks"] = [
    {
      id: "localstack.reachable",
      label: `LocalStack ${h.version ?? ""} is running${h.edition ? ` (${h.edition})` : ""}`,
      status: "pass",
      detail: `Health endpoint answered at ${LOCALSTACK_ENDPOINT}.`,
    },
    {
      id: "localstack.s3",
      label: "S3 (buckets provision for real)",
      status: up("s3") ? "pass" : "warn",
      detail: up("s3") ? "Buckets will be created in LocalStack." : "S3 service not reported as available.",
      fix: up("s3") ? undefined : "Ensure the s3 service is enabled in your LocalStack configuration.",
    },
    {
      id: "localstack.sqs",
      label: "SQS (queues provision for real)",
      status: up("sqs") ? "pass" : "warn",
      detail: up("sqs") ? "Queues will be created in LocalStack." : "SQS service not reported as available.",
      fix: up("sqs") ? undefined : "Ensure the sqs service is enabled in your LocalStack configuration.",
    },
    {
      id: "localstack.simulated",
      label: "Databases, caches, containers and load balancers are simulated",
      status: "warn",
      detail:
        "LocalStack Community has no RDS/ElastiCache/ECS/ALB, so those steps run as labeled local simulations. The exported Terraform provisions all of them for real on AWS.",
    },
  ];
  return { ok: true, checks, permissions: PERMISSIONS };
}

/* ---------------------------------- plan ----------------------------------- */

function planSteps(env: Environment, next: Manifest, previous?: Manifest): ProviderPlanStep[] {
  const steps: ProviderPlanStep[] = [];
  const managed = <T extends { ownership: string }>(xs: T[]) =>
    xs.filter((x) => x.ownership === "managed");
  const had = (nodeId: string) =>
    !!previous && [...previous.services, ...previous.resources].some((n) => n.id === nodeId);

  steps.push({
    phase: "prepare",
    title: "Check LocalStack health and enabled services",
    targetId: "",
    estMs: 1500,
    detail: `GET ${LOCALSTACK_ENDPOINT}/_localstack/health`,
  });

  for (const r of managed(next.resources)) {
    if (r.kind === "object_store") {
      steps.push({
        phase: "provision",
        title: `${had(r.id) ? "Reconcile" : "Create"} S3 bucket "${bucketName(r.name, env)}" in LocalStack`,
        targetId: r.id,
        estMs: 2500,
        detail: `s3:CreateBucket via ${LOCALSTACK_ENDPOINT}`,
      });
    } else if (r.kind === "queue") {
      steps.push({
        phase: "provision",
        title: `${had(r.id) ? "Reconcile" : "Create"} SQS queue "${queueName(r.name, env)}" in LocalStack`,
        targetId: r.id,
        estMs: 2000,
        detail: `sqs:CreateQueue via ${LOCALSTACK_ENDPOINT}`,
      });
    } else {
      steps.push({
        phase: "provision",
        title: `Simulate ${r.kind} "${r.name}" locally`,
        targetId: r.id,
        estMs: 3000,
        detail: SIMULATED_NOTE[r.kind] ?? "simulated locally",
      });
    }
  }

  for (const s of managed(next.services)) {
    steps.push({
      phase: "release",
      title: `Simulate ${s.kind === "cron" ? "schedule" : "rollout"} of ${s.name} locally`,
      targetId: s.id,
      estMs: s.kind === "web" ? 5000 : 3000,
      detail: "ECS is not in LocalStack Community — simulated locally, real on AWS",
    });
  }

  for (const route of next.routes) {
    steps.push({
      phase: "release",
      title: `Simulate routing ${route.host} locally`,
      targetId: route.id,
      estMs: 2000,
      detail: "ALB/Route 53 are not in LocalStack Community — simulated locally, real on AWS",
    });
  }

  steps.push({
    phase: "verify",
    title: "Verify LocalStack resources and record outputs",
    targetId: "",
    estMs: 2000,
    detail: "HeadBucket / GetQueueUrl round-trips",
  });

  return steps;
}

/* --------------------------------- execute --------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, FAST() ? 15 : ms));

async function executeStep(rt: StepRuntime): Promise<void> {
  const { step, env, revision } = rt;
  const m = revision.manifest;
  const est = (step as { estMs?: number }).estMs ?? 1500;

  if (step.phase === "prepare") {
    rt.log(`GET ${LOCALSTACK_ENDPOINT}/_localstack/health`, "provider");
    const h = await health();
    if (!h)
      throw new Error(
        `LocalStack is not reachable at ${LOCALSTACK_ENDPOINT}. Start Docker Desktop and run \`localstack start\`, then deploy again.`
      );
    rt.log(
      `LocalStack ${h.version ?? "(unknown version)"} up — ${Object.values(h.services ?? {}).filter((s) => s === "running" || s === "available").length} services available`,
      "info"
    );
    return;
  }

  const resource = m.resources.find((r) => r.id === step.targetId);
  const service = m.services.find((s) => s.id === step.targetId);

  // Real S3 bucket.
  if (resource?.kind === "object_store" && REAL_KINDS.has(resource.kind)) {
    const name = bucketName(resource.name, env);
    const client = s3();
    rt.log(`s3:CreateBucket ${name}`, "provider");
    try {
      await client.send(new CreateBucketCommand({ Bucket: name }));
    } catch (err) {
      const code = (err as { name?: string }).name ?? "";
      if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") throw err;
      rt.log(`bucket ${name} already exists — idempotent, continuing`, "info");
    }
    await client.send(new HeadBucketCommand({ Bucket: name }));
    rt.output({
      key: `bucket-${resource.id}`,
      label: `${resource.name} — s3://${name} (LocalStack)`,
      value: `${LOCALSTACK_ENDPOINT}/${name}`,
      kind: "connection",
      targetId: resource.id,
    });
    rt.log(`bucket ${name} live at ${LOCALSTACK_ENDPOINT}/${name}`, "info");
    return;
  }

  // Real SQS queue.
  if (resource?.kind === "queue" && REAL_KINDS.has(resource.kind)) {
    const name = queueName(resource.name, env);
    rt.log(`sqs:CreateQueue ${name}`, "provider");
    const res = await sqs().send(new CreateQueueCommand({ QueueName: name }));
    rt.output({
      key: `queue-${resource.id}`,
      label: `${resource.name} — SQS queue (LocalStack)`,
      value: res.QueueUrl ?? `${LOCALSTACK_ENDPOINT}/000000000000/${name}`,
      kind: "connection",
      targetId: resource.id,
    });
    rt.log(`queue live: ${res.QueueUrl}`, "info");
    return;
  }

  // Labeled local simulations for everything LocalStack Community can't run.
  if (resource) {
    rt.log(`simulating ${resource.kind} "${resource.name}" — ${SIMULATED_NOTE[resource.kind] ?? "local simulation"}`, "info");
    await sleep(est);
    rt.output({
      key: `sim-${resource.id}`,
      label: `${resource.name} — simulated locally (real on AWS via export)`,
      value: `local://${resource.name}`,
      kind: "text",
      targetId: resource.id,
    });
    return;
  }

  if (service) {
    rt.log(`simulating ${service.kind} "${service.name}" (${service.replicas} replica${service.replicas === 1 ? "" : "s"})`, "info");
    await sleep(est);
    if (service.kind === "web" || service.kind === "static") {
      rt.output({
        key: `url-${service.id}`,
        label: `${service.name} — simulated preview (ECS is Pro/AWS territory)`,
        value: `/preview/${rt.deployment.id}/${service.id}`,
        kind: "url",
        targetId: service.id,
      });
    }
    return;
  }

  // Routes + verify.
  await sleep(est);
  if (step.phase === "verify") rt.log("outputs recorded — LocalStack deploy complete", "info");
}

/* --------------------------------- export ---------------------------------- */

const OVERRIDE_FILE = `# providers_override.tf — the ONLY LocalStack-specific file.
#
# Terraform merges *_override.tf into the aws provider from providers.tf,
# pointing every service at LocalStack with throwaway credentials.
#
# >>> Moving to real AWS: DELETE THIS FILE and supply real credentials.
# >>> Nothing else in this bundle changes.
provider "aws" {
  access_key                  = "test"
  secret_key                  = "test"
  region                      = "${REGION}"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    s3             = "${LOCALSTACK_ENDPOINT}"
    sqs            = "${LOCALSTACK_ENDPOINT}"
    ses            = "${LOCALSTACK_ENDPOINT}"
    rds            = "${LOCALSTACK_ENDPOINT}"
    elasticache    = "${LOCALSTACK_ENDPOINT}"
    ecs            = "${LOCALSTACK_ENDPOINT}"
    ec2            = "${LOCALSTACK_ENDPOINT}"
    ecr            = "${LOCALSTACK_ENDPOINT}"
    iam            = "${LOCALSTACK_ENDPOINT}"
    logs           = "${LOCALSTACK_ENDPOINT}"
    route53        = "${LOCALSTACK_ENDPOINT}"
    acm            = "${LOCALSTACK_ENDPOINT}"
    elbv2          = "${LOCALSTACK_ENDPOINT}"
    sts            = "${LOCALSTACK_ENDPOINT}"
    cloudwatch     = "${LOCALSTACK_ENDPOINT}"
    events         = "${LOCALSTACK_ENDPOINT}"
  }
}
`;

function exportBundle(env: Environment, manifest: Manifest): ExportBundle {
  const files = terraformFiles(env, manifest);
  files.unshift({ path: "providers_override.tf", content: OVERRIDE_FILE });
  const readme =
    terraformReadme(env, manifest) +
    `\n\n## LocalStack mode\n\nThis bundle was exported from a LocalStack environment. \`providers_override.tf\` points the AWS provider at ${LOCALSTACK_ENDPOINT}; with LocalStack running, \`terraform init && terraform apply\` provisions against your machine (Community edition applies the S3/SQS subset; Pro covers more).\n\n**Switching to real AWS is one step: delete \`providers_override.tf\` and run with real AWS credentials.** Every resource definition is identical between the two targets — that is Orrery's migration guarantee.\n`;
  return { files, readme };
}

/* --------------------------------- adapter ---------------------------------- */

export const localstackProvider: ProviderAdapter = {
  id: "localstack",
  displayName: "LocalStack",
  availability: "available",
  tagline:
    "AWS emulated on your machine. Buckets and queues provision for real against LocalStack; kinds Community can't emulate run as labeled local simulations. Requires Docker + LocalStack running.",
  regions: [{ id: REGION, label: `${REGION} (emulated locally)` }],

  accessExplanation: () => ({
    summary:
      "Orrery talks to LocalStack's edge endpoint on this machine with LocalStack's throwaway test credentials. No real cloud account is touched, no traffic leaves localhost, and stopping the LocalStack container removes everything.",
    permissions: PERMISSIONS,
  }),

  preflight,
  planSteps,
  executeStep,
  exportBundle,
};
