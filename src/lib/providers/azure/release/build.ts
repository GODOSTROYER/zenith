/**
 * ACR Tasks build adapter, reusing runAcrBuild's isolated source upload/build.
 * BuildPort.startBuild waits for that helper; waitForBuild rereads native ACR
 * run metadata, so handles survive worker replacement. Only digest references
 * leave this adapter, even though the helper also pushes its historical tag.
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
import { runAcrBuild, MAX_SOURCE_BYTES } from "@/lib/providers/azure/acr-build";
import { armClient, type ArmResource } from "@/lib/providers/azure/arm";
import { API } from "@/lib/providers/azure/platform";
import { nodeNameOf } from "@/lib/providers/azure/naming";
import { context, managed, locate, validId, assertResource, bounded, pause, rec, arr, IMAGE_DIGEST, type Ctx, type LaunchJournal } from "./support";

export interface AzureBuildOptions {
  /** Load bundle bytes inside the current broker callback; never return signed URLs or credentials. */
  readSource?(ctx: DriverContext<AzureSession>, source: { s3Key: string; digest: string; bucket?: string }): Promise<Uint8Array>;
  launches?: LaunchJournal;
  /** Plain SAS upload transport; receives NO broker credential. Default the helper's fetch. */
  uploadFetch?: typeof fetch;
}
interface Handle { version: 1; scope: string; runId: string; registryId: string; registryAddress: string; loginServer: string; repository: string; tag: string }
const scope = (ctx: Ctx) => digest([ctx.workspaceId, ctx.environmentId, ctx.session.subscriptionId, ctx.region]);
function decode(ctx: Ctx, raw: string): Handle {
  let h: Handle;
  try { if (raw.length > 4000) throw new Error(); h = JSON.parse(raw) as Handle; } catch { throw new StepFailedError("Invalid Azure build handle."); }
  if (h.version !== 1 || h.scope !== scope(ctx) || typeof h.registryId !== "string" || !validId(ctx, h.registryId, "Microsoft.ContainerRegistry/registries") || typeof h.runId !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(h.runId) || typeof h.registryAddress !== "string" || !/^[a-z_]+\/[A-Za-z0-9_.-]+$/.test(h.registryAddress) || typeof h.loginServer !== "string" || !/^[a-z0-9]{5,50}\.azurecr\.io$/.test(h.loginServer) || typeof h.repository !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(h.repository) || typeof h.tag !== "string" || !/^zn-[a-f0-9]{64}$/.test(h.tag)) throw new StepFailedError("Azure build handle is outside this environment or malformed.");
  return h;
}
async function verifyRegistry(ctx: Ctx, h: Handle): Promise<void> {
  let registry: ArmResource;
  try { registry = (await armClient(ctx.session, ctx.signal).get<ArmResource>(h.registryId, { apiVersion: API.containerRegistry })).body; } catch { throw new Error("Build output registry state is unknown."); }
  assertResource(ctx, { address: h.registryAddress } as Parameters<typeof assertResource>[1], registry, "Microsoft.ContainerRegistry/registries");
  if (registry.id.toLowerCase() !== h.registryId.toLowerCase() || rec(registry.properties).loginServer !== h.loginServer) throw new StepFailedError("Build output login server does not match the owning registry.");
}

export function createBuildPort(options: AzureBuildOptions = {}): BuildPort {
  return {
    async startBuild(raw, input) {
      const ctx = context(raw); managed(ctx, input.service); managed(ctx, input.pipeline, "build_pipeline");
      const spec = input.pipeline.spec as unknown as BuildPipelineSpec; const artifact = rec(input.service.spec.artifact);
      if (!input.registry || spec.location !== "customer_account" || rec(spec.output).registry !== input.registry.address || artifact.type !== "built" || artifact.pipeline !== input.pipeline.address || artifact.registry !== input.registry.address || !input.idempotencyKey || !/^(?:sha256:)?[a-f0-9]{64}$/.test(input.source.digest) || typeof input.source.s3Key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(input.source.s3Key) || input.source.s3Key.split("/").some((p) => p === "." || p === "..") || (input.source.bucket !== undefined && !/^[A-Za-z0-9._/-]{1,300}$/.test(input.source.bucket))) throw new StepFailedError("Azure build inputs do not identify this workload's source/pipeline/registry.");
      if (!options.readSource || !options.launches) throw new StepFailedError("Azure builds require a source reader and durable tenant-scoped launch journal.");
      const registry = await locate(ctx, input.registry, "Microsoft.ContainerRegistry/registries");
      const loginServer = rec(registry.properties).loginServer; const repository = nodeNameOf(input.service.address);
      if (typeof loginServer !== "string" || !/^[a-z0-9]{5,50}\.azurecr\.io$/.test(loginServer) || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(repository)) throw new StepFailedError("Azure build output registry/repository is malformed.");
      const key = digest([scope(ctx), "build", input.service.address, input.source.digest, input.idempotencyKey]);
      const journalScope = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, key };
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
      let source: Uint8Array;
      try { source = await options.readSource(ctx, input.source); } catch { throw new Error("Azure source bundle could not be read; no build was launched."); }
      if (!(source instanceof Uint8Array) || source.byteLength === 0 || source.byteLength > MAX_SOURCE_BYTES || sha256Hex(source) !== input.source.digest.replace(/^sha256:/, "")) throw new StepFailedError("Source bundle bytes do not match the recorded digest/size bounds.");
      let result;
      try { result = await runAcrBuild(ctx.session, { registryId: registry.id, loginServer, repository, source, tags: [`zn-${key}`], dockerfilePath: spec.source?.dockerfile, uploadFetch: options.uploadFetch, clientRequestId: key }, ctx.signal); } catch { ctx.signal.throwIfAborted(); throw new Error("ACR build did not complete; reconcile the consumed launch key before retrying."); }
      const h: Handle = { version: 1, scope: scope(ctx), registryId: registry.id, registryAddress: input.registry.address, loginServer, repository, runId: result.runId, tag: `zn-${key}` };
      const encoded = JSON.stringify(h);
      try { await options.launches.record(journalScope, encoded); } catch { throw new Error("ACR build finished but its launch receipt was not persisted; reconcile before retrying."); }
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
            return { status: "succeeded", digest: outputs[0].digest, imageUri: `${h.loginServer}/${h.repository}@${outputs[0].digest}` };
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
