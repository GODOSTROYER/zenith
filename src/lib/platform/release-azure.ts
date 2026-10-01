/** Azure release ports: source acquisition and durable launch receipts are injected, never simulated by default. */
export { createBuildPort as createAzureBuildPort, type AzureBuildOptions } from "@/lib/providers/azure/release/build";
export { createWorkloadsPort as createAzureWorkloadsPort } from "@/lib/providers/azure/release/workloads";
export { createMigrationsPort as createAzureMigrationsPort } from "@/lib/providers/azure/release/migrations";
export type { LaunchJournal as AzureReleaseLaunchJournal, LaunchScope as AzureReleaseLaunchScope } from "@/lib/providers/azure/release/support";
export { createLaunchJournal as createAzureReleaseLaunchJournal } from "@/lib/providers/azure/release/journal";
