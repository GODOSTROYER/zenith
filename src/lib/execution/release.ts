/**
 * The release side of the deploy journey, after infrastructure is applied:
 *
 *   buildArtifacts → deployWorkloads → runMigrations
 *
 * buildArtifacts — for each managed container service / scheduled job whose
 *   artifact is `built` (a git source), upload the source bundle to the
 *   customer's artifact bucket (`SourceBundlePort`: source acquisition is out of
 *   scope here), start a CodeBuild build in the customer's account and wait for
 *   it (ADR-0016: hostile code never builds in Zenith's process). The image
 *   digest CodeBuild reports is checked for shape and recorded as `build`
 *   evidence. Services with an `image` artifact pass through; an image in the
 *   connection's own ECR is pinned to a digest, anything else is kept as written
 *   and reported NOT pinned (`digest: ""`).
 *   AWS launches require a permanent operation/service claim before StartBuild.
 *   Unknown dispatch outcomes are unconfirmed failures, never automatic retries.
 *   A provider-confirmed terminal failure stops continuation; it does not prove
 *   customer code had no external effects or authorize cleanup.
 *
 * deployWorkloads — first sync current vault values under a separate exact-resource
 * secret.write grant. A refused or partial sync stops the rollout. Then, for
 * every service with a pinned image, point the service at
 *   `repo@sha256:…` (`WorkloadsPort.deployImage`, idempotent on an operation +
 *   service + digest key), then wait for ECS steady state. Unpinned images are
 *   NOT rolled here (OpenTofu already deployed the reference); they are only
 *   waited on. Runs under the fenced lease with heartbeats.
 *
 * runMigrations — the manifest's `release.migrate` runs once as a one-off task
 *   (`MigrationsPort`): argv, never a shell string. Absent: `ran: false`.
 *   A non-zero exit is a clean failure that says the database may be partially
 *   migrated; nothing is rolled back and nothing is retried.
 */
import { digest } from "@/lib/controlplane/digest";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { ArtifactSpec, BuildPipelineSpec } from "@/lib/resources/specs";
import type { ExecutionActivities, LeaseRef } from "@/lib/workflows/types";
import { mapLimit } from "./concurrency";
import { loadExecContext, resolveConnection, type ExecContext } from "./context";
import { assertLeaseFor, requireExecutable } from "./desired";
import { StepFailedError } from "./errors";
import { buildDesiredState } from "./graph";
import { pinImage, SHA256_IMAGE_DIGEST } from "./images";
import { withKeepAlive } from "./keepalive";
import type { Runtime } from "./runtime";
import { driverContext, LONG_SESSION_SEC, withProviderSession } from "./session";
import { safeText } from "./text";
import { approvedSources, type ApprovedSourceSnapshot } from "./source-snapshot";
import { assertOperationSemantics } from "./semantics/operation";
import { isApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { assertBuildIsolation, BuildIsolationError, contextDirOf, type BuildAttestation, type BuildProviderKey } from "./build-isolation";
import { BuildProvenanceError, provenanceEvidenceDigest, signBuildProvenance, verifyBuildProvenance } from "./build-provenance";
import { syncEnvironmentSecrets } from "./secrets";
import { abortCanary, asStepFailure, beginRuns, finishRun, isRollbackOperation, rolloutRun, type ImageRef } from "./release-safety";
import type { ReleaseRun } from "@/lib/release-safety";

type ReleaseActivities = Pick<ExecutionActivities, "buildArtifacts" | "deployWorkloads" | "runMigrations">;

const isWorkload = (n: ResourceNode): boolean => n.ownership === "managed" && (n.kind === "container_service" || n.kind === "scheduled_job");
const artifactOf = (n: ResourceNode): ArtifactSpec | undefined => n.spec.artifact as ArtifactSpec | undefined;
const nodeAt = (graph: ResourceGraph, address: string): ResourceNode | undefined => graph.nodes.find((n) => n.address === address);
const keyOf = (...parts: unknown[]): string => digest(parts).slice(0, 32);

export function createReleaseActivities(rt: Runtime): ReleaseActivities {
  return {
    async buildArtifacts({ operationId, lease }) {
      const ec = await loadExecContext(rt, operationId);
      assertLeaseFor(ec, lease);
      const { graph } = requireExecutable(rt, ec);
      const workloads = graph.nodes.filter(isWorkload).sort((a, b) => (a.address < b.address ? -1 : 1));
      if (workloads.length === 0) return { images: [] };
      // A code rollback restores the digest that revision last served; it does not rebuild.
      const priors = await priorServedImages(rt, ec, workloads);
      const needsBuild = workloads.some((n) => artifactOf(n)?.type === "built" && !priors.has(n.address));
      if (needsBuild && (!rt.d.build || !rt.d.sourceBundle)) {
        throw new StepFailedError("This worker has no build runner or source bundler configured, so services with a git source cannot be built. Pin an image or configure the build ports.");
      }
      const connection = await resolveConnection(rt, ec);

      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      const images = await withKeepAlive(rt, { lease, detail: "build artifacts", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
        await approvedSources(rt,ec,graph,lease,false,signal);
        // PROD-DUR-03: nothing is built from semantics other than the ones the approver reviewed.
        await assertOperationSemantics(rt, ec, lease, "build dispatch", signal);
        return withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
          const failures: unknown[] = [];
          const built = await mapLimit(workloads, 3, async (node) => {
            // Stop new builds, await every already-started sibling, and retain
            // uncertainty even when a definitive failure arrived first.
            if (failures.length) return undefined;
            try {
              const artifact = artifactOf(node);
              const ctx = driverContext(rt, ec, session, signal, { node, fence: lease });
              if (!artifact || artifact.type === "blueprint") {
                throw new StepFailedError(`${node.address} has no runnable artifact (${artifact ? "a blueprint source" : "none"}).`);
              }
              if (artifact.type === "image") {
                const pinned = await pinImage(session, artifact.ref, signal);
                if (pinned.note) rt.log("info", "image left unpinned", { service: node.address, note: pinned.note });
                return { service: node.address, imageUri: pinned.imageUri, digest: pinned.digest };
              }
              const prior = priors.get(node.address);
              if (prior) return { service: node.address, imageUri: prior.imageUri, digest: prior.digest };
              return await buildOne(rt, ec, graph, node, artifact, ctx, lease);
            } catch (error) { failures.push(error); return undefined; }
          });
          if (failures.length) throw failures.find(error => !(error instanceof StepFailedError)) ?? failures[0];
          return built.filter((result): result is NonNullable<typeof result> => result !== undefined);
        }
        );
      });
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      return { images };
    },

    async deployWorkloads({ operationId, lease, images }) {
      const ec = await loadExecContext(rt, operationId);
      assertLeaseFor(ec, lease);
      const { graph } = requireExecutable(rt, ec);
      const targets = graph.nodes.filter(isWorkload).sort((a, b) => (a.address < b.address ? -1 : 1));
      const byService = validateImages(graph, images);
      const workloads = rt.d.workloads;
      if (targets.length > 0 && !workloads) throw new StepFailedError("This worker has no workload deployer configured; it cannot roll out services.");
      const needsSecrets = graph.nodes.some((n) => (n.kind === "secret" && typeof n.spec.secretRef === "string" && n.spec.secretRef.startsWith("vault:")) || (n.ownership === "managed" && ["kubernetes", "zenith"].includes(n.provider) && ["postgres", "redis"].includes(n.kind)));
      if (targets.length === 0 && !needsSecrets) return { services: 0 };
      // The ONE verification of signed build provenance. Its result feeds the release gate as the `attested` verdict.
      const admissions = await admitBuiltArtifacts(rt, ec, graph, targets, byService);
      const connection = await resolveConnection(rt, ec);
      // PROD-DUR-03: the first rollout effect (secret sync included) happens only under the approved semantics.
      await assertOperationSemantics(rt, ec, lease, "rollout dispatch");

      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      const rolled = await withKeepAlive(rt, { lease, detail: "deploy workloads", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
        await syncEnvironmentSecrets(rt, ec, graph, connection, lease, signal);
        if (!targets.length) return { done: 0, pinned: 0 };
        return withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
          let done = 0;
          let pinned = 0;
          if (rt.d.releaseSafety) {
            // Digest-bound release: every gate is cleared for every service BEFORE the first rollout effect.
            const release = buildDesiredState(ec.product).manifest?.release;
            const ctxFor = (node: ResourceNode) => driverContext(rt, ec, session, signal, { node, fence: lease });
            const images = new Map<string, ImageRef>();
            for (const node of targets) {
              const supplied = byService.get(node.address);
              const artifact = artifactOf(node);
              const pinnedRef = artifact?.type === "image" ? /@(sha256:[0-9a-f]{64})$/.exec(artifact.ref) : null;
              if (supplied?.digest) images.set(node.address, supplied);
              else if (pinnedRef && artifact?.type === "image") images.set(node.address, { imageUri: artifact.ref, digest: pinnedRef[1] });
            }
            const runs = await beginRuns(rt, ec, { targets, images, release, ctxFor, workloads: workloads!, admissions });
            for (const node of targets) {
              await rolloutRun(rt, ec, { run: runs.get(node.address)!, node, image: images.get(node.address)!, ctx: ctxFor(node), workloads: workloads!, signal, steadyTimeoutMs: rt.limits.steadyTimeoutMs });
              pinned++;
              done++;
            }
            return { done, pinned };
          }
          for (const node of targets) {
            const ctx = driverContext(rt, ec, session, signal, { node, fence: lease });
            const image = byService.get(node.address);
            if (image?.digest) {
              await workloads!.deployImage(ctx, node, { uri: image.imageUri, digest: image.digest }, { idempotencyKey: keyOf(ec.op.id, "deploy", node.address, image.digest) });
              pinned++;
            }
            if (node.kind === "container_service") {
              const steady = await workloads!.waitSteady(ctx, node, { timeoutMs: rt.limits.steadyTimeoutMs });
              if (!steady.steady) {
                throw new StepFailedError(
                  `${node.address} did not reach steady state (${safeText(steady.detail ?? "no detail", 200)}); it may be partially rolled out and reconcile will observe the environment.`
                );
              }
            }
            done++;
          }
          return { done, pinned };
        });
      }
      );
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      await rt.emit(ec.scope, "resource.applied", `deploy:${ec.op.id}`, { step: "deploy", services: rolled.done, rolledWithPinnedImage: rolled.pinned });
      return { services: rolled.done };
    },

    async runMigrations({ operationId, lease }) {
      const ec = await loadExecContext(rt, operationId);
      assertLeaseFor(ec, lease);
      const desired = buildDesiredState(ec.product);
      const migrate = desired.manifest?.release?.migrate;
      const safety = rt.d.releaseSafety;
      const rollback = isRollbackOperation(ec);
      const runs: ReleaseRun[] = safety ? await safety.list(ec.workspaceId, { operationId: ec.op.id, limit: 100 }) : [];
      for (const run of runs) {
        if (run.state === "failed" || run.state === "uncertain" || run.state === "refused" || run.state === "rolled_back" || run.state === "blocked_approval") {
          throw new StepFailedError(`Release ${run.id} for ${run.serviceAddress} is ${run.state.replace("_", " ")}${run.reason ? ` (${safeText(run.reason, 200)})` : ""}; it cannot continue.`);
        }
      }

      let outcome: { ran: boolean; detail: string };
      const migrateAddress = migrate ? [`container_service/${migrate.service}`, `scheduled_job/${migrate.service}`] : [];
      const migrateRun = runs.find((r) => migrateAddress.includes(r.serviceAddress) && r.kind === "deploy");
      const alreadyPast = (r: ReleaseRun | undefined): boolean => !!r && ["migrated", "ready", "cut_over", "readback_verified", "cut_over_unverified"].includes(r.state);
      if (!migrate) outcome = { ran: false, detail: "no migration declared" };
      else if (rollback) {
        // A code rollback never runs, reverts or re-applies a data migration, whatever the older manifest declares.
        outcome = { ran: false, detail: "code rollback: the release migration was not run and no migration was reverted" };
      } else if (safety && !migrateRun) {
        throw new StepFailedError(`The migration names service "${safeText(migrate.service, 40)}", which has no release run for this operation; refusing to run it ungated.`);
      } else if (alreadyPast(migrateRun)) outcome = { ran: true, detail: `migration on ${migrate.service} already ran for release ${migrateRun!.id}` };
      else outcome = await runMigrationTask(rt, ec, lease, migrate, migrateRun, runs);

      // Re-read: the migration step has moved the run it belongs to.
      if (safety && runs.length > 0) await finishReleases(rt, ec, lease, await safety.list(ec.workspaceId, { operationId: ec.op.id, limit: 100 }));
      return outcome;
    },
  };
}

type MigrateDecl = NonNullable<NonNullable<ReturnType<typeof buildDesiredState>["manifest"]>["release"]>["migrate"] & object;

/** The gated one-off migration task. Returns after the run record says what happened. */
async function runMigrationTask(rt: Runtime, ec: ExecContext, lease: LeaseRef, migrate: MigrateDecl, run: ReleaseRun | undefined, runs: ReleaseRun[]): Promise<{ ran: boolean; detail: string }> {
  const { graph } = requireExecutable(rt, ec);
  const service = nodeAt(graph, `container_service/${migrate.service}`) ?? nodeAt(graph, `scheduled_job/${migrate.service}`);
  if (!service || service.ownership !== "managed") {
    throw new StepFailedError(`The migration names service "${safeText(migrate.service, 40)}", which is not a managed workload of this graph.`);
  }
  const migrations = rt.d.migrations;
  if (!migrations) throw new StepFailedError("This worker has no one-off task runner configured; the declared migration cannot run.");
  // PROD-DUR-03: the migration command, its class and the image it runs in are part of the approved semantics. Checked
  // before the single-use migration approval is consumed, so a refusal spends nothing.
  await assertOperationSemantics(rt, ec, lease, "migration dispatch");
  const safety = rt.d.releaseSafety;
  // The approval for a data or contract migration is checked and consumed HERE, immediately before dispatch.
  let current = run;
  if (safety && current) {
    try {
      current = await safety.beginMigration(current);
    } catch (e) {
      asStepFailure(e);
    }
  }
  const connection = await resolveConnection(rt, ec);
  const timeoutMs = Math.min((migrate.timeoutSec ?? rt.limits.migrationTimeoutMs / 1000) * 1000, rt.limits.migrationTimeoutMs);

  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  const result = await withKeepAlive(rt, { lease, detail: "run migration", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
    withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, (session) =>
      migrations.runOneOffTask(driverContext(rt, ec, session, signal, { node: service, fence: lease }), service, migrate.command, {
        timeoutMs,
        idempotencyKey: keyOf(ec.op.id, "migrate", service.address, migrate.command),
      })
    )
  );
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);

  // The argv is stored as a digest and a count, never as text: a command line can carry what a manifest should not.
  await rt.evidence(
    ec.scope,
    {
      kind: "machine_request",
      digest: digest({ op: ec.op.id, kind: "release.migrate", service: service.address, exitCode: result.exitCode, command: migrate.command }),
      summary: { kind: "release.migrate", service: service.address, commandDigest: digest(migrate.command), argc: migrate.command.length, exitCode: result.exitCode, ...(result.logsRef ? { logsRef: safeText(result.logsRef, 200) } : {}) },
      simulated: false,
      key: `migrate:${ec.op.id}`,
    },
    { critical: true }
  );
  if (safety && current) {
    await safety.markMigrated(current, { ran: true, exitCode: result.exitCode, detail: `migration on ${migrate.service} exited ${result.exitCode}` });
  }
  if (result.exitCode !== 0) {
    // Code only: a canary that will not complete goes back to the previous revision. The data stays as the task left it.
    if (safety) await abortCanaries(rt, ec, lease, runs);
    throw new StepFailedError(`The migration task exited with code ${result.exitCode}; the database may be partially migrated. Nothing was rolled back; reconcile will observe and a new operation decides.`);
  }
  return { ran: true, detail: safeText(`migration on ${migrate.service} exited 0${result.logsRef ? ` (logs ${result.logsRef})` : ""}`, 300) };
}

async function withReleaseSession<T>(rt: Runtime, ec: ExecContext, lease: LeaseRef, detail: string, body: (session: Parameters<typeof driverContext>[2], signal: AbortSignal) => Promise<T>): Promise<T> {
  const connection = await resolveConnection(rt, ec);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  const out = await withKeepAlive(rt, { lease, detail, operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
    withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, (session) => body(session, signal))
  );
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  return out;
}

/** Readiness, cutover and readback for every run of this operation. */
async function finishReleases(rt: Runtime, ec: ExecContext, lease: LeaseRef, runs: ReleaseRun[]): Promise<void> {
  const { graph } = requireExecutable(rt, ec);
  const workloads = rt.d.workloads;
  if (!workloads) throw new StepFailedError("This worker has no workload deployer configured; releases cannot be finished.");
  const finished = await withReleaseSession(rt, ec, lease, "finish release", async (session, signal) => {
    const out: ReleaseRun[] = [];
    for (const run of [...runs].sort((a, b) => (a.serviceAddress < b.serviceAddress ? -1 : 1))) {
      const node = nodeAt(graph, run.serviceAddress);
      if (!node) throw new StepFailedError(`Release ${run.id} names ${safeText(run.serviceAddress, 80)}, which is not in this graph.`);
      out.push(await finishRun(rt, ec, { run, node, ctx: driverContext(rt, ec, session, signal, { node, fence: lease }), workloads, steadyTimeoutMs: rt.limits.steadyTimeoutMs }));
    }
    return out;
  });
  await rt.emit(ec.scope, "resource.applied", `release:${ec.op.id}`, { step: "release", releases: finished.map((r) => ({ id: r.id, service: r.serviceAddress, state: r.state, digest: r.imageDigest })) });
}

async function abortCanaries(rt: Runtime, ec: ExecContext, lease: LeaseRef, runs: ReleaseRun[]): Promise<void> {
  const open = runs.filter((r) => r.rollout.strategy === "progressive" && r.kind === "deploy");
  if (open.length === 0) return;
  try {
    const { graph } = requireExecutable(rt, ec);
    await withReleaseSession(rt, ec, lease, "abort canary", async (session, signal) => {
      for (const run of open) {
        const node = nodeAt(graph, run.serviceAddress);
        if (node) await abortCanary(rt, run, node, driverContext(rt, ec, session, signal, { node, fence: lease }));
      }
    });
  } catch (e) {
    rt.log("error", "canary abort could not run; traffic may still be split", { error: safeText(e instanceof Error ? e.message : "unknown", 200) });
  }
}

/** Images a code rollback restores: the digest each built service last served for the revision being restored. */
async function priorServedImages(rt: Runtime, ec: ExecContext, nodes: ResourceNode[]): Promise<Map<string, ImageRef>> {
  const out = new Map<string, ImageRef>();
  const safety = rt.d.releaseSafety;
  const revisionId = ec.product.revision?.id;
  if (!safety || !isRollbackOperation(ec) || !revisionId) return out;
  for (const node of nodes) {
    if (artifactOf(node)?.type !== "built") continue;
    const prior = await safety.lastServedForRevision(ec.workspaceId, ec.environmentId, node.address, revisionId).catch(() => null);
    if (prior) out.set(node.address, { imageUri: prior.imageUri, digest: prior.imageDigest });
  }
  return out;
}

/** The images the workflow hands back must name workloads of this graph and carry a real digest (or none). */
function validateImages(graph: ResourceGraph, images: { service: string; imageUri: string; digest: string }[]): Map<string, { imageUri: string; digest: string }> {
  const out = new Map<string, { imageUri: string; digest: string }>();
  for (const image of images) {
    const node = nodeAt(graph, image.service);
    if (!node || !isWorkload(node)) throw new StepFailedError(`An image was supplied for ${safeText(image.service, 80)}, which is not a managed workload of this graph.`);
    if (image.digest !== "" && !SHA256_IMAGE_DIGEST.test(image.digest)) throw new StepFailedError(`The image digest for ${node.address} is not a sha256 digest.`);
    if (typeof image.imageUri !== "string" || image.imageUri.length === 0 || image.imageUri.length > 500 || /\s/.test(image.imageUri)) {
      throw new StepFailedError(`The image reference for ${node.address} is malformed.`);
    }
    out.set(image.service, { imageUri: image.imageUri, digest: image.digest });
  }
  return out;
}

async function buildOne(
  rt: Runtime,
  ec: ExecContext,
  graph: ResourceGraph,
  node: ResourceNode,
  artifact: Extract<ArtifactSpec, { type: "built" }>,
  ctx: ReturnType<typeof driverContext>,
  lease: LeaseRef
): Promise<{ service: string; imageUri: string; digest: string }> {
  const build = rt.d.build;
  const bundler = rt.d.sourceBundle;
  if (!build || !bundler) throw new StepFailedError("No build runner is configured.");
  const pipeline = nodeAt(graph, artifact.pipeline);
  if (!pipeline) throw new StepFailedError(`${node.address} points at build pipeline ${safeText(artifact.pipeline, 80)}, which is not in the graph.`);
  const registry = artifact.registry ? nodeAt(graph, artifact.registry) : undefined;
  const source = (pipeline.spec as unknown as BuildPipelineSpec).source;
  if (!source || typeof source.repo !== "string") throw new StepFailedError(`${artifact.pipeline} has no source repository.`);

  // Admission of the build INPUT: buildpack plans and an invalid or unsupported context directory are refused before any bundle is prepared.
  const contextDir = contextDirFor(node, pipeline);
  const approvedSource=ec.approvedSourceSnapshots?.find(s=>s.serviceAddress===node.address);
  if(!approvedSource) throw new StepFailedError("This build plan has no approved source snapshot; a new operation and review are required.");
  // A non-root context is accepted only when it carries the digest source inspection produced AND that digest re-derives from the approved commit.
  const contextDigest = await admitBuildContext(rt, ec, node, pipeline, approvedSource, contextDir);
  ctx = { ...ctx, ...(rt.d.buildProfile && ["zenith", "kubernetes"].includes(ctx.provider)
    ? { reviewedBuildProfileDigest: rt.d.buildProfile(ctx) } : {}) };
  await assertOperationSemantics(rt, ec, lease, "source custody", ctx.signal);
  const bundle = await bundler.prepare(ctx, { service: node, approvedSource, source: { repo: source.repo, ref: source.ref, ...(source.dockerfile ? { dockerfile: source.dockerfile } : {}) } });
  if(bundle.digest!==approvedSource.archiveDigest)throw new StepFailedError("Prepared build bytes do not match the reviewed source.");
  // Refresh after upload, before requesting a build. This never grants/rebinds source access.
  await bundler.verify!(approvedSource,ctx.signal);
  await rt.d.sourceSnapshots!.assertCurrent(approvedSource);
  await assertOperationSemantics(rt, ec, lease, "isolated build launch", ctx.signal);
  const authority=await rt.d.broker.approvalStatus(ec.op.id);
  if(!authority.approved || authority.rejected || (ec.op.approvalRequired && !authority.approvalId))throw new StepFailedError("Current approval changed before build dispatch.");
  const started = rt.now().getTime();
  const handle = await build.startBuild(ctx, { service: node, pipeline, registry, source: bundle, idempotencyKey: keyOf(ec.op.id, "build", node.address, bundle.digest) });
  const result = await build.waitForBuild(ctx, handle, { timeoutMs: rt.limits.buildTimeoutMs });
  if (result.status !== "succeeded") {
    throw new StepFailedError(`The build of ${node.address} ${result.status.replace("_", " ")}${result.detail ? `: ${safeText(result.detail, 300)}` : ""}.`);
  }
  if (!result.digest || !SHA256_IMAGE_DIGEST.test(result.digest) || !result.imageUri) {
    throw new StepFailedError(`The build of ${node.address} finished without a verifiable image digest, so nothing will be deployed from it.`);
  }
  // The image must be referenced by the digest that was verified, never by a mutable tag.
  const imageUri = result.imageUri.includes("@") ? result.imageUri : `${result.imageUri.replace(/:[^:/]+$/, "")}@${result.digest}`;
  await rt.evidence(
    ec.scope,
    {
      kind: "build",
      digest: digest({ service: node.address, imageUri, digest: result.digest, source: bundle.digest, buildId: handle.buildId }),
      summary: {
        service: node.address,
        pipeline: pipeline.address,
        buildId: safeText(handle.buildId, 120),
        imageUri: safeText(imageUri, 400),
        imageDigest: result.digest,
        sourceDigest: bundle.digest,
        durationMs: rt.now().getTime() - started,
      },
      simulated: false,
      key: `build:${node.address}:${result.digest}`,
    },
    { critical: true }
  );
  // PROD-LIFE-09: isolation check, signed provenance and its evidence are required before this image can be admitted for rollout.
  await recordBuildProvenance(rt, ec, node, pipeline, approvedSource, { imageUri, digest: result.digest, attestation: result.attestation, contextDir, contextDigest });
  rt.log("info", "build finished", { service: node.address });
  return { service: node.address, imageUri, digest: result.digest };
}

/**
 * The compact JWS is stored as its three segments: the evidence store refuses any JWT-shaped
 * string (it cannot tell a signed statement from a leaked credential), so the whole token never
 * appears as one value. Anything that is not exactly three strings fails verification.
 */
const joinJws = (parts: unknown): unknown => (Array.isArray(parts) && parts.length === 3 && parts.every((p) => typeof p === "string") ? parts.join(".") : undefined);

const CONTEXT_DIGEST = /^[a-f0-9]{64}$/;

/** The inspection digest bound to a non-root context directory (never present for the repository root). */
function contextDigestFor(pipeline: ResourceNode, contextDir: string): string | undefined {
  if (contextDir === ".") return undefined;
  const digest = (pipeline.spec as unknown as BuildPipelineSpec).source.contextDigest;
  if (typeof digest !== "string" || !CONTEXT_DIGEST.test(digest)) {
    throw new StepFailedError(`${pipeline.address} builds from the subdirectory ${safeText(contextDir, 80)} without the digest source inspection returns for it, so the build is refused. Inspect the repository (GitHub source) and use its buildSource.contextDir and contextDigest.`);
  }
  return digest;
}

/**
 * LIFE-08 / LIFE-09 join. The context directory is only buildable when it came from source inspection:
 * its digest (repository, approved commit, directory tree, Dockerfile blob) is re-derived through the
 * binding-scoped GitHub access and must equal the one in the spec. A worker without that port refuses.
 */
async function admitBuildContext(rt: Runtime, ec: ExecContext, node: ResourceNode, pipeline: ResourceNode, source: ApprovedSourceSnapshot, contextDir: string): Promise<string | undefined> {
  const digest = contextDigestFor(pipeline, contextDir);
  if (digest === undefined) return undefined;
  if (!rt.d.sourceContext) throw new StepFailedError(`This worker cannot verify the build context of ${node.address}, so a subdirectory build is refused.`);
  const ok = await rt.d.sourceContext({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, repository: `${source.owner}/${source.repo}`, commitSha: source.commitSha, contextDir, dockerfile: source.dockerfile, contextDigest: digest });
  if (!ok) throw new StepFailedError(`The build context ${safeText(contextDir, 80)} of ${node.address} does not match what source inspection reported for the approved commit, so it will not be built.`);
  return digest;
}

/** Validated build context of the pipeline, as a StepFailedError (a definitive, non-retried refusal). */
function contextDirFor(node: ResourceNode, pipeline: ResourceNode): string {
  try {
    return contextDirOf(pipeline.spec as unknown as BuildPipelineSpec, providerOf(node));
  } catch (error) {
    if (error instanceof BuildIsolationError) throw new StepFailedError(`${safeText(error.message, 300)} (${pipeline.address}).`);
    throw error;
  }
}

const buildPolicy = (rt: Runtime) => rt.d.buildIsolation ?? { allowOpenEgress: false };
const providerOf = (node: ResourceNode): BuildProviderKey => {
  if (node.provider !== "aws" && node.provider !== "gcp" && node.provider !== "azure" && node.provider !== "zenith" && node.provider !== "kubernetes") throw new StepFailedError(`Source builds on ${safeText(node.provider, 20)} have no build isolation profile and are refused.`);
  return node.provider;
};

/**
 * PROD-LIFE-09: after a successful build, check the OBSERVED isolation against
 * the provider profile, sign a SLSA-style provenance statement with the
 * control-plane key and retain it as critical build evidence. Nothing is
 * deployed from an artifact whose isolation or provenance cannot be recorded.
 */
async function recordBuildProvenance(
  rt: Runtime,
  ec: ExecContext,
  node: ResourceNode,
  pipeline: ResourceNode,
  source: ApprovedSourceSnapshot,
  built: { imageUri: string; digest: string; attestation: BuildAttestation | undefined; contextDir: string; contextDigest?: string }
): Promise<void> {
  const provider = providerOf(node);
  const authority = rt.d.provenance;
  if (!authority) throw new StepFailedError("This worker has no build provenance signer configured, so built artifacts cannot be released.");
  if (!built.attestation) throw new StepFailedError(`The build of ${node.address} returned no isolation attestation from its provider, so nothing will be deployed from it.`);
  const signer = await authority.signer();
  if (!signer) throw new StepFailedError("The control-plane signing key is not configured, so build provenance cannot be signed.");
  try {
    const { exceptions } = assertBuildIsolation(provider, built.attestation.isolation, buildPolicy(rt));
    const input = {
      workspaceId: ec.workspaceId,
      operationId: ec.op.id,
      environmentId: ec.environmentId,
      provider,
      serviceAddress: node.address,
      pipelineAddress: pipeline.address,
      contextDir: built.contextDir,
      ...(built.contextDigest ? { contextDigest: built.contextDigest } : {}),
      imageName: built.imageUri.replace(/@sha256:[a-f0-9]{64}$/, "").replace(/:[^:/@]+$/, ""),
      imageDigest: built.digest,
      source,
      attestation: built.attestation,
      exceptions,
    };
    const signed = await signBuildProvenance(signer, input, rt.now());
    // Verify what was just signed so a key/pinning mismatch fails here, not at rollout.
    await verifyBuildProvenance(signed.jws, { ...input, policy: buildPolicy(rt) }, await authority.keys());
    const evidence = await rt.evidence(
      ec.scope,
      {
        kind: "build",
        digest: provenanceEvidenceDigest(ec.op.id, node.address, built.digest),
        summary: { kind: "build.provenance", service: node.address, pipeline: pipeline.address, imageDigest: built.digest, sourceDigest: source.archiveDigest, commit: source.commitSha, statementDigest: signed.statementDigest, kid: signed.kid, exceptions, jwsParts: signed.jws.split(".") },
        simulated: false,
        key: `build-provenance:${node.address}:${built.digest}`,
      },
      { critical: true }
    );
    if (!evidence) throw new StepFailedError(`The provenance of ${node.address} could not be recorded, so nothing will be deployed from it.`);
  } catch (error) {
    if (error instanceof BuildIsolationError || error instanceof BuildProvenanceError) throw new StepFailedError(`${safeText(error.message, 300)} Nothing will be deployed from ${node.address}.`);
    throw error;
  }
}

/**
 * PROD-LIFE-09 release admission: a workload built from customer source is only
 * pointed at an image whose signed provenance verifies against pinned keys and
 * binds this operation, this service, the image digest and the reviewed source
 * snapshot, and whose recorded isolation still satisfies the profile.
 */
async function admitBuiltArtifacts(rt: Runtime, ec: ExecContext, graph: ResourceGraph, targets: ResourceNode[], images: Map<string, { imageUri: string; digest: string }>): Promise<Map<string, () => Promise<{ evidenceRef: string }>>> {
  const admissions = new Map<string, () => Promise<{ evidenceRef: string }>>();
  const built = targets.filter((n) => artifactOf(n)?.type === "built");
  if (built.length === 0) return admissions;
  const authority = rt.d.provenance;
  const store = rt.d.sourceSnapshots;
  if (!authority || !isApprovedSourceSnapshotStore(store)) throw new StepFailedError("Built artifacts cannot be admitted: provenance keys or the approved source store are not configured.");
  const sources = await store.list({ workspaceId: ec.workspaceId, operationId: ec.op.id, projectId: ec.product.project.id, environmentId: ec.environmentId });
  const keys = await authority.keys();
  for (const node of built) {
    const artifact = artifactOf(node) as Extract<ArtifactSpec, { type: "built" }>;
    const image = images.get(node.address);
    const source = sources.find((s) => s.serviceAddress === node.address);
    const pipeline = nodeAt(graph, artifact.pipeline);
    if (!image || !SHA256_IMAGE_DIGEST.test(image.digest) || !source || !pipeline) throw new StepFailedError(`${node.address} has no verified built image and reviewed source, so it will not be released.`);
    const record = await rt.d.evidence.find({ workspaceId: ec.workspaceId, operationId: ec.op.id, kind: "build", digest: provenanceEvidenceDigest(ec.op.id, node.address, image.digest) });
    if (!record || record.simulated || record.summary.kind !== "build.provenance") throw new StepFailedError(`${node.address} has no build provenance, so it will not be released.`);
    try {
      await verifyBuildProvenance(
        joinJws(record.summary.jwsParts),
        { workspaceId: ec.workspaceId, operationId: ec.op.id, environmentId: ec.environmentId, provider: providerOf(node), serviceAddress: node.address, pipelineAddress: pipeline.address, contextDir: contextDirFor(node, pipeline), contextDigest: contextDigestFor(pipeline, contextDirFor(node, pipeline)), imageDigest: image.digest, source, policy: buildPolicy(rt) },
        keys
      );
    } catch (error) {
      if (error instanceof BuildIsolationError || error instanceof BuildProvenanceError) throw new StepFailedError(`${safeText(error.message, 300)} ${node.address} will not be released.`);
      throw error;
    }
    // Verified once, above; the release gate reads this result and never re-verifies or contradicts it.
    const verified = { evidenceRef: `evidence:${record.id}` };
    admissions.set(node.address, async () => verified);
  }
  return admissions;
}
