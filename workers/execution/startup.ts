/** Startup errors are fixed operator guidance, never database/provider error strings. */
import { platformDb, platformDbConfigFromEnv, assertPlatformSchemaCurrent, MIGRATE_COMMAND } from "@/lib/controlplane/db";
import { planArtifactCipherFromEnv } from "@/lib/platform/plan-artifacts";
import { TofuRunner } from "@/lib/tofu/runner";
import { getControlSigner } from "@/lib/credentials/signing";
import { derivePlanFingerprintKey } from "@/lib/platform/execution";
import type { Sql } from "@/lib/controlplane/types";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import { Client, Connection } from "@temporalio/client";
import type { DataConverter } from "@temporalio/common";
import { connectionOptionsFor } from "@/lib/workflows/config";
import { TASK_QUEUE } from "@/lib/workflows/types";
import { ensureCriticalMaintenanceSchedule } from "@/lib/workflows/critical-schedule";
import { ensureReconcileSchedule, inspectReconcileObservation, type ReconcileObservation, type ReconcileSweepRuntime } from "@/lib/workflows/reconcile-schedule";
import type { ExecutionWorkerConfig, ReconcileWorkerConfig } from "./config";

export class ExecutionStartupError extends Error {}

/** Fixed diagnostic categories. Never derive these from exception messages. */
export const EXECUTION_FAILURE_CATEGORIES = ["module-load", "configuration", "health-listener", "platform-store", "platform-composition", "policy-assets", "plan-directory", "activity-composition", "reconcile-composition", "reconcile-client", "reconcile-pollers", "reconcile-schedule", "temporal-runtime", "workflow-bundle", "temporal-connect", "temporal-worker", "worker-lifecycle", "worker-run", "resource-close"] as const;
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

export async function openExecutionStore(open: () => Promise<Sql> = platformDb): Promise<PlatformDbHandle> {
  let db: Sql;
  try { db = await open(); }
  catch { throw new ExecutionStartupError(`Platform store could not open. Check its configuration and schema; run ${MIGRATE_COMMAND} before starting a Postgres worker.`); }
  try {
    try { await assertPlatformSchemaCurrent(db); }
    catch { throw new ExecutionStartupError(`Platform schema is behind or incompatible; run ${MIGRATE_COMMAND} before starting the worker.`); }
    if ((db as Sql & {kind?:string}).kind !== "postgres") throw new ExecutionStartupError("Execution requires PostgreSQL for durable cross-worker plan custody.");
    return db as PlatformDbHandle;
  } catch (error) { await closeExecutionStore(db).catch(() => undefined); throw error; }
}

/** Close the worker-owned store after polling, maintenance and probes stop. */
export async function closeExecutionStore(db?: Sql): Promise<void> {
  const handle = db as (Sql & { close?: () => Promise<void> }) | undefined;
  if (typeof handle?.close === "function") await handle.close();
}

/** Read-only poller compatibility remains general; this composition requires the fixed sweep route. */
export function validateReconcileWorkerConfiguration(config: ExecutionWorkerConfig, env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (config.taskQueue !== TASK_QUEUE || !config.reconcile) throw new ExecutionStartupError("This worker must service the fixed durable reconciliation task queue.");
  if (!env.ZENITH_TEMPORAL_NAMESPACE?.trim() || env.ZENITH_TEMPORAL_NAMESPACE.trim() !== config.temporal.namespace) throw new ExecutionStartupError("Set the configured ZENITH_TEMPORAL_NAMESPACE explicitly for durable reconciliation.");
  if (env.NODE_ENV === "production" && (!config.temporal.tls
    || (!config.temporal.apiKey && !config.temporal.tlsOptions?.clientCertPair))) throw new ExecutionStartupError("Production reconciliation requires configured authenticated Temporal TLS.");
}

/** A dedicated client owns its connection; no global cache or privilege mutation. */
export async function openReconcileWorkerClient(config: ExecutionWorkerConfig, dataConverter: DataConverter): Promise<{ client: Client; close(): Promise<void> }> {
  let connection: Connection | undefined;
  try {
    connection = await Connection.connect({ ...connectionOptionsFor(config.temporal), connectTimeout: 5_000 });
    const observed = await connection.withDeadline(Date.now() + 5_000, () => connection!.workflowService.describeNamespace({ namespace: config.temporal.namespace }));
    if (observed.namespaceInfo?.name !== config.temporal.namespace || observed.namespaceInfo.state !== 1) throw new Error();
    const client = new Client({ connection, namespace: config.temporal.namespace, identity: config.identity, dataConverter });
    return { client, close: () => connection!.close() };
  } catch { await connection?.close().catch(() => undefined); throw new ExecutionStartupError("Reconciliation client could not confirm its configured Temporal namespace."); }
}

/** Only explicit provisioning permission reaches a schedule mutation; existing pauses survive. */
export async function prepareReconcileWorkerSchedule(client: Client, runtime: ReconcileSweepRuntime, config: ReconcileWorkerConfig): Promise<void> {
  if (config.mode === "provision") await ensureReconcileSchedule(client, runtime, config.input);
  else await runtime.assertReady();
}

/** Same custody rule as the reconcile schedule: only explicit provision mode creates it; observe mode never mutates. */
export async function prepareCriticalMaintenanceSchedule(client: Client, config: ReconcileWorkerConfig): Promise<void> {
  if (config.mode === "provision") await ensureCriticalMaintenanceSchedule(client);
}

/** Share one bounded inspection and retain only fixed phases/counts, never arguments/errors. */
export function reconcileWorkerMonitor(client: Client, config: ReconcileWorkerConfig) {
  let current: ReconcileObservation = Object.freeze({ phase: "unknown", observationCurrent: false, running: 0 });
  let pending: Promise<ReconcileObservation> | undefined;
  let stopped = false;
  return {
    snapshot: () => current,
    async refresh(): Promise<ReconcileObservation> {
      if (stopped) return Object.freeze({ phase: "unknown", observationCurrent: false, running: 0 });
      if (!pending) {
        const request = inspectReconcileObservation(client, config.input).then(result => {
          if (!stopped) current = Object.freeze(result);
          return current;
        }, () => { current = Object.freeze({ phase: "unknown", observationCurrent: false, running: 0 }); return current; });
        pending = request;
        void request.finally(() => { if (pending === request) pending = undefined; });
      }
      return pending;
    },
    async stop() { stopped = true; await pending; },
  };
}
