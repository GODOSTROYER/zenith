/**
 * Cloud Build → Artifact Registry. Contract evidence only; no live GCP account.
 * C3 SourceBundlePort supplies a GCS object (`s3Key` and optional `objectKey`,
 * `uri` aliases) and bucket. The object generation is pinned during build.
 * Handles contain identifiers only and can be recovered by another worker.
 * Cloud Build's tag lookup prevents sequential duplicates, not concurrent
 * creates; duplicate builds are harmless content-addressed artifact work.
 */
import type { BuildPort, BuildResult } from "@/lib/execution/ports";
import type { ResourceNode } from "@/lib/resources/types";
import type { BuildPipelineSpec } from "@/lib/resources/specs";
import { StepFailedError } from "@/lib/execution/errors";
import { digest } from "@/lib/controlplane/digest";
import { namePrefix } from "@/lib/execution/session";
import { cloudName, nodeName, parseTagDescription, gcpLabels } from "@/lib/providers/gcp/naming";
import { startBuild, opTag, CLOUD_BUILD_DOCKER_IMAGE } from "@/lib/providers/gcp/drivers/build/build-api";
import { allowlistDigest, BUILD_ISOLATION_PROFILES, contextDirOf, type BuildAttestation } from "@/lib/execution/build-isolation";
import { rec, arr } from "@/lib/providers/gcp/read-kit";
import { context, managed, assertLabels, get, AR, SOURCE_DIGEST, IMAGE_DIGEST, bounded, pause, pipelineNames, type Ctx } from "./support";

const CB = "https://cloudbuild.googleapis.com/v1";
interface Handle {
  version: 1;
  scope: string;
  id: string;
  tag: string;
  image: string;
  registry: string;
  registryAddress: string;
  bucket: string;
  object: string;
  generation: string;
  serviceAccount: string;
}
const scope = (ctx: Ctx) => digest([ctx.workspaceId, ctx.environmentId, ctx.session.projectId, ctx.region]);

async function registry(ctx: Ctx, node: ResourceNode): Promise<{ name: string; uri: string }> {
  managed(ctx, node, "container_registry");
  const base = `projects/${ctx.session.projectId}/locations/${ctx.region}/repositories/`;
  const name = node.externalRef ?? `${base}${cloudName(namePrefix(ctx.environmentId), node.address, { max: 63 })}`;
  if (!name.startsWith(base) || !/^[a-z][a-z0-9-]{0,62}$/.test(name.slice(base.length))) throw new StepFailedError("Build registry is outside this GCP project/region.");
  const obj = await get(ctx, `${AR}/${name}`);
  if (obj.name !== name || obj.format !== "DOCKER") throw new StepFailedError("Build output is not the requested Docker repository.");
  assertLabels(ctx, node, obj);
  return { name, uri: `${ctx.region}-docker.pkg.dev/${ctx.session.projectId}/${name.slice(base.length)}` };
}

function decode(ctx: Ctx, raw: string): Handle {
  let h: Handle;
  try { if (typeof raw !== "string" || raw.length > 6000) throw new Error(); h = JSON.parse(raw) as Handle; if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error(); } catch { throw new StepFailedError("Invalid GCP build handle."); }
  const base = `projects/${ctx.session.projectId}/locations/${ctx.region}/repositories/`;
  if (h.version !== 1 || h.scope !== scope(ctx) || typeof h.id !== "string" || !/^[a-f0-9-]{8,64}$/.test(h.id) || typeof h.tag !== "string" || !/^zenith-op-[a-f0-9]{12}$/.test(h.tag) || typeof h.registry !== "string" || !h.registry.startsWith(base) || !/^[a-z][a-z0-9-]{0,62}$/.test(h.registry.slice(base.length)) || typeof h.registryAddress !== "string" || !/^[a-z_]+\/[A-Za-z0-9_.-]+$/.test(h.registryAddress) || typeof h.bucket !== "string" || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(h.bucket) || typeof h.object !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._=+@/-]{0,1023}$/.test(h.object) || h.object.split("/").some((p) => p === ".." || p === ".") || !/^\d{1,20}$/.test(h.generation) || typeof h.serviceAccount !== "string" || !h.serviceAccount.endsWith(`@${ctx.session.projectId}.iam.gserviceaccount.com`)) throw new StepFailedError("GCP build handle is outside this environment or malformed.");
  const uri = `${ctx.region}-docker.pkg.dev/${ctx.session.projectId}/${h.registry.slice(base.length)}/`;
  if (typeof h.image !== "string" || !h.image.startsWith(uri) || !/^[a-z0-9][a-z0-9._-]{0,127}:zn-[a-f0-9]{64}$/.test(h.image.slice(uri.length))) throw new StepFailedError("GCP build handle has an invalid output image.");
  return h;
}

/**
 * What the executed Cloud Build carried, read back from the build record (and the private pool, when one
 * ran it). The build's own `options` are the evidence, not the request this process made. Without a
 * private pool with NO_PUBLIC_EGRESS the default pool has open egress and the build is reported so.
 */
async function attest(ctx: Ctx, obj: Record<string, unknown>, h: Handle): Promise<BuildAttestation> {
  const profile = BUILD_ISOLATION_PROFILES.gcp;
  const options = rec(obj.options);
  const pool = rec(options.pool);
  let egress: BuildAttestation["isolation"]["network"] = { egress: "unrestricted", mechanism: "the default Cloud Build pool has public egress; configure spec.isolation.workerPool" };
  let computeClass = typeof options.machineType === "string" ? options.machineType : "unknown";
  if (typeof pool.name === "string") {
    if (!/^projects\/[^/]+\/locations\/[^/]+\/workerPools\/[a-z][a-z0-9-]{0,62}$/.test(pool.name) || !pool.name.startsWith(`projects/${ctx.session.projectId}/`)) throw new StepFailedError("Cloud Build ran in a worker pool outside this project.");
    const poolObj = await get(ctx, `${CB}/${pool.name}`);
    const config = rec(rec(poolObj.privatePoolV1Config).networkConfig);
    const worker = rec(rec(poolObj.privatePoolV1Config).workerConfig);
    if (typeof worker.machineType === "string") computeClass = worker.machineType;
    if (config.egressOption === "NO_PUBLIC_EGRESS") egress = { egress: "allowlisted", verifiedBy: "provider_read", allowlistDigest: allowlistDigest([pool.name, "NO_PUBLIC_EGRESS"]), mechanism: profile.mechanisms.network };
  }
  const timeoutSec = /^(\d{1,6})s$/.exec(String(obj.timeout ?? ""));
  return {
    builderId: typeof pool.name === "string" ? pool.name : `projects/${ctx.session.projectId}/locations/${ctx.region}/builds`,
    invocationId: h.id,
    builderImage: CLOUD_BUILD_DOCKER_IMAGE,
    ...(typeof obj.startTime === "string" ? { startedOn: obj.startTime } : {}),
    ...(typeof obj.finishTime === "string" ? { finishedOn: obj.finishTime } : {}),
    isolation: {
      profileId: profile.id,
      identity: { principal: h.serviceAccount, dedicated: obj.serviceAccount === `projects/${ctx.session.projectId}/serviceAccounts/${h.serviceAccount}`, deployCredentials: "absent" },
      metadata: { exposes: "build_identity_only", mechanism: profile.mechanisms.metadata },
      network: egress,
      dependencies: { downloads: egress.egress === "allowlisted" ? "allowlisted" : "direct" },
      filesystem: { sourceMount: rec(rec(obj.source).storageSource).generation === h.generation ? "read_only" : "read_write" },
      resources: { timeoutSec: timeoutSec ? Number(timeoutSec[1]) : 0, computeClass },
    },
  };
}

type StartInput = Parameters<BuildPort["startBuild"]>[1];
/** Everything before the launch: validation and read-only lookups. Shared by startBuild and adoptBuild. */
async function prepare(raw: Parameters<BuildPort["startBuild"]>[0], input: StartInput) {
      const ctx = context(raw);
      managed(ctx, input.service); managed(ctx, input.pipeline, "build_pipeline");
      if (!["container_service", "scheduled_job"].includes(input.service.kind)) throw new StepFailedError("Build target must be a managed GCP workload.");
      const spec = input.pipeline.spec as unknown as BuildPipelineSpec;
      const artifact = rec(input.service.spec.artifact);
      if (!input.registry || spec.location !== "customer_account" || !("registry" in (spec.output ?? {})) || (spec.output as { registry: string }).registry !== input.registry.address || artifact.type !== "built" || artifact.pipeline !== input.pipeline.address || artifact.registry !== input.registry.address || !input.idempotencyKey || !SOURCE_DIGEST.test(input.source.digest)) throw new StepFailedError("Build inputs do not identify this workload's customer-account pipeline and registry.");
      const names = pipelineNames(ctx, input.pipeline);
      const bucket = input.source.bucket ?? names.bucket;
      if (bucket !== names.bucket || (input.pipeline.externalRef && ![bucket, `projects/_/buckets/${bucket}`].includes(input.pipeline.externalRef))) throw new StepFailedError("Source bundle bucket is outside this build pipeline.");
      const bucketObj = await get(ctx, `https://storage.googleapis.com/storage/v1/b/${bucket}`);
      if (bucketObj.name !== bucket) throw new StepFailedError("Source bucket identity does not match the pipeline.");
      assertLabels(ctx, input.pipeline, bucketObj);
      // Additive C3 fields do not change the shared BuildPort contract.
      const source = input.source as typeof input.source & { objectKey?: string; uri?: string };
      const object = source.objectKey ?? source.s3Key;
      if ((source.objectKey !== undefined && source.objectKey !== source.s3Key) || (source.uri !== undefined && source.uri !== `gs://${bucket}/${object}`)) throw new StepFailedError("Source bundle GCS identifiers do not match.");
      if (!/^[A-Za-z0-9][A-Za-z0-9._=+@/-]{0,1023}$/.test(object) || object.split("/").some((p) => p === ".." || p === ".")) throw new StepFailedError("Source bundle object key is invalid.");
      const metadata = await get(ctx, `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`);
      if (metadata.bucket !== bucket || metadata.name !== object || typeof metadata.generation !== "string" || !/^\d{1,20}$/.test(metadata.generation)) throw new StepFailedError("Source bundle generation could not be verified.");
      const account = await get(ctx, `https://iam.googleapis.com/v1/projects/${ctx.session.projectId}/serviceAccounts/${names.serviceAccount}`);
      const accountLabels = parseTagDescription(account.description);
      const expected = gcpLabels({ "zenith:environment": ctx.environmentId, "zenith:resource": input.pipeline.address });
      if (account.email !== names.serviceAccount || account.disabled === true || accountLabels.zenith_environment !== expected.zenith_environment || accountLabels.zenith_resource !== expected.zenith_resource) throw new StepFailedError("Build service account is outside this pipeline.");
      const output = await registry(ctx, input.registry);
      const imageName = nodeName(input.service.address);
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(imageName)) throw new StepFailedError("Build workload name is not an image repository name.");
      const key = digest([scope(ctx), input.service.address, input.pipeline.address, input.source.digest, input.idempotencyKey]);
      const image = `${output.uri}/${imageName}:zn-${key}`;
      const registryAddress = input.registry.address, pinnedGeneration: string = metadata.generation;
      return { ctx, key, startArgs: { sourceBucket: bucket, sourceObject: object, sourceGeneration: pinnedGeneration, imageRef: image, buildServiceAccount: names.serviceAccount, dockerfile: spec.source?.dockerfile, contextDir: contextDirOf(spec, "gcp"), ...(spec.isolation?.workerPool ? { workerPool: spec.isolation.workerPool } : {}) }, handleFor: (id: string): Handle => ({ version: 1, scope: scope(ctx), id, tag: opTag(key), image, registry: output.name, registryAddress, bucket, object, generation: pinnedGeneration, serviceAccount: names.serviceAccount }) };
}

export function createBuildPort(): BuildPort {
  return {
    async startBuild(raw, input) {
      const p = await prepare(raw, input);
      const started = await startBuild({ ...p.ctx, operationId: p.key }, p.startArgs);
      if (!started.ok || !started.buildId) throw new Error("Cloud Build launch could not be confirmed; reconcile before retrying.");
      return { buildId: JSON.stringify(p.handleFor(started.buildId)) };
    },
    /** Rebuild the handle of a launch an operator confirmed from readback; launches nothing. */
    async adoptBuild(raw, input, buildId) {
      if (!/^[a-f0-9-]{8,64}$/.test(buildId)) throw new StepFailedError("The confirmed Cloud Build id is malformed.");
      const p = await prepare(raw, input);
      return { buildId: JSON.stringify(p.handleFor(buildId)) };
    },
    /** The tag this launch carries, for independent readback. Pure. */
    launchIdentity(raw, input) {
      const ctx = context(raw);
      const key = digest([scope(ctx), input.service.address, input.pipeline.address, input.source.digest, input.idempotencyKey]);
      return { tag: opTag(key), projectId: ctx.session.projectId, region: ctx.region };
    },
    async waitForBuild(raw, handle, opts): Promise<BuildResult> {
      const original = context(raw); const h = decode(original, handle.buildId);
      const wait = bounded(original, opts.timeoutMs); const ctx = wait.ctx;
      try {
        for (;;) {
          const obj = await get(ctx, `${CB}/projects/${ctx.session.projectId}/locations/${ctx.region}/builds/${h.id}`);
          const source = rec(rec(obj.source).storageSource);
          if (obj.id !== h.id || !arr(obj.tags).includes(h.tag) || obj.serviceAccount !== `projects/${ctx.session.projectId}/serviceAccounts/${h.serviceAccount}` || source.bucket !== h.bucket || source.object !== h.object || source.generation !== h.generation || !arr(obj.images).includes(h.image)) throw new StepFailedError("Cloud Build metadata does not match this environment's build handle.");
          const state = obj.status;
          if (["FAILURE", "INTERNAL_ERROR"].includes(String(state))) return { status: "failed", detail: "Cloud Build reported failure." };
          if (state === "CANCELLED") return { status: "stopped" };
          if (state === "TIMEOUT" || state === "EXPIRED") return { status: "timed_out" };
          if (state === "SUCCESS") {
            const images = arr(rec(obj.results).images).map(rec).filter((i) => i.name === h.image);
            if (images.length !== 1 || typeof images[0].digest !== "string" || !IMAGE_DIGEST.test(images[0].digest)) return { status: "failed", detail: "Build finished without one verifiable output digest." };
            const imageDigest = images[0].digest;
            const registryObj = await get(ctx, `${AR}/${h.registry}`);
            assertLabels(ctx, { address: h.registryAddress } as ResourceNode, registryObj);
            if (registryObj.name !== h.registry || registryObj.format !== "DOCKER") throw new StepFailedError("Build output registry identity could not be verified.");
            const imageUri = `${h.image.replace(/:[^:/]+$/, "")}@${imageDigest}`;
            const imageId = `${h.image.split("/").slice(3).join("/").replace(/:[^:/]+$/, "")}@${imageDigest}`;
            const actual = await get(ctx, `${AR}/${h.registry}/dockerImages/${encodeURIComponent(imageId)}`);
            if (actual.uri !== imageUri || actual.name !== `${h.registry}/dockerImages/${imageId}`) throw new StepFailedError("Artifact Registry did not verify the build's image digest.");
            return { status: "succeeded", digest: imageDigest, imageUri, attestation: await attest(ctx, obj, h) };
          }
          if (!["QUEUED", "WORKING", "PENDING"].includes(String(state))) throw new Error("Cloud Build state is unknown.");
          if (Date.now() >= wait.deadline) return { status: "timed_out" };
          await pause(ctx, wait.deadline);
        }
      } catch (e) {
        original.signal.throwIfAborted();
        if (wait.timeout.aborted) return { status: "timed_out" };
        throw e;
      }
    },
  };
}
