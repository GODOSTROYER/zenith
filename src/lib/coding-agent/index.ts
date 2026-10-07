/**
 * Bounded, evaluated coding agents (PROD-MACH-06).
 *
 *   runAgent            the budgeted, checkpointed loop over fixed read-only tools
 *   createRun/resumeRun/cancelRun  control half the REST routes call (record + launch)
 *   executeRunStep      worker half: one durable step from the stored checkpoint (Temporal activity)
 *   runEval             the fixed task/unsafe/recovery evaluation set and report
 *
 * Model output is only ever a proposal artifact; the capability broker, policy
 * and approvals decide everything after it.
 */
export * from "./budget";
export * from "./types";
export { runAgent, pendingToolUses, MAX_UNSAFE_ATTEMPTS, type ProposalSink, type RunAgentInput, type RunOutcome } from "./runner";
export { createRun, resumeRun, cancelRun, executeRunStep, failRunStep, AgentServiceError, type AgentControlDeps, type AgentWorkerDeps, type RunLauncher } from "./service";
export { createBrokerProposalSink, assertAdoptable, AdoptionRefused } from "./proposal-sink";
export { anthropicProvider, anthropicKeyPresent } from "./anthropic";
export { runEval, skippedReport } from "./eval/harness";
