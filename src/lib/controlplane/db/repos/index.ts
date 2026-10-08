/**
 * The repositories, as one namespace per table family.
 *
 * Every row repository function takes a `Sql` as its first argument, so they
 * compose inside one transaction:
 *
 *     await db.tx(async (tx) => {
 *       const lease = await leases.assertFence(tx, scope, fence);
 *       const op = await operations.transition(tx, { … });
 *       await events.append(tx, { … });
 *     });
 *
 * `bindRepos(sql)` returns the same functions with `sql` pre-applied, for code
 * that wants `repos.operations.get(ws, id)` instead of threading the argument.
 * Bind to the `tx` you were handed, not to the top-level handle, when the calls
 * must commit together.
 *
 * Scoped capability constructors and provenance predicates are exposed by
 * their module, but excluded from bindRepos at runtime and in its return type.
 */
import type { Sql } from "@/lib/controlplane/types";
import * as planArtifacts from "./plan-artifacts";
import * as planCustody from "./plan-custody";
import * as stateBackendRecovery from "./state-backend-recovery";
import * as cleanupWriterBarriers from "./cleanup-writer-barriers";
import * as mixedChildIntents from "./mixed-child-intents";
import * as buildLaunches from "./build-launches";
import * as workflowStartIntents from "./workflow-start-intents";
import * as approvedSourceSnapshots from "./approved-source-snapshots";
import * as approvals from "./approvals";
import * as connections from "./connections";
import * as connectionRotations from "./connection-rotations";
import * as cost from "./cost";
import * as actualSpend from "./actual-spend";
import * as drift from "./drift";
import * as events from "./events";
import * as evidence from "./evidence";
import * as grants from "./grants";
import * as idempotency from "./idempotency";
import * as incidents from "./incidents";
import * as incidentStability from "./incident-stability";
import * as jobs from "./jobs";
import * as leases from "./leases";
import * as machines from "./machines";
import * as nonces from "./nonces";
import * as observations from "./observations";
import * as operations from "./operations";
import * as ownershipTransfers from "./ownership-transfers";
import * as portability from "./portability";
import * as operationExecution from "./operations-execution";
import * as policyDecisions from "./policy-decisions";
import * as resources from "./resources";
import * as runners from "./runners";
import * as settings from "./settings";
import * as optimizerSettings from "./optimizer-settings";
import * as workspaceMfaControls from "./workspace-mfa-controls";
import * as scheduledJobs from "./scheduled-jobs";
import * as plugins from "./plugins";
import * as externalEffects from "./external-effects";
import * as k8sGuestBindings from "./k8s-guest-bindings";
import * as mcpStreams from "./mcp-streams";
import * as codingAgentRuns from "./coding-agent-runs";
import * as mixedParentPlans from "./mixed-parent-plans";
import * as mixedRuns from "./mixed-runs";
import * as mixedOutputPreauthorizations from "./mixed-output-preauthorizations";

export {
  planArtifacts,
  planCustody,
  stateBackendRecovery,
  cleanupWriterBarriers,
  mixedChildIntents,
  buildLaunches,
  workflowStartIntents,
  approvedSourceSnapshots,
  approvals,
  connections,
  connectionRotations,
  cost,
  actualSpend,
  drift,
  events,
  evidence,
  grants,
  idempotency,
  incidents,
  incidentStability,
  jobs,
  leases,
  machines,
  nonces,
  observations,
  operations,
  ownershipTransfers,
  portability,
  operationExecution,
  policyDecisions,
  resources,
  runners,
  settings,
  optimizerSettings,
  workspaceMfaControls,
  codingAgentRuns,
  mixedRuns,
  mixedOutputPreauthorizations,
  scheduledJobs,
  plugins,
  externalEffects,
  k8sGuestBindings,
  mcpStreams,
  mixedParentPlans,
};

type CapabilityConstructor = "createApprovedSourceSnapshotStore" | "isApprovedSourceSnapshotStore" | "createIsolatedApprovedSourceStoreForTests" | "reserveOwnerGrant" | "insertOwnerGrant" | "inventory" | "retainCleanupWriterHold" | "reserveCleanupOwnerGrant" | "insertCleanupOwnerGrant";

/** A module whose SQL row functions take `Sql` first, rewritten to omit it. */
export type Bound<M> = {
  [K in keyof M as K extends CapabilityConstructor ? never : M[K] extends (sql: Sql, ...args: never[]) => unknown ? K : never]: M[K] extends (sql: Sql, ...args: infer A) => infer R
    ? (...args: A) => R
    : never;
};

/** Exports that are pure helpers, not repository functions: they take no `Sql`. */
const PURE_HELPERS = new Set(["toOperation", "generateRegistrationToken", "hashRegistrationToken", "PlanArtifactError", "captureArtifactAccess", "BuildLaunchError", "createIsolatedBuildClaimerForTests", "assertIsolatedBuildTestAdmission", "WorkflowStartIntentError", "snapshotWorkflowArguments", "createIsolatedStartIntentStoreForTests", "MixedChildAdmissionError", "CleanupWriterBarrierError", "PlanCustodyError", "StateRecoveryRecordError", "restoreProposalDigest"]);
/** Capability construction/provenance is never an automatically bound row API. */
const CAPABILITY_CONSTRUCTORS = new Set(["createApprovedSourceSnapshotStore", "isApprovedSourceSnapshotStore", "createIsolatedApprovedSourceStoreForTests", "reserveOwnerGrant", "insertOwnerGrant", "inventory", "retainCleanupWriterHold", "reserveCleanupOwnerGrant", "insertCleanupOwnerGrant"]);

function bind<M extends object>(mod: M, sql: Sql): Bound<M> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function" && !PURE_HELPERS.has(name) && !CAPABILITY_CONSTRUCTORS.has(name)) out[name] = (...args: unknown[]) => (value as (...a: unknown[]) => unknown)(sql, ...args);
  }
  return out as Bound<M>;
}

export function bindRepos(sql: Sql) {
  return {
    planArtifacts: bind(planArtifacts, sql),
    planCustody: bind(planCustody, sql),
    stateBackendRecovery: bind(stateBackendRecovery, sql),
    cleanupWriterBarriers: bind({preview:cleanupWriterBarriers.preview}, sql),
    mixedChildIntents: bind(mixedChildIntents, sql),
    buildLaunches: bind(buildLaunches, sql),
    workflowStartIntents: bind(workflowStartIntents, sql),
    approvedSourceSnapshots: bind(approvedSourceSnapshots, sql),
    approvals: bind(approvals, sql),
    connections: bind(connections, sql),
    connectionRotations: bind(connectionRotations, sql),
    cost: bind(cost, sql),
    actualSpend: bind(actualSpend, sql),
    drift: bind(drift, sql),
    events: bind(events, sql),
    evidence: bind(evidence, sql),
    grants: bind(grants, sql),
    idempotency: bind(idempotency, sql),
    incidents: bind(incidents, sql),
    incidentStability: bind(incidentStability, sql),
    jobs: bind(jobs, sql),
    leases: bind(leases, sql),
    machines: bind(machines, sql),
    nonces: bind(nonces, sql),
    observations: bind(observations, sql),
    operations: bind(operations, sql),
    ownershipTransfers: bind(ownershipTransfers, sql),
    portability: bind(portability, sql),
    operationExecution: bind(operationExecution, sql),
    policyDecisions: bind(policyDecisions, sql),
    resources: bind(resources, sql),
    runners: bind(runners, sql),
    settings: bind(settings, sql),
    optimizerSettings: bind(optimizerSettings, sql),
    workspaceMfaControls: bind(workspaceMfaControls, sql),
    scheduledJobs: bind(scheduledJobs, sql),
    plugins: bind(plugins, sql),
    externalEffects: bind(externalEffects, sql),
    k8sGuestBindings: bind(k8sGuestBindings, sql),
    mcpStreams: bind(mcpStreams, sql),
    codingAgentRuns: bind(codingAgentRuns, sql),
    mixedParentPlans: bind(mixedParentPlans, sql),
    mixedRuns: bind(mixedRuns, sql),
    mixedOutputPreauthorizations: bind(mixedOutputPreauthorizations, sql),
  };
}

export type PlatformRepos = ReturnType<typeof bindRepos>;
