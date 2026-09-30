/**
 * Policy engine public surface (ADR-0008). Import from `@/lib/policy`.
 *
 *   - contract types                       ./types
 *   - resolving workspace parameters       ./defaults
 *   - plan -> facts                        ./plan-facts
 *   - evaluating a request                 ./engine   (loads policy/dist/policy.wasm)
 */
export type {
  AutonomyLevel,
  EnvironmentClass,
  EvaluatedPolicy,
  PlanFacts,
  PolicyDecision,
  PolicyEngine,
  PolicyInput,
  WorkspacePolicyParams,
} from "./types";
export { DEFAULT_WORKSPACE_POLICY, PolicyConfigError, resolveWorkspacePolicy, type WorkspacePolicyOverrides } from "./defaults";
export { extractPlanFacts } from "./plan-facts";
export {
  createPolicyEngine,
  loadPolicyEngine,
  PolicyLoadError,
  policyWasmPath,
  POLICY_ENTRYPOINT,
  resetPolicyEngineCache,
  type WasmPolicy,
} from "./engine";
export { PolicyDecisionSchema, PolicyInputSchema, WorkspacePolicyParamsSchema } from "./schema";
