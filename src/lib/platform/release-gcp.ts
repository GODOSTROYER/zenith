/**
 * GCP release ports: consume the C3 GCS source bundle through the injected
 * SourceBundlePort, build in the customer's project, verify an Artifact Registry
 * digest and record it on the Cloud Run template. Built workload images are
 * preserved by the compute drivers' OpenTofu ignore_changes paths.
 * Contract evidence only; no live GCP acceptance run.
 */
export { createBuildPort as createGcpBuildPort } from "@/lib/providers/gcp/release/build";
export { createWorkloadsPort as createGcpWorkloadsPort } from "@/lib/providers/gcp/release/workloads";
export { createMigrationsPort as createGcpMigrationsPort } from "@/lib/providers/gcp/release/migrations";
