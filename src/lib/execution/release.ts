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
import type { ExecutionActivities } from "@/lib/workflows/types";
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
import { syncEnvironmentSecrets } from "./secrets";

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
      const needsBuild = workloads.some((n) => artifactOf(n)?.type === "built");
      if (needsBuild && (!rt.d.build || !rt.d.sourceBundle)) {
        throw new StepFailedError("This worker has no build runner or source bundler configured, so services with a git source cannot be built. Pin an image or configure the build ports.");
      }
      const connection = await resolveConnection(rt, ec);

      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      const images = await withKeepAlive(rt, { lease, detail: "build artifacts", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
        withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
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
              return await buildOne(rt, ec, graph, node, artifact, ctx);
            } catch (error) { failures.push(error); return undefined; }
          });
          if (failures.length) throw failures.find(error => !(error instanceof StepFailedError)) ?? failures[0];
          return built.filter((result): result is NonNullable<typeof result> => result !== undefined);
        }
        )
      );
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
      const connection = await resolveConnection(rt, ec);

      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      const rolled = await withKeepAlive(rt, { lease, detail: "deploy workloads", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
        await syncEnvironmentSecrets(rt, ec, graph, connection, lease, signal);
        if (!targets.length) return { done: 0, pinned: 0 };
        return withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
          let done = 0;
          let pinned = 0;
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
      if (!migrate) return { ran: false, detail: "no migration declared" };
      const { graph } = requireExecutable(rt, ec);
      const service = nodeAt(graph, `container_service/${migrate.service}`) ?? nodeAt(graph, `scheduled_job/${migrate.service}`);
      if (!service || service.ownership !== "managed") {
        throw new StepFailedError(`The migration names service "${safeText(migrate.service, 40)}", which is not a managed workload of this graph.`);
      }
      const migrations = rt.d.migrations;
      if (!migrations) throw new StepFailedError("This worker has no one-off task runner configured; the declared migration cannot run.");
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
      if (result.exitCode !== 0) {
        throw new StepFailedError(`The migration task exited with code ${result.exitCode}; the database may be partially migrated. Nothing was rolled back; reconcile will observe and a new operation decides.`);
      }
      return { ran: true, detail: safeText(`migration on ${migrate.service} exited 0${result.logsRef ? ` (logs ${result.logsRef})` : ""}`, 300) };
    },
  };
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
  ctx: ReturnType<typeof driverContext>
): Promise<{ service: string; imageUri: string; digest: string }> {
  const build = rt.d.build;
  const bundler = rt.d.sourceBundle;
  if (!build || !bundler) throw new StepFailedError("No build runner is configured.");
  const pipeline = nodeAt(graph, artifact.pipeline);
  if (!pipeline) throw new StepFailedError(`${node.address} points at build pipeline ${safeText(artifact.pipeline, 80)}, which is not in the graph.`);
  const registry = artifact.registry ? nodeAt(graph, artifact.registry) : undefined;
  const source = (pipeline.spec as unknown as BuildPipelineSpec).source;
  if (!source || typeof source.repo !== "string") throw new StepFailedError(`${artifact.pipeline} has no source repository.`);

  const bundle = await bundler.prepare(ctx, { service: node, source: { repo: source.repo, ref: source.ref, ...(source.dockerfile ? { dockerfile: source.dockerfile } : {}) } });
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
  rt.log("info", "build finished", { service: node.address });
  return { service: node.address, imageUri, digest: result.digest };
}
