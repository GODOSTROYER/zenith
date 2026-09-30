/**
 * Capability broker public surface (ADR-0007). Import from `@/lib/capabilities`.
 *
 *   vocabulary        ./catalog            the capability names and `CapabilityRequest`
 *   the broker        ./broker             propose · check · authorizeRead
 *                     ./approvals          approve · reject · revokeApproval
 *                     ./execution          beginExecution · completeExecution · markUncertain
 *                     ./operations         read / list / cancel operations
 *                     ./autonomy           per-environment autonomy 0–5
 *                     ./policy-settings    workspace policy parameters
 *   ports             ./ports              BrokerStore · ScopeResolver · RoleResolver · GrantSigner · Clock
 *   implementations   ./memory-store       MemoryBrokerStore (tests / local dev only)
 *                     ./grant-signer       JoseGrantSigner (replaceable)
 *                     ./product-adapters   product-store ScopeResolver / RoleResolver
 *   wiring            ./platform           createBroker · platformBroker · registerPlatformBrokerStore
 *   product bridge    ./action-bridge      checkActionThroughBroker (not wired into runAction)
 *
 * Importing this barrel pulls in the product store (through `product-adapters`).
 * Code that only needs the broker logic (tests, the workflow activities) should
 * import the specific modules instead.
 */
export * from "./catalog";
export * from "./errors";
export * from "./types";
export * from "./ports";
export { propose, check, authorizeRead, parseRequest, READ_GRANT_DEFAULT_SEC, READ_GRANT_MAX_SEC, READ_EVENT_WINDOW_MS } from "./broker";
export { approve, reject, revokeApproval, isStricter, type ApprovalOutcome, type DecideInput } from "./approvals";
export {
  beginExecution,
  completeExecution,
  markUncertain,
  EXECUTION_GRANT_DEFAULT_SEC,
  EXECUTION_GRANT_MAX_SEC,
  type BeginExecutionInput,
  type BeginExecutionResult,
  type CompleteExecutionInput,
} from "./execution";
export { cancelOperation, getOperationDetail, listOperations, listOperationEvents, type OperationDetail, type EventView } from "./operations";
export {
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY_BY_CLASS,
  defaultAutonomyFor,
  describeAutonomy,
  effectiveAutonomy,
  getEnvironmentAutonomy,
  isAutonomyLevel,
  levelFromNavigator,
  navigatorFromLevel,
  setEnvironmentAutonomy,
  type AutonomyDescription,
  type AutonomyView,
  type EffectiveAutonomy,
} from "./autonomy";
export { getWorkspacePolicy, setWorkspacePolicy, type WorkspacePolicyView } from "./policy-settings";
export { evaluate, applyGuards, buildPlanFacts, raiseRisk, originFor, type Evaluation, type EvaluationRequest } from "./evaluate";
export { MemoryBrokerStore } from "./memory-store";
export { JoseGrantSigner, verifyGrantJws, GRANT_TYP, MAX_GRANT_LIFETIME_SEC, SIGNING_JWK_ENV } from "./grant-signer";
export { productRoleResolver, productScopeResolver, credentialDirectory, type IntegrationDirectory, type IntegrationGrant } from "./product-adapters";
export { ACTION_CAPABILITY_MAP, checkActionThroughBroker, mappingFor, principalFromAction, type ActionMapping, type BridgeResult } from "./action-bridge";
export { findSecret, scrubSecrets } from "./secret-guard";
export { operationView, decisionView } from "./views";
export {
  createBroker,
  platformBroker,
  registerPlatformBrokerPorts,
  registerPlatformBrokerStore,
  resetPlatformBrokerForTests,
  setPlatformBrokerForTests,
  isMemoryStoreEnabled,
  MEMORY_STORE_ENV,
  type Broker,
} from "./platform";
