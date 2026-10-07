/**
 * ACR Tasks build adapter. startBuild uploads verified archive bytes and
 * records the scheduled run before polling. Only an operation tag is pushed;
 * waitForBuild returns its verified digest, never a mutable image reference.
 * Source loading and a durable launch journal MUST be supplied: AzureSession
 * currently has no Blob Storage audience, and scheduleRun has no launch token.
 * No live Azure account has verified this path; evidence is contract only.
 */
import type { BuildPort, BuildResult } from "@/lib/execution/ports";
import type { BuildPipelineSpec } from "@/lib/resources/specs";
import type { DriverContext } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import { StepFailedError } from "@/lib/execution/errors";
import { digest, sha256Hex } from "@/lib/controlplane/digest";
import { MAX_SOURCE_BYTES } from "@/lib/providers/azure/acr-build";
import { armClient, type ArmResource } from "@/lib/providers/azure/arm";
import { API } from "@/lib/providers/azure/platform";
import { nodeNameOf } from "@/lib/providers/azure/naming";
import { acrLoginServerPattern, cloudOf } from "@/lib/providers/azure/cloud";
import { context, managed, locate, validId, assertResource, bounded, pause, rec, arr, IMAGE_DIGEST, type Ctx, type LaunchJournal } from "./support";
import { scheduleBuild, ACR_RUN_ID, ACR_RUN_CPU, ACR_RUN_TIMEOUT_SEC } from "./acr-task";
import { allowlistDigest, BUILD_ISOLATION_PROFILES, contextDirOf, type BuildAttestation } from "@/lib/execution/build-isolation";
import { readArchive, type AzureSourceReader } from "./source";
import { contextArchive } from "./context-archive";

export interface AzureBuildOptions {
  /** C3 createSourceBundles(deps); Azure uses read(), not its S3/GCS upload port. */
  sourceBundles?: AzureSourceReader;
  /** Load bundle bytes inside the current broker callback; never return signed URLs or credentials. */
  readSource?(ctx: DriverContext<AzureSession>, source: { s3Key: string; digest: string; bucket?: string }): Promise<Uint8Array>;
  launches?: LaunchJournal;
  /** Plain SAS upload transport; receives NO broker credential. Defaults to fetch. */
  uploadFetch?: typeof fetch;
}
interface Handle { version: 1; scope: string; runId: string; registryId: string; registryAddress: string; loginServer: string; repository: string; tag: string }
const scope = (ctx: Ctx) => digest([ctx.workspaceId, ctx.environmentId, ctx.session.subscriptionId, ctx.region]);
function decode(ctx: Ctx, raw: string): Handle {
  let h: Handle;
  try { if (raw.length > 4000) throw new Error(); h = JSON.parse(raw) as Handle; } catch { throw new StepFailedError("Invalid Azure build handle."); }
  if (!h || h.version !== 1 || h.scope !== scope(ctx) || typeof h.registryId !== "string" || !validId(ctx, h.registryId, "Microsoft.ContainerRegistry/registries") || typeof h.runId !== "string" || !ACR_RUN_ID.test(h.runId) || typeof h.registryAddress !== "string" || !/^[a-z_]+\/[A-Za-z0-9_.-]+$/.test(h.registryAddress) || typeof h.loginServer !== "string" || !acrLoginServerPattern(cloudOf(ctx.session)).test(h.loginServer) || typeof h.repository !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(h.repository) || typeof h.tag !== "string" || !/^zn-[a-f0-9]{64}$/.test(h.tag)) throw new StepFailedError("Azure build handle is outside this environment or malformed.");
  return h;
}
async function verifyRegistry(ctx: Ctx, h: Handle): Promise<void> {
  let registry: ArmResource;
  try { registry = (await armClient(ctx.session, ctx.signal).get<ArmResource>(h.registryId, { apiVersion: API.containerRegistry })).body; } catch { throw new Error("Build output registry state is unknown."); }
  assertResource(ctx, { address: h.registryAddress } as Parameters<typeof assertResource>[1], registry, "Microsoft.ContainerRegistry/registries");
  if (registry.id.toLowerCase() !== h.registryId.toLowerCase() || rec(registry.properties).loginServer !== h.loginServer) throw new StepFailedError("Build output login server does not match the owning registry.");
}

/**
 * What the executed ACR run carried, read back from the run record and, when a dedicated agent pool ran it, the
 * pool itself. ACR Tasks attach no managed identity and receive no deploy credential from this request. A run on
 * the shared agents has open egress and is reported so; a pool joined to a virtual network is reported as
 * allowlisted only because the pool's subnet NSG (customer owned) is the enforcement point, which says so.
 */
async function attest(ctx: Ctx, h: Handle, run: Record<string, unknown>): Promise<BuildAttestation> {
  const profile = BUILD_ISOLATION_PROFILES.azure;
  const props = rec(run.properties);
  const poolName = typeof props.agentPoolName === "string" && props.agentPoolName.length > 0 ? props.agentPoolName : undefined;
  let network: BuildAttestation["isolation"]["network"] = { egress: "unrestricted", mechanism: "ACR Tasks shared agents have public egress; configure spec.isolation.workerPool" };
  if (poolName) {
    if (!/^[A-Za-z][A-Za-z0-9]{2,19}$/.test(poolName)) throw new StepFailedError("ACR ran in an agent pool with an unexpected name.");
    let pool: ArmResource;
    try { pool = (await armClient(ctx.session, ctx.signal).get<ArmResource>(`${h.registryId}/agentPools/${poolName}`, { apiVersion: API.containerRegistryRuns })).body; } catch { throw new Error("ACR agent pool state is unknown."); }
    if (typeof rec(pool.properties).virtualNetworkSubnetResourceId === "string") network = { egress: "allowlisted", verifiedBy: "provider_read", allowlistDigest: allowlistDigest([`${h.registryId}/agentPools/${poolName}`]), mechanism: profile.mechanisms.network };
  }
  const cpu = rec(props.agentConfiguration).cpu;
  return {
    builderId: poolName ? `${h.registryId}/agentPools/${poolName}` : h.registryId,
    invocationId: h.runId,
    ...(typeof props.startTime === "string" ? { startedOn: props.startTime } : {}),
    ...(typeof props.finishTime === "string" ? { finishedOn: props.finishTime } : {}),
    isolation: {
      profileId: profile.id,
      identity: { principal: "acr-tasks-run", dedicated: true, deployCredentials: "absent" },
      metadata: { exposes: "build_identity_only", mechanism: profile.mechanisms.metadata },
      network,
      dependencies: { downloads: network.egress === "allowlisted" ? "allowlisted" : "direct" },
      filesystem: { sourceMount: props.isArchiveEnabled === true ? "read_write" : "read_only" },
      // ACR does not return the run timeout; the value is the one this adapter requested and ACR enforces.
      resources: { timeoutSec: ACR_RUN_TIMEOUT_SEC, computeClass: cpu === undefined || cpu === ACR_RUN_CPU ? "cpu-2" : "unknown" },
    },
  };
}

export function createBuildPort(options: AzureBuildOptions = {}): BuildPort {
  return {
    async startBuild(raw, input) {
      const ctx = context(raw); managed(ctx, input.service); managed(ctx, input.pipeline, "build_pipeline");
      const spec = input.pipeline.spec as unknown as BuildPipelineSpec; const contextDir = contextDirOf(spec, "azure"); const artifact = rec(input.service.spec.artifact);
      if (!input.registry || spec.location !== "customer_account" || rec(spec.output).registry !== input.registry.address || artifact.type !== "built" || artifact.pipeline !== input.pipeline.address || artifact.registry !== input.registry.address || !input.idempotencyKey || !/^(?:sha256:)?[a-f0-9]{64}$/.test(input.source.digest) || typeof input.source.s3Key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(input.source.s3Key) || input.source.s3Key.split("/").some((p) => p === "." || p === "..") || (input.source.bucket !== undefined && !/^[A-Za-z0-9._/-]{1,300}$/.test(input.source.bucket))) throw new StepFailedError("Azure build inputs do not identify this workload's source/pipeline/registry.");
      if ((!options.sourceBundles && !options.readSource) || !options.launches) throw new StepFailedError("Azure builds require a source reader and durable tenant-scoped launch journal.");
      const registry = await locate(ctx, input.registry, "Microsoft.ContainerRegistry/registries");
      const loginServer = rec(registry.properties).loginServer; const repository = nodeNameOf(input.service.address);
      if (typeof loginServer !== "string" || !acrLoginServerPattern(cloudOf(ctx.session)).test(loginServer) || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(repository)) throw new StepFailedError("Azure build output registry/repository is malformed.");
      const key = digest([scope(ctx), "build", input.service.address, input.source.digest, input.idempotencyKey, ...(contextDir === "." ? [] : [contextDir])]);
      const journalScope = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, key };
      // A non-root context is derived and validated BEFORE the permanent launch claim: a derivation failure leaves the key unconsumed and retryable.
      const loadSource = async (): Promise<{ archive: Uint8Array; dockerfilePath: string }> => {
        let source: Uint8Array;
        if (options.sourceBundles) source = (await readArchive(options.sourceBundles, spec.source, ctx.signal)).archive;
        else {
          try { source = await options.readSource!(ctx, input.source); } catch { ctx.signal.throwIfAborted(); throw new Error("Azure source bundle could not be read; no build was launched."); }
        }
        ctx.signal.throwIfAborted();
        if (!(source instanceof Uint8Array) || source.byteLength === 0 || source.byteLength > MAX_SOURCE_BYTES || sha256Hex(source) !== input.source.digest.replace(/^sha256:/, "")) throw new StepFailedError("Source bundle bytes do not match the recorded digest/size bounds.");
        return contextArchive(source, contextDir, spec.source?.dockerfile);
      };
      let built: { archive: Uint8Array; dockerfilePath: string } | undefined;
      if (contextDir !== ".") {
        let existing: string | undefined;
        try { existing = await options.launches.read(journalScope); } catch { throw new Error("Azure build launch outcome is unknown."); }
        if (existing === undefined) built = await loadSource();
      }
      let claimed: boolean;
      try { claimed = await options.launches.claim(journalScope); } catch { throw new Error("Azure build launch claim could not be confirmed."); }
      if (!claimed) {
        let saved: string | undefined;
        try { saved = await options.launches.read(journalScope); } catch { throw new Error("Azure build launch outcome is unknown."); }
        if (!saved) throw new Error("Azure build launch outcome is unknown; this key will not launch again.");
        const h = decode(ctx, saved);
        if (h.tag !== `zn-${key}` || h.registryId.toLowerCase() !== registry.id.toLowerCase() || h.repository !== repository || h.loginServer !== loginServer) throw new StepFailedError("Recovered Azure build handle does not match this build.");
        return { buildId: saved };
      }
      built ??= await loadSource();
      let runId;
      try { runId = await scheduleBuild(ctx, { registryId: registry.id, loginServer, repository, source: built.archive, tag: `zn-${key}`, dockerfilePath: built.dockerfilePath, uploadFetch: options.uploadFetch, ...(spec.isolation?.workerPool ? { agentPool: spec.isolation.workerPool } : {}) }); } catch { ctx.signal.throwIfAborted(); throw new Error("ACR build launch was not confirmed; reconcile the consumed launch key before retrying."); }
      const h: Handle = { version: 1, scope: scope(ctx), registryId: registry.id, registryAddress: input.registry.address, loginServer, repository, runId, tag: `zn-${key}` };
      const encoded = JSON.stringify(h);
      try { await options.launches.record(journalScope, encoded); } catch { throw new Error("ACR build was scheduled but its launch receipt was not persisted; reconcile before retrying."); }
      return { buildId: encoded };
    },
    async waitForBuild(raw, handle, opts): Promise<BuildResult> {
      const original = context(raw); const h = decode(original, handle.buildId); const wait = bounded(original, opts.timeoutMs); const ctx = wait.ctx;
      try {
        await verifyRegistry(ctx, h);
        for (;;) {
          let run;
          try { run = (await armClient(ctx.session, ctx.signal).get(`${h.registryId}/runs/${h.runId}`, { apiVersion: API.containerRegistryRuns })).body; } catch { throw new Error("ACR build state could not be read; outcome is unknown."); }
          if (run.name !== h.runId || (run.id !== undefined && run.id !== `${h.registryId}/runs/${h.runId}`) || rec(run.properties).runId !== h.runId) throw new StepFailedError("ACR run identity does not match its build handle.");
          const state = rec(run.properties).status;
          if (state === "Succeeded") {
            const outputs = arr(rec(run.properties).outputImages).filter((i) => i.registry === h.loginServer && i.repository === h.repository && i.tag === h.tag);
            if (outputs.length !== 1 || typeof outputs[0].digest !== "string" || !IMAGE_DIGEST.test(outputs[0].digest)) return { status: "failed", detail: "ACR finished without one matching pushed image digest." };
            return { status: "succeeded", digest: outputs[0].digest, imageUri: `${h.loginServer}/${h.repository}@${outputs[0].digest}`, attestation: await attest(ctx, h, run) };
          }
          if (state === "Canceled") return { status: "stopped" };
          if (state === "Timeout") return { status: "timed_out" };
          if (state === "Failed" || state === "Error") return { status: "failed", detail: "ACR reported a failed build." };
          if (!["Queued", "Started", "Running"].includes(String(state))) throw new Error("ACR build state is unknown.");
          if (Date.now() >= wait.deadline) return { status: "timed_out" };
          await pause(ctx, wait.deadline);
        }
      } catch (e) { original.signal.throwIfAborted(); if (wait.timeout.aborted) return { status: "timed_out" }; throw e; }
    },
  };
}
