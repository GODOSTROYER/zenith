/**
 * Bounded, evaluated coding agents (PROD-MACH-06).
 *
 *   runAgent            the budgeted, checkpointed loop over fixed read-only tools
 *   startRun/resumeRun  the service the REST routes call (store + source + broker)
 *   runEval             the fixed task/unsafe/recovery evaluation set and report
 *
 * Model output is only ever a proposal artifact; the capability broker, policy
 * and approvals decide everything after it.
 */
export * from "./budget";
export * from "./types";
export { runAgent, pendingToolUses, MAX_UNSAFE_ATTEMPTS, type ProposalSink, type RunAgentInput, type RunOutcome } from "./runner";
export { startRun, resumeRun, AgentServiceError, type AgentServiceDeps } from "./service";
export { createBrokerProposalSink, assertAdoptable, AdoptionRefused } from "./proposal-sink";
export { anthropicProvider, anthropicKeyPresent } from "./anthropic";
export { runEval, skippedReport } from "./eval/harness";
