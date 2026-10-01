/**
 * Digest image releases use zenith SSA without force. Extract its entire applied
 * set first: a partial apply would remove Zenith's probes, labels and replicas.
 * UID/resourceVersion preconditions prevent writing a replacement or stale object.
 * Contract suites and gated disposable-kind acceptance cover this adapter.
 * Managed cloud acceptance remains separate.
 */
import { ApiException, PatchStrategy, type KubernetesObject } from "@kubernetes/client-node";
import type { WorkloadsPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { extractOwned } from "../fields";
import { conflictsFrom } from "../client";
import { diffPaths, normalizeForDiff } from "../diff";
import { evaluateRollout } from "../rollout";
import { ANNOTATION, FIELD_MANAGER } from "../types";
import { dig, isRecord } from "../util";
import { assertKey, assertPinnedImage, boundedContext, loadWorkload, mainContainer, pause, releaseContext, releaseFailure } from "./support";

export function createWorkloadsPort(): WorkloadsPort {
  return {
    async deployImage(ctx, node, image, opts) {
      try {
        assertKey(opts.idempotencyKey);
        assertPinnedImage(image.uri, image.digest);
        const scoped = releaseContext(ctx);
        let workload = await loadWorkload(scoped, node);
        const originalUid = dig(workload.live, "metadata", "uid");
        for (let attempt = 0; ; attempt++) {
          const { client, live } = workload;
          const body = extractOwned(live, FIELD_MANAGER);
          if (!body || !isRecord(body.metadata)) throw new StepFailedError("Kubernetes workload has no zenith SSA ownership record.");
          const container = mainContainer(node, dig(body, "spec", "template", "spec"));
          const liveContainer = mainContainer(node, dig(live, "spec", "template", "spec"));
          if (liveContainer.image === image.uri) return { detail: "Kubernetes workload already uses the requested image digest." };
          container.image = image.uri;
          body.metadata.uid = dig(live, "metadata", "uid");
          body.metadata.resourceVersion = dig(live, "metadata", "resourceVersion");
          if (scoped.fence) {
            const annotations = isRecord(body.metadata.annotations) ? body.metadata.annotations : {};
            body.metadata.annotations = { ...annotations, [ANNOTATION.fenceToken]: String(scoped.fence.token) };
          }
          try {
            await client.objects.patch(body as KubernetesObject, undefined, undefined, FIELD_MANAGER, false, PatchStrategy.ServerSideApply);
            return { detail: "Kubernetes image digest applied; rollout must reach steady state." };
          } catch (e) {
            // A 409 is a definitive refusal. Retry only controller bookkeeping
            // races, never field conflicts, replacements or changed user fields.
            if (attempt >= 2 || !(e instanceof ApiException) || e.code !== 409 || conflictsFrom(e).length > 0) throw e;
            const fresh = await loadWorkload(scoped, node, client);
            if (dig(fresh.live, "metadata", "uid") !== originalUid ||
                diffPaths(normalizeForDiff(live), normalizeForDiff(fresh.live)).length > 0) throw e;
            workload = fresh;
          }
        }
      } catch (e) { return releaseFailure(e); }
    },
    async waitSteady(ctx, node, opts) {
      const scoped = boundedContext(ctx, opts.timeoutMs);
      let uid: unknown;
      let client;
      try {
        for (;;) {
          const workload = await loadWorkload(scoped, node, client);
          assertPinnedImage(mainContainer(node, dig(workload.live, "spec", "template", "spec")).image);
          client = workload.client;
          const currentUid = dig(workload.live, "metadata", "uid");
          if (uid !== undefined && currentUid !== uid) throw new Error("Kubernetes rollout target changed; outcome is unknown.");
          uid = currentUid;
          const result = evaluateRollout(workload.kind, workload.live);
          const observed = dig(workload.live, "status", "observedGeneration");
          const generation = dig(workload.live, "metadata", "generation");
          if (result.failed) return { steady: false, detail: "Kubernetes rollout exceeded its progress deadline." };
          if (result.done && typeof observed === "number" && typeof generation === "number" && observed >= generation) return { steady: true, detail: "Kubernetes rollout complete." };
          await pause(scoped.signal);
        }
      } catch (e) {
        if (scoped.signal.aborted && !ctx.signal.aborted) return { steady: false, detail: "Kubernetes rollout wait timed out; steady state is unknown." };
        return releaseFailure(e);
      }
    },
  };
}
