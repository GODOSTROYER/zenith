/**
 * Signed automation and scheduling for machines (PROD-MACH-03).
 *
 *   definition  versioned runbooks of semantic machine operations; classification by operation
 *   signing     control-plane EdDSA signature binding workspace, runbook, version, definition digest
 *   policy      run-level gate and approval binding to the exact immutable effect
 *   schedule    UTC windows, bounded cadence, slot decisions (never late, never past the window)
 *   service     publish / request / approve / cancel / schedule / durable tick
 *   runner      step-by-step execution with at-most-once custody, cancellation and deadline
 *
 * Raw `machine.exec` / `container.exec` remain the approved high-risk escape hatch. Nothing
 * here classifies a command line as safe, and argv validation is not presented as a sandbox.
 */
export * from "./definition";
export * from "./signing";
export * from "./policy";
export * from "./schedule";
export * from "./audit";
export * from "./ports";
export { MemoryRunbookStore } from "./memory-store";
export { createRunbookService, type RunbookAction, type RunbookService, type RunbookServiceDeps, type RunRequestInput } from "./service";
export { executeRunbookRun, createMachineStepExecutor, stepOperationId, type RunbookRunnerDeps, type RunbookStepContext, type RunbookStepExecutor, type MachineStepExecutorDeps, type StepGrant } from "./runner";
