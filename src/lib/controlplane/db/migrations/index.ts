/**
 * The ordered list of platform control-store migrations.
 *
 * Append-only. A migration that has shipped is never edited (its checksum is
 * recorded in `platform.schema_migrations` and verified on every open); a change
 * is a new module with the next version number. Versions are contiguous from 1.
 */
import { sha256Hex } from "@/lib/controlplane/digest";
import { migration0001Core } from "./0001_core";

export interface PlatformMigration {
  /** contiguous from 1 */
  version: number;
  name: string;
  /** DDL only; idempotent; may contain many statements */
  sql: string;
}

export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = [migration0001Core];

/** The highest version this build knows. */
export const PLATFORM_SCHEMA_VERSION: number = PLATFORM_MIGRATIONS[PLATFORM_MIGRATIONS.length - 1].version;

/** SHA-256 of the SQL text — what the ledger records and every open verifies. */
export function migrationChecksum(migration: PlatformMigration): string {
  return sha256Hex(migration.sql);
}
