/**
 * LocalStack observe/discover against a mocked AWS SDK.
 *
 * LocalStack is the provider where drift is REAL, so the thing worth pinning is
 * that it reports what the endpoint actually returned: a bucket that is there,
 * a bucket that is not, and buckets and queues nobody in this environment owns.
 * Equally: that it stays silent about the kinds it only ever simulated, rather
 * than reporting an RDS instance nobody created as present and correct.
 */
import { describe, expect, it, vi } from "vitest";
import type { CloudConnection, Environment, Manifest } from "@/lib/domain/types";

// Factories are hoisted above every const in this file, so the fixtures live
// inside them rather than being referenced from outside.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    destroy() {}
    send = async () => ({
      Buckets: [
        { Name: "uploads-env1", CreationDate: new Date("2026-01-01T00:00:00.000Z") },
        { Name: "someone-elses-bucket", CreationDate: new Date("2026-02-02T00:00:00.000Z") },
      ],
    });
  },
  ListBucketsCommand: class {},
  CreateBucketCommand: class {},
  HeadBucketCommand: class {},
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    destroy() {}
    send = async () => ({
      QueueUrl: "http://localhost:4566/000000000000/jobs-env1",
      QueueUrls: [
        "http://localhost:4566/000000000000/jobs-env1",
        "http://localhost:4566/000000000000/orphan",
      ],
    });
  },
  ListQueuesCommand: class {},
  GetQueueUrlCommand: class {},
  CreateQueueCommand: class {},
}));

const { computeDrift } = await import("@/lib/drift");
const { localstackProvider } = await import("@/lib/providers/localstack");

/** LocalStack's health endpoint, answering as a healthy container. */
function healthy() {
  vi.stubGlobal("fetch", async () =>
    Response.json({ services: { s3: "running", sqs: "running" }, version: "4.0", edition: "community" })
  );
}

function down() {
  vi.stubGlobal("fetch", async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:4566");
  });
}

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

const connection: CloudConnection = {
  id: "conn-localstack",
  workspaceId: "ws",
  provider: "localstack",
  label: "LocalStack",
  region: "us-east-1",
  status: "healthy",
  grantedPermissions: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** uploads exists, gone does not, and neither postgres nor the service is visible. */
const manifest = (): Manifest => ({
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
    { id: "res-gone", name: "gone", kind: "object_store", config: {}, size: "small", ownership: "managed" },
    { id: "res-jobs", name: "jobs", kind: "queue", config: {}, size: "small", ownership: "managed" },
    { id: "res-db", name: "main", kind: "postgres", config: {}, size: "small", ownership: "managed" },
  ],
  routes: [],
  bindings: [],
});

describe("localstack observe", () => {
  it("is not simulated — it read a real endpoint", async () => {
    healthy();
    const state = await localstackProvider.observe!(environment, manifest());
    expect(state.simulated).toBe(false);
  });

  it("finds the bucket and queue it provisioned, by the names it provisions them under", async () => {
    healthy();
    const state = await localstackProvider.observe!(environment, manifest());
    const uploads = state.resources.find((r) => r.nodeId === "res-uploads")!;
    const jobs = state.resources.find((r) => r.nodeId === "res-jobs")!;
    expect(uploads.exists).toBe(true);
    expect(uploads.attributes.externalRef).toBe("s3://uploads-env1");
    expect(uploads.attributes.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(jobs.exists).toBe(true);
    expect(jobs.attributes.externalRef).toBe("http://localhost:4566/000000000000/jobs-env1");
  });

  it("reports a bucket that is not there as missing", async () => {
    healthy();
    const m = manifest();
    const items = computeDrift(m, await localstackProvider.observe!(environment, m));
    const missing = items.filter((i) => i.kind === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].nodeName).toBe("gone");
    expect(missing[0].severity).toBe("high");
  });

  it("says nothing about kinds it only ever simulated", async () => {
    healthy();
    const state = await localstackProvider.observe!(environment, manifest());
    // No RDS in Community, and no containers either: absent, not "fine".
    expect(state.resources.some((r) => r.nodeId === "res-db")).toBe(false);
    expect(state.resources.some((r) => r.nodeId === "svc-api")).toBe(false);
  });

  it("reports what it does not own as extra drift", async () => {
    healthy();
    const m = manifest();
    const items = computeDrift(m, await localstackProvider.observe!(environment, m));
    const extra = items.filter((i) => i.kind === "extra").map((i) => i.nodeName).sort();
    expect(extra).toEqual(["orphan", "someone-elses-bucket"]);
  });

  it("refuses, with the fix, when LocalStack is not running", async () => {
    down();
    await expect(localstackProvider.observe!(environment, manifest())).rejects.toThrow(
      /not reachable/i
    );
    await expect(localstackProvider.observe!(environment, manifest())).rejects.toThrow(
      /localstack start/
    );
  });
});

describe("localstack discover", () => {
  it("lists every real bucket and queue at the endpoint", async () => {
    healthy();
    const found = await localstackProvider.discover!(connection);
    expect(found.simulated).toBe(false);
    expect(found.resources.map((r) => r.externalRef).sort()).toEqual([
      "http://localhost:4566/000000000000/jobs-env1",
      "http://localhost:4566/000000000000/orphan",
      "s3://someone-elses-bucket",
      "s3://uploads-env1",
    ]);
    expect(found.resources.filter((r) => r.kind === "object_store")).toHaveLength(2);
    expect(found.resources.filter((r) => r.kind === "queue")).toHaveLength(2);
  });

  it("refuses when LocalStack is not running", async () => {
    down();
    await expect(localstackProvider.discover!(connection)).rejects.toThrow(/not reachable/i);
  });
});

describe("complete LocalStack verification", () => {
  const supported = (): Manifest => ({ ...manifest(), services: [], resources: manifest().resources.filter((r) => r.id === "res-uploads" || r.id === "res-jobs") });
  it("verifies real bucket and queue presence", async () => {
    healthy();
    const result = await localstackProvider.verify!(environment, supported());
    expect(result).toMatchObject({ status: "passed", simulated: false });
    expect(result.checks).toHaveLength(2);
  });
  it("fails if a removed bucket still exists", async () => {
    healthy();
    const previous = supported(), next = { ...previous, resources: previous.resources.filter((r) => r.kind === "queue") };
    const result = await localstackProvider.verify!(environment, next, previous);
    expect(result.status).toBe("failed");
    expect(result.checks.some((check) => !check.passed && check.detail.includes("expected absent"))).toBe(true);
  });
  it("does not verify simulated kinds or uninspected configuration", async () => {
    healthy();
    expect((await localstackProvider.verify!(environment, manifest())).status).toBe("unavailable");
    const value = supported(); value.resources[0].config = { versioning: true };
    expect((await localstackProvider.verify!(environment, value)).status).toBe("unavailable");
  });
});
