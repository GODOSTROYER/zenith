/**
 * Pure helpers shared by the ledger store, the resolvers, the API and the UX
 * projection. Nothing here reads a database or a provider.
 */
import { digest } from "@/lib/controlplane/digest";
import {
  ABSENCE_SETTLE_MS,
  type EffectRecord,
  type EffectState,
  type ProviderReceipt,
  type Readback,
  type ResolutionDecision,
} from "./types";

export function receiptDigest(receipt: ProviderReceipt): string {
  return digest({
    resourceId: receipt.resourceId ?? null,
    requestIds: [...receipt.requestIds].sort(),
    identity: receipt.identity ?? null,
  });
}

/** Build a readback with its digest. `observedAt` is part of the digest: a fresher read invalidates an earlier approval. */
export function buildReadback(input: Omit<Readback, "digest">): Readback {
  const body = {
    outcome: input.outcome,
    source: input.source,
    observedAt: input.observedAt,
    resourceId: input.resourceId ?? null,
    requestIds: input.requestIds ? [...input.requestIds].sort() : null,
    facts: input.facts,
    reason: input.reason ?? null,
  };
  return { ...input, digest: digest(body) };
}

/** What an approver reviews and signs: this exact effect version, this exact readback, this decision. */
export function resolutionBinding(
  effect: Pick<EffectRecord, "workspaceId" | "effectId" | "family" | "requestDigest" | "version">,
  decision: ResolutionDecision,
  readbackDigest: string
): string {
  return digest({
    kind: "zenith.effect-resolution.v1",
    workspaceId: effect.workspaceId,
    effectId: effect.effectId,
    family: effect.family,
    requestDigest: effect.requestDigest,
    version: effect.version,
    decision,
    readbackDigest,
  });
}

/** An unresolved effect that has a late receipt after a tombstone is shown as a conflict; the database state stays tombstoned. */
export function projectedState(effect: Pick<EffectRecord, "state" | "lateReceipt">): EffectState {
  if (effect.state === "tombstoned" && effect.lateReceipt) return "conflict";
  return effect.state;
}

export interface ResolutionOption {
  decision: ResolutionDecision;
  available: boolean;
  /** present when available */
  bindingDigest?: string;
  /** present when not available: what is missing */
  blockedBy?: string;
}

/**
 * Which resolutions can be authorized right now. `fenceLive` is whether the
 * lease that dispatched the effect still holds its fence (a renewed lease
 * does); the database trigger re-checks both facts at write time.
 */
export function resolutionOptions(effect: EffectRecord, fenceLive: boolean): ResolutionOption[] {
  const unresolved = effect.state === "uncertain" || effect.state === "conflict";
  const rb = effect.readback;
  const applied: ResolutionOption = { decision: "confirm_applied", available: false };
  const notApplied: ResolutionOption = { decision: "confirm_not_applied", available: false };
  if (!unresolved) {
    applied.blockedBy = notApplied.blockedBy = "This effect does not need resolution.";
    return [applied, notApplied];
  }
  if (!rb) {
    applied.blockedBy = notApplied.blockedBy = "No independent readback has been recorded yet. Run readback first.";
    return [applied, notApplied];
  }
  if (rb.outcome === "present" && effect.providerReceipt?.resourceId && effect.providerReceipt.resourceId !== rb.resourceId) {
    applied.blockedBy = "The recorded receipt and the readback name different provider objects.";
  } else if (rb.outcome === "present") {
    applied.available = true;
    applied.bindingDigest = resolutionBinding(effect, "confirm_applied", rb.digest);
  } else applied.blockedBy = rb.outcome === "absent" ? "Readback found nothing to confirm." : `Readback was ${rb.outcome}; it cannot confirm the effect.`;
  if (rb.outcome !== "absent") notApplied.blockedBy = rb.outcome === "present" ? "Readback found the effect; it cannot be declared not applied." : `Readback was ${rb.outcome}; it cannot prove absence.`;
  else if (effect.lateReceipt) notApplied.blockedBy = "A late provider receipt arrived; absence cannot be accepted.";
  else if (fenceLive) notApplied.blockedBy = "The lease that dispatched this effect is still live, so the call may still be in flight.";
  else {
    const base = Date.parse(effect.uncertainAt ?? effect.createdAt);
    const settled = Math.max(base, Date.parse(effect.createdAt)) + ABSENCE_SETTLE_MS;
    if (Date.parse(rb.observedAt) < settled) notApplied.blockedBy = `The absence read was taken before the ${Math.round(ABSENCE_SETTLE_MS / 60000)} minute settle window ended; read again after ${new Date(settled).toISOString()}.`;
    else {
      notApplied.available = true;
      notApplied.bindingDigest = resolutionBinding(effect, "confirm_not_applied", rb.digest);
    }
  }
  return [applied, notApplied];
}

/** Receipt synthesized from a `present` readback when an operator confirms an effect that never returned its receipt. */
export function receiptFromReadback(readback: Readback): ProviderReceipt {
  return { ...(readback.resourceId ? { resourceId: readback.resourceId } : {}), requestIds: readback.requestIds ?? [] };
}
