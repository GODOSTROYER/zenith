/** GCP release ports. Source acquisition is still an injected SourceBundlePort. */
export { createBuildPort as createGcpBuildPort } from "@/lib/providers/gcp/release/build";
export { createWorkloadsPort as createGcpWorkloadsPort } from "@/lib/providers/gcp/release/workloads";
export { createMigrationsPort as createGcpMigrationsPort } from "@/lib/providers/gcp/release/migrations";
