/**
 * The release pipeline wired into the deploy activities (PROD-LIFE-10). `release.ts` calls these
 * around `deployWorkloads` and `runMigrations`; every function is a no-op unless the composition
 * supplied `deps.releaseSafety`.
 *
 *   beginRuns      before ANY rollout effect: bind each digest, verify provenance, refuse an
 *                  unsupported progressive rollout, refuse an unsafe code rollback, and stop at a
 *                  migration that has no independent human approval
 *   rolloutRun     the rollout itself: rolling replace, or staged canary steps with a bake
 *   finishRuns     after the migration: readiness, cutover (100%), readback of the serving digest
 *   abortCanaries  best effort: put canary traffic back on the previous revision (code only)
 *
 * A code rollback (`deployment.rollback`) reaches here as kind `rollback`: it restores a digest
 * that already served, never runs a migration, and never touches data.
 */
import type { DriverContext } from "@/lib/drivers/types";
import type { ManifestV2 } from "@/lib/resources/manifest-v2";
import type { ArtifactSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { digest } from "@/lib/controlplane/digest";
import { accountableId, canarySteps, ReleaseSafetyError, type ReleaseRun, type ReleaseSafetyService } from "@/lib/release-safety";
import type { ExecContext } from "./context";
import { StepFailedError } from "./errors";
import type { Runtime } from "./runtime";
import { safeText } from "./text";

type ReleaseDecl = NonNullable<ManifestV2["release"]>;
export type ImageRef = { imageUri: string; digest: string };

export const isRollbackOperation = (ec: Pick<ExecContext, "op">): boolean => ec.op.capability === "deployment.rollback";

/** Definitive refusals cross the activity boundary as `StepFailedError` (nothing was changed before them). */
export function asStepFailure(err: unknown): never {
  if (err instanceof ReleaseSafetyError) throw new StepFailedError(err.message);
  throw err;
}

const isMigrateService = (release: ReleaseDecl | undefined, node: ResourceNode): boolean =>
  !!release?.migrate && (node.address === `container_service/${release.migrate.service}` || node.address === `scheduled_job/${release.migrate.service}`);

const key = (...parts: unknown[]): string => digest(parts).slice(0, 32);

export async function beginRuns(
  rt: Runtime,
  ec: ExecContext,
  input: { targets: ResourceNode[]; images: Map<string, ImageRef>; release: ReleaseDecl | undefined; ctxFor: (node: ResourceNode) => DriverContext; workloads: NonNullable<Runtime["d"]["workloads"]> }
): Promise<Map<string, ReleaseRun>> {
  const safety = rt.d.releaseSafety;
  const runs = new Map<string, ReleaseRun>();
  if (!safety) return runs;
  const rollback = isRollbackOperation(ec);
  for (const node of input.targets) {
    const image = input.images.get(node.address);
    if (!image?.digest) {
      throw new StepFailedError(`${node.address} has no pinned image digest, so a digest-bound release cannot be created. Pin the image by its sha256 digest. Nothing was deployed.`);
    }
    const artifact = node.spec.artifact as ArtifactSpec | undefined;
    const ctx = input.ctxFor(node);
    const wantsProgressive = !rollback && node.kind === "container_service" && input.release?.rollout?.strategy === "progressive";
    const migrate = !rollback && isMigrateService(input.release, node) ? input.release!.migrate! : undefined;
    try {
      const run = await safety.begin({
        workspaceId: ec.workspaceId,
        projectId: ec.product.project.id,
        environmentId: ec.environmentId,
        operationId: ec.op.id,
        ...(ec.product.revision?.id ? { revisionId: ec.product.revision.id } : {}),
        serviceAddress: node.address,
        provider: node.provider,
        nodeKind: node.kind,
        kind: rollback ? "rollback" : "deploy",
        imageUri: image.imageUri,
        imageDigest: image.digest,
        sourceDigest: ec.approvedSourceSnapshots?.find((s) => s.serviceAddress === node.address)?.archiveDigest,
        origin: artifact?.type === "built" ? "built" : "pinned",
        requestedBy: accountableId(ec.op.principal),
        ...(migrate ? { migration: { commandDigest: digest(migrate.command), declared: migrate.class } } : {}),
        ...(wantsProgressive ? { rollout: input.release!.rollout } : {}),
        ...(wantsProgressive ? { progressive: await input.workloads.progressive?.support(ctx, node).catch(() => ({ supported: false as const, reason: "The provider could not report weighted traffic support." })) } : {}),
      });
      runs.set(node.address, run);
    } catch (e) {
      asStepFailure(e);
    }
  }
  return runs;
}

/** What went wrong after an effect may have started: a definitive refusal is `failed`, anything else `uncertain`. */
async function settle(safety: ReleaseSafetyService, run: ReleaseRun, err: unknown): Promise<never> {
  const text = safeText(err instanceof Error ? err.message : "unknown", 300);
  if (err instanceof StepFailedError || err instanceof ReleaseSafetyError) await safety.fail(run, text).catch(() => undefined);
  else await safety.uncertain(run, text).catch(() => undefined);
  throw err;
}

export async function rolloutRun(
  rt: Runtime,
  ec: ExecContext,
  input: { run: ReleaseRun; node: ResourceNode; image: ImageRef; ctx: DriverContext; workloads: NonNullable<Runtime["d"]["workloads"]>; signal: AbortSignal; steadyTimeoutMs: number }
): Promise<ReleaseRun> {
  const safety = rt.d.releaseSafety!;
  const { node, image, ctx, workloads } = input;
  let run = input.run;
  try {
    if (run.rollout.strategy === "progressive" && run.kind === "deploy") {
      const p = workloads.progressive;
      if (!p) throw new StepFailedError("Progressive rollout is not available on this worker.");
      await p.stageCandidate(ctx, node, { uri: image.imageUri, digest: image.digest }, { idempotencyKey: key(ec.op.id, "stage", node.address, image.digest) });
      for (const percent of canarySteps(run.rollout)) {
        const moved = await p.setTrafficPercent(ctx, node, { candidateDigest: image.digest, percent, idempotencyKey: key(ec.op.id, "traffic", node.address, image.digest, percent) });
        run = await safety.markDeployed(run, { percent: moved.observedPercent, detail: `candidate serving ${moved.observedPercent}% of traffic` });
        rt.log("info", "canary step", { service: node.address, percent: moved.observedPercent });
        if (run.rollout.bakeSec > 0) await rt.sleep(run.rollout.bakeSec * 1000, input.signal);
      }
      return run;
    }
    await workloads.deployImage(ctx, node, { uri: image.imageUri, digest: image.digest }, { idempotencyKey: key(ec.op.id, "deploy", node.address, image.digest) });
    if (node.kind === "container_service") {
      const steady = await workloads.waitSteady(ctx, node, { timeoutMs: input.steadyTimeoutMs });
      if (!steady.steady) {
        throw new StepFailedError(`${node.address} did not reach steady state (${safeText(steady.detail ?? "no detail", 200)}); it may be partially rolled out and reconcile will observe the environment.`);
      }
    }
    return await safety.markDeployed(run, { percent: 100, detail: run.kind === "rollback" ? "previous digest restored" : "candidate replaced the serving digest" });
  } catch (e) {
    return settle(safety, run, e);
  }
}

/** Move traffic back for a canary that will not complete. Never throws; never touches data. */
export async function abortCanary(rt: Runtime, run: ReleaseRun, node: ResourceNode, ctx: DriverContext): Promise<void> {
  if (run.rollout.strategy !== "progressive" || run.kind !== "deploy" || run.rollout.percent >= 100) return;
  try {
    await rt.d.workloads?.progressive?.abort(ctx, node, { candidateDigest: run.imageDigest });
    rt.log("info", "canary aborted", { service: node.address });
  } catch (e) {
    rt.log("error", "canary abort failed; traffic may still be split", { service: node.address, error: safeText(e instanceof Error ? e.message : "unknown", 200) });
  }
}

/** Readiness, cutover and readback for one run whose migration step is behind it. */
export async function finishRun(
  rt: Runtime,
  ec: ExecContext,
  input: { run: ReleaseRun; node: ResourceNode; ctx: DriverContext; workloads: NonNullable<Runtime["d"]["workloads"]>; steadyTimeoutMs: number }
): Promise<ReleaseRun> {
  const safety = rt.d.releaseSafety!;
  const { node, ctx, workloads } = input;
  let run = input.run;
  if (run.state === "readback_verified" || run.state === "cut_over_unverified") return run;
  try {
    if (run.state === "deployed") run = await safety.markMigrated(run, { ran: false, detail: "no migration for this service" });
    if (run.state === "migrated") run = await safety.markReady(run, run.rollout.strategy === "progressive" ? "canary baked and migration complete" : "steady state reached and migration complete");
    if (run.state === "ready") {
      if (run.rollout.strategy === "progressive" && run.kind === "deploy") {
        const p = workloads.progressive;
        if (!p) throw new StepFailedError("Progressive rollout is not available on this worker.");
        await p.setTrafficPercent(ctx, node, { candidateDigest: run.imageDigest, percent: 100, idempotencyKey: key(ec.op.id, "traffic", node.address, run.imageDigest, 100) });
        if (node.kind === "container_service") {
          const steady = await workloads.waitSteady(ctx, node, { timeoutMs: input.steadyTimeoutMs });
          if (!steady.steady) throw new StepFailedError(`${node.address} did not reach steady state after cutover (${safeText(steady.detail ?? "no detail", 200)}).`);
        }
      }
      run = await safety.markCutOver(run, run.kind === "rollback" ? "previous digest serving all traffic" : "candidate serving all traffic");
    }
    if (run.state === "cut_over") {
      let read: Awaited<ReturnType<NonNullable<typeof workloads.readServing>>> | undefined;
      let readFailed = false;
      try {
        read = workloads.readServing ? await workloads.readServing(ctx, node) : undefined;
      } catch {
        readFailed = true;
      }
      run = await safety.recordReadback(run, read ? (readFailed ? { supported: true, readable: false } : { supported: read.supported, observedDigest: read.digest, readable: read.steady !== false, detail: read.detail }) : { supported: false, readable: false });
      if (run.state === "failed") throw new StepFailedError(`${node.address} reports a different image than the release bound after cutover (${safeText(run.reason ?? "", 200)}). Nothing was reverted; investigate before redeploying.`);
      if (run.kind === "rollback") await markReplaced(safety, run);
    }
    return run;
  } catch (e) {
    await abortCanary(rt, run, node, ctx);
    return settle(safety, run, e);
  }
}

/** A finished code rollback marks the release it replaced as rolled back, and says data was not changed. */
async function markReplaced(safety: ReleaseSafetyService, rollbackRun: ReleaseRun): Promise<void> {
  const served = await safety.list(rollbackRun.workspaceId, { environmentId: rollbackRun.environmentId, serviceAddress: rollbackRun.serviceAddress, limit: 20 });
  const replaced = served.find((r) => r.id !== rollbackRun.id && r.imageDigest !== rollbackRun.imageDigest && ["cut_over", "readback_verified", "cut_over_unverified"].includes(r.state));
  if (replaced) await safety.markRolledBack(replaced.workspaceId, replaced.id, `Code rolled back to ${rollbackRun.imageDigest.slice(0, 19)}; data was not changed.`).catch(() => undefined);
}
