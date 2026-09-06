/**
 * LocalStack teardown against a mocked AWS SDK.
 *
 * The bug this pins down: planning used to iterate only the NEXT manifest, so a
 * bucket or queue you removed from your system was never deleted — the
 * deployment reported success while the resource stayed live at the endpoint,
 * contradicting the very revision it claimed to have converged to (and drift
 * reported it as "extra" seconds later).
 *
 * So the assertions are about the product law, not the call shapes: removal is
 * planned, it runs last and in dependency order, it refuses rather than
 * destroying data, and it never pretends to delete something LocalStack only
 * ever simulated.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment, Manifest } from "@/lib/domain/types";
import type { ProviderPlanStep, StepRuntime } from "@/lib/providers/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-teardown-"));
process.env.ORRERY_FAST = "1";

/**
 * A LocalStack endpoint that records every call. `vi.hoisted` because the
 * `vi.mock` factories below are lifted above every other statement in the file
 * and still need to reach this.
 */
const aws = vi.hoisted(() => {
  interface Cmd {
    command: string;
    input: Record<string, unknown>;
  }
  const state = {
    calls: [] as Cmd[],
    /** what the bucket currently holds */
    objects: [] as string[],
    messages: 0,
    inFlight: 0,
    bucketGone: false,
    queueGone: false,
  };
  const fail = (name: string) => Object.assign(new Error(name), { name });
  const sent = (command: string) => state.calls.filter((c) => c.command === command);

  const s3send = async (c: Cmd): Promise<Record<string, unknown>> => {
    state.calls.push(c);
    if (state.bucketGone && ["ListObjectsV2", "DeleteBucket", "HeadBucket"].includes(c.command))
      throw fail("NoSuchBucket");
    if (c.command === "ListObjectsV2")
      return { Contents: state.objects.map((Key) => ({ Key })), IsTruncated: false };
    if (c.command === "DeleteObjects") {
      const keys = ((c.input.Delete as { Objects?: { Key: string }[] } | undefined)?.Objects ?? []).map(
        (o) => o.Key
      );
      state.objects = state.objects.filter((k) => !keys.includes(k));
      return { Deleted: keys.map((Key) => ({ Key })) };
    }
    return {};
  };

  const sqsSend = async (c: Cmd): Promise<Record<string, unknown>> => {
    state.calls.push(c);
    if (c.command === "GetQueueUrl") {
      if (state.queueGone) throw fail("QueueDoesNotExist");
      return { QueueUrl: `http://localhost:4566/000000000000/${String(c.input.QueueName)}` };
    }
    if (c.command === "GetQueueAttributes")
      return {
        Attributes: {
          ApproximateNumberOfMessages: String(state.messages),
          ApproximateNumberOfMessagesNotVisible: String(state.inFlight),
        },
      };
    return {};
  };

  return {
    state,
    s3send,
    sqsSend,
    sent,
    names: () => state.calls.map((c) => c.command),
    reset() {
      state.calls = [];
      state.objects = [];
      state.messages = 0;
      state.inFlight = 0;
      state.bucketGone = false;
      state.queueGone = false;
    },
  };
});

/** Command classes that carry their own name, so the fake endpoint can switch on it. */
const command = (name: string) =>
  class {
    command = name;
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown> = {}) {
      this.input = input;
    }
  };

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(c: { command: string; input: Record<string, unknown> }) {
      return aws.s3send(c);
    }
  },
  CreateBucketCommand: command("CreateBucket"),
  HeadBucketCommand: command("HeadBucket"),
  ListBucketsCommand: command("ListBuckets"),
  ListObjectsV2Command: command("ListObjectsV2"),
  DeleteObjectsCommand: command("DeleteObjects"),
  DeleteBucketCommand: command("DeleteBucket"),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    send(c: { command: string; input: Record<string, unknown> }) {
      return aws.sqsSend(c);
    }
  },
  CreateQueueCommand: command("CreateQueue"),
  ListQueuesCommand: command("ListQueues"),
  GetQueueUrlCommand: command("GetQueueUrl"),
  GetQueueAttributesCommand: command("GetQueueAttributes"),
  DeleteQueueCommand: command("DeleteQueue"),
}));

const { localstackProvider } = await import("@/lib/providers/localstack");
const { awsProvider } = await import("@/lib/providers/aws");

/* -------------------------------- fixtures -------------------------------- */

const environment: Environment = {
  id: "env1",
  projectId: "proj-atlas",
  name: "local",
  class: "sandbox",
  connectionId: "conn-localstack",
  region: "us-east-1",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: "atlas.orrery.test",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/**
 * One of everything that can be removed: a real bucket, a real queue, a kind
 * LocalStack only simulates, a resource Zenith.ai does not own, a service and a
 * route.
 */
const base = (): Manifest => ({
  version: 1,
  services: [
    {
      id: "svc-api",
      name: "api",
      kind: "web",
      source: { type: "image", image: "ghcr.io/acme/api:1" },
      size: "small",
      replicas: 2,
      port: 3000,
      env: [],
      ownership: "managed",
    },
  ],
  resources: [
    { id: "res-uploads", name: "uploads", kind: "object_store", config: {}, size: "small", ownership: "managed" },
    { id: "res-jobs", name: "jobs", kind: "queue", config: {}, size: "small", ownership: "managed" },
    { id: "res-db", name: "main", kind: "postgres", config: {}, size: "small", ownership: "managed" },
    {
      id: "res-adopted",
      name: "adopted",
      kind: "object_store",
      config: {},
      size: "small",
      ownership: "referenced",
      externalRef: "s3://adopted-elsewhere",
    },
  ],
  routes: [{ id: "rt-app", host: "app.atlas.test", pathPrefix: "/", tls: true, managedDns: true }],
  bindings: [],
});

/** The next revision, with some nodes taken out. */
const without = (...ids: string[]): Manifest => {
  const m = base();
  return {
    ...m,
    services: m.services.filter((s) => !ids.includes(s.id)),
    resources: m.resources.filter((r) => !ids.includes(r.id)),
    routes: m.routes.filter((r) => !ids.includes(r.id)),
  };
};

const plan = (next: Manifest, previous?: Manifest) =>
  localstackProvider.planSteps(environment, next, previous);

const titles = (steps: ProviderPlanStep[]) => steps.map((s) => s.title);
const teardowns = (steps: ProviderPlanStep[]) => steps.filter((s) => /^(Delete|Forget) /.test(s.title));
const stepFor = (steps: ProviderPlanStep[], re: RegExp) => steps.find((s) => re.test(s.title))!;

/** A StepRuntime carrying only what `executeStep` reads. */
function runtime(step: ProviderPlanStep, opts: { allowStatefulDeletion?: boolean } = {}) {
  const logs: string[] = [];
  const rt = {
    signal: new AbortController().signal,
    log: (line: string) => logs.push(line),
    output: () => {},
    env: {
      ...environment,
      policies: { approvalRequired: false, allowStatefulDeletion: !!opts.allowStatefulDeletion },
    },
    revision: { id: "rev-2", manifest: without("res-uploads", "res-jobs") },
    deployment: { id: "dep-1", estMs: { s0: 20 } },
    step: {
      id: "s0",
      seq: 0,
      status: "running",
      phase: step.phase,
      title: step.title,
      targetId: step.targetId,
      detail: step.detail,
    },
  } as unknown as StepRuntime;
  return { rt, logs };
}

const run = (step: ProviderPlanStep, opts?: { allowStatefulDeletion?: boolean }) => {
  const { rt, logs } = runtime(step, opts);
  return { promise: localstackProvider.executeStep(rt), logs };
};

beforeEach(() => aws.reset());

/* -------------------------------- planning -------------------------------- */

describe("localstack teardown planning", () => {
  it("plans a real delete for a bucket that left the manifest", () => {
    const step = stepFor(plan(without("res-uploads"), base()), /^Delete S3 bucket/);
    expect(step.title).toContain('"uploads-env1"');
    expect(step.title).toContain("not in this revision");
    // The name to delete travels in `detail` — the only field the engine hands
    // back that can carry it, since the node is gone from the next manifest.
    expect(step.detail).toMatch(/^s3:DeleteBucket uploads-env1 /);
    expect(step.targetId).toBe("res-uploads");
  });

  it("plans a real delete for a queue that left the manifest", () => {
    const step = stepFor(plan(without("res-jobs"), base()), /^Delete SQS queue/);
    expect(step.title).toContain('"jobs-env1"');
    expect(step.detail).toMatch(/^sqs:DeleteQueue jobs-env1 /);
    expect(step.targetId).toBe("res-jobs");
  });

  it("plans nothing to tear down while every resource is still there", () => {
    const steps = plan(base(), base());
    expect(teardowns(steps)).toHaveLength(0);
    expect(titles(steps).some((t) => /^Delete /.test(t))).toBe(false);
  });

  it("plans no teardown on a first deploy, when there is no previous revision", () => {
    expect(teardowns(plan(without("res-uploads", "res-jobs")))).toHaveLength(0);
  });

  it("never deletes a resource Zenith.ai does not own", () => {
    // `referenced` means it exists in the cloud and Zenith.ai only reads it.
    // Dropping it from the manifest stops tracking it; it does not destroy it.
    const steps = plan(without("res-adopted"), base());
    expect(teardowns(steps)).toHaveLength(0);
  });

  it("does not pretend to tear down a kind it only ever simulated", () => {
    const steps = plan(without("res-db"), base());
    expect(steps.some((s) => /^Delete /.test(s.title))).toBe(false);
    const step = stepFor(steps, /^Forget simulated postgres/);
    expect(step.title).toContain("nothing was created in LocalStack to delete");
    expect(step.detail).toMatch(/^No LocalStack call —/);
    expect(step.detail).not.toMatch(/DeleteBucket|DeleteQueue|rds:/i);
  });

  it("runs every teardown after the revision's creates and before verify", () => {
    // res-db stays, so the revision still has creates to run before any delete.
    const steps = plan(without("res-uploads", "res-jobs", "svc-api", "rt-app"), base());
    const last = (re: RegExp) => steps.map((s, i) => (re.test(s.title) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const first = (re: RegExp) => steps.findIndex((s) => re.test(s.title));

    const lastCreate = last(/^(Create|Reconcile|Simulate) /);
    const firstTeardown = first(/^(Delete|Forget) /);
    expect(lastCreate).toBeGreaterThanOrEqual(0);
    expect(firstTeardown).toBeGreaterThan(lastCreate);
    expect(steps.findIndex((s) => s.phase === "verify")).toBeGreaterThan(last(/^(Delete|Forget) /));
    // `release` is the last mutating phase, so the timeline's phase grouping
    // renders these where they actually run.
    expect(teardowns(steps).every((s) => s.phase === "release")).toBe(true);
  });

  it("tears down in reverse dependency order — routes, then services, then resources", () => {
    const steps = plan(without("res-uploads", "svc-api", "rt-app"), base());
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s.title));
    const route = at(/^Forget routing for app\.atlas\.test/);
    const service = at(/^Forget rollout of api/);
    const bucket = at(/^Delete S3 bucket/);
    expect(route).toBeGreaterThanOrEqual(0);
    expect(route).toBeLessThan(service);
    expect(service).toBeLessThan(bucket);
  });
});

/* -------------------------------- execution ------------------------------- */

describe("localstack teardown execution", () => {
  it("deletes an empty bucket", async () => {
    const step = stepFor(plan(without("res-uploads"), base()), /^Delete S3 bucket/);
    const { promise, logs } = run(step);
    await promise;
    expect(aws.names()).toEqual(["ListObjectsV2", "DeleteBucket"]);
    expect(aws.sent("DeleteBucket")[0].input.Bucket).toBe("uploads-env1");
    expect(logs.join("\n")).toMatch(/deleted — LocalStack now matches this revision/);
  });

  it("refuses a bucket that still holds objects, and deletes nothing", async () => {
    aws.state.objects = ["invoices/2026-01.pdf", "invoices/2026-02.pdf"];
    const step = stepFor(plan(without("res-uploads"), base()), /^Delete S3 bucket/);
    await expect(run(step).promise).rejects.toThrow(/still holds objects/);
    // Refusing FAILS the deployment, which is the honest outcome: the engine
    // must not report a convergence that did not happen.
    expect(aws.names()).not.toContain("DeleteObjects");
    expect(aws.names()).not.toContain("DeleteBucket");
    expect(aws.state.objects).toHaveLength(2);
  });

  it("names both ways forward when it refuses", async () => {
    aws.state.objects = ["keep-me.txt"];
    const step = stepFor(plan(without("res-uploads"), base()), /^Delete S3 bucket/);
    await expect(run(step).promise).rejects.toThrow(/s3 rm s3:\/\/uploads-env1 --recursive/);
    await expect(run(step).promise).rejects.toThrow(/Allow deleting databases and other stateful resources/);
  });

  it("empties then deletes when the environment allows stateful deletion", async () => {
    aws.state.objects = ["a.txt", "b.txt"];
    const step = stepFor(plan(without("res-uploads"), base()), /^Delete S3 bucket/);
    const { promise, logs } = run(step, { allowStatefulDeletion: true });
    await promise;
    // Emptying must precede the delete: S3 refuses to drop a non-empty bucket.
    expect(aws.names().indexOf("DeleteObjects")).toBeLessThan(aws.names().indexOf("DeleteBucket"));
    expect(aws.state.objects).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/2 object\(s\) destroyed/);
  });

  it("deletes a queue by the URL LocalStack hands back", async () => {
    const step = stepFor(plan(without("res-jobs"), base()), /^Delete SQS queue/);
    await run(step).promise;
    expect(aws.names()).toEqual(["GetQueueUrl", "GetQueueAttributes", "DeleteQueue"]);
    expect(aws.sent("DeleteQueue")[0].input.QueueUrl).toBe(
      "http://localhost:4566/000000000000/jobs-env1"
    );
  });

  it("refuses a queue that still holds messages", async () => {
    aws.state.messages = 3;
    aws.state.inFlight = 1;
    const step = stepFor(plan(without("res-jobs"), base()), /^Delete SQS queue/);
    await expect(run(step).promise).rejects.toThrow(/roughly 4 message\(s\)/);
    expect(aws.names()).not.toContain("DeleteQueue");
  });

  it("is idempotent — a bucket already gone is success, not a failed deploy", async () => {
    aws.state.bucketGone = true;
    const step = stepFor(plan(without("res-uploads"), base()), /^Delete S3 bucket/);
    const { promise, logs } = run(step);
    await expect(promise).resolves.toBeUndefined();
    expect(logs.join("\n")).toMatch(/already gone/);
  });

  it("is idempotent for a queue that is already gone", async () => {
    aws.state.queueGone = true;
    const step = stepFor(plan(without("res-jobs"), base()), /^Delete SQS queue/);
    await expect(run(step).promise).resolves.toBeUndefined();
    expect(aws.names()).not.toContain("DeleteQueue");
  });

  it("makes no LocalStack call for a kind it only simulated", async () => {
    const step = stepFor(plan(without("res-db"), base()), /^Forget simulated postgres/);
    const { promise, logs } = run(step);
    await promise;
    expect(aws.names()).toEqual([]);
    expect(logs.join("\n")).toMatch(/labeled local simulation/);
  });

  it("fails loudly when a teardown step lost the detail naming what to delete", async () => {
    const step = stepFor(plan(without("res-uploads"), base()), /^Delete S3 bucket/);
    const { promise } = run({ ...step, detail: undefined });
    // The old behaviour — falling through to the generic tail and reporting
    // success — is exactly the bug. Silence is not an option here.
    await expect(promise).rejects.toThrow(/no provider detail naming it/);
    expect(aws.names()).toEqual([]);
  });
});

/* ------------------------------ aws preview ------------------------------- */

describe("aws preview access copy", () => {
  it("claims no assumed role and no read it cannot perform", async () => {
    const access = awsProvider.accessExplanation();
    const preflight = await awsProvider.preflight({
      id: "conn-aws",
      workspaceId: "ws",
      provider: "aws",
      label: "AWS",
      region: "us-east-1",
      status: "healthy",
      grantedPermissions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    // Every string the Settings "Exact permissions" disclosure can render:
    // `connection.create` stores accessExplanation().permissions, and
    // `connection.check` replaces them with the preflight report's.
    const copy = [access.summary, ...access.permissions, ...preflight.permissions].join("\n");

    // No standing trust is asked for: there is no role, no ExternalId, no STS.
    expect(copy).not.toMatch(/AssumeRole|ExternalId|short-lived STS/i);
    expect(copy).not.toMatch(/You create an IAM role|trust Zenith.ai's principal/i);
    // No read it cannot perform.
    expect(copy).not.toMatch(/GetCostAndUsage|GetCallerIdentity|ListAllMyBuckets|Describe\*|Read-only inventory/i);
    // and it says plainly that there is nothing to grant. (Telling the user to
    // create NO role is the honest copy, so "IAM role" is not itself banned.)
    expect(copy).toMatch(/no AWS access/i);
    expect(copy).toMatch(/Reads nothing from your account/i);

    // The plan preview must not imply a role Zenith.ai assumes either.
    const steps = awsProvider.planSteps(environment, base());
    expect(steps.some((s) => /assume/i.test(s.title) || /sts:/i.test(s.detail ?? ""))).toBe(false);
  });
});
