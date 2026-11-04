/**
 * Public surface of the OpenTofu engine (ADR-0005). Everything a caller needs
 * to go graph fragments → pinned workspace → plan → digest-verified apply.
 */
export * from "@/lib/tofu/types";
export { PROVIDER_PINS, PROVIDER_SET_NAMES, PROVIDER_SET_PROVIDERS, LOCK_PLATFORMS, requiredProviders, type ProviderLocalName, type ProviderSetName, type ProviderSetSpec } from "@/lib/tofu/providers";
export { LOCKFILES } from "@/lib/tofu/locks.generated";
export { assembleWorkspace, assertWorkspaceIntact, configDigestOf, lockDigestOf, resolveProviderSet, TofuWorkspaceError, type AssembleWorkspaceInput, type BackendConfig } from "@/lib/tofu/workspace";
export { DEFAULT_STATEFUL_TYPES, normalizePlan, parseShowJson, planView, TofuPlanFormatError, type NormalizePlanOptions, type PlanDiagnostic, type PlanView, type ShowJson } from "@/lib/tofu/plan";
export { TofuCommandError, TofuRun, TofuRunner, type TofuRunContext, type TofuRunnerOptions, type TofuSessionEnv } from "@/lib/tofu/runner";
export { TofuBinaryError, checkTofuVersion, resolveTofuBinary } from "@/lib/tofu/binary";
export { applyVerifiedPlan, planWorkspace, type ApplyVerifiedResult, type EngineOptions, type PlanWorkspaceOptions, type PlanWorkspaceResult } from "@/lib/tofu/engine";
export { redactOutput } from "@/lib/tofu/redact";
export { backendForConnection } from "@/lib/tofu/backends";
