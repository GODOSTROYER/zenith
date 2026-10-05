/**
 * Execution: the real activities of the deploy journey (WS-ACT).
 *
 *   createExecutionActivities(deps)   the activities behind `ExecutionActivities` (+ reconcileObserve)
 *   createPlatformPorts(sql)          platform-store ports over the merged control store
 *   createProductPort()               product-store port (Deployment projection) over `@/lib/db/store`
 *   createSafeProber()                SSRF-safe HTTP prober for verifyApplication
 *   defaultCostPort()                 cost port over the placement cost engine
 *
 * See `ports.ts` for every dependency and which implementation backs it.
 */
export { createExecutionActivities, type ExecutionWorkerActivities } from "./activities";
export { createDestroyActivities } from "./destroy";
export type { DestroyActivities, DestroyWorkflowInput } from "@/lib/workflows/definitions/destroy";
export { defaultCostPort } from "./cost";
export { createPlatformPorts, createOperationsPort, createLeasesPort, createEventsPort, createEvidencePort, createResourcesPort, createConnectionsPort, createPortabilityPort, executionHolder, CLAIM_LEASE_MS, type PlatformPorts } from "./platform";
export { createProductPort, workerStoreScope, ProductNotFoundError, type StoreScope } from "./product-port";
export { createSafeProber, httpsTransport, isPublicAddress, ProbeTransportError, PROBE_MAX_BODY_BYTES, PROBE_TIMEOUT_MS, type ProbeTransport, type SafeProberOptions } from "./prober";
export { LeaseBusyError, LeaseLostError, StepFailedError, TofuPlanChangedError } from "./errors";
export { DEFAULT_LIMITS } from "./ports";
export type * from "./ports";
