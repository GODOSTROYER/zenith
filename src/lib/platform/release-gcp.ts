/**
 * GCP release ports: consume the C3 GCS source bundle through the injected
 * SourceBundlePort, build in the customer's project, verify an Artifact Registry
 * digest and record it on the Cloud Run template. Built workload images are
 * preserved by the compute drivers' OpenTofu ignore_changes paths.
 * Contract evidence only; no live GCP acceptance run.
 */
export { createBuildPort as createGcpBuildPort } from "@/lib/providers/gcp/release/build";
import type { WorkloadsPort } from "@/lib/execution/ports";
import { createWorkloadsPort } from "@/lib/providers/gcp/release/workloads";
import { createGcpProgressivePort, createGcpReadServing } from "@/lib/providers/gcp/release/traffic";
/** Cloud Run: digest rollout, serving-digest readback and weighted (canary) traffic. */
export const createGcpWorkloadsPort = (): WorkloadsPort => ({ ...createWorkloadsPort(), readServing: createGcpReadServing(), progressive: createGcpProgressivePort() });
export { createMigrationsPort as createGcpMigrationsPort } from "@/lib/providers/gcp/release/migrations";
