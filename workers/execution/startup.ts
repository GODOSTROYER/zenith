/** Startup errors are fixed operator guidance, never database/provider error strings. */
import { platformDb, platformDbConfigFromEnv, assertPlatformSchemaCurrent, MIGRATE_COMMAND } from "@/lib/controlplane/db";
import { planArtifactCipherFromEnv } from "@/lib/platform/plan-artifacts";
import { TofuRunner } from "@/lib/tofu/runner";
import { getControlSigner } from "@/lib/credentials/signing";
import { derivePlanFingerprintKey } from "@/lib/platform/execution";
import type { Sql } from "@/lib/controlplane/types";

export class ExecutionStartupError extends Error {}

/** Fixed diagnostic categories. Never derive these from exception messages. */
export const EXECUTION_FAILURE_CATEGORIES = ["module-load", "configuration", "health-listener", "platform-store", "platform-composition", "policy-assets", "plan-directory", "activity-composition", "temporal-runtime", "workflow-bundle", "temporal-connect", "temporal-worker", "worker-lifecycle", "worker-run", "resource-close"] as const;
export type ExecutionFailureCategory = (typeof EXECUTION_FAILURE_CATEGORIES)[number];

export async function validateExecutionConfiguration(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  if (!env.ZENITH_TEMPORAL_ADDRESS?.trim()) throw new ExecutionStartupError("Set ZENITH_TEMPORAL_ADDRESS explicitly for the execution worker.");
  try { derivePlanFingerprintKey(env.ZENITH_SECRET_KEY ?? ""); }
  catch { throw new ExecutionStartupError("Execution requires ZENITH_SECRET_KEY (64 hex characters); plan fingerprints cannot use the public default."); }
  try { if (!(await getControlSigner(env))) throw new Error("missing signer"); }
  catch { throw new ExecutionStartupError("Execution requires a usable ZENITH_CONTROL_SIGNING_JWK or ZENITH_CONTROL_KMS_KEY_ID."); }
  let configured = false;
  try { configured = platformDbConfigFromEnv(env).source !== "default"; }
  catch { throw new ExecutionStartupError("Platform store configuration is invalid; check ZENITH_PLATFORM_DB and ZENITH_PLATFORM_DB_URL."); }
  if (!configured) throw new ExecutionStartupError("Execution requires an explicitly configured platform store (ZENITH_PLATFORM_DB or ZENITH_PLATFORM_DB_URL).");
  if (platformDbConfigFromEnv(env).kind !== "postgres") throw new ExecutionStartupError("Execution requires PostgreSQL for durable cross-worker plan custody.");
  try { planArtifactCipherFromEnv(env); } catch { throw new ExecutionStartupError("Execution requires dedicated ZENITH_PLAN_ARTIFACT_KEY and valid previous artifact keys."); }
  try {
    const identity = await new TofuRunner({ hostEnv: env, identityFile: env.ZENITH_TOFU_IDENTITY_FILE ?? "/usr/local/share/zenith/tofu-identity.json" }).identity();
    if (!identity.archiveSha256) throw new Error();
  } catch { throw new ExecutionStartupError("Execution requires a matching checksum-verified packaged OpenTofu identity."); }
}

export async function openExecutionStore(open: () => Promise<Sql> = platformDb): Promise<Sql> {
  let db: Sql;
  try { db = await open(); }
  catch { throw new ExecutionStartupError(`Platform store could not open. Check its configuration and schema; run ${MIGRATE_COMMAND} before starting a Postgres worker.`); }
  try { await assertPlatformSchemaCurrent(db); }
  catch { throw new ExecutionStartupError(`Platform schema is behind or incompatible; run ${MIGRATE_COMMAND} before starting the worker.`); }
  if ((db as Sql & {kind?:string}).kind !== "postgres") throw new ExecutionStartupError("Execution requires PostgreSQL for durable cross-worker plan custody.");
  return db;
}

/** Close the worker-owned store after polling, maintenance and probes stop. */
export async function closeExecutionStore(db?: Sql): Promise<void> {
  const handle = db as (Sql & { close?: () => Promise<void> }) | undefined;
  if (typeof handle?.close === "function") await handle.close();
}
