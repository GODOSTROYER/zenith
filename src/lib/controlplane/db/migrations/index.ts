/**
 * The ordered list of platform control-store migrations.
 *
 * Append-only. A migration that has shipped is never edited (its checksum is
 * recorded in `platform.schema_migrations` and verified on every open); a change
 * is a new module with the next version number. Versions are contiguous from 1.
 */
import { sha256Hex } from "@/lib/controlplane/digest";
import { migration0001Core } from "./0001_core";
import { migration0002Reconcile } from "./0002_reconcile";
import { migration0003MachineRequests } from "./0003_machine_requests";
import { migration0004ApprovalRounds } from "./0004_approval_rounds";
import { migration0005ReadJobs } from "./0005_read_jobs";
import { migration0006GithubSources } from "./0006_github_sources";
import { migration0007PlanArtifacts } from "./0007_plan_artifacts";
import { migration0008BuildLaunches } from "./0008_build_launches";
import { migration0009GithubRevocation } from "./0009_github_revocation";
import { migration0010GithubDeliveries } from "./0010_github_deliveries";
import { migration0011AgentEffectReceipts } from "./0011_agent_effect_receipts";
import { migration0012WorkflowStartIntents } from "./0012_workflow_start_intents";
import { migration0013ApprovedSourceSnapshots } from "./0013_approved_source_snapshots";
import { migration0014MixedChildIntents } from "./0014_mixed_child_intents";
import { migration0015CleanupWriterBarriers } from "./0015_cleanup_writer_barriers";
import { migration0016CleanupWriterSettlements } from "./0016_cleanup_writer_settlements";
import { migration0017MachineRunbooks } from "./0017_machine_runbooks";
import { migration0018OwnershipTransfers } from "./0018_ownership_transfers";
import { migration0019IncidentStability } from "./0019_incident_stability";
import { migration0020OptimizerSettings } from "./0020_optimizer_settings";
import { migration0021ScheduledJobRuns } from "./0021_scheduled_job_runs";
import { migration0022ConnectionRotations } from "./0022_connection_rotations";
import { migration0023ReleasePipelines } from "./0023_release_pipelines";
import { migration0024Portability } from "./0024_portability";
import { migration0025AgentLifecycle } from "./0025_agent_lifecycle";
import { migration0026PluginBoundaries } from "./0026_plugin_boundaries";
import { migration0027GithubRevocationReason } from "./0027_github_revocation_reason";
import { migration0036CodingAgentRuns } from "./0036_coding_agent_runs";
import { migration0028IncidentStabilityHardening } from "./0028_incident_stability_hardening";
import { migration0029CleanupWriterRecordFields } from "./0029_cleanup_writer_record_fields";
import { migration0030DurableIntentAuthority } from "./0030_durable_intent_authority";
import { migration0031ExecutableSemantics } from "./0031_executable_semantics";
import { migration0032PlanCustodyStateRecovery } from "./0032_plan_custody_state_recovery";
import { migration0033ExternalEffects } from "./0033_external_effects";
import { migration0034K8sGuestBindings } from "./0034_k8s_guest_bindings";
import { migration0035McpStreams } from "./0035_mcp_streams";
import { migration0037ActualSpend } from "./0037_actual_spend";
import { migration0038FairBoundedControlPlane } from "./0038_fair_bounded_control_plane";

// Versions 21-23 belong to sibling wave-2 requirements; the assembler fills them in before 24.

export interface PlatformMigration {
  /** contiguous from 1 */
  version: number;
  name: string;
  /** DDL only; idempotent; may contain many statements */
  sql: string;
}

export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = [migration0001Core, migration0002Reconcile, migration0003MachineRequests, migration0004ApprovalRounds, migration0005ReadJobs, migration0006GithubSources, migration0007PlanArtifacts, migration0008BuildLaunches, migration0009GithubRevocation, migration0010GithubDeliveries, migration0011AgentEffectReceipts, migration0012WorkflowStartIntents, migration0013ApprovedSourceSnapshots, migration0014MixedChildIntents, migration0015CleanupWriterBarriers, migration0016CleanupWriterSettlements, migration0017MachineRunbooks, migration0018OwnershipTransfers, migration0019IncidentStability, migration0020OptimizerSettings, migration0021ScheduledJobRuns, migration0022ConnectionRotations, migration0023ReleasePipelines, migration0024Portability, migration0025AgentLifecycle, migration0026PluginBoundaries, migration0027GithubRevocationReason, migration0028IncidentStabilityHardening, migration0029CleanupWriterRecordFields, migration0030DurableIntentAuthority, migration0031ExecutableSemantics, migration0032PlanCustodyStateRecovery, migration0033ExternalEffects, migration0034K8sGuestBindings, migration0035McpStreams, migration0036CodingAgentRuns, migration0037ActualSpend, migration0038FairBoundedControlPlane];

/** The highest version this build knows. */
export const PLATFORM_SCHEMA_VERSION: number = PLATFORM_MIGRATIONS[PLATFORM_MIGRATIONS.length - 1].version;

/** SHA-256 of the SQL text — what the ledger records and every open verifies. */
export function migrationChecksum(migration: PlatformMigration): string {
  return sha256Hex(migration.sql);
}
