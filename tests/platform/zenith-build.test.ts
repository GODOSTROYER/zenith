/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-MAN-01: source builds on the Zenith-operated cluster.
 *
 * Pure parts (the Job spec, builder arguments, egress classification, the
 * attestation) are tested directly. The port itself is exercised against the
 * Kubernetes contract fake (tests/providers/kubernetes/fake-api.ts): real
 * `createKubernetesSession`, real client, real Job/Secret/NetworkPolicy
 * requests; the cluster side is a CONTRACT fake, not a cluster. It models no
 * scheduler: the test plays the controller by setting the Job's status and
 * seeding its pod. tests/providers/zenith/managed-kind.test.ts (gated) runs the
 * same port against a real kind cluster with a real builder and registry.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DriverContext } from "@/lib/drivers/types";
import { assertBuildIsolation, BuildIsolationError } from "@/lib/execution/build-isolation";
import { StepFailedError } from "@/lib/execution/errors";
import { createKubernetesToolkit } from "@/lib/platform/kubernetes-toolkit";
import {
  MAX_INCLUSTER_SOURCE_BYTES,
  ZENITH_BUILD_COMPUTE_CLASS,
  attestBuild,
  builderArgs,
  builderPaths,
  classifyBuildEgress,
  createZenithBuildPort,
  createZenithSourceStore,
  jobNameFor,
  renderBuildJob,
  sourceSecretName,
} from "@/lib/platform/zenith-managed-build";
import { createKubernetesSession } from "@/lib/providers/kubernetes/session";
import type { ManagedBuildConfig } from "@/lib/providers/zenith/managed-build-config";
import type { ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import { createManagedSubstrate, readManagedConfigs } from "@/lib/providers/zenith/managed-substrate";
import type { BuildPipelineSpec } from "@/lib/resources/specs";
import { startFakeK8s, type FakeK8s } from "../providers/kubernetes/fake-api";
import { FULL_ENV, TENANT, mkNode } from "../providers/zenith/support";

const BUILDER = `registry.example.com/zenith/builder@sha256:${"a".repeat(64)}`;
const NAMESPACE = "zenith-build";
const CONFIG: ManagedBuildConfig = { namespace: NAMESPACE, builderImage: BUILDER, insecureRegistry: false, serviceAccount: "zenith-builder" };
const KEY = createHash("sha256").update("build-key").digest("hex");
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;

const jobInput = (over: Partial<Parameters<typeof renderBuildJob>[0]> = {}) => ({
  config: CONFIG, workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId, serviceAddress: "container_service/web", pipelineAddress: "build_pipeline/web",
  key: KEY, image: `registry.example.com/zenith/ws/env/web:zn-${KEY.slice(0, 40)}`, sourceSecret: sourceSecretName(TENANT.environmentId, "d".repeat(64)),
  sourceDigest: "d".repeat(64), dockerfile: "Dockerfile", contextDir: ".", timeoutSec: 1800, ...over,
});

describe("the builder invocation", () => {
  it("reads a tar context from the read-only source mount and writes the digest where the pod reports it", () => {
    const args = builderArgs({ config: CONFIG, image: "r/web:zn-1", dockerfile: "Dockerfile", contextDir: "." });
    expect(args).toContain("--context=tar:///source/source.tar.gz");
    expect(args).toContain("--dockerfile=Dockerfile");
    expect(args).toContain("--destination=r/web:zn-1");
    expect(args).toContain("--digest-file=/dev/termination-log");
    expect(args.some((a) => a.startsWith("--context-sub-path"))).toBe(false);
    expect(args).not.toContain("--insecure");
  });

  it("honours a context subdirectory and a plain-http registry only when told to", () => {
    const args = builderArgs({ config: { ...CONFIG, insecureRegistry: true }, image: "r/web:zn-1", dockerfile: "Dockerfile", contextDir: "apps/web" });
    expect(args).toContain("--context-sub-path=apps/web");
    expect(args).toContain("--insecure");
  });

  it("makes the Dockerfile relative to the context and refuses one outside it", () => {
    const spec = (dockerfile?: string): BuildPipelineSpec => ({ source: { repo: "acme/web", ref: "main", ...(dockerfile ? { dockerfile } : {}) }, output: { registry: "container_registry/web" }, location: "customer_account" });
    expect(builderPaths(spec(), ".")).toEqual({ dockerfile: "Dockerfile", contextDir: "." });
    expect(builderPaths(spec("apps/web/Dockerfile"), "apps/web")).toEqual({ dockerfile: "Dockerfile", contextDir: "apps/web" });
    expect(() => builderPaths(spec("other/Dockerfile"), "apps/web")).toThrowError(StepFailedError);
    expect(() => builderPaths(spec("../Dockerfile"), ".")).toThrowError(StepFailedError);
    expect(() => builderPaths(spec("/etc/Dockerfile"), ".")).toThrowError(StepFailedError);
  });
});

describe("the build Job as submitted", () => {
  const job = renderBuildJob(jobInput());
  const pod = (job.spec as any).template.spec;
  const container = pod.containers[0];

  it("runs one pinned builder with no retries, a hard deadline and a TTL", () => {
    expect(job.metadata.name).toBe(jobNameFor(KEY));
    expect(job.metadata.namespace).toBe(NAMESPACE);
    expect(container.image).toBe(BUILDER);
    expect((job.spec as any)).toMatchObject({ completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 1800, ttlSecondsAfterFinished: 3600 });
    expect(pod.restartPolicy).toBe("Never");
  });

  it("gives the build no cluster identity and mounts the source read-only", () => {
    expect(pod.serviceAccountName).toBe("zenith-builder");
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.enableServiceLinks).toBe(false);
    expect(pod.hostNetwork).toBeUndefined();
    expect(container.securityContext).toMatchObject({ privileged: false, allowPrivilegeEscalation: false });
    expect(container.volumeMounts).toEqual([{ name: "source", mountPath: "/source", readOnly: true }]);
    expect(pod.volumes).toEqual([{ name: "source", secret: { secretName: sourceSecretName(TENANT.environmentId, "d".repeat(64)), defaultMode: 0o444 } }]);
  });

  it("bounds resources and records the launch's identity as annotations", () => {
    expect(container.resources.limits).toEqual({ cpu: "2", memory: "4Gi", "ephemeral-storage": "10Gi" });
    expect(job.metadata.annotations).toMatchObject({
      "zenith.dev/environment": TENANT.environmentId, "zenith.dev/workspace-id": TENANT.workspaceId, "zenith.dev/build-key": KEY, "zenith.dev/source-digest": "d".repeat(64),
    });
  });

  it("mounts the registry push credential read-only, as a docker config, only when one is configured", () => {
    const withPush = renderBuildJob(jobInput({ config: { ...CONFIG, pushSecret: "registry-push" } }));
    const spec = (withPush.spec as any).template.spec;
    expect(spec.volumes[1]).toEqual({ name: "registry-auth", secret: { secretName: "registry-push", items: [{ key: ".dockerconfigjson", path: "config.json" }], defaultMode: 0o444 } });
    expect(spec.containers[0].volumeMounts[1]).toEqual({ name: "registry-auth", mountPath: "/kaniko/.docker", readOnly: true });
  });
});

describe("source hand-off naming", () => {
  it("is scoped to the environment: two tenants never share a source object", () => {
    const sha = "e".repeat(64);
    expect(sourceSecretName("env-a", sha)).toMatch(/^zsrc-[a-f0-9]{40}$/);
    expect(sourceSecretName("env-a", sha)).toBe(sourceSecretName("env-a", sha));
    expect(sourceSecretName("env-a", sha)).not.toBe(sourceSecretName("env-b", sha));
  });
});

describe("egress classification of the build namespace policy", () => {
  const policy = (egress: unknown, types: string[] = ["Egress"]) => ({ spec: { podSelector: {}, policyTypes: types, ...(egress === undefined ? {} : { egress }) } });

  it("treats a missing policy, or one that does not restrict egress, as unrestricted", () => {
    expect(classifyBuildEgress(undefined).egress).toBe("unrestricted");
    expect(classifyBuildEgress(policy([], ["Ingress"])).egress).toBe("unrestricted");
  });

  it("an empty egress list is a deny-all allowlist", () => {
    expect(classifyBuildEgress(policy([]))).toMatchObject({ egress: "allowlisted", metadataReachable: false });
  });

  it("a rule with no peers, or the whole internet, is unrestricted", () => {
    expect(classifyBuildEgress(policy([{ ports: [{ port: 443 }] }])).egress).toBe("unrestricted");
    expect(classifyBuildEgress(policy([{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }])).egress).toBe("unrestricted");
    expect(classifyBuildEgress(policy([{ to: [{ ipBlock: { cidr: "::/0" } }] }])).egress).toBe("unrestricted");
  });

  it("named destinations stay allowlisted, and the metadata address is reachable only if a rule covers it", () => {
    expect(classifyBuildEgress(policy([{ to: [{ ipBlock: { cidr: "10.0.0.0/8" } }], ports: [{ port: 5000 }] }]))).toMatchObject({ egress: "allowlisted", metadataReachable: false });
    expect(classifyBuildEgress(policy([{ to: [{ ipBlock: { cidr: "169.254.0.0/16" } }] }])).metadataReachable).toBe(true);
    expect(classifyBuildEgress(policy([{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16"] } }] }])).metadataReachable).toBe(false);
  });
});

describe("the attestation read back from an executed Job", () => {
  const executed = (over: Record<string, unknown> = {}) => ({
    ...(renderBuildJob(jobInput()) as any), metadata: { ...(renderBuildJob(jobInput()).metadata as any), uid: "job-uid-1" },
    status: { startTime: "2026-10-07T00:00:00Z", completionTime: "2026-10-07T00:01:00Z" }, ...over,
  });
  const allowlisted = classifyBuildEgress({ spec: { policyTypes: ["Egress"], egress: [{ to: [{ ipBlock: { cidr: "10.0.0.0/8" } }] }] } });

  it("satisfies the zenith isolation profile when egress is allowlisted and the identity is dedicated", () => {
    const attestation = attestBuild({ config: CONFIG, job: executed(), egress: allowlisted, serviceAccountExists: true });
    expect(attestation).toMatchObject({ builderId: "zenith-managed:zenith-build", invocationId: "job-uid-1", builderImage: BUILDER, startedOn: "2026-10-07T00:00:00Z" });
    expect(attestation.isolation.resources.computeClass).toBe(ZENITH_BUILD_COMPUTE_CLASS);
    expect(assertBuildIsolation("zenith", attestation.isolation, { allowOpenEgress: false })).toEqual({ exceptions: [] });
  });

  it("is refused when egress is unrestricted, and admitted only under the recorded open-egress exception", () => {
    const open = classifyBuildEgress({ spec: { policyTypes: ["Egress"], egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16"] } }] }] } });
    const attestation = attestBuild({ config: CONFIG, job: executed(), egress: open, serviceAccountExists: true });
    expect(attestation.isolation.network.egress).toBe("unrestricted");
    expect(() => assertBuildIsolation("zenith", attestation.isolation, { allowOpenEgress: false })).toThrowError(BuildIsolationError);
    expect(assertBuildIsolation("zenith", attestation.isolation, { allowOpenEgress: true }).exceptions).toEqual(["open_egress"]);
  });

  it("is refused when the metadata endpoint is reachable, even under the open-egress exception", () => {
    const reachable = classifyBuildEgress({ spec: { policyTypes: ["Egress"], egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }] } });
    const attestation = attestBuild({ config: CONFIG, job: executed(), egress: reachable, serviceAccountExists: true });
    expect(() => assertBuildIsolation("zenith", attestation.isolation, { allowOpenEgress: true })).toThrowError(/metadata/);
  });

  it("is refused when the identity is not the dedicated builder, a token is mounted, or the source is writable", () => {
    const base = executed() as any;
    const noAccount = attestBuild({ config: CONFIG, job: base, egress: allowlisted, serviceAccountExists: false });
    expect(() => assertBuildIsolation("zenith", noAccount.isolation, { allowOpenEgress: false })).toThrowError(/dedicated build identity/);

    const withToken = structuredClone(base);
    withToken.spec.template.spec.automountServiceAccountToken = true;
    const mounted = attestBuild({ config: CONFIG, job: withToken, egress: allowlisted, serviceAccountExists: true });
    expect(() => assertBuildIsolation("zenith", mounted.isolation, { allowOpenEgress: false })).toThrowError(/deployment credentials/);

    const writable = structuredClone(base);
    writable.spec.template.spec.containers[0].volumeMounts[0].readOnly = false;
    const rw = attestBuild({ config: CONFIG, job: writable, egress: allowlisted, serviceAccountExists: true });
    expect(() => assertBuildIsolation("zenith", rw.isolation, { allowOpenEgress: false })).toThrowError(/read-only/);
  });

  it("is refused when another Secret is mounted into the build, or resources are not the profile's", () => {
    const base = executed() as any;
    const extra = structuredClone(base);
    extra.spec.template.spec.volumes.push({ name: "x", secret: { secretName: "some-tenant-secret" } });
    const leaked = attestBuild({ config: CONFIG, job: extra, egress: allowlisted, serviceAccountExists: true });
    expect(leaked.isolation.identity.deployCredentials).toBe("unknown");
    expect(() => assertBuildIsolation("zenith", leaked.isolation, { allowOpenEgress: false })).toThrowError(/deployment credentials/);

    const big = structuredClone(base);
    big.spec.template.spec.containers[0].resources.limits.memory = "64Gi";
    const resized = attestBuild({ config: CONFIG, job: big, egress: allowlisted, serviceAccountExists: true });
    expect(resized.isolation.resources.computeClass).toBe("k8s-unrecognised");
    expect(() => assertBuildIsolation("zenith", resized.isolation, { allowOpenEgress: false })).toThrowError(/compute class/);
  });
});

/* ------------------------- the port against the contract fake ------------------------- */

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("the build port against the Kubernetes contract fake", () => {
  let fake: FakeK8s;
  let managed: ManagedSubstratePort;

  const seedBaseline = (egress: unknown[] | undefined = [{ to: [{ ipBlock: { cidr: "10.0.0.0/8" } }], ports: [{ protocol: "TCP", port: 5000 }] }]) => {
    fake.seed({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "zenith-builder", namespace: NAMESPACE }, automountServiceAccountToken: false });
    if (egress !== undefined) {
      fake.seed({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "zenith-build-egress", namespace: NAMESPACE }, spec: { podSelector: {}, policyTypes: ["Egress"], egress } });
    }
  };

  beforeEach(async () => {
    fake = await startFakeK8s();
    managed = createManagedSubstrate({
      ...readManagedConfigs({ ...FULL_ENV, ZENITH_MANAGED_BUILDER_IMAGE: BUILDER }),
      toolkit: createKubernetesToolkit(),
      tenants: { resolve: async (ref) => ({ ...TENANT, ...ref }) },
      // The substrate's server must be https; the contract fake is plain http on loopback, so only the URL is swapped.
      createKubernetesSession: (config, signal) => createKubernetesSession({ ...config, server: fake.url }, { resolveCredential: async () => fake.token, allowInsecureLoopback: true }, signal),
      resolvePlatformCredential: async () => fake.token,
      fetch: globalThis.fetch,
    });
  });
  afterEach(async () => {
    await fake.close();
  });

  const ref = { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId };
  const bundle = (() => {
    const archive = Buffer.from("not really a tarball, but bytes with an identity");
    return { archive, sha256: sha256(archive), bytes: archive.length };
  })();

  async function context(): Promise<DriverContext> {
    const session = await managed.openSession(ref);
    return { provider: "zenith", region: "zenith-managed", workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId, operationId: "op-1", session, signal: new AbortController().signal, log: () => undefined, tags: {}, now: () => new Date() };
  }

  const nodes = () => ({
    service: mkNode("container_service/web", "container_service", { artifact: { type: "built", pipeline: "build_pipeline/web", registry: "container_registry/web" } }),
    pipeline: mkNode("build_pipeline/web", "build_pipeline", { source: { repo: "acme/web", ref: "main" }, output: { registry: "container_registry/web" }, location: "customer_account" }),
  });

  const start = async (port: ReturnType<typeof createZenithBuildPort>, ctx: DriverContext) => {
    const stored = await createZenithSourceStore(managed).upload(ctx, bundle);
    const n = nodes();
    return port.startBuild(ctx, { ...n, source: { s3Key: stored.name, digest: bundle.sha256, bucket: stored.namespace }, idempotencyKey: "idem-1" });
  };

  it("hands the source over as an immutable, environment-owned Secret, idempotently", async () => {
    const ctx = await context();
    const store = createZenithSourceStore(managed);
    const first = await store.upload(ctx, bundle);
    const second = await store.upload(ctx, bundle);
    expect(second).toEqual(first);
    expect(first).toEqual({ name: sourceSecretName(TENANT.environmentId, bundle.sha256), namespace: NAMESPACE });
    const secret = fake.get("Secret", NAMESPACE, first.name) as any;
    expect(secret.immutable).toBe(true);
    expect(secret.metadata.annotations["zenith.dev/environment"]).toBe(TENANT.environmentId);
    expect(secret.metadata.annotations["zenith.dev/source-digest"]).toBe(bundle.sha256);
    expect(Buffer.from(secret.data["source.tar.gz"], "base64").equals(bundle.archive)).toBe(true);
  });

  it("refuses a source archive larger than the in-cluster hand-off carries, naming the limit", async () => {
    const ctx = await context();
    const archive = Buffer.alloc(MAX_INCLUSTER_SOURCE_BYTES + 1, 1);
    await expect(createZenithSourceStore(managed).upload(ctx, { archive, sha256: sha256(archive), bytes: archive.length })).rejects.toThrowError(new RegExp(`${MAX_INCLUSTER_SOURCE_BYTES}`));
    expect(fake.list("Secret", NAMESPACE)).toEqual([]);
  });

  it("refuses to run a build when the build namespace has no declared egress policy, and launches nothing", async () => {
    seedBaseline(undefined);
    const ctx = await context();
    await expect(start(createZenithBuildPort({ managed, pollMs: 1 }), ctx)).rejects.toThrowError(/zenith-build-egress/);
    expect(fake.list("Job", NAMESPACE)).toEqual([]);
  });

  it("refuses to run a build without the platform builder ServiceAccount", async () => {
    fake.seed({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "zenith-build-egress", namespace: NAMESPACE }, spec: { podSelector: {}, policyTypes: ["Egress"], egress: [] } });
    const ctx = await context();
    await expect(start(createZenithBuildPort({ managed, pollMs: 1 }), ctx)).rejects.toThrowError(/zenith-builder/);
    expect(fake.list("Job", NAMESPACE)).toEqual([]);
  });

  it("launches exactly one Job per launch identity and re-adopts it on a retry", async () => {
    seedBaseline();
    const ctx = await context();
    const port = createZenithBuildPort({ managed, pollMs: 1 });
    const first = await start(port, ctx);
    const second = await start(port, ctx);
    expect(second).toEqual(first);
    const jobs = fake.list("Job", NAMESPACE);
    expect(jobs).toHaveLength(1);
    const handle = JSON.parse(first.buildId) as { id: string; image: string; repository: string };
    expect(jobs[0].metadata.name).toBe(handle.id);
    // the image lands in THIS tenant's repository on the Zenith-operated registry
    expect(handle.repository).toBe(managed.registry()!.repositoryFor(TENANT, "web"));
    expect(handle.image.startsWith(`${handle.repository}:zn-`)).toBe(true);
    expect((jobs[0] as any).spec.template.spec.automountServiceAccountToken).toBe(false);
  });

  it("refuses a handle that belongs to another environment", async () => {
    seedBaseline();
    const ctx = await context();
    const port = createZenithBuildPort({ managed, pollMs: 1 });
    const handle = await start(port, ctx);
    const foreign: DriverContext = { ...ctx, environmentId: "env_other", session: { ...(ctx.session as object), tenant: { ...TENANT, environmentId: "env_other" } } };
    await expect(port.waitForBuild(foreign, handle, { timeoutMs: 50 })).rejects.toThrowError(StepFailedError);
  });

  async function finish(handleText: string, state: "complete" | "failed", message = `${IMAGE_DIGEST}\n`): Promise<void> {
    const handle = JSON.parse(handleText) as { id: string };
    const job = fake.get("Job", NAMESPACE, handle.id) as any;
    const uid = job.metadata.uid as string;
    fake.setStatus("Job", NAMESPACE, handle.id, {
      conditions: [state === "complete" ? { type: "Complete", status: "True" } : { type: "Failed", status: "True", reason: "BackoffLimitExceeded" }],
      startTime: "2026-10-07T00:00:00Z", ...(state === "complete" ? { completionTime: "2026-10-07T00:01:00Z" } : {}),
    });
    fake.seedPod({
      apiVersion: "v1", kind: "Pod",
      metadata: { name: `${handle.id}-pod`, namespace: NAMESPACE, labels: { "batch.kubernetes.io/controller-uid": uid }, ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: handle.id, uid, controller: true }] },
      status: { containerStatuses: [{ name: "build", state: { terminated: { exitCode: state === "complete" ? 0 : 1, message } } }] },
    });
  }

  it("returns the digest the builder wrote, an image reference by that digest, and an attestation that passes admission", async () => {
    seedBaseline();
    const ctx = await context();
    const port = createZenithBuildPort({ managed, pollMs: 1 });
    const handle = await start(port, ctx);
    await finish(handle.buildId, "complete");
    const result = await port.waitForBuild(ctx, handle, { timeoutMs: 5_000 });
    expect(result.status).toBe("succeeded");
    expect(result.digest).toBe(IMAGE_DIGEST);
    const repository = (JSON.parse(handle.buildId) as { repository: string }).repository;
    expect(result.imageUri).toBe(`${repository}@${IMAGE_DIGEST}`);
    expect(managed.registry()!.ownsPinnedImage(TENANT, result.imageUri!)).toBe(true);
    expect(result.attestation).toBeDefined();
    expect(assertBuildIsolation("zenith", result.attestation!.isolation, { allowOpenEgress: false })).toEqual({ exceptions: [] });
    // the source object is dropped once the build is over
    expect(fake.list("Secret", NAMESPACE)).toEqual([]);
  });

  it("reports a failed Job as failed with no digest, and does not claim an attestation", async () => {
    seedBaseline();
    const ctx = await context();
    const port = createZenithBuildPort({ managed, pollMs: 1 });
    const handle = await start(port, ctx);
    await finish(handle.buildId, "failed", "");
    const result = await port.waitForBuild(ctx, handle, { timeoutMs: 5_000 });
    expect(result.status).toBe("failed");
    expect(result.digest).toBeUndefined();
    expect(result.attestation).toBeUndefined();
    expect(result.detail).toContain("BackoffLimitExceeded");
  });

  it("does not turn an unreadable digest into a success", async () => {
    seedBaseline();
    const ctx = await context();
    const port = createZenithBuildPort({ managed, pollMs: 1 });
    const handle = await start(port, ctx);
    await finish(handle.buildId, "complete", "not-a-digest");
    await expect(port.waitForBuild(ctx, handle, { timeoutMs: 5_000 })).rejects.toThrowError(/digest/);
  });

  it("times out waiting without deleting the Job or inventing a result", async () => {
    seedBaseline();
    const ctx = await context();
    const port = createZenithBuildPort({ managed, pollMs: 1 });
    const handle = await start(port, ctx);
    const result = await port.waitForBuild(ctx, handle, { timeoutMs: 20 });
    expect(result.status).toBe("timed_out");
    expect(fake.list("Job", NAMESPACE)).toHaveLength(1);
  });

  it("reports an open-egress namespace honestly, so release admission can refuse it", async () => {
    seedBaseline([{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16"] } }] }]);
    const ctx = await context();
    const port = createZenithBuildPort({ managed, pollMs: 1 });
    const handle = await start(port, ctx);
    await finish(handle.buildId, "complete");
    const result = await port.waitForBuild(ctx, handle, { timeoutMs: 5_000 });
    expect(result.attestation?.isolation.network.egress).toBe("unrestricted");
    expect(() => assertBuildIsolation("zenith", result.attestation!.isolation, { allowOpenEgress: false })).toThrowError(BuildIsolationError);
  });

  it("exposes the launch identity for independent readback and adopts a confirmed launch", async () => {
    seedBaseline();
    const ctx = await context();
    const port = createZenithBuildPort({ managed, pollMs: 1 });
    const stored = await createZenithSourceStore(managed).upload(ctx, bundle);
    const n = nodes();
    const input = { ...n, source: { s3Key: stored.name, digest: bundle.sha256, bucket: stored.namespace }, idempotencyKey: "idem-9" };
    const identity = port.launchIdentity!(ctx, input);
    expect(identity.namespace).toBe(NAMESPACE);
    const adopted = await port.adoptBuild!(ctx, input, identity.job);
    expect((JSON.parse(adopted.buildId) as { id: string }).id).toBe(identity.job);
    await expect(port.adoptBuild!(ctx, input, "zbuild-" + "0".repeat(40))).rejects.toThrowError(StepFailedError);
    expect(fake.list("Job", NAMESPACE)).toEqual([]); // adoption launches nothing
  });
});
