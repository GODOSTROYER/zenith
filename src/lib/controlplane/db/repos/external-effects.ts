/**
 * External-effect ledger store (PROD-DUR-07 / PROD-DUR-08).
 *
 * Permanent, tenant-scoped inventory of provider mutations. Every function
 * filters on `workspace_id` in SQL; a foreign effect id is the same as a
 * missing one. Authority over legal transitions lives in the migration-0033
 * trigger, not here: this module chooses the next state, the database refuses
 * anything illegal.
 *
 * Rules this module enforces on top of the trigger:
 *  - `begin` is the only creator and is idempotent by (family, dedupKey). A
 *    stale fence cannot create a NEW effect, but an existing one is always
 *    returned, never re-created, never reset.
 *  - A provider receipt that arrives late (after the effect went uncertain, was
 *    tombstoned, or the lease/fence is gone) is evidence. It never reopens or
 *    clears `uncertain`, `conflict` or `tombstoned`.
 *  - Readback evidence is recorded verbatim; only an exact match of an
 *    `accepted` effect confirms automatically. Everything else needs `resolve`.
 *  - `resolve` binds to the exact effect version and readback digest the
 *    approver reviewed.
 */
import type { Sql } from "@/lib/controlplane/types";
import { assertFence } from "./leases";
import { ControlStoreError, requireText } from "../errors";
import { clampLimit, json, jsonOrNull, newId, requireDigest } from "../sql";
import { receiptDigest, receiptFromReadback, resolutionBinding } from "@/lib/effects/binding";
import {
  EFFECT_FAMILIES,
  EFFECT_STATES,
  PENDING_STALE_MS,
  type EffectEvent,
  type EffectFamily,
  type EffectRecord,
  type EffectResolution,
  type EffectState,
  type EffectTarget,
  type LateReceipt,
  type ProviderReceipt,
  type Readback,
  type ResolutionDecision,
  type TombstoneReason,
} from "@/lib/effects/types";

interface Row {
  workspace_id: string;
  effect_id: string;
  family: EffectFamily;
  operation_id: string;
  environment_id: string | null;
  provider: string;
  dedup_key: string;
  request_digest: string;
  target: EffectTarget;
  idempotency_token: string | null;
  idempotency_supported: boolean;
  fence_scope: string | null;
  fence_epoch: number | string | null;
  state: EffectState;
  state_reason: string | null;
  provider_receipt: ProviderReceipt | null;
  late_receipt: LateReceipt | null;
  readback: Readback | null;
  tombstone_reason: TombstoneReason | null;
  version: number;
  created_at: unknown;
  updated_at: unknown;
  uncertain_at: unknown;
}

const COLUMNS = `workspace_id, effect_id, family, operation_id, environment_id, provider, dedup_key, request_digest, target,
  idempotency_token, idempotency_supported, fence_scope, fence_epoch, state, state_reason, provider_receipt, late_receipt,
  readback, tombstone_reason, version, created_at, updated_at, uncertain_at`;
const iso = (v: unknown): string => new Date(v as string).toISOString();

const toEffect = (r: Row): EffectRecord => ({
  workspaceId: r.workspace_id,
  effectId: r.effect_id,
  family: r.family,
  operationId: r.operation_id,
  environmentId: r.environment_id,
  provider: r.provider,
  dedupKey: r.dedup_key,
  requestDigest: r.request_digest,
  target: r.target,
  idempotencyToken: r.idempotency_token,
  idempotencySupported: r.idempotency_supported,
  fenceScope: r.fence_scope,
  fenceEpoch: r.fence_epoch === null ? null : Number(r.fence_epoch),
  state: r.state,
  stateReason: r.state_reason,
  providerReceipt: r.provider_receipt,
  lateReceipt: r.late_receipt,
  readback: r.readback,
  tombstoneReason: r.tombstone_reason,
  version: Number(r.version),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  uncertainAt: r.uncertain_at ? iso(r.uncertain_at) : null,
});

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
function id(name: string, value: unknown): string {
  const text = requireText(name, value, 128);
  if (!ID.test(text)) throw new ControlStoreError("invalid_input", `${name} is not a valid identifier.`, { field: name });
  return text;
}
function reasonText(value: unknown): string {
  const text = requireText("reason", value, 500).replace(/[\r\n\t]+/g, " ");
  return text;
}
const actorText = (value: unknown): string => requireText("actor", value, 200);

function receiptOf(raw: ProviderReceipt): ProviderReceipt {
  if (!raw || !Array.isArray(raw.requestIds) || raw.requestIds.length > 20 || raw.requestIds.some((r) => typeof r !== "string" || r.length < 1 || r.length > 200))
    throw new ControlStoreError("invalid_input", "A provider receipt needs a bounded list of request ids.", { field: "receipt" });
  if (raw.resourceId !== undefined && (typeof raw.resourceId !== "string" || raw.resourceId.length < 1 || raw.resourceId.length > 400))
    throw new ControlStoreError("invalid_input", "A provider receipt resource id is invalid.", { field: "receipt" });
  return { ...(raw.resourceId !== undefined ? { resourceId: raw.resourceId } : {}), requestIds: [...raw.requestIds],
    ...(raw.acceptedAt !== undefined ? { acceptedAt: new Date(raw.acceptedAt).toISOString() } : {}),
    ...(raw.identity ? { identity: { ...raw.identity } } : {}) };
}

async function event(tx: Sql, e: EffectRecord, kind: string, from: EffectState | null, to: EffectState, actor: string, evidenceDigest: string | null): Promise<void> {
  await tx.query(
    `insert into platform.external_effect_events (workspace_id, effect_id, kind, from_state, to_state, actor, evidence_digest)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.workspaceId, e.effectId, kind, from, to, actorText(actor), evidenceDigest]
  );
}

async function lock(tx: Sql, workspaceId: string, effectId: string): Promise<EffectRecord> {
  const rows = await tx.query<Row>(`select ${COLUMNS} from platform.external_effects where workspace_id = $1 and effect_id = $2 for update`, [workspaceId, effectId]);
  if (!rows[0]) throw new ControlStoreError("not_found", "Effect not found.", { effectId });
  return toEffect(rows[0]);
}

async function fenceLive(sql: Sql, scope: string | null, epoch: number | null): Promise<boolean> {
  if (scope === null || epoch === null) return false;
  const rows = await sql.query<{ n: number }>(
    `select count(*)::int as n from platform.leases where scope = $1 and fence_token = $2::bigint and expires_at > clock_timestamp() and released_at is null`,
    [scope, epoch]
  );
  return (rows[0]?.n ?? 0) > 0;
}

export interface BeginEffectInput {
  workspaceId: string;
  family: EffectFamily;
  operationId: string;
  environmentId?: string;
  provider: string;
  /** natural identity of the effect, e.g. `<operation>:<service>`; the same key never creates a second effect */
  dedupKey: string;
  /** digest of the exact request; a second begin with a different digest is refused */
  requestDigest: string;
  target?: EffectTarget;
  idempotencyToken?: string;
  idempotencySupported: boolean;
  fence?: { scope: string; token: number };
  actor: string;
}

/** Insert-or-return. Creation needs a live fence when one is named; an existing effect is returned regardless. */
export async function begin(sql: Sql, input: BeginEffectInput): Promise<{ created: boolean; effect: EffectRecord }> {
  const workspaceId = id("workspaceId", input.workspaceId);
  const operationId = id("operationId", input.operationId);
  if (!EFFECT_FAMILIES.includes(input.family)) throw new ControlStoreError("invalid_input", "Unknown effect family.", { field: "family" });
  const dedupKey = requireText("dedupKey", input.dedupKey, 256);
  const requestDigest = requireDigest("requestDigest", input.requestDigest);
  const existing = async (tx: Sql): Promise<EffectRecord | undefined> => {
    const rows = await tx.query<Row>(`select ${COLUMNS} from platform.external_effects where workspace_id = $1 and family = $2 and dedup_key = $3`, [workspaceId, input.family, dedupKey]);
    if (!rows[0]) return undefined;
    const effect = toEffect(rows[0]);
    if (effect.requestDigest !== requestDigest) throw new ControlStoreError("conflict", "That effect identity was already used for a different request.", { effectId: effect.effectId });
    return effect;
  };
  return sql.tx(async (tx) => {
    const found = await existing(tx);
    if (found) return { created: false, effect: found };
    if (input.fence) await assertFence(tx, input.fence.scope, input.fence.token);
    const effectId = newId("fx");
    const inserted = await tx.query<Row>(
      `insert into platform.external_effects
         (workspace_id, effect_id, family, operation_id, environment_id, provider, dedup_key, request_digest, target,
          idempotency_token, idempotency_supported, fence_scope, fence_epoch)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11, $12, $13::bigint)
       on conflict (workspace_id, family, dedup_key) do nothing
       returning ${COLUMNS}`,
      [workspaceId, effectId, input.family, operationId, input.environmentId ?? null, requireText("provider", input.provider, 32), dedupKey, requestDigest,
        json(input.target ?? {}), input.idempotencyToken ?? null, input.idempotencySupported, input.fence?.scope ?? null, input.fence?.token ?? null]
    );
    if (!inserted[0]) {
      const raced = await existing(tx);
      if (!raced) throw new ControlStoreError("conflict", "The effect could not be recorded.");
      return { created: false, effect: raced };
    }
    const effect = toEffect(inserted[0]);
    await event(tx, effect, "begin", null, "pending", input.actor, effect.requestDigest);
    return { created: true, effect };
  });
}

export async function get(sql: Sql, workspaceId: string, effectId: string): Promise<EffectRecord | null> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.external_effects where workspace_id = $1 and effect_id = $2`, [id("workspaceId", workspaceId), id("effectId", effectId)]);
  return rows[0] ? toEffect(rows[0]) : null;
}

export async function getByDedup(sql: Sql, workspaceId: string, family: EffectFamily, dedupKey: string): Promise<EffectRecord | null> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.external_effects where workspace_id = $1 and family = $2 and dedup_key = $3`, [id("workspaceId", workspaceId), family, requireText("dedupKey", dedupKey, 256)]);
  return rows[0] ? toEffect(rows[0]) : null;
}

export interface ListEffectsFilter {
  operationId?: string;
  environmentId?: string;
  family?: EffectFamily;
  states?: readonly EffectState[];
  /** include tombstoned effects that later received a provider receipt */
  includeContradicted?: boolean;
  limit?: number;
}

export async function list(sql: Sql, workspaceId: string, filter: ListEffectsFilter = {}): Promise<EffectRecord[]> {
  const states = filter.states?.filter((s) => EFFECT_STATES.includes(s));
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.external_effects
      where workspace_id = $1
        and ($2::text is null or operation_id = $2)
        and ($3::text is null or environment_id = $3)
        and ($4::text is null or family = $4)
        and ($5::text[] is null or state = any($5::text[]) or ($6::boolean and state = 'tombstoned' and late_receipt is not null))
      order by created_at desc, effect_id limit $7::bigint`,
    [id("workspaceId", workspaceId), filter.operationId ?? null, filter.environmentId ?? null, filter.family ?? null,
      states ? `{${states.map((s) => `"${s}"`).join(",")}}` : null, filter.includeContradicted ?? false, clampLimit(filter.limit, 100, 500)]
  );
  return rows.map(toEffect);
}

export async function listEvents(sql: Sql, workspaceId: string, effectId: string, limit = 100): Promise<EffectEvent[]> {
  const rows = await sql.query<{ seq: number | string; effect_id: string; kind: string; from_state: EffectState | null; to_state: EffectState; actor: string; evidence_digest: string | null; at: unknown }>(
    `select seq, effect_id, kind, from_state, to_state, actor, evidence_digest, at from platform.external_effect_events
      where workspace_id = $1 and effect_id = $2 order by seq limit $3::bigint`,
    [id("workspaceId", workspaceId), id("effectId", effectId), clampLimit(limit, 100, 500)]
  );
  return rows.map((r) => ({ seq: Number(r.seq), effectId: r.effect_id, kind: r.kind, fromState: r.from_state, toState: r.to_state, actor: r.actor, evidenceDigest: r.evidence_digest, at: iso(r.at) }));
}

export async function listResolutions(sql: Sql, workspaceId: string, effectId: string): Promise<EffectResolution[]> {
  const rows = await sql.query<{ id: string; workspace_id: string; effect_id: string; effect_version: number; decision: ResolutionDecision; readback_digest: string; binding_digest: string; approver_id: string; reason: string; created_at: unknown }>(
    `select id, workspace_id, effect_id, effect_version, decision, readback_digest, binding_digest, approver_id, reason, created_at
       from platform.external_effect_resolutions where workspace_id = $1 and effect_id = $2 order by created_at`,
    [id("workspaceId", workspaceId), id("effectId", effectId)]
  );
  return rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, effectId: r.effect_id, effectVersion: Number(r.effect_version), decision: r.decision, readbackDigest: r.readback_digest, bindingDigest: r.binding_digest, approverId: r.approver_id, reason: r.reason, createdAt: iso(r.created_at) }));
}

/** Whether the lease that dispatched the effect still holds its fence. A renewed lease keeps its fence. */
export async function isFenceLive(sql: Sql, workspaceId: string, effectId: string): Promise<boolean> {
  const effect = await get(sql, workspaceId, effectId);
  return effect ? fenceLive(sql, effect.fenceScope, effect.fenceEpoch) : false;
}

async function update(tx: Sql, old: EffectRecord, patch: { state?: EffectState; stateReason?: string | null; providerReceipt?: ProviderReceipt | null; lateReceipt?: LateReceipt | null;
  readback?: Readback | null; tombstoneReason?: TombstoneReason | null; uncertain?: boolean }): Promise<EffectRecord> {
  const rows = await tx.query<Row>(
    `update platform.external_effects set
        state = $4, state_reason = $5, provider_receipt = $6::text::jsonb, late_receipt = $7::text::jsonb, readback = $8::text::jsonb,
        tombstone_reason = $9, version = version + 1, updated_at = clock_timestamp(),
        uncertain_at = case when $10::boolean then coalesce(uncertain_at, clock_timestamp()) else uncertain_at end
      where workspace_id = $1 and effect_id = $2 and version = $3
      returning ${COLUMNS}`,
    [old.workspaceId, old.effectId, old.version, patch.state ?? old.state, patch.stateReason === undefined ? old.stateReason : patch.stateReason,
      jsonOrNull(patch.providerReceipt === undefined ? old.providerReceipt : patch.providerReceipt),
      jsonOrNull(patch.lateReceipt === undefined ? old.lateReceipt : patch.lateReceipt),
      jsonOrNull(patch.readback === undefined ? old.readback : patch.readback),
      patch.tombstoneReason === undefined ? old.tombstoneReason : patch.tombstoneReason, patch.uncertain ?? false]
  );
  if (!rows[0]) throw new ControlStoreError("conflict", "The effect changed concurrently; read it again.");
  return toEffect(rows[0]);
}

export interface RecordAcceptedInput { workspaceId: string; effectId: string; receipt: ProviderReceipt; actor: string }

/**
 * The provider's reply. Always recorded, even with no live lease or approval: a late response is evidence, and
 * refusing to store it would lose the only proof the call landed. It never changes `uncertain`, `conflict` or
 * `tombstoned` into anything better; it makes the contradiction visible instead.
 */
export async function recordAccepted(sql: Sql, input: RecordAcceptedInput): Promise<EffectRecord> {
  const workspaceId = id("workspaceId", input.workspaceId);
  const effectId = id("effectId", input.effectId);
  const receipt = receiptOf(input.receipt);
  const digest = receiptDigest(receipt);
  return sql.tx(async (tx) => {
    const e = await lock(tx, workspaceId, effectId);
    const same = e.providerReceipt && receiptDigest(e.providerReceipt) === digest;
    if (e.state === "pending") {
      const next = await update(tx, e, { state: "accepted", providerReceipt: receipt, stateReason: null });
      await event(tx, next, "accepted", "pending", "accepted", input.actor, digest);
      return next;
    }
    if (e.state === "accepted") {
      if (same) return e;
      // A second, different receipt for one effect: two provider objects may exist.
      const late: LateReceipt = { ...receipt, receivedAt: new Date().toISOString(), staleFence: !(await fenceLive(tx, e.fenceScope, e.fenceEpoch)), digest };
      const next = await update(tx, e, { state: "conflict", stateReason: "A second provider receipt differs from the first.", lateReceipt: e.lateReceipt ?? late });
      await event(tx, next, "receipt_conflict", "accepted", "conflict", input.actor, digest);
      return next;
    }
    if (e.lateReceipt && e.lateReceipt.digest === digest) return e;
    if (e.state === "confirmed" && same) return e;
    const stale = !(await fenceLive(tx, e.fenceScope, e.fenceEpoch));
    const late: LateReceipt = { ...receipt, receivedAt: new Date().toISOString(), staleFence: stale, digest };
    const differs = !!e.providerReceipt && !same;
    // Record the evidence; a differing receipt additionally turns a not-yet-resolved effect into a conflict.
    const toConflict = (e.state === "uncertain") && (differs || !!e.lateReceipt);
    const next = await update(tx, e, e.lateReceipt
      ? (toConflict ? { state: "conflict", stateReason: "A second late provider receipt differs from the first." } : {})
      : { lateReceipt: late, ...(toConflict ? { state: "conflict" as const, stateReason: "A late provider receipt differs from the recorded one." } : {}) });
    await event(tx, next, e.state === "tombstoned" ? "late_receipt_after_tombstone" : "late_receipt", e.state, next.state, input.actor, digest);
    return next;
  });
}

export interface RecordRejectedInput { workspaceId: string; effectId: string; reason: string; actor: string }

/** The provider definitively refused before accepting: nothing happened, the effect is retired. Pending only. */
export async function recordRejected(sql: Sql, input: RecordRejectedInput): Promise<EffectRecord> {
  const workspaceId = id("workspaceId", input.workspaceId);
  const effectId = id("effectId", input.effectId);
  const reason = reasonText(input.reason);
  return sql.tx(async (tx) => {
    const e = await lock(tx, workspaceId, effectId);
    if (e.state !== "pending") return e;
    const next = await update(tx, e, { state: "tombstoned", tombstoneReason: "provider_rejected", stateReason: reason });
    await event(tx, next, "rejected", "pending", "tombstoned", input.actor, null);
    return next;
  });
}

export interface MarkUncertainInput { workspaceId: string; effectId: string; reason: string; actor: string }

/** Pending or accepted becomes uncertain. Idempotent; never touches a conflict, confirmed or tombstoned effect. */
export async function markUncertain(sql: Sql, input: MarkUncertainInput): Promise<EffectRecord> {
  const workspaceId = id("workspaceId", input.workspaceId);
  const effectId = id("effectId", input.effectId);
  const reason = reasonText(input.reason);
  return sql.tx(async (tx) => {
    const e = await lock(tx, workspaceId, effectId);
    if (e.state !== "pending" && e.state !== "accepted") return e;
    const next = await update(tx, e, { state: "uncertain", stateReason: reason, uncertain: true });
    await event(tx, next, "uncertain", e.state, "uncertain", input.actor, null);
    return next;
  });
}

export interface RecordReadbackInput { workspaceId: string; effectId: string; readback: Readback; actor: string }

function checkReadback(rb: Readback): void {
  const t = Date.parse(rb.observedAt);
  const now = Date.now();
  if (!Number.isFinite(t) || t > now + 5_000 || t < now - 15 * 60_000)
    throw new ControlStoreError("invalid_input", "A readback must be a fresh observation (taken within the last 15 minutes).", { field: "readback" });
  if (!["present", "absent", "mismatch", "unavailable"].includes(rb.outcome) || typeof rb.source !== "string" || rb.source.length > 128)
    throw new ControlStoreError("invalid_input", "The readback is malformed.", { field: "readback" });
  requireDigest("readback.digest", rb.digest);
}

/**
 * Independent readback evidence. An exact match of an `accepted` effect confirms it; a mismatch on an accepted or
 * uncertain effect makes it a conflict. Everything else is stored as evidence and waits for an authorized
 * resolution. An `unavailable` read never replaces earlier definitive evidence.
 */
export async function recordReadback(sql: Sql, input: RecordReadbackInput): Promise<EffectRecord> {
  const workspaceId = id("workspaceId", input.workspaceId);
  const effectId = id("effectId", input.effectId);
  checkReadback(input.readback);
  return sql.tx(async (tx) => {
    const e = await lock(tx, workspaceId, effectId);
    if (e.state === "confirmed" || e.state === "tombstoned") return e;
    const rb = input.readback;
    const keepOld = rb.outcome === "unavailable" && e.readback && e.readback.outcome !== "unavailable";
    const patch: Parameters<typeof update>[2] = keepOld ? {} : { readback: rb };
    let kind = keepOld ? "readback_unavailable" : "readback";
    if (!keepOld) {
      if (e.state === "accepted" && rb.outcome === "present" && e.providerReceipt && (!e.providerReceipt.resourceId || e.providerReceipt.resourceId === rb.resourceId)) {
        patch.state = "confirmed";
        patch.stateReason = null;
        kind = "confirmed";
      } else if ((e.state === "accepted" || e.state === "uncertain") && (rb.outcome === "mismatch" || (rb.outcome === "present" && !!e.providerReceipt?.resourceId && e.providerReceipt.resourceId !== rb.resourceId))) {
        patch.state = "conflict";
        patch.stateReason = rb.reason ?? "Readback does not match the request or the recorded receipt.";
        kind = "readback_conflict";
      }
    }
    if (keepOld) {
      // Evidence that a read failed is an event, not a state change.
      await event(tx, e, kind, e.state, e.state, input.actor, rb.digest);
      return e;
    }
    const next = await update(tx, e, patch);
    await event(tx, next, kind, e.state, next.state, input.actor, rb.digest);
    return next;
  });
}

export interface ResolveEffectInput {
  workspaceId: string;
  effectId: string;
  decision: ResolutionDecision;
  /** the binding the approver reviewed (see `resolutionBinding`) */
  bindingDigest: string;
  /** the verified human; role and browser-session checks happen at the API boundary */
  approverId: string;
  reason: string;
}

/**
 * Evidence-based resolution of an `uncertain` or `conflict` effect. The approver's binding must equal the
 * binding of the CURRENT effect version and readback: any later receipt, readback or state change makes an old
 * approval unusable. The trigger additionally refuses absence while the dispatching fence is live, inside the
 * settle window, or after a late receipt.
 */
export async function resolve(sql: Sql, input: ResolveEffectInput): Promise<{ effect: EffectRecord; resolution: EffectResolution }> {
  const workspaceId = id("workspaceId", input.workspaceId);
  const effectId = id("effectId", input.effectId);
  const approverId = requireText("approverId", input.approverId, 200);
  const reason = reasonText(input.reason);
  const bindingDigest = requireDigest("bindingDigest", input.bindingDigest);
  if (input.decision !== "confirm_applied" && input.decision !== "confirm_not_applied") throw new ControlStoreError("invalid_input", "Unknown resolution decision.", { field: "decision" });
  return sql.tx(async (tx) => {
    const e = await lock(tx, workspaceId, effectId);
    if (e.state !== "uncertain" && e.state !== "conflict") throw new ControlStoreError("invalid_state", "This effect is not waiting for resolution.", { state: e.state });
    if (!e.readback) throw new ControlStoreError("approval_required", "Record an independent readback before resolving.");
    if (input.decision === "confirm_applied" && e.providerReceipt?.resourceId && e.providerReceipt.resourceId !== e.readback.resourceId)
      throw new ControlStoreError("invalid_state", "The recorded receipt and the readback name different provider objects; they cannot be confirmed as one effect.");
    const expected = resolutionBinding(e, input.decision, e.readback.digest);
    if (expected !== bindingDigest) throw new ControlStoreError("digest_mismatch", "The effect or its readback changed after you reviewed it; review it again.");
    const resolutionId = newId("fxr");
    try {
      await tx.query(
        `insert into platform.external_effect_resolutions (id, workspace_id, effect_id, effect_version, decision, readback_digest, binding_digest, approver_id, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [resolutionId, workspaceId, effectId, e.version, input.decision, e.readback.digest, bindingDigest, approverId, reason]
      );
    } catch {
      throw new ControlStoreError("invalid_state", "The evidence does not allow this resolution yet.", { decision: input.decision });
    }
    const next = await update(tx, e, input.decision === "confirm_applied"
      ? { state: "confirmed", stateReason: reason, providerReceipt: e.providerReceipt ?? receiptFromReadback(e.readback) }
      : { state: "tombstoned", tombstoneReason: "operator_resolved_not_applied", stateReason: reason });
    await event(tx, next, "resolved", e.state, next.state, `user:${approverId}`, e.readback.digest);
    const resolution: EffectResolution = { id: resolutionId, workspaceId, effectId, effectVersion: e.version, decision: input.decision, readbackDigest: e.readback.digest, bindingDigest, approverId, reason, createdAt: new Date().toISOString() };
    return { effect: next, resolution };
  });
}

/**
 * System sweep: a `pending` effect whose dispatcher disappeared (fence no longer live, or no fence and old) becomes
 * `uncertain`. It is NEVER retried. Every returned row carries its workspace; nothing is read from tenant input.
 */
export async function sweepStalePending(sql: Sql, opts: { olderThanMs?: number; limit?: number } = {}): Promise<{ workspaceId: string; effectId: string }[]> {
  const olderThanMs = Math.max(1_000, Math.min(opts.olderThanMs ?? PENDING_STALE_MS, 7 * 86_400_000));
  const limit = clampLimit(opts.limit, 50, 200);
  return sql.tx(async (tx) => {
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from platform.external_effects e
        where e.state = 'pending' and e.updated_at < clock_timestamp() - ($1::bigint * interval '1 millisecond')
          and (e.fence_scope is null or not exists (select 1 from platform.leases l where l.scope = e.fence_scope
                and l.fence_token = e.fence_epoch and l.expires_at > clock_timestamp() and l.released_at is null))
        order by e.updated_at limit $2::bigint for update skip locked`,
      [olderThanMs, limit]
    );
    const out: { workspaceId: string; effectId: string }[] = [];
    for (const row of rows) {
      const e = toEffect(row);
      const next = await update(tx, e, { state: "uncertain", stateReason: "The dispatcher stopped before the provider call was known to have been accepted.", uncertain: true });
      await event(tx, next, "uncertain", "pending", "uncertain", "system:effect-sweeper", null);
      out.push({ workspaceId: e.workspaceId, effectId: e.effectId });
    }
    return out;
  });
}
