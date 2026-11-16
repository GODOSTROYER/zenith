/** Runner-only OCI releases; bring pre-built digest-pinned images. No OCI DevOps build is wired. */
import type { BuildPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
export { createWorkloadsPort as createOciWorkloadsPort } from "@/lib/providers/oci/release/workloads";
export { createMigrationsPort as createOciMigrationsPort } from "@/lib/providers/oci/release/migrations";

export function createOciBuildPort(): BuildPort {
  const refuse = async (): Promise<never> => { throw new StepFailedError("OCI source builds are unavailable; bring a pre-built OCIR image pinned to a sha256 digest."); };
  return { startBuild: refuse, waitForBuild: refuse };
}
