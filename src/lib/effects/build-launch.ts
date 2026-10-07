/**
 * Ledger glue for build launches (PROD-DUR-08), shared by every provider.
 *
 * AWS keeps its dedicated `platform.build_launches` claim (which carries the
 * approval, policy, source and fence authority); the ledger adds the typed
 * state, the receipt that survives a crash between "provider accepted" and
 * "launch row acknowledged", and the readback/resolution path for a launch
 * whose response was lost. Other providers have no such claim table, so their
 * launches are deduplicated by the ledger alone (see `withBuildEffects`).
 */
import type { Sql } from "@/lib/controlplane/types";
import * as launches from "@/lib/controlplane/db/repos/build-launches";
import { digest } from "@/lib/controlplane/digest";
import { buildReadback } from "./binding";
import { createEffectLedger, EffectUnresolvedError, type EffectLedger } from "./ledger";
import type { DriverContext } from "@/lib/drivers/types";
import { StepFailedError, type BuildHandle, type BuildPort } from "@/lib/execution";
import type { EffectRecord } from "./types";
import type { BeginEffectInput } from "@/lib/controlplane/db/repos/external-effects";

type AwsBinding = launches.BuildLaunchBinding;
type EffectInput = Omit<BeginEffectInput, "actor"> & { actor?: string };

export const awsBuildDedupKey = (operationId: string, serviceAddress: string): string => `build:${operationId}:${serviceAddress}`;

export function awsBuildEffectInput(binding: AwsBinding, idempotencyToken: string, fence: { scope: string; token: number }): EffectInput {
  return {
    workspaceId: binding.workspaceId,
    family: "build_launch",
    operationId: binding.operationId,
    environmentId: binding.environmentId,
    provider: "aws",
    dedupKey: awsBuildDedupKey(binding.operationId, binding.serviceAddress),
    requestDigest: digest(binding),
    target: {
      accountId: binding.accountId, region: binding.region, projectName: binding.projectName, projectArn: binding.projectArn,
      sourceBucket: binding.sourceBucket, sourceKey: binding.sourceKey, sourceDigest: binding.sourceDigest,
      executedSettingsDigest: binding.executedSettingsDigest, serviceAddress: binding.serviceAddress,
    },
    idempotencyToken,
    // CodeBuild honors StartBuild idempotencyToken (best effort); the ledger never relies on it for replay safety.
    idempotencySupported: true,
    fence: { scope: fence.scope, token: fence.token },
  };
}

/**
 * The durable launch claim already exists but carries no provider receipt, so an earlier attempt ended without a
 * known outcome. NEVER start another build. If the ledger holds the provider's own receipt (accepted, or confirmed
 * after an authorized resolution) adopt it; otherwise the launch is uncertain and stays so until resolved.
 */
export async function resolveUnreceiptedLaunch(sql: Sql, ledger: EffectLedger, launch: launches.BuildLaunch, input: EffectInput): Promise<launches.BuildLaunch> {
  let effect: EffectRecord;
  try {
    effect = (await ledger.begin({ ...input, fence: undefined })).effect;
  } catch {
    throw new launches.BuildLaunchError();
  }
  if (effect.state === "pending" || (effect.state === "accepted" && !effect.providerReceipt?.resourceId)) {
    effect = await ledger.markUncertain(effect.workspaceId, effect.effectId, "A launch claim exists without a provider receipt; an earlier attempt ended without a known outcome.").catch(() => effect);
  }
  const receipt = effect.providerReceipt;
  if ((effect.state === "accepted" || effect.state === "confirmed") && receipt?.resourceId && receipt.requestIds.length > 0)
    return launches.acknowledge(sql, launch, receipt.resourceId, receipt.requestIds);
  throw new launches.BuildLaunchError();
}

/** A launch claimed before the ledger existed already has its receipt; register it so it is visible and deduplicated. */
export async function registerExistingLaunch(ledger: EffectLedger, launch: launches.BuildLaunch, input: EffectInput): Promise<void> {
  try {
    const { created, effect } = await ledger.begin({ ...input, fence: undefined });
    if (created && effect.state === "pending" && launch.build_id && launch.request_ids?.length)
      await ledger.recordAccepted(effect.workspaceId, effect.effectId, { resourceId: launch.build_id, requestIds: launch.request_ids }, "system:legacy-launch");
  } catch { /* visibility only; the durable launch row remains the authority */ }
}

/** Exact independent BatchGetBuilds read of an accepted build. Best effort evidence; never fails the caller. */
export async function confirmBuildFromExactRead(ledger: EffectLedger, launch: launches.BuildLaunch, build: { id: string; status: string }, requestId: string | undefined): Promise<void> {
  try {
    const effect = await ledger.getByDedup(launch.workspace_id, "build_launch", awsBuildDedupKey(launch.operation_id, launch.service_address));
    if (!effect || effect.state !== "accepted") return;
    await ledger.recordReadback(effect.workspaceId, effect.effectId, buildReadback({
      outcome: "present", source: "aws.codebuild.batch-get-build", observedAt: new Date().toISOString(), resourceId: build.id,
      ...(requestId ? { requestIds: [requestId] } : {}), facts: { buildStatus: build.status },
    }), "system:build-readback");
  } catch { /* the effect stays accepted; an operator or the next read confirms it */ }
}

/* ------------------- providers without a dedicated launch claim table ------------------- */

type StartInput = Parameters<BuildPort["startBuild"]>[1];

/** A refusal raised before the provider call (validation, identity, ownership) proves nothing was dispatched. */
const isDefiniteRefusal = (error: unknown): boolean => error instanceof StepFailedError || (error instanceof Error && error.name === "OperationRefused");

/** The provider's own id inside an opaque port handle (GCP build id, ACR run id); a digest for any other shape. */
function providerIdOf(handle: string): string {
  try {
    const h = JSON.parse(handle) as { id?: unknown; runId?: unknown };
    if (typeof h.id === "string" && h.id) return h.id;
    if (typeof h.runId === "string" && h.runId) return h.runId;
  } catch { /* opaque handle */ }
  return digest(handle);
}

export type BuildOncePort = Pick<BuildPort, "startBuild" | "launchIdentity" | "adoptBuild"> | BuildPort["startBuild"];

/**
 * GCP, Azure, Kubernetes and OCI build ports. The call happens at most once per (operation, service): the ledger
 * records it before the provider is called, stores the returned handle as the receipt (with the provider's own id and
 * the identity an independent readback needs), and answers every retry from it or refuses it as unresolved. After an
 * operator confirmed a lost launch from readback, `adoptBuild` rebuilds the handle from the provider's id. Without a
 * database (isolated test composition) the port is called directly, exactly as before.
 */
export async function startBuildOnce(db: Sql | undefined, ctx: DriverContext, input: StartInput, portOrStart: BuildOncePort): Promise<BuildHandle> {
  const port = typeof portOrStart === "function" ? { startBuild: portOrStart } : portOrStart;
  if (!db || !ctx.operationId) return port.startBuild(ctx, input);
  const ledger = createEffectLedger(db);
  let identity: Record<string, string> = {};
  try { identity = (port as { launchIdentity?: BuildPort["launchIdentity"] }).launchIdentity?.(ctx, input) ?? {}; } catch { identity = {}; }
  const requestDigest = digest({ provider: ctx.provider, workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, region: ctx.region,
    service: input.service.address, pipeline: input.pipeline.address, registry: input.registry?.address ?? null, source: input.source.digest, key: input.idempotencyKey });
  const outcome = await ledger.dispatchOnce({
    workspaceId: ctx.workspaceId, family: "build_launch", operationId: ctx.operationId, environmentId: ctx.environmentId, provider: ctx.provider,
    dedupKey: awsBuildDedupKey(ctx.operationId, input.service.address), requestDigest,
    target: { region: ctx.region, serviceAddress: input.service.address, pipelineAddress: input.pipeline.address, sourceDigest: input.source.digest, ...identity },
    idempotencySupported: false, ...(ctx.fence ? { fence: ctx.fence } : {}),
  }, async () => {
    const handle = await port.startBuild(ctx, input);
    // Provider handles are opaque (and can be long); keep them verbatim as the receipt identity.
    return { value: handle, receipt: { resourceId: providerIdOf(handle.buildId), requestIds: [], identity: { handle: handle.buildId } } };
  }, (error) => (isDefiniteRefusal(error) ? "rejected" : "unknown"));
  if (outcome.kind === "dispatched") return outcome.value;
  const saved = outcome.effect.providerReceipt?.identity?.handle;
  if (saved) return { buildId: saved };
  // Confirmed by an authorized resolution from independent readback: rebuild the handle from the provider's id.
  const confirmedId = outcome.effect.providerReceipt?.resourceId;
  const adopt = (port as { adoptBuild?: BuildPort["adoptBuild"] }).adoptBuild;
  if (outcome.effect.state === "confirmed" && confirmedId && adopt) return adopt.call(port, ctx, input, confirmedId);
  throw new EffectUnresolvedError(outcome.effect.effectId, outcome.effect.state);
}
