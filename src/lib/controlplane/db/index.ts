/**
 * The platform control store (ADR-0002): the fifth state authority.
 *
 * One SQL dialect — PostgreSQL — on real Postgres (production) and PGlite
 * (local development and tests). Import from here:
 *
 *     import { platformDb, repos } from "@/lib/controlplane/db";
 *     const db = await platformDb();
 *     await db.tx(async (tx) => { await repos.operations.create(tx, { … }); });
 */
export * from "./errors";
export { createPlatformDbHandle, normalizeParams, normalizeRows, normalizeValue } from "./executor";
export type { Conn, Driver, ExecSql, PlatformDbHandle, TxRetryOptions } from "./executor";
export { openPlatformDb, platformDb, platformDbConfigFromEnv, resetPlatformDbForTests } from "./open";
export type { OpenPlatformDbOptions, PlatformDbConfig, PlatformDbKind } from "./open";
export { MIGRATE_COMMAND, assertPlatformSchemaCurrent, migratePlatformDb, platformSchemaStatus } from "./migrator";
export type { AppliedMigration, MigrateResult, PlatformSchemaStatus } from "./migrator";
export { PLATFORM_MIGRATIONS, PLATFORM_SCHEMA_VERSION, migrationChecksum } from "./migrations/index";
export type { PlatformMigration } from "./migrations/index";
export { assertNoSecretKeys, assertNoSecretValues, isSecretKey } from "./secrets";
export { json, jsonOrNull, newId, textArray } from "./sql";
export * as repos from "./repos";
export { bindRepos } from "./repos";
export type { Bound, PlatformRepos } from "./repos";
