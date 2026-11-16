/**
 * Field ownership, one door: `@/lib/ownership` (PROD-LIFE-12).
 *
 *   types       FieldOwner, rules, transfers, writes, conflicts
 *   registry    FieldOwnershipRegistry, default rules, transfer digests
 *   facts       autoscaled / release-managed facts from the graph
 *   conflicts   evaluateWrite, native-operation and plan enforcement
 *   drift       ownership-aware drift classification
 *   lifecycle   ignore_changes generation
 *
 * Pure (L0): no fs, no env, no store. Consumers (e.g. cost optimization) call
 * `resolveFieldOwner` / `evaluateWrite` before proposing any field change.
 */
import { defaultFieldOwnershipRegistry } from "./registry";
import type { FieldOwnerResolution, FieldQuery, OwnershipTransfer } from "./types";

export * from "./types";
export { normalizePath, pathCovers } from "./paths";
export {
  DEFAULT_OWNERSHIP_RULES,
  FieldOwnershipRegistry,
  OwnershipRegistrationError,
  defaultFieldOwnershipRegistry,
  transferDigest,
  transferRequest,
} from "./registry";
export { AUTOSCALER_NATIVE_TYPES, autoscaledAddresses, factsByAddress, factsForNode } from "./facts";
export {
  FieldOwnershipConflictError,
  NATIVE_OPERATION_WRITES,
  assertNativeOperationAllowed,
  assertPlanFieldOwnership,
  blocking,
  checkNativeOperation,
  checkPlanFieldOwnership,
  driftRepairWrites,
  evaluateWrite,
  type EnforcementOptions,
  type NativeOperationCheck,
  type NativeOperationWrite,
  type PlanOwnershipOptions,
} from "./conflicts";
export { applyFieldOwnership, classifyDrift, type OwnedDriftClass, type OwnedDriftField, type OwnedDriftFinding, type OwnershipDriftOptions } from "./drift";
export { ignoreChangesFor, lifecycleIgnoreChanges, mergeIgnoreChanges, type IgnoreChangesInput } from "./lifecycle";

/** Who owns this field right now, on the default registry. */
export function resolveFieldOwner(query: FieldQuery, opts?: { transfers?: readonly OwnershipTransfer[]; now?: Date }): FieldOwnerResolution {
  return defaultFieldOwnershipRegistry.resolve(query, opts);
}
