import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ApiException, type KubernetesObject } from "@kubernetes/client-node";
import { z } from "zod";
import { StepFailedError } from "@/lib/execution/errors";
import { contextDirOf, BUILD_ISOLATION_PROFILES, type BuildAttestation } from "@/lib/execution/build-isolation";
import type { BuildHandle, BuildPort, BuildResult } from "@/lib/execution/ports";
import type { DriverContext } from "@/lib/drivers/types";
import type { BuildPipelineSpec } from "@/lib/resources/specs";
import type { ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import { assertSessionMatches, type ZenithSession } from "@/lib/providers/zenith/session";
import { serviceLabelOf } from "@/lib/providers/zenith/substrate";
import { createK8sClient, listByKind, readObject, READ_ONLY_KINDS, type K8sClient } from "../client";
import { buildProfileDigest, createBuildCustody, type BuildCustodyPort } from "./custody";
import { assertBuildNodes } from "./nodes";
import { dig, isRecord } from "../util";
import { configDigest, readIsolatedBuildConfig, validateConfig, type IsolatedBuildConfig } from "./config";
import { createRegistryReader, verifyPublishedArtifact } from "./artifact";
import { assertBaseline, assertPod, verifyJob, verifyProbe } from "./admission";
import { buildName, buildKey, sourceName, renderBaseline, renderProxy, renderJob, type BuildRequest } from "./render";

const SHA = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
export const MAX_SOURCE_BYTES = 700 * 1024;
type Start = Parameters<BuildPort["startBuild"]>[1];
export interface BuilderOptions { config?: IsolatedBuildConfig; custody?: BuildCustodyPort; managed?: ManagedSubstratePort; pollMs?: number }
interface Handle { version: 1; config: string; custody: string; request: BuildRequest; node: string; nodes: string; baseline: string; jobUID: string; probeUID: string }
const RequestSchema = z.object({
  workspaceId: z.string().min(1), environmentId: z.string().min(1), operationId: z.string().min(1), serviceAddress: z.string().min(1),
  pipelineAddress: z.string().min(1), sourceSecret: z.string().regex(/^zsrc-[a-f0-9]{40}$/), sourceDigest: z.string().regex(SHA),
  image: z.string().regex(/^[a-z0-9][a-z0-9.:/_-]*:zn-[a-f0-9]{40}$/), dockerfile: z.string(), contextDir: z.string(), idempotencyKey: z.string().min(1).max(1024),
}).strict();
const HandleSchema = z.object({ version: z.literal(1), config: z.string().regex(SHA), custody: z.string().regex(SHA), request: RequestSchema, node: z.string().min(1), nodes: z.string().regex(SHA), baseline: z.string().regex(SHA), jobUID: z.string().min(1), probeUID: z.string().min(1) }).strict();
function kubernetesRepository(ctx: DriverContext, input: Start, spec: BuildPipelineSpec, artifact: { registry?: string }, root: string | undefined): string {
  if (ctx.provider !== "kubernetes" || input.registry?.provider !== "kubernetes" || input.registry.ownership !== "managed" || input.registry.address !== (spec.output as { registry?: string }).registry || artifact.registry !== input.registry.address) throw new StepFailedError("Kubernetes source builds require the exact managed registry repository.");
  if (!root) throw new StepFailedError("Native Kubernetes has no tenant-owned registry custody.");
  const repository = root + "/" + serviceLabelOf(input.service.address);
  if (input.registry.externalRef && input.registry.externalRef !== repository) throw new StepFailedError("The registry reference is outside the tenant's reviewed repository.");
  return repository;
}
export function validateBuildRequest(r: BuildRequest): void {
  if (r.dockerfile === "." || (r.contextDir !== "." && !r.dockerfile.startsWith(r.contextDir + "/"))) throw new StepFailedError("The Dockerfile must be a file inside the approved build context.");
  if (!RequestSchema.safeParse(r).success || [r.contextDir, r.dockerfile].some(p => p !== "." && (!/^[A-Za-z0-9._/-]+$/.test(p) || p.startsWith("/") || p.split("/").some(s => s === ".." || s === "." || s === "")))) throw new StepFailedError("Build source paths or launch identity are invalid.");
}

export function createIsolatedBuildPort(options: BuilderOptions = {}): BuildPort {
  const custody = options.custody ?? createBuildCustody();
  const scoped = (ctx: DriverContext) => createScopedBuildPort({ ...options, custody, config: options.config ?? custody.profile(ctx).config });
  return {
    startBuild: (ctx, input) => scoped(ctx).startBuild(ctx, input),
    waitForBuild: (ctx, handle, opts) => scoped(ctx).waitForBuild(ctx, handle, opts),
    launchIdentity: (ctx, input) => scoped(ctx).launchIdentity!(ctx, input),
    adoptBuild: async () => { throw new StepFailedError("Adoption requires the original node-bound proof and custody handle."); },
  };
}
function createScopedBuildPort(options: BuilderOptions & { custody: BuildCustodyPort; config: IsolatedBuildConfig }): BuildPort {
  const config = () => validateConfig(options.config ?? readIsolatedBuildConfig());
  const pollMs = options.pollMs ?? 1000;
  async function withClient<T>(ctx: DriverContext, fn: (client: K8sClient, verifier: K8sClient) => Promise<T>): Promise<T> {
    const c = config();
    return options.custody.withSessions(ctx, async (writer, reader, profile) => {
      if (configDigest(c) !== configDigest(profile.config)) throw new StepFailedError("Build custody changed before dispatch; review the build profile again.");
      const client = createK8sClient(writer, { signal: ctx.signal }), verifier = createK8sClient(reader, { signal: ctx.signal });
      await client.guard.assert(c.namespace);
      await verifier.guard.assert(c.namespace); await verifier.guard.assert(c.proxy.namespace);
      return fn(client, verifier);
    });
  }

  async function baseline(client: K8sClient): Promise<string> {
    const c = config(), objects: Record<string, unknown>[] = [];
    for (const wanted of [...renderBaseline(c), ...renderProxy(c), { apiVersion: "node.k8s.io/v1", kind: "RuntimeClass", metadata: { name: c.runtimeClass, namespace: undefined } }]) {
      const live = await readObject(client, { apiVersion: wanted.apiVersion, kind: wanted.kind, name: wanted.metadata.name, namespace: wanted.metadata.namespace });
      if (live) objects.push({ ...live, kind: wanted.kind });
    }
    // NetworkPolicy permissions are additive. A named policy alone proves nothing.
    const policies: Record<string, unknown>[] = [];
    for (const namespace of [c.namespace, c.proxy.namespace]) {
      const result = await listByKind(client, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", namespaced: true }, namespace, { maxPages: 1 });
      if (result.truncated || result.unavailable) throw new StepFailedError("All isolation policies must be readable.");
      policies.push(...result.items);
    }
    const proxyPods = await listByKind(client, READ_ONLY_KINDS.Pod, c.proxy.namespace, { labelSelector: "app=zenith-build-proxy", maxPages: 1 });
    if (proxyPods.truncated || proxyPods.unavailable || proxyPods.items.length !== 1) throw new StepFailedError("The proxy must have exactly one readable executed pod.");
    const expectedProxy = renderProxy(c).find(o => o.kind === "Deployment")!;
    assertPod(proxyPods.items[0].spec, dig(expectedProxy, "spec", "template", "spec"));
    const proxyStatus = dig(proxyPods.items[0], "status", "containerStatuses", 0);
    if (dig(proxyStatus, "ready") !== true || typeof dig(proxyStatus, "imageID") !== "string" || !(dig(proxyStatus, "imageID") as string).endsWith(c.proxy.image.slice(c.proxy.image.lastIndexOf("@") + 1))) throw new StepFailedError("The running proxy image could not be verified.");
    return assertBaseline(c, [...objects.filter(o => o.kind !== "NetworkPolicy"), ...policies]);
  }

  function request(ctx: DriverContext, input: Start): BuildRequest {
    const c = config(), spec = input.pipeline.spec as unknown as BuildPipelineSpec;
    if (!ctx.operationId) throw new StepFailedError("An immutable operation identity is required for an isolated source build.");
    if (input.service.provider !== ctx.provider || input.pipeline.provider !== ctx.provider || input.service.ownership !== "managed" || input.pipeline.ownership !== "managed" || input.pipeline.kind !== "build_pipeline") throw new StepFailedError("The build target or pipeline is outside this managed provider.");
    const artifact = input.service.spec.artifact as { type?: string; pipeline?: string; registry?: string } | undefined;
    if (artifact?.type !== "built" || artifact.pipeline !== input.pipeline.address || input.service.region !== ctx.region || input.pipeline.region !== ctx.region) throw new StepFailedError("The source build does not match the workload pipeline or region.");
    if (input.source.bucket !== c.namespace || input.source.s3Key !== sourceName(ctx.environmentId, input.source.digest)) throw new StepFailedError("The immutable source hand-off belongs to another environment.");
    const contextDir = contextDirOf(spec, ctx.provider as "zenith" | "kubernetes");
    const dockerfile = spec.source.dockerfile ?? "Dockerfile";
    let repository: string;
    if (ctx.provider === "zenith") {
      const registry = options.managed?.registry();
      if (!registry) throw new StepFailedError("Managed source builds require the owned registry.");
      assertSessionMatches(ctx.session as ZenithSession, ctx);
      repository = registry.repositoryFor((ctx.session as ZenithSession).tenant, serviceLabelOf(input.service.address));
    } else {
      repository = kubernetesRepository(ctx, input, spec, artifact, options.custody.profile(ctx).registryRepositoryRoot);
    }
    if (!/^[a-z0-9][a-z0-9.:/_-]*\/[a-z0-9._/-]+$/.test(repository)) throw new StepFailedError("The output repository is invalid.");
    const reg = new URL(`https://${repository.split("/")[0]}`);
    if (!c.proxy.destinations.some(d => d.host === reg.hostname && d.port === Number(reg.port || "443"))) throw new StepFailedError("The output registry is outside the proxy allowlist.");
    const base = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, operationId: ctx.operationId, serviceAddress: input.service.address, pipelineAddress: input.pipeline.address, sourceSecret: input.source.s3Key, sourceDigest: input.source.digest, dockerfile, contextDir, idempotencyKey: input.idempotencyKey };
    const r = { ...base, image: `${repository}:zn-${buildKey({ ...base, image: repository }).slice(0, 40)}` };
    validateBuildRequest(r); return r;
  }

  async function createOrRead(client: K8sClient, expected: ReturnType<typeof renderJob>): Promise<Record<string, unknown>> {
    try { await client.objects.create(expected as KubernetesObject, undefined, undefined, "zenith-isolated-build"); }
    catch (e) { if (!(e instanceof ApiException) || e.code !== 409) throw e; }
    const job = await readObject(client, { apiVersion: expected.apiVersion, kind: expected.kind, namespace: expected.metadata.namespace, name: expected.metadata.name });
    if (!job) throw new Error("Build launch is uncertain; reconcile the claimed Job before retrying.");
    verifyJob(job, expected); return job;
  }

  async function completed(client: K8sClient, expected: ReturnType<typeof renderJob>, signal: AbortSignal, timeoutMs: number, uid?: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal.throwIfAborted();
      const job = await readObject(client, { apiVersion: "batch/v1", kind: "Job", namespace: config().namespace, name: expected.metadata.name });
      if (!job || typeof dig(job, "metadata", "uid") !== "string") throw new Error("The claimed Job disappeared; the build outcome is uncertain.");
      verifyJob(job, expected);
      const currentUID = dig(job, "metadata", "uid") as string;
      if (uid && uid !== currentUID) throw new StepFailedError("The build Job was replaced.");
      uid = currentUID;
      const pods = await listByKind(client, READ_ONLY_KINDS.Pod, config().namespace, { labelSelector: `batch.kubernetes.io/controller-uid=${uid}`, maxPages: 1 });
      if (pods.truncated || pods.unavailable || pods.items.length > 1) throw new StepFailedError("The build must have exactly one readable executed pod.");
      const pod = pods.items[0];
      if (pod) {
        const owners = dig(pod, "metadata", "ownerReferences");
        if (!Array.isArray(owners) || !owners.some(o => isRecord(o) && o.uid === uid && o.controller === true && o.kind === "Job")) throw new StepFailedError("The executed pod is outside the claimed Job.");
        assertPod(pod.spec, dig(expected, "spec", "template", "spec"));
      }
      const conditions = dig(job, "status", "conditions");
      const has = (type: string) => Array.isArray(conditions) && conditions.some(c => isRecord(c) && c.type === type && c.status === "True");
      if (has("Failed")) return { status: "failed" as const, job, pod, message: "" };
      if (has("Complete")) {
        const statuses = dig(pod, "status", "containerStatuses");
        if (!Array.isArray(statuses) || statuses.length !== 1 || dig(statuses[0], "state", "terminated", "exitCode") !== 0 || typeof statuses[0].imageID !== "string" || !statuses[0].imageID.endsWith(config().builderImage.slice(config().builderImage.lastIndexOf("@") + 1))) throw new StepFailedError("The executed builder image or exit status could not be verified.");
        return { status: "succeeded" as const, job, pod, message: dig(statuses[0], "state", "terminated", "message") };
      }
      if (Date.now() >= deadline) return { status: "timed_out" as const, job, pod, message: "" };
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }

  return {
    async startBuild(ctx, input) {
      const r = request(ctx, input), c = config();
      return withClient(ctx, async (client, verifier) => {
        const before = await baseline(verifier);
        const nodes = await assertBuildNodes(verifier, c);
        const source = await readObject(client, { apiVersion: "v1", kind: "Secret", namespace: c.namespace, name: r.sourceSecret });
        const encoded = dig(source, "data", "source.tar.gz");
        if (!source || source.immutable !== true || typeof encoded !== "string" || dig(source, "metadata", "annotations", "zenith.dev/environment") !== ctx.environmentId || dig(source, "metadata", "annotations", "zenith.dev/workspace-id") !== ctx.workspaceId || createHash("sha256").update(Buffer.from(encoded, "base64")).digest("hex") !== r.sourceDigest) throw new StepFailedError("The source bytes are not the immutable approved hand-off.");
        const probeSpec = renderJob(c, r, true), probeJob = await createOrRead(client, probeSpec);
        const result = await completed(client, probeSpec, ctx.signal, 180_000, String(dig(probeJob, "metadata", "uid")));
        if (result.status !== "succeeded") throw new StepFailedError("Runtime isolation probes failed; no source build was launched.");
        verifyProbe(result.message);
        const node = dig(result.pod, "spec", "nodeName");
        if (typeof node !== "string" || !node || (Date.now() - Date.parse(String(dig(result.job, "status", "completionTime"))) > 300_000 || Date.parse(String(dig(result.job, "status", "completionTime"))) > Date.now() + 5000) || !Number.isFinite(Date.parse(String(dig(result.job, "status", "completionTime"))))) throw new StepFailedError("A fresh probe on the build node is required.");
        if (before !== await baseline(verifier)) throw new StepFailedError("Isolation configuration changed during the probe.");
        if (nodes !== await assertBuildNodes(verifier, c, node)) throw new StepFailedError("The isolated node allocation changed during the probe; no source build was launched.");
        const job = await createOrRead(client, renderJob(c, r, false, node));
        const handle: Handle = { version: 1, config: configDigest(c), custody: buildProfileDigest(options.custody.profile(ctx)), request: r, node, nodes, baseline: before, jobUID: String(dig(job, "metadata", "uid")), probeUID: String(dig(result.job, "metadata", "uid")) };
        return { buildId: JSON.stringify(handle) };
      });
    },
    async waitForBuild(ctx, built: BuildHandle, opts): Promise<BuildResult> {
      if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > 3_600_000) throw new StepFailedError("Build wait must be bounded.");
      let raw: unknown;
      try { if (built.buildId.length > 10_000) throw new Error(); raw = JSON.parse(built.buildId); } catch { throw new StepFailedError("The build handle is malformed."); }
      const parsed = HandleSchema.safeParse(raw);
      if (!parsed.success) throw new StepFailedError("The build handle is malformed.");
      const h = parsed.data, c = config(); validateBuildRequest(h.request);
      if (h.custody !== buildProfileDigest(options.custody.profile(ctx)) || h.config !== configDigest(c) || h.request.workspaceId !== ctx.workspaceId || h.request.environmentId !== ctx.environmentId || h.request.operationId !== ctx.operationId) throw new StepFailedError("The build handle belongs to another operation or configuration.");
      return withClient(ctx, async (client, verifier) => {
        if (h.baseline !== await baseline(verifier)) throw new StepFailedError("Isolation changed after the build started; release is refused.");
        if (h.nodes !== await assertBuildNodes(verifier, c, h.node)) throw new StepFailedError("The isolated node allocation changed after launch; release is refused.");
        const result = await completed(client, renderJob(c, h.request, false, h.node), ctx.signal, opts.timeoutMs, h.jobUID);
        if (result.status !== "succeeded") return { status: result.status, detail: "The owned isolated build did not complete successfully." };
        if (h.baseline !== await baseline(verifier)) throw new StepFailedError("Isolation changed during completion readback.");
        if (h.nodes !== await assertBuildNodes(verifier, c, h.node)) throw new StepFailedError("The isolated node allocation changed after launch; release is refused.");
        const probe = await completed(client, renderJob(c, h.request, true), ctx.signal, 1, h.probeUID);
        if (probe.status !== "succeeded" || dig(probe.pod, "spec", "nodeName") !== h.node) throw new StepFailedError("The original node-bound isolation probe is unavailable.");
        verifyProbe(probe.message);
        const probeTime = Date.parse(String(dig(probe.job, "status", "completionTime"))), buildTime = Date.parse(String(dig(result.job, "status", "startTime")));
        if (!Number.isFinite(probeTime) || !Number.isFinite(buildTime) || buildTime < probeTime || buildTime - probeTime > 300_000) throw new StepFailedError("The build did not start under a fresh isolation proof.");
        let metadata: { digest?: unknown; provenanceRequested?: unknown };
        try { if (typeof result.message !== "string" || Buffer.byteLength(result.message) > 4096) throw new Error(); metadata = JSON.parse(result.message); } catch { throw new StepFailedError("The build result receipt is unreadable."); }
        if (typeof metadata.digest !== "string" || !IMAGE.test(metadata.digest) || metadata.provenanceRequested !== true) throw new StepFailedError("A digest and generated BuildKit provenance are required.");
        let dockerConfig: unknown;
        if (c.pushSecret) {
          const secret = await readObject(client, { apiVersion: "v1", kind: "Secret", namespace: c.namespace, name: c.pushSecret });
          try { dockerConfig = JSON.parse(Buffer.from(String(dig(secret, "data", ".dockerconfigjson")), "base64").toString("utf8")); } catch { throw new StepFailedError("Registry authentication could not be read."); }
        }
        await verifyPublishedArtifact(createRegistryReader(c, h.request.image.split(":zn-")[0], dockerConfig, ctx.signal), metadata.digest, "zenith-isolated:" + configDigest(c) + ":" + buildKey(h.request));
        // Existing LIFE-09 signer verifies this observation again before storing/admitting provenance.
        const attestation: BuildAttestation = {
          builderId: `zenith-isolated:${c.namespace}:${c.runtimeClass}`, invocationId: h.jobUID, builderImage: c.builderImage,
          startedOn: String(dig(result.job, "status", "startTime")), finishedOn: String(dig(result.job, "status", "completionTime")),
          isolation: { profileId: BUILD_ISOLATION_PROFILES[ctx.provider as "zenith" | "kubernetes"].id, identity: { principal: `system:serviceaccount:${c.namespace}:zenith-builder`, dedicated: true, deployCredentials: "absent" },
            metadata: { exposes: "none", mechanism: "Fresh node-bound denial probes and proxy-only egress; all live policies compared." },
            network: { egress: "allowlisted", verifiedBy: "provider_read", allowlistDigest: h.baseline, mechanism: "No direct DNS or egress; exact host/IP/port allowlist proxy and policy readback." },
            dependencies: { downloads: "allowlisted" }, filesystem: { sourceMount: "read_only" }, resources: { timeoutSec: c.timeoutSec, computeClass: "k8s-2cpu-4gi" },
          },
        };
        return { status: "succeeded", digest: metadata.digest, imageUri: `${h.request.image.split(":zn-")[0]}@${metadata.digest}`, attestation };
      });
    },
    launchIdentity(ctx, input) { const r = request(ctx, input); return { job: buildName(r), namespace: config().namespace }; },
    async adoptBuild() { throw new StepFailedError("Adoption requires the original node-bound probe and baseline handle; an operator Job name alone is insufficient."); },
  };
}
export const createZenithBuildPort = createIsolatedBuildPort;
export const createKubernetesBuildPort = createIsolatedBuildPort;




