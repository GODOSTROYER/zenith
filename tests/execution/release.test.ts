/**
 * buildArtifacts, deployWorkloads, runMigrations.
 *
 * ECR is mocked with aws-sdk-client-mock through the fake credential broker's
 * AwsSession (its `client()` builds real SDK clients, which the mock intercepts).
 * The build, rollout and one-off-task ports are scripted fakes.
 */
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeaseLostError, StepFailedError } from "@/lib/execution/errors";
import { BuildLaunchError } from "@/lib/controlplane/db/repos/build-launches";
import { CANARY_SECRET, ENV, OP, builtManifest, migratingManifest, webDbManifest } from "./fakes/fixtures";
import { createWorld, type World, type WorldOptions } from "./fakes/world";

const ecr = mockClient(ECRClient);
const worlds: World[] = [];
const world = (opts: WorldOptions = {}): World => {
  const w = createWorld(opts);
  worlds.push(w);
  return w;
};
beforeEach(() => ecr.reset());
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

const OWN_ECR = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
const DIGEST = `sha256:${"a".repeat(64)}`;

async function ready(w: World) {
  await w.activities.markOperation({ operationId: OP, status: "running" });
  return w.lease();
}

describe("buildArtifacts", () => {
  it("builds a git-sourced service in the customer's account and returns the verified image digest", async () => {
    const w = world();
    w.product.setManifest(builtManifest());
    const lease = await ready(w);
    const out = await w.activities.buildArtifacts({ operationId: OP, lease });

    expect(out.images).toEqual([{ service: "container_service/api", imageUri: `${OWN_ECR}/zenith-api@sha256:${"9".repeat(64)}`, digest: `sha256:${"9".repeat(64)}` }]);
    // the source bundle was prepared from the pipeline's repository, then the build started against the pipeline and registry nodes
    expect(w.sourceBundle.calls).toEqual([{ service: "container_service/api", repo: "github.com/acme/api", ref: "main", hadSession: true }]);
    expect(w.build.started).toMatchObject([{ service: "container_service/api", pipeline: "build_pipeline/api", registry: "container_registry/api", fence: lease.fenceToken }]);
    // a mutating session under the operation's own capability
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "deploy", capability: "deployment.deploy", fence: lease.fenceToken, revoked: true });
    // evidence: the digest that was built, never the source itself
    const [row] = w.evidence.ofKind("build");
    expect(row.summary).toMatchObject({ service: "container_service/api", pipeline: "build_pipeline/api", imageDigest: `sha256:${"9".repeat(64)}`, sourceDigest: "5".repeat(64) });
    expect(row.simulated).toBe(false);
  });

  it("passes stable port keys; provider launch deduplication is verified separately against PostgreSQL", async () => {
    const w = world();
    w.product.setManifest(builtManifest());
    const lease = await ready(w);
    await w.activities.buildArtifacts({ operationId: OP, lease });
    await w.activities.buildArtifacts({ operationId: OP, lease });
    expect(w.build.started).toHaveLength(2);
    expect(w.build.started[0].idempotencyKey).toBe(w.build.started[1].idempotencyKey);
    expect(w.evidence.ofKind("build")).toHaveLength(1);
  });

  it.each(["lost-response", "polling-deadline"] as const)("retains a later parallel %s uncertainty over an earlier definitive failure and starts no fourth build", async kind => {
    const w=world(), manifest=builtManifest();
    manifest.services=["a","b","c","d"].map(name=>({...manifest.services[0],id:`svc-${name}`,name}));
    w.product.setManifest(manifest);
    const original=w.build.startBuild.bind(w.build);
    let allStarted!:()=>void, firstFailure!:()=>void;
    const started=new Promise<void>(resolve=>{allStarted=resolve;});
    const failed=new Promise<void>(resolve=>{firstFailure=resolve;});
    const uncertainty=kind==="lost-response" ? new BuildLaunchError() : new Error("Provider polling ended before terminal readback.");
    w.build.startBuild=async(ctx,input)=>{
      const handle=await original(ctx,input);
      if(w.build.started.length===3) allStarted();
      await started;
      if(input.service.address==="container_service/a") {firstFailure();throw new StepFailedError("Provider confirmed the first build failed.");}
      await failed;
      // Let the first rejection arrive before this already-started sibling's
      // later unknown result; classification must not depend on that ordering.
      await Promise.resolve(); await Promise.resolve();
      if(input.service.address==="container_service/b") throw uncertainty;
      return handle;
    };
    const lease=await ready(w);
    await expect(w.activities.buildArtifacts({operationId:OP,lease})).rejects.toBe(uncertainty);
    expect(w.build.started.map(b=>b.service)).toEqual(["container_service/a","container_service/b","container_service/c"]);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it.each([
    ["failed", /build of container_service\/api failed/],
    ["timed_out", /timed out/],
    ["stopped", /stopped/],
  ] as const)("a build that %s is a clean failure that deploys nothing", async (status, message) => {
    const w = world();
    w.product.setManifest(builtManifest());
    w.build.result = { status, detail: `exit code 1 token=${CANARY_SECRET}` };
    const lease = await ready(w);
    const err = await w.activities.buildArtifacts({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(message);
    expect((err as Error).message).not.toContain(CANARY_SECRET);
    expect(w.evidence.ofKind("build")).toHaveLength(0);
  });

  it("refuses a 'succeeded' build that reports no verifiable digest", async () => {
    for (const result of [
      { status: "succeeded" as const, imageUri: `${OWN_ECR}/zenith-api:latest` },
      { status: "succeeded" as const, imageUri: `${OWN_ECR}/zenith-api:latest`, digest: "sha256:short" },
      { status: "succeeded" as const, digest: DIGEST },
    ]) {
      const w = world();
      w.product.setManifest(builtManifest());
      w.build.result = result;
      const lease = await ready(w);
      await expect(w.activities.buildArtifacts({ operationId: OP, lease })).rejects.toThrow(/without a verifiable image digest/);
    }
  });

  it("refuses to build when this worker has no build runner or source bundler configured", async () => {
    const w = world({ withoutRelease: true });
    w.product.setManifest(builtManifest());
    const lease = await ready(w);
    await expect(w.activities.buildArtifacts({ operationId: OP, lease })).rejects.toThrow(/no build runner or source bundler/);
  });

  it("returns nothing and opens no session for a manifest with no workloads", async () => {
    const w = world();
    w.product.setManifest({ version: 1, services: [], resources: [], routes: [], bindings: [] });
    const lease = await ready(w);
    expect(await w.activities.buildArtifacts({ operationId: OP, lease })).toEqual({ images: [] });
    expect(w.credentials.sessions).toHaveLength(0);
  });

  describe("image services (pass-through and pinning)", () => {
    const withImage = (image: string) => {
      const m = webDbManifest();
      (m.services[0] as { source: unknown }).source = { type: "image", image };
      return m;
    };

    it("pins a tag in the connection's own ECR registry to its digest with ecr:DescribeImages", async () => {
      ecr.on(DescribeImagesCommand).resolves({ imageDetails: [{ imageDigest: DIGEST }] });
      const w = world();
      w.product.setManifest(withImage(`${OWN_ECR}/web:prod`));
      const lease = await ready(w);
      const out = await w.activities.buildArtifacts({ operationId: OP, lease });
      expect(out.images).toEqual([{ service: "container_service/web", imageUri: `${OWN_ECR}/web@${DIGEST}`, digest: DIGEST }]);
      expect(ecr.commandCalls(DescribeImagesCommand)[0].args[0].input).toEqual({ registryId: "123456789012", repositoryName: "web", imageIds: [{ imageTag: "prod" }] });
      expect(w.build.started).toHaveLength(0); // nothing to build
    });

    it("passes an already pinned reference through without asking ECR", async () => {
      const w = world();
      w.product.setManifest(withImage(`${OWN_ECR}/web@${DIGEST}`));
      const lease = await ready(w);
      const out = await w.activities.buildArtifacts({ operationId: OP, lease });
      expect(out.images[0]).toMatchObject({ digest: DIGEST });
      expect(ecr.commandCalls(DescribeImagesCommand)).toHaveLength(0);
    });

    it.each([
      ["a public registry", "ghcr.io/acme/web:1"],
      ["another account's ECR registry", "999999999999.dkr.ecr.us-east-1.amazonaws.com/web:prod"],
      ["another region's ECR registry", "123456789012.dkr.ecr.eu-west-1.amazonaws.com/web:prod"],
      ["a reference with neither tag nor digest", `${OWN_ECR}/web`],
    ])("keeps %s as written and reports it NOT pinned (empty digest), never guessing one", async (_name, ref) => {
      const w = world();
      w.product.setManifest(withImage(ref));
      const lease = await ready(w);
      const out = await w.activities.buildArtifacts({ operationId: OP, lease });
      expect(out.images).toEqual([{ service: "container_service/web", imageUri: ref, digest: "" }]);
      expect(ecr.commandCalls(DescribeImagesCommand)).toHaveLength(0);
    });

    it("fails cleanly when the image does not exist in the registry", async () => {
      ecr.on(DescribeImagesCommand).rejects(Object.assign(new Error("not found"), { name: "ImageNotFoundException" }));
      const w = world();
      w.product.setManifest(withImage(`${OWN_ECR}/web:missing`));
      const lease = await ready(w);
      await expect(w.activities.buildArtifacts({ operationId: OP, lease })).rejects.toBeInstanceOf(StepFailedError);
    });

    it("leaves the image unpinned when the deploy role may not read the registry, and retries other errors", async () => {
      ecr.on(DescribeImagesCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
      const w = world();
      w.product.setManifest(withImage(`${OWN_ECR}/web:prod`));
      const lease = await ready(w);
      expect((await w.activities.buildArtifacts({ operationId: OP, lease })).images[0].digest).toBe("");

      ecr.reset();
      ecr.on(DescribeImagesCommand).rejects(Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
      const err = await w.activities.buildArtifacts({ operationId: OP, lease }).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(StepFailedError); // plain → the build policy retries it
    });
  });
});

describe("deployWorkloads", () => {
  const image = { service: "container_service/web", imageUri: `${OWN_ECR}/web@${DIGEST}`, digest: DIGEST };

  it("rolls a pinned image and waits for steady state, idempotently keyed", async () => {
    const w = world();
    const lease = await ready(w);
    const out = await w.activities.deployWorkloads({ operationId: OP, lease, images: [image] });
    expect(out).toEqual({ services: 1 });
    expect(w.workloads.deployed).toEqual([{ service: "container_service/web", uri: image.imageUri, digest: DIGEST, idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
    expect(w.workloads.waited).toEqual(["container_service/web"]);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image] });
    expect(w.workloads.deployed[1].idempotencyKey).toBe(w.workloads.deployed[0].idempotencyKey);
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "deploy", fence: lease.fenceToken });
    expect(w.events.ofType("resource.applied").some((e) => e.data.step === "deploy")).toBe(true);
  });

  it("does not roll an unpinned image (OpenTofu already deployed the reference) but still waits for it", async () => {
    const w = world();
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [{ ...image, digest: "", imageUri: "ghcr.io/acme/web:1" }] });
    expect(w.workloads.deployed).toHaveLength(0);
    expect(w.workloads.waited).toEqual(["container_service/web"]);
  });

  it("waits for steady state even when the workflow skipped the build step (no images)", async () => {
    const w = world();
    const lease = await ready(w);
    expect(await w.activities.deployWorkloads({ operationId: OP, lease, images: [] })).toEqual({ services: 1 });
    expect(w.workloads.waited).toEqual(["container_service/web"]);
  });

  it("fails cleanly, saying it may be partially rolled out, when the service never becomes steady", async () => {
    const w = world();
    w.workloads.steady = false;
    const lease = await ready(w);
    const err = await w.activities.deployWorkloads({ operationId: OP, lease, images: [image] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/did not reach steady state \(2 of 3 tasks running\).*partially rolled out.*reconcile will observe/);
  });

  it("refuses images that name a node outside the graph or carry a malformed digest, before opening a session", async () => {
    const w = world();
    const lease = await ready(w);
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: [{ ...image, service: "container_service/ghost" }] })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: [{ ...image, digest: "latest" }] })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: [{ ...image, imageUri: "has spaces" }] })).rejects.toBeInstanceOf(StepFailedError);
    expect(w.credentials.sessions).toHaveLength(0);
  });

  it("does nothing for a graph with no workloads, and refuses without a workload deployer", async () => {
    const w = world();
    w.product.setManifest({ version: 1, services: [], resources: [], routes: [], bindings: [] });
    const lease = await ready(w);
    expect(await w.activities.deployWorkloads({ operationId: OP, lease, images: [] })).toEqual({ services: 0 });

    const bare = world({ withoutRelease: true });
    const l2 = await ready(bare);
    await expect(bare.activities.deployWorkloads({ operationId: OP, lease: l2, images: [] })).rejects.toThrow(/no workload deployer/);
  });

  it("raises LeaseLost when the lease is lost while the rollout is being waited on", async () => {
    const w = world();
    const lease = await ready(w);
    let release!: () => void;
    w.workloads.waitGate = new Promise<void>((resolve) => (release = resolve));
    const running = w.activities.deployWorkloads({ operationId: OP, lease, images: [] }).catch((e: unknown) => e);
    while (w.workloads.waited.length === 0) await new Promise((r) => setTimeout(r, 2)); // the rollout wait has begun
    w.leases.steal(lease.scope);
    await new Promise((r) => setTimeout(r, 30));
    release();
    expect(await running).toBeInstanceOf(LeaseLostError);
  });
});

describe("runMigrations", () => {
  it("reports 'no migration declared' and opens no session when the manifest has no release section", async () => {
    const w = world();
    const lease = await ready(w);
    expect(await w.activities.runMigrations({ operationId: OP, lease })).toEqual({ ran: false, detail: "no migration declared" });
    expect(w.migrations.runs).toHaveLength(0);
    expect(w.credentials.sessions).toHaveLength(0);
  });

  it("runs the declared argv once as a one-off task of the service, verbatim, and records evidence without the command text", async () => {
    const w = world();
    w.product.setManifest(migratingManifest(["node", "migrate.js", "--up", `--note=${CANARY_SECRET}`], { timeoutSec: 120 }));
    const lease = await ready(w);
    const out = await w.activities.runMigrations({ operationId: OP, lease });

    expect(out.ran).toBe(true);
    expect(out.detail).toMatch(/migration on web exited 0/);
    expect(w.migrations.runs).toHaveLength(1);
    expect(w.migrations.runs[0]).toMatchObject({ service: "container_service/web", command: ["node", "migrate.js", "--up", `--note=${CANARY_SECRET}`], timeoutMs: 120_000 });
    expect(Array.isArray(w.migrations.runs[0].command)).toBe(true); // an argv vector, never a shell string
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "deploy", fence: lease.fenceToken });

    const [row] = w.evidence.ofKind("machine_request");
    expect(row.summary).toMatchObject({ kind: "release.migrate", service: "container_service/web", exitCode: 0, argc: 4 });
    expect(w.stored()).not.toContain(CANARY_SECRET); // only a digest of the command is kept
  });

  it("caps the task's timeout at the step deadline", async () => {
    const w = world({ limits: { migrationTimeoutMs: 60_000 } });
    w.product.setManifest(migratingManifest(["run"], { timeoutSec: 3600 }));
    const lease = await ready(w);
    await w.activities.runMigrations({ operationId: OP, lease });
    expect(w.migrations.runs[0].timeoutMs).toBe(60_000);
  });

  it("fails cleanly on a non-zero exit code, warning that the database may be partially migrated", async () => {
    const w = world();
    w.product.setManifest(migratingManifest());
    w.migrations.exitCode = 3;
    const lease = await ready(w);
    const err = await w.activities.runMigrations({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/exited with code 3; the database may be partially migrated/);
    expect(w.evidence.ofKind("machine_request")[0].summary.exitCode).toBe(3); // the failure is on the record
  });

  it("leaves a timeout or crash of the task runner PLAIN, so the workflow finalizes uncertain", async () => {
    const w = world();
    w.product.setManifest(migratingManifest());
    w.migrations.error = new Error("task did not stop within 900 s");
    const lease = await ready(w);
    const err = await w.activities.runMigrations({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/did not stop/);
  });

  it("refuses without a one-off task runner, and is idempotently keyed per operation, service and command", async () => {
    const bare = world({ withoutRelease: true });
    bare.product.setManifest(migratingManifest());
    const l0 = await ready(bare);
    await expect(bare.activities.runMigrations({ operationId: OP, lease: l0 })).rejects.toThrow(/no one-off task runner/);

    const w = world();
    w.product.setManifest(migratingManifest());
    const lease = await ready(w);
    await w.activities.runMigrations({ operationId: OP, lease });
    await w.activities.runMigrations({ operationId: OP, lease });
    expect(w.migrations.runs[0].idempotencyKey).toBe(w.migrations.runs[1].idempotencyKey);
    w.product.setManifest(migratingManifest(["node", "other.js"]));
    await w.activities.runMigrations({ operationId: OP, lease });
    expect(w.migrations.runs[2].idempotencyKey).not.toBe(w.migrations.runs[0].idempotencyKey);
    expect(ENV).toBe("env-act-1");
  });
});
