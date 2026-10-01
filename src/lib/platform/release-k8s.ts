/** Kubernetes release adapters: pre-built digests only; no in-process or simulated builder. */
import { StepFailedError } from "@/lib/execution/errors";
import type { BuildPort } from "@/lib/execution/ports";
import type { DriverContext } from "@/lib/drivers/types";
import { releaseContext } from "@/lib/providers/kubernetes/release/support";
export { createWorkloadsPort as createKubernetesWorkloadsPort } from "@/lib/providers/kubernetes/release/workloads";
export { createMigrationsPort as createKubernetesMigrationsPort } from "@/lib/providers/kubernetes/release/migrations";

export function createKubernetesBuildPort(): BuildPort {
  const refuse = async (ctx: DriverContext): Promise<never> => {
    releaseContext(ctx);
    throw new StepFailedError("Kubernetes has no configured external builder. Bring a pre-built image pinned by sha256 digest, or inject external build and source ports.");
  };
  return { startBuild: refuse, waitForBuild: refuse };
}
