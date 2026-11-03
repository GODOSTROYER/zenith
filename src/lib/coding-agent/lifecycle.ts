import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { digest } from "@/lib/controlplane/digest";
import { DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "@/lib/workflows/config";
import { TASK_QUEUE } from "@/lib/workflows/types";

/** Match the launcher's address, namespace and queue without storing connection details. */
export const modelWorkerScope = (env: Readonly<Record<string, string | undefined>> = process.env): string => digest([
  env.ZENITH_TEMPORAL_ADDRESS?.trim() || DEFAULT_TEMPORAL_ADDRESS,
  env.ZENITH_TEMPORAL_NAMESPACE?.trim() || DEFAULT_TEMPORAL_NAMESPACE,
  TASK_QUEUE,
]);

/** Only execution workers publish this non-secret fact. The web process never needs a model key. */
export async function recordModelWorker(sql: Sql, workerId: string, ready: boolean, scope = modelWorkerScope()): Promise<void> {
  if (!workerId || workerId.length > 200) throw new Error("Invalid worker identity.");
  await sql.query("insert into platform.coding_agent_workers(worker_id,model_ready,worker_scope) values($1,$2,$3) on conflict(worker_scope,worker_id) do update set model_ready=excluded.model_ready,seen_at=clock_timestamp()", [workerId, ready, scope]);
}
export async function modelWorkerAvailable(sql: Sql, scope = modelWorkerScope()): Promise<boolean> {
  const rows = await sql.query("select worker_id from platform.coding_agent_workers where worker_scope=$1 and model_ready and seen_at > clock_timestamp()-interval '90 seconds' limit 1", [scope]);
  return rows.length > 0;
}

/**
 * Remove disposable payloads, retain source IDs, usage and approval/operation
 * identifiers. CAS version advances so an in-flight worker cannot restore them.
 * Existing operation/audit/approved-source tables are never deleted.
 */
export async function purgeRunPayload(sql: Sql, workspaceId: string, id: string, expectedVersion?: number): Promise<boolean> {
  const rows = await sql.query(
    "update platform.coding_agent_runs set task='[Analysis content deleted]', checkpoint=jsonb_build_object('version',1,'messages','[]'::jsonb,'usage',usage,'steps',coalesce(checkpoint->'steps','0'::jsonb),'toolHistogram','{}'::jsonb,'unsafeAttempts','[]'::jsonb,'injectionSignals','[]'::jsonb), result=jsonb_build_object('purged',true,'manifestDigest',result->'artifact'->'manifestDigest','requirementsDigest',result->'artifact'->'requirementsDigest'), status=case when status in ('running','failed','budget_exhausted') then 'cancelled' else status end, payload_purged_at=clock_timestamp(), version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and id=$2 and payload_purged_at is null and ($3::integer is null or version=$3) returning id",
    [workspaceId, id, expectedVersion ?? null],
  );
  return rows.length > 0;
}

/** Bounded worker maintenance. Revoked sources and expired sessions lose disposable payloads too. */
export async function expireAnalysisPayloads(sql: Sql): Promise<number> {
  return sql.tx(async tx => {
    await tx.query("delete from platform.github_discovery_sessions where expires_at<=clock_timestamp()");
    const rows = await tx.query<{ id: string; workspace_id: string; version: number }>(
      "select r.id,r.workspace_id,r.version from platform.coding_agent_runs r where r.payload_purged_at is null and (r.payload_expires_at<=clock_timestamp() or (r.source->>'bindingId' is not null and not exists (select 1 from platform.github_source_bindings b where b.workspace_id=r.workspace_id and b.binding_id=r.source->>'bindingId' and b.revoked_at is null and b.version::text=r.source->>'bindingVersion'))) order by r.payload_expires_at limit 100 for update of r skip locked",
    );
    for (const row of rows) await purgeRunPayload(tx, row.workspace_id, row.id, row.version);
    return rows.length;
  });
}

/** Owned timer: shutdown drains the outstanding database work before closing the store. */
export function startAnalysisMaintenance(sql: Sql, workerId: string, ready: () => boolean, onError: () => void) {
  let pending: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (pending || stopped) return;
    pending = (async () => {
      await recordModelWorker(sql, workerId, ready());
      await expireAnalysisPayloads(sql);
    })().catch(onError).finally(() => { pending = undefined; });
  };
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return { async stop() {
    stopped = true;
    clearInterval(timer);
    await pending;
    await recordModelWorker(sql, workerId, false).catch(onError);
  } };
}

/** Serialize admissions per tenant and reserve the full run budget before scheduling. */
export async function withRunAdmission<T>(sql: Sql, workspaceId: string, spendMicroUsd: number, excludedRunId: string | undefined, work: (tx: Sql) => Promise<T>, replay?: (tx: Sql) => Promise<{ value: T } | null>): Promise<T> {
  if (!Number.isSafeInteger(spendMicroUsd) || spendMicroUsd < 0) throw new ControlStoreError("invalid_state", "Analysis spend must be a nonnegative safe integer.");
  return sql.tx(async tx => {
    await tx.query("insert into platform.coding_agent_workspace_limits(workspace_id) values($1) on conflict do nothing", [workspaceId]);
    const [limit] = await tx.query<{ concurrent_runs: number; daily_spend_micro_usd: string | number }>(
      "select concurrent_runs,daily_spend_micro_usd from platform.coding_agent_workspace_limits where workspace_id=$1 for update", [workspaceId]);
    const previous = await replay?.(tx);
    if (previous) return previous.value;
    const [usage] = await tx.query<{ active: string | number; reserved: string | number }>(
      "select count(*) filter(where status='running') as active,coalesce(sum(case when checkpoint->>'analysisMode'='static' then 0 when status='running' then (limits->>'spendMicroUsd')::bigint else (usage->>'spendMicroUsd')::bigint end),0) as reserved from platform.coding_agent_runs where workspace_id=$1 and (updated_at > clock_timestamp()-interval '24 hours' or status='running') and ($2::text is null or id<>$2)", [workspaceId, excludedRunId ?? null]);
    if (Number(usage.active) >= Number(limit.concurrent_runs)) throw new ControlStoreError("invalid_state", "The workspace concurrent analysis limit has been reached.");
    if (Number(usage.reserved) + spendMicroUsd > Number(limit.daily_spend_micro_usd)) throw new ControlStoreError("invalid_state", "The workspace daily analysis budget has been reached.");
    return work(tx);
  });
}
