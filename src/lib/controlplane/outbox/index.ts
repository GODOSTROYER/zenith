/**
 * Durable intent outbox and relay (PROD-DUR-01).
 *
 * An effect that leaves the database (a Temporal signal, the recovery of a
 * workflow start) is first a row in `platform.durable_intents`: deterministic
 * id/idempotency key, bounded secret-free payload, the authority version it was
 * decided under. Any worker may deliver it:
 *
 *   claim (SKIP LOCKED, bumps claim_epoch)  ->  deliver (idempotent transport)
 *     ->  settle (conditional on that exact claim_epoch)
 *
 * A crash at any of the three boundaries leaves a `pending` row whose lease
 * lapses; the next pass reclaims it with a higher epoch, and the earlier holder
 * can no longer settle it. Delivery is at-least-once and every transport call
 * carries the intent id as its idempotency key, so a duplicate is absorbed by
 * the receiver (Temporal signal requestId, workflow-start requestId).
 *
 * Secrets: payloads are scanned and bounded; grants, envelopes and credentials
 * never enter an intent. Runner jobs are NOT outbox rows: `runner_jobs` is
 * already the durable queue and its ids are made deterministic instead
 * (`idempotencyKey` on enqueue).
 *
 * Tenancy: every per-operation statement names `workspace_id`. The two
 * system-maintenance sweeps (`adoptStartIntents`, `claimDue`) are cross-tenant by
 * design (one relay serves all tenants) and are listed in the verify document.
 */
import { createHash } from "node:crypto";
import { digest } from "@/lib/controlplane/digest";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { assertNoSecretKeys } from "@/lib/controlplane/db/secrets";
import type { Sql } from "@/lib/controlplane/types";

export type IntentKind = "workflow_signal" | "workflow_start";
export type IntentState = "pending" | "delivered" | "dead";
export type IntentOutcome = "delivered" | "not_found" | "refused" | "exhausted" | "superseded";

export interface DurableIntent {
  readonly id: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly kind: IntentKind;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadDigest: string;
  readonly authorityVersion: number;
  readonly state: IntentState;
  readonly outcome: IntentOutcome | null;
  readonly claimEpoch: number;
  readonly claimedBy: string | null;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
}

interface IntentRow {
  id: string; workspace_id: string; operation_id: string; kind: IntentKind; idempotency_key: string;
  payload: Record<string, unknown>; payload_digest: string; authority_version: string | number;
  state: IntentState; outcome: IntentOutcome | null; claim_epoch: string | number; claimed_by: string | null;
  attempts: number; last_error_code: string | null;
}
const COLUMNS = "id, workspace_id, operation_id, kind, idempotency_key, payload, payload_digest, authority_version, state, outcome, claim_epoch, claimed_by, attempts, last_error_code";
const toIntent = (r: IntentRow): DurableIntent => Object.freeze({
  id: r.id, workspaceId: r.workspace_id, operationId: r.operation_id, kind: r.kind, idempotencyKey: r.idempotency_key,
  payload: Object.freeze({ ...r.payload }), payloadDigest: r.payload_digest, authorityVersion: Number(r.authority_version),
  state: r.state, outcome: r.outcome, claimEpoch: Number(r.claim_epoch), claimedBy: r.claimed_by,
  attempts: r.attempts, lastErrorCode: r.last_error_code,
});

const KEY = /^[A-Za-z0-9_.:@-]{1,200}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Deterministic id: the same (workspace, kind, key) is the same intent on every worker and after every crash. */
export function intentId(workspaceId: string, kind: IntentKind, idempotencyKey: string): string {
  return `di_${createHash("sha256").update(JSON.stringify([workspaceId, kind, idempotencyKey])).digest("hex").slice(0, 40)}`;
}

/** The same id as `intentId`, computed in SQL for set-based adoption. Ids and keys are restricted to JSON-stable characters. */
const idSql = (ws: string, kind: string, key: string): string =>
  `'di_' || substr(encode(sha256(convert_to('[' || to_json(${ws})::text || ',"${kind}",' || to_json(${key})::text || ']', 'UTF8')), 'hex'), 1, 40)`;

/** Retry budget: attempts beyond this settle the row dead/exhausted for operator inspection. */
export const MAX_ATTEMPTS = 12;
export const DEFAULT_LEASE_MS = 30_000;
/** A start intent younger than this is presumed to be in the original caller's hands, not abandoned. */
export const START_ADOPTION_GRACE_MS = 30_000;
const backoffMs = (attempts: number): number => Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts - 1));

export interface EnqueueIntentInput {
  workspaceId: string;
  operationId: string;
  kind: IntentKind;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}

/**
 * Record an intent. Idempotent: the same key returns the existing row; the same
 * key with a different payload is a conflict (never a silent overwrite). Joins an
 * open transaction, so a caller can commit it with the state change that decides it.
 */
export async function enqueueIntent(sql: Sql, input: EnqueueIntentInput): Promise<DurableIntent> {
  if (!ID.test(input.workspaceId) || !ID.test(input.operationId) || !KEY.test(input.idempotencyKey))
    throw new ControlStoreError("invalid_input", "Intent ids and keys must be 1-200 characters of A-Za-z0-9_.:@-.");
  const payload = input.payload ?? {};
  assertNoSecretKeys(payload, "payload");
  const payloadDigest = digest(payload);
  const id = intentId(input.workspaceId, input.kind, input.idempotencyKey);
  const inserted = await sql.query<IntentRow>(
    `insert into platform.durable_intents (id, workspace_id, operation_id, kind, idempotency_key, payload, payload_digest, authority_version)
     select $1, a.workspace_id, a.operation_id, $4, $5, $6::text::jsonb, $7, a.version
       from platform.operation_authority a where a.workspace_id = $2 and a.operation_id = $3
     on conflict (workspace_id, kind, idempotency_key) do nothing
     returning ${COLUMNS}`,
    [id, input.workspaceId, input.operationId, input.kind, input.idempotencyKey, JSON.stringify(payload), payloadDigest]);
  if (inserted[0]) return toIntent(inserted[0]);
  const rows = await sql.query<IntentRow>(
    `select ${COLUMNS} from platform.durable_intents where workspace_id = $1 and kind = $2 and idempotency_key = $3`,
    [input.workspaceId, input.kind, input.idempotencyKey]);
  if (!rows[0]) throw new ControlStoreError("operation_not_found", "Operation not found.", { id: input.operationId });
  if (rows[0].operation_id !== input.operationId || rows[0].payload_digest !== payloadDigest)
    throw new ControlStoreError("conflict", "This intent key already records a different effect.", { kind: input.kind });
  return toIntent(rows[0]);
}

export async function getIntent(sql: Sql, workspaceId: string, kind: IntentKind, idempotencyKey: string): Promise<DurableIntent | null> {
  const rows = await sql.query<IntentRow>(
    `select ${COLUMNS} from platform.durable_intents where workspace_id = $1 and kind = $2 and idempotency_key = $3`,
    [workspaceId, kind, idempotencyKey]);
  return rows[0] ? toIntent(rows[0]) : null;
}

export interface ClaimOptions { holder: string; leaseMs?: number; limit?: number; only?: { workspaceId: string; id: string } }

/**
 * Claim due intents under a new fence. `FOR UPDATE SKIP LOCKED` means two relays
 * never receive the same row in one instant; an expired lease is reclaimable and
 * the new claim_epoch invalidates the previous holder's settle.
 * Cross-tenant by design (system relay) unless `only` narrows it to one row.
 */
export async function claimDue(sql: Sql, options: ClaimOptions): Promise<DurableIntent[]> {
  const lease = Math.min(10 * 60_000, Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS));
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  const rows = await sql.query<IntentRow>(
    `update platform.durable_intents d
        set claim_epoch = d.claim_epoch + 1, claimed_by = $1, attempts = d.attempts + 1,
            lease_until = clock_timestamp() + ($2::bigint * interval '1 millisecond')
      where d.id in (
        select q.id from platform.durable_intents q
         where q.state = 'pending' and q.next_attempt_at <= clock_timestamp()
           and (q.lease_until is null or q.lease_until <= clock_timestamp())
           and ($4::text is null or (q.workspace_id = $4 and q.id = $5))
         order by q.next_attempt_at, q.id
         limit $3::bigint
         for update of q skip locked)
      returning ${COLUMNS.split(", ").map((c) => `d.${c}`).join(", ")}`,
    [options.holder, lease, limit, options.only?.workspaceId ?? null, options.only?.id ?? null]);
  return rows.map(toIntent);
}

export type Settlement =
  | { kind: "delivered" }
  | { kind: "dead"; outcome: Exclude<IntentOutcome, "delivered"> }
  | { kind: "retry"; code: string };

/**
 * Settle under the claim that produced the delivery. False when the row is not
 * pending or was reclaimed by another relay (a stale holder changes nothing).
 */
export async function settleIntent(sql: Sql, intent: Pick<DurableIntent, "workspaceId" | "id" | "claimEpoch" | "attempts">, settlement: Settlement): Promise<boolean> {
  const code = settlement.kind === "retry" ? settlement.code.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) : null;
  const exhausted = settlement.kind === "retry" && intent.attempts >= MAX_ATTEMPTS;
  const state: IntentState = settlement.kind === "retry" && !exhausted ? "pending" : settlement.kind === "delivered" ? "delivered" : "dead";
  const outcome: IntentOutcome | null = state === "pending" ? null : settlement.kind === "delivered" ? "delivered" : exhausted ? "exhausted" : (settlement as { outcome: IntentOutcome }).outcome;
  const rows = await sql.query<{ id: string }>(
    `update platform.durable_intents
        set state = $4, outcome = $5, last_error_code = coalesce($6, last_error_code),
            settled_at = case when $4 = 'pending' then null else clock_timestamp() end,
            lease_until = null,
            next_attempt_at = case when $4 = 'pending' then clock_timestamp() + ($7::bigint * interval '1 millisecond') else next_attempt_at end
      where workspace_id = $1 and id = $2 and state = 'pending' and claim_epoch = $3
      returning id`,
    [intent.workspaceId, intent.id, intent.claimEpoch, state, outcome, code, backoffMs(intent.attempts)]);
  return rows.length > 0;
}

/**
 * Adopt retained workflow-start intents that are not acknowledged and have been
 * idle past the grace period. The start-intent table is the durable record of the
 * start; adoption gives it a relay row without touching its immutable history.
 * System sweep across tenants.
 */
export async function adoptStartIntents(sql: Sql, limit = 50, graceMs = START_ADOPTION_GRACE_MS): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `insert into platform.durable_intents (id, workspace_id, operation_id, kind, idempotency_key, payload_digest, authority_version)
     select ${idSql("i.workspace_id", "workflow_start", "'start:' || i.operation_id")},
            i.workspace_id, i.operation_id, 'workflow_start', 'start:' || i.operation_id, $2, a.version
       from platform.workflow_start_intents i
       join platform.operation_authority a on a.workspace_id = i.workspace_id and a.operation_id = i.operation_id
      where i.phase <> 'acknowledged'
        and coalesce(i.attempted_at, i.created_at) < clock_timestamp() - ($3::bigint * interval '1 millisecond')
      order by i.created_at
      limit $1::bigint
     on conflict (workspace_id, kind, idempotency_key) do nothing
     returning id`,
    [limit, digest({}), Math.max(0, graceMs)]);
  return rows.length;
}

/**
 * Derive wake-up signals from authority state. An approval or rejection that is
 * still waiting on its workflow (acknowledged start, operation still
 * approved/rejected for a plan round, no signal intent since the last authority
 * change) gets one signal intent. This closes the crash between the approval
 * commit and the signal without touching the approval code path; the workflow's
 * own poll (30 minutes) remains only the last-resort backstop. System sweep.
 */
export async function deriveApprovalSignals(sql: Sql, limit = 50): Promise<number> {
  const payload = { signal: "approvalRecorded" };
  const rows = await sql.query<{ id: string }>(
    `insert into platform.durable_intents (id, workspace_id, operation_id, kind, idempotency_key, payload, payload_digest, authority_version)
     select ${idSql("a.workspace_id", "workflow_signal", "'approval-sweep:' || a.operation_id || ':' || a.version")},
            a.workspace_id, a.operation_id, 'workflow_signal', 'approval-sweep:' || a.operation_id || ':' || a.version, $2::text::jsonb, $3, a.version
       from platform.operation_authority a
       join platform.workflow_start_intents i on i.workspace_id = a.workspace_id and i.operation_id = a.operation_id and i.phase = 'acknowledged'
      where a.status in ('approved','rejected') and a.approval_round > 0 and a.plan_digest is not null
        and a.updated_at < clock_timestamp() - ($4::bigint * interval '1 millisecond')
        and not exists (select 1 from platform.durable_intents d
                         where d.workspace_id = a.workspace_id and d.operation_id = a.operation_id and d.kind = 'workflow_signal'
                           and d.payload->>'signal' = 'approvalRecorded' and d.created_at >= a.updated_at)
      order by a.updated_at
      limit $1::bigint
     on conflict (workspace_id, kind, idempotency_key) do nothing
     returning id`,
    [limit, JSON.stringify(payload), digest(payload), SIGNAL_SWEEP_GRACE_MS]);
  return rows.length;
}
export const SIGNAL_SWEEP_GRACE_MS = 60_000;

/* ----------------------------------- relay --------------------------------- */

export type DeliveryResult =
  | { status: "delivered" }
  | { status: "not_found" }
  | { status: "refused" }
  | { status: "superseded" }
  | { status: "retry"; code: string };

export type IntentHandlers = Readonly<Record<IntentKind, (intent: DurableIntent) => Promise<DeliveryResult>>>;

/**
 * Crash-injection seams. Production passes none. Tests throw from these to stop
 * the relay exactly at a boundary, then run another pass as a different worker.
 */
export interface RelayFaults {
  afterClaim?: (intent: DurableIntent) => void | Promise<void>;
  afterDeliver?: (intent: DurableIntent, result: DeliveryResult) => void | Promise<void>;
}

export interface RelayOptions { holder: string; leaseMs?: number; limit?: number; faults?: RelayFaults; only?: ClaimOptions["only"]; adopt?: boolean; adoptGraceMs?: number }
export interface RelayResult { adopted: number; claimed: number; delivered: number; retried: number; dead: number; stale: number }

/** NOT_FOUND on a signal retries a bounded number of times (the workflow may not be visible yet) before the row dies as not_found. */
const NOT_FOUND_RETRIES = 4;

export async function relayOnce(sql: Sql, handlers: IntentHandlers, options: RelayOptions): Promise<RelayResult> {
  const result: RelayResult = { adopted: 0, claimed: 0, delivered: 0, retried: 0, dead: 0, stale: 0 };
  if (options.adopt !== false && !options.only) result.adopted = (await adoptStartIntents(sql, 50, options.adoptGraceMs)) + (await deriveApprovalSignals(sql));
  const claimed = await claimDue(sql, { holder: options.holder, leaseMs: options.leaseMs, limit: options.limit, only: options.only });
  result.claimed = claimed.length;
  for (const intent of claimed) {
    await options.faults?.afterClaim?.(intent);
    let delivery: DeliveryResult;
    try { delivery = await handlers[intent.kind](intent); }
    catch { delivery = { status: "retry", code: "handler_error" }; }
    await options.faults?.afterDeliver?.(intent, delivery);
    const settlement: Settlement =
      delivery.status === "delivered" ? { kind: "delivered" }
      : delivery.status === "retry" ? { kind: "retry", code: delivery.code }
      : delivery.status === "not_found" && intent.attempts <= NOT_FOUND_RETRIES ? { kind: "retry", code: "not_found" }
      : { kind: "dead", outcome: delivery.status };
    if (!(await settleIntent(sql, intent, settlement))) { result.stale++; continue; }
    if (settlement.kind === "delivered") result.delivered++;
    else if (settlement.kind === "dead") result.dead++;
    else result.retried++;
  }
  return result;
}
