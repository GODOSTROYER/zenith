/**
 * Ledger glue for external cleanup effects (PROD-DUR-08): the destructive apply of a reviewed destroy plan.
 *
 * One effect per (operation, reviewed plan digest). The effect is recorded immediately before the destructive
 * provider call. A retried activity, a new worker or another lease holder finds it and never applies again:
 * an accepted effect returns its saved result; a pending, uncertain or conflicting one refuses. The independent
 * readback for this family is Zenith's own reconcile observation of the reviewed addresses (see
 * `cleanupObservationResolver`); it never trusts the apply's own report.
 *
 * Plan custody and writer barriers (DUR-C) are not touched: this only adds the receipt around the call.
 */
import { digest } from "@/lib/controlplane/digest";
import { EffectTombstonedError, EffectUnresolvedError, type EffectLedger } from "./ledger";
import type { EffectRecord } from "./types";

export interface CleanupEffectScope {
  workspaceId: string;
  operationId: string;
  environmentId: string;
  provider: string;
  planDigest: string;
  /** the reviewed destroy addresses; also the readback targets */
  addresses: readonly string[];
  fence: { scope: string; token: number };
}

export const cleanupDedupKey = (operationId: string, planDigest: string): string => `destroy:${operationId}:${planDigest}`;

function inputOf(s: CleanupEffectScope) {
  const addresses = [...new Set(s.addresses)].sort();
  return {
    workspaceId: s.workspaceId,
    family: "cleanup_apply" as const,
    operationId: s.operationId,
    environmentId: s.environmentId,
    provider: s.provider,
    dedupKey: cleanupDedupKey(s.operationId, s.planDigest),
    requestDigest: digest({ kind: "zenith.cleanup-apply.v1", workspaceId: s.workspaceId, operationId: s.operationId, environmentId: s.environmentId, planDigest: s.planDigest, addresses }),
    // Addresses can be numerous; the target keeps their count and digest. The readback loads the list from the
    // reviewed plan's evidence and verifies it against this digest.
    target: { environmentId: s.environmentId, planDigest: s.planDigest, addressCount: addresses.length, addressesDigest: digest(addresses) },
    // The providers' destroy paths (tofu state, provider teardown) are idempotent by construction but give no
    // client token; the ledger, not a token, supplies the no-replay rule.
    idempotencySupported: false,
    fence: s.fence,
  };
}

/**
 * Called before any apply work. Returns the saved result when this exact destroy already completed; refuses when an
 * earlier attempt is unresolved or retired; returns undefined when no effect exists yet.
 */
export async function priorCleanupResult(ledger: EffectLedger, s: CleanupEffectScope): Promise<{ deleted: number } | undefined> {
  const existing = await ledger.getByDedup(s.workspaceId, "cleanup_apply", cleanupDedupKey(s.operationId, s.planDigest));
  if (!existing) return undefined;
  if (existing.state === "accepted" || existing.state === "confirmed") {
    const n = Number(existing.providerReceipt?.identity?.deleted);
    return { deleted: Number.isFinite(n) && n >= 0 ? n : 0 };
  }
  if (existing.state === "tombstoned") throw new EffectTombstonedError(existing.effectId);
  throw new EffectUnresolvedError(existing.effectId, existing.state);
}

/** Record the effect immediately before the destructive call. A second caller is refused here, never allowed to apply. */
export async function beginCleanupEffect(ledger: EffectLedger, s: CleanupEffectScope): Promise<EffectRecord> {
  const { created, effect } = await ledger.begin(inputOf(s));
  if (!created) throw effect.state === "tombstoned" ? new EffectTombstonedError(effect.effectId) : new EffectUnresolvedError(effect.effectId, effect.state);
  return effect;
}

/** The provider call returned: store its receipt even if the lease or approval is gone by now. */
export async function acceptCleanupEffect(ledger: EffectLedger, effect: EffectRecord, deleted: number): Promise<EffectRecord> {
  return ledger.recordAccepted(effect.workspaceId, effect.effectId, {
    resourceId: `destroy:${effect.requestDigest.slice(0, 32)}`,
    requestIds: [],
    identity: { deleted: String(deleted) },
  }, "system:destroy-worker");
}

/** The call ended without a known outcome. Only a still-pending effect becomes uncertain; an accepted one keeps its receipt. */
export async function uncertainCleanupEffect(ledger: EffectLedger, effect: EffectRecord, reason: string): Promise<void> {
  const current = await ledger.get(effect.workspaceId, effect.effectId).catch(() => null);
  if (current && current.state !== "pending") return;
  await ledger.markUncertain(effect.workspaceId, effect.effectId, reason, "system:destroy-worker").catch(() => undefined);
}
