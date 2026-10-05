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

export interface PlatformMigration {
  /** contiguous from 1 */
  version: number;
  name: string;
  /** DDL only; idempotent; may contain many statements */
  sql: string;
}

export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = [migration0001Core, migration0002Reconcile, migration0003MachineRequests, migration0004ApprovalRounds, migration0005ReadJobs, migration0006GithubSources, migration0007PlanArtifacts, migration0008BuildLaunches, migration0009GithubRevocation, migration0010GithubDeliveries, migration0011AgentEffectReceipts, migration0012WorkflowStartIntents, migration0013ApprovedSourceSnapshots, migration0014MixedChildIntents, migration0015CleanupWriterBarriers, migration0016CleanupWriterSettlements];

/** The highest version this build knows. */
export const PLATFORM_SCHEMA_VERSION: number = PLATFORM_MIGRATIONS[PLATFORM_MIGRATIONS.length - 1].version;

/** SHA-256 of the SQL text — what the ledger records and every open verifies. */
export function migrationChecksum(migration: PlatformMigration): string {
  return sha256Hex(migration.sql);
}
