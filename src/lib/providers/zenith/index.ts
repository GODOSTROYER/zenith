/**
 * The Zenith-managed provider (`provider = "zenith"`): fully managed hosting
 * modelled as one more provider behind the portable resource contracts.
 *
 *   substrate       ZENITH_MANAGED_* config: cluster, gateway, domain, registry, storage, database
 *   tenancy         namespace per environment + isolation baseline (pure objects)
 *   isolation       the gate every rendered object passes before it is applied
 *   render / apply  the pipeline: tenancy + workloads + routes; databases; server-side apply
 *   database        ManagedDatabaseProvider port; neon.ts is the one adapter
 *   drivers         the Kubernetes drivers under `zenith`, plus the zenith-specific ones
 *   export          Kubernetes manifest bundle + README: run the same app anywhere
 *
 * Honest status: nobody operates a hosted Zenith cluster. See
 * docs/platform/MANAGED-PLATFORM.md.
 */
export * from "./types";
export * from "./k8s-port";
export * from "./plans";
export * from "./substrate";
export * from "./tenancy";
export * from "./isolation";
export * from "./routing";
export * from "./platform";
export * from "./database";
export * from "./database-factory";
export * from "./database-lifecycle";
export { createNeonProvider, NEON_SIZE_CU, NEON_DATABASE_NAME, NEON_ROLE_NAME, NEON_BRANCH_NAME } from "./neon";
export * from "./render";
export * from "./session";
export * from "./apply";
export * from "./tls";
export * from "./tls-client";
export * from "./tls-lifecycle";
export * from "./teardown";
export * from "./export";
export * from "./drivers";
