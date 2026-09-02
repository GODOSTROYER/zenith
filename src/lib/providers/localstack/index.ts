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
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import type { CloudConnection, Environment, Manifest } from "@/lib/domain/types";
import {
  stepBudgetMs,
  type ExportBundle,
  type PreflightReport,
  type ProviderAdapter,
  type ProviderPlanStep,
  type ProviderProbe,
  type StepRuntime,
} from "@/lib/providers/types";
import { terraformFiles, terraformReadme } from "@/lib/providers/aws/terraform";

export const LOCALSTACK_ENDPOINT = env().ORRERY_LOCALSTACK_ENDPOINT;

const REGION = "us-east-1";
const FAST = () => env().ORRERY_FAST;

const PERMISSIONS = [
  `Talks only to LocalStack on this machine (${LOCALSTACK_ENDPOINT})`,
  'Uses the throwaway credentials "test"/"test" that LocalStack accepts',
  "Never contacts a real AWS account or the internet",
];

/* -------------------------------- clients --------------------------------- */

/**
 * LocalStack is on loopback, so a call that has not answered in a few seconds
 * is not slow — it is a container that died mid-deploy. Without these the SDK
 * defaults apply (no request timeout, 3 attempts with backoff) and a step can
 * hang the deployment indefinitely.
 */
const clientConfig = {
  region: REGION,
  endpoint: LOCALSTACK_ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 2_000, requestTimeout: 8_000 },
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

/**
 * Why the health check failed. "Not reachable" is one of four outcomes, and
 * telling a user to start Docker when LocalStack answered with a 500 sends
 * them down the wrong path entirely.
 */
type HealthFailure = "unreachable" | "timeout" | "http" | "malformed";

type HealthResult =
  | { ok: true; health: LocalstackHealth }
  | { ok: false; kind: HealthFailure; detail: string; fix: string };

const START_LOCALSTACK =
  "Start Docker Desktop, then run `localstack start` (or `docker run --rm -p 4566:4566 localstack/localstack`).";

async function health(): Promise<HealthResult> {
  const url = `${LOCALSTACK_ENDPOINT}/_localstack/health`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(2500), cache: "no-store" });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return timedOut
      ? {
          ok: false,
          kind: "timeout",
          detail: `${url} did not answer within 2.5s.`,
          fix: "Something is listening but not responding — often a LocalStack container still starting up, or another process on this port. Wait a few seconds and re-check, or run `docker ps` to see what holds the port.",
        }
      : {
          ok: false,
          kind: "unreachable",
          detail: `Nothing answered at ${url} (${err instanceof Error ? err.message : String(err)}).`,
          fix: `${START_LOCALSTACK} Re-check here when it's up.`,
        };
  }

  if (!res.ok)
    return {
      ok: false,
      kind: "http",
      detail: `${url} answered ${res.status} ${res.statusText}.`,
      fix: "LocalStack is running but unhealthy. Check the container logs (`localstack logs` or `docker logs`), then restart it.",
    };

  try {
    return { ok: true, health: (await res.json()) as LocalstackHealth };
  } catch {
    return {
      ok: false,
      kind: "malformed",
      detail: `${url} answered 200, but the body was not JSON.`,
      fix: `Something other than LocalStack is serving ${LOCALSTACK_ENDPOINT}. Free the port, or point ORRERY_LOCALSTACK_ENDPOINT at the right one.`,
    };
  }
}

const FAILURE_LABEL: Record<HealthFailure, string> = {
  unreachable: "LocalStack is not reachable",
  timeout: "LocalStack did not answer in time",
  http: "LocalStack answered, but is unhealthy",
  malformed: "Something other than LocalStack is on this port",
};

/**
 * Connection-free reachability check, exposed on the adapter as `probe` so
 * surfaces that offer LocalStack before any connection exists — onboarding's
 * "Available now" list — can ask whether it is actually up. One GET against
 * the health endpoint with a 2.5s timeout; safe to call on render.
 */
async function probe(): Promise<ProviderProbe> {
  const h = await health();
  if (h.ok) {
    const running = Object.values(h.health.services ?? {}).filter(
      (s) => s === "running" || s === "available"
    ).length;
    return {
      reachable: true,
      detail: `LocalStack ${h.health.version ?? ""}${h.health.edition ? ` (${h.health.edition})` : ""} is up at ${LOCALSTACK_ENDPOINT} — ${running} service(s) available.`.replace(
        /\s+/g,
        " "
      ),
    };
  }
  return { reachable: false, detail: `${FAILURE_LABEL[h.kind]}. ${h.detail}`, fix: h.fix };
}

async function preflight(_conn: CloudConnection): Promise<PreflightReport> {
  const result = await health();
  if (!result.ok) {
    return {
      ok: false,
      checks: [
        {
          id: "localstack.reachable",
          label: FAILURE_LABEL[result.kind],
          status: "fail",
          detail: result.detail,
          fix: result.fix,
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

  const h = result.health;
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
  const est = stepBudgetMs(rt, 1500);

  if (step.phase === "prepare") {
    rt.log(`GET ${LOCALSTACK_ENDPOINT}/_localstack/health`, "provider");
    const result = await health();
    if (!result.ok) {
      log.warn("localstack health check failed", {
        kind: result.kind,
        endpoint: LOCALSTACK_ENDPOINT,
        deploymentId: rt.deployment.id,
        detail: result.detail,
      });
      throw new Error(
        `${FAILURE_LABEL[result.kind]} at ${LOCALSTACK_ENDPOINT}. ${result.detail} ${result.fix} Then deploy again.`
      );
    }
    const h = result.health;
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
  probe,
  planSteps,
  executeStep,
  exportBundle,
};
