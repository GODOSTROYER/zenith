/**
 * OCI cannot update a Container Instance's image in place: UpdateContainer and
 * UpdateContainerInstance accept names/tags only. OpenTofu owns replacements and
 * load-balancer targets. This port verifies manifest-pinned images through the
 * runner, then waits for every replica to be ACTIVE. No live acceptance claimed.
 */
import type { WorkloadsPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { container, id, instance, instances, liveWorkloads, pause, releaseContext, timeoutSignal, workload } from "./support";

export function createWorkloadsPort(): WorkloadsPort {
  return {
    async deployImage(ctx, node, image) {
      const oci = releaseContext(ctx);
      const desired = workload(oci, node);
      if (desired.image !== image.uri || image.digest !== image.uri.split("@").at(-1)) {
        throw new StepFailedError("OCI images are immutable; pin this image digest in the manifest and apply the reviewed OpenTofu replacement.");
      }
      const bounded = { ...oci, signal: timeoutSignal(oci, 60_000) };
      const found = liveWorkloads(bounded, await instances(bounded), node);
      if (found.length !== desired.replicas) throw new Error("OCI release replica count does not match; outcome is unknown.");
      for (const summary of found) {
        const full = await instance(bounded, id(summary.id, "computecontainerinstance"), node.address);
        await container(bounded, full, desired.image);
      }
      return { detail: "Verified the manifest's image digest applied by OpenTofu; waiting for OCI Container Instances to become ACTIVE." };
    },
    async waitSteady(ctx, node, opts) {
      const oci = releaseContext(ctx);
      const desired = workload(oci, node);
      const bounded = { ...oci, signal: timeoutSignal(oci, opts.timeoutMs) };
      try {
        for (;;) {
          const found = liveWorkloads(bounded, await instances(bounded), node);
          if (new Set(found.map((item) => item.id)).size !== found.length) throw new Error();
          if (found.some((item) => ["FAILED", "DELETING"].includes(String(item.lifecycleState)))) {
            return { steady: false, detail: "OCI workload has a failed or deleting instance." };
          }
          let ready = found.length === desired.replicas;
          for (const summary of found) {
            const full = await instance(bounded, id(summary.id, "computecontainerinstance"), node.address);
            const c = await container(bounded, full, desired.image);
            if (full.lifecycleState !== "ACTIVE" || c.lifecycleState !== "ACTIVE") ready = false;
          }
          if (ready) return { steady: true, detail: "Every expected OCI instance and container is ACTIVE at the manifest image digest." };
          await pause(bounded.signal);
        }
      } catch {
        return { steady: false, detail: "OCI workload state is unknown, cancelled or timed out." };
      }
    },
  };
}
