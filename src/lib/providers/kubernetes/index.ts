/**
 * Kubernetes provider (ADR-0015): pure rendering, server-side apply with
 * explicit ownership, resource drivers and day-two operations.
 *
 * Execution-worker wiring, in order:
 *   1. `createKubernetesSession(config, { resolveCredential, eksToken })`
 *   2. `renderGraph(nodes, { environmentId, … })`          → objects, notes
 *   3. `diff(objects, session, opts)`                       → plan view (paths only)
 *   4. `serverSideApply(objects, session, { resolveSecret }`)
 *   5. `waitForRollout(target, session)`; on failure `rollback(target, session, …)`
 *   6. `pruneOrphans({ desired: objects, environmentId, namespaces }, session)`
 * Reads and day-two operations go through the registered drivers.
 */
export * from "./types";
export * from "./naming";
export { createKubernetesSession, sessionFromKubeConfig, sessionNamespaces, validateServerUrl, type KubernetesSessionDeps, type ScopedKubernetesSession } from "./session";
export { renderObjects, renderNode, renderGraph, applyOrder, RENDERABLE_KINDS } from "./render";
export { serverSideApply, diff, pruneOrphans, waitForRollout, rollback } from "./apply";
export type { ApplyOptions, DiffItem, PruneInput, PruneReport, RollbackOptions, RollbackResult, RolloutOptions, RolloutResult, SecretResolver } from "./apply";
export { generatedCredentialRef, credentialsSecretName, dataVolumeName } from "./renderers/data";
export { kubernetesDrivers, driversFor, registerKubernetesDrivers, registerZenithManagedDrivers } from "./drivers";
export { targetFor, externalIdFor, parseExternalId } from "./target";
export { teardownKubernetesEnvironment, type KubernetesTeardownInput, type KubernetesTeardownReport } from "./teardown";
export { rollbackStatefulSet } from "./rollout";
export { detectPolicyEngine, type PolicyEngineReading } from "./cni";
export { detectSnapshotSupport, snapshotData, restoreData, chooseSnapshotClass, type SnapshotSupport, type SnapshotClassInfo } from "./snapshots";
export { immutableViolations } from "./immutability";
