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

export interface PlatformMigration {
  /** contiguous from 1 */
  version: number;
  name: string;
  /** DDL only; idempotent; may contain many statements */
  sql: string;
}

export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = [migration0001Core, migration0002Reconcile, migration0003MachineRequests, migration0004ApprovalRounds, migration0005ReadJobs, migration0006GithubSources, migration0007PlanArtifacts, migration0008BuildLaunches];

/** The highest version this build knows. */
export const PLATFORM_SCHEMA_VERSION: number = PLATFORM_MIGRATIONS[PLATFORM_MIGRATIONS.length - 1].version;

/** SHA-256 of the SQL text — what the ledger records and every open verifies. */
export function migrationChecksum(migration: PlatformMigration): string {
  return sha256Hex(migration.sql);
}
