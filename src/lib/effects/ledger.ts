/**
 * The dispatch discipline for external effects (PROD-DUR-07 / PROD-DUR-08).
 *
 *   dispatchOnce(begin input, call)
 *
 * records the effect BEFORE the provider call, performs the call at most once
 * for a (family, dedupKey) identity, and records the outcome:
 *
 *   - a second caller (retried activity, new worker, another lease holder, a
 *     replayed workflow) finds the existing effect and never calls the provider:
 *       accepted / confirmed  -> the saved receipt is returned (deduplicated)
 *       pending / uncertain / conflict -> refused as unresolved
 *       tombstoned            -> refused: a new operation is required
 *   - a provider that answers: the receipt is stored, even when the lease or
 *     approval that started the call is gone by now (late response = evidence)
 *   - a provider that definitively refuses before accepting: tombstoned
 *   - anything else (timeout, reset, abort, lost lease, crash): uncertain
 *
 * Nothing in this file calls a provider itself.
 */
import type { Sql } from "@/lib/controlplane/types";
import { externalEffects as store } from "@/lib/controlplane/db/repos";
import type { BeginEffectInput } from "@/lib/controlplane/db/repos/external-effects";
import type { EffectRecord, ProviderReceipt, Readback } from "./types";

export class EffectUnresolvedError extends Error {
  readonly code = "effect_unresolved";
  constructor(
    readonly effectId: string,
    readonly state: EffectRecord["state"],
    message = `An earlier provider call (${state}) is not resolved. It will not be repeated. Inspect the effect, run its readback, and resolve it with a fresh authorization.`
  ) {
    super(message);
    this.name = "EffectUnresolvedError";
  }
}

export class EffectTombstonedError extends Error {
  readonly code = "effect_tombstoned";
  constructor(readonly effectId: string) {
    super("This effect was retired and will not be repeated. Propose a new operation to try again.");
    this.name = "EffectTombstonedError";
  }
}

export type DispatchOutcome<T> =
  | { kind: "dispatched"; effect: EffectRecord; value: T }
  | { kind: "deduplicated"; effect: EffectRecord };

/** Whether a thrown error proves the provider did not accept the call. Default: it does not. */
export type FailureClass = "rejected" | "unknown";

export interface EffectLedger {
  begin(input: Omit<BeginEffectInput, "actor"> & { actor?: string }): Promise<{ created: boolean; effect: EffectRecord }>;
  get(workspaceId: string, effectId: string): Promise<EffectRecord | null>;
  getByDedup(workspaceId: string, family: EffectRecord["family"], dedupKey: string): Promise<EffectRecord | null>;
  list: (workspaceId: string, filter?: Parameters<typeof store.list>[2]) => Promise<EffectRecord[]>;
  recordAccepted(workspaceId: string, effectId: string, receipt: ProviderReceipt, actor?: string): Promise<EffectRecord>;
  markUncertain(workspaceId: string, effectId: string, reason: string, actor?: string): Promise<EffectRecord>;
  recordReadback(workspaceId: string, effectId: string, readback: Readback, actor?: string): Promise<EffectRecord>;
  recordRejected(workspaceId: string, effectId: string, reason: string, actor?: string): Promise<EffectRecord>;
  /** Errors if any effect of the operation is unresolved (pending, uncertain or conflict, or tombstoned with a late receipt). */
  unresolvedForOperation(workspaceId: string, operationId: string): Promise<EffectRecord[]>;
  dispatchOnce<T>(
    input: Omit<BeginEffectInput, "actor"> & { actor?: string },
    call: (effect: EffectRecord) => Promise<{ value: T; receipt: ProviderReceipt }>,
    classify?: (error: unknown) => FailureClass
  ): Promise<DispatchOutcome<T>>;
}

const DEFAULT_ACTOR = "system:worker";

export function createEffectLedger(sql: Sql): EffectLedger {
  const ledger: EffectLedger = {
    begin: (input) => store.begin(sql, { ...input, actor: input.actor ?? DEFAULT_ACTOR }),
    get: (ws, id) => store.get(sql, ws, id),
    getByDedup: (ws, family, key) => store.getByDedup(sql, ws, family, key),
    list: (ws, filter) => store.list(sql, ws, filter),
    recordAccepted: (ws, id, receipt, actor) => store.recordAccepted(sql, { workspaceId: ws, effectId: id, receipt, actor: actor ?? DEFAULT_ACTOR }),
    markUncertain: (ws, id, reason, actor) => store.markUncertain(sql, { workspaceId: ws, effectId: id, reason, actor: actor ?? DEFAULT_ACTOR }),
    recordReadback: (ws, id, readback, actor) => store.recordReadback(sql, { workspaceId: ws, effectId: id, readback, actor: actor ?? DEFAULT_ACTOR }),
    recordRejected: (ws, id, reason, actor) => store.recordRejected(sql, { workspaceId: ws, effectId: id, reason, actor: actor ?? DEFAULT_ACTOR }),
    unresolvedForOperation: (ws, operationId) =>
      store.list(sql, ws, { operationId, states: ["pending", "uncertain", "conflict"], includeContradicted: true }),
    async dispatchOnce(input, call, classify = () => "unknown") {
      const { created, effect } = await ledger.begin(input);
      if (!created) {
        if (effect.state === "accepted" || effect.state === "confirmed") return { kind: "deduplicated", effect };
        if (effect.state === "tombstoned") throw new EffectTombstonedError(effect.effectId);
        throw new EffectUnresolvedError(effect.effectId, effect.state);
      }
      let result: { value: unknown; receipt: ProviderReceipt };
      try {
        result = await call(effect);
      } catch (error) {
        let failure: FailureClass = "unknown";
        try { failure = classify(error); } catch { /* an unclassifiable failure is unknown */ }
        // Recording the failure must itself never throw over the real error: a missed write leaves `pending`,
        // which the sweeper declares uncertain. It can never become a retry.
        const settled = await (failure === "rejected"
          ? ledger.recordRejected(effect.workspaceId, effect.effectId, "The provider refused the call before accepting it.", input.actor)
          : ledger.markUncertain(effect.workspaceId, effect.effectId, "The provider call ended without a confirmed outcome.", input.actor)
        ).catch(() => undefined);
        if (settled?.state === "tombstoned") throw error;
        throw new EffectUnresolvedError(effect.effectId, settled?.state ?? "pending", "The provider call ended without a confirmed outcome. It will not be repeated; inspect and resolve the effect.");
      }
      let accepted: EffectRecord;
      try {
        accepted = await ledger.recordAccepted(effect.workspaceId, effect.effectId, result.receipt, input.actor);
      } catch {
        // The provider accepted but the receipt could not be stored. Never retry; the readback finds it.
        await ledger.markUncertain(effect.workspaceId, effect.effectId, "The provider accepted the call but its receipt could not be recorded.", input.actor).catch(() => undefined);
        throw new EffectUnresolvedError(effect.effectId, "uncertain", "The provider accepted the call but Zenith could not record the receipt. It will not be repeated; resolve the effect from readback.");
      }
      return { kind: "dispatched", effect: accepted, value: result.value as never };
    },
  };
  return ledger;
}
