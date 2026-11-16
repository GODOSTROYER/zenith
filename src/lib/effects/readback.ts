/**
 * Readback: independent, read-only evidence about whether an effect landed.
 *
 * A resolver reads the provider (or Zenith's own independent observation
 * store) and answers about the EFFECT, not about the resource:
 *
 *   present      the effect's result was observed, exactly once and matching
 *   absent       the effect's result was not observed
 *   mismatch     duplicates, a different identity, or a contradiction
 *   unavailable  the read failed or the provider offers no independent read
 *
 * A resolver never mutates anything and never retries the effect. Whether the
 * answer is enough to resolve an effect is decided by the ledger store, the
 * database trigger and a human approver, not here.
 */
import type { Sql } from "@/lib/controlplane/types";
import { externalEffects as store } from "@/lib/controlplane/db/repos";
import { digest } from "@/lib/controlplane/digest";
import { buildReadback } from "./binding";
import type { EffectFamily, EffectRecord, Readback } from "./types";
import { ABSENCE_SETTLE_MS } from "./types";

export interface ReadbackRequest {
  effect: EffectRecord;
  signal: AbortSignal;
}

export type ReadbackFinding = Omit<Readback, "digest" | "observedAt"> & { observedAt?: string };

export interface EffectResolver {
  family: EffectFamily;
  /** `*` matches every provider */
  provider: string;
  read(request: ReadbackRequest): Promise<ReadbackFinding>;
}

export class ResolverRegistry {
  private readonly resolvers: EffectResolver[] = [];
  constructor(resolvers: readonly EffectResolver[] = []) {
    for (const r of resolvers) this.add(r);
  }
  add(resolver: EffectResolver): this {
    this.resolvers.push(resolver);
    return this;
  }
  find(effect: Pick<EffectRecord, "family" | "provider">): EffectResolver | undefined {
    return this.resolvers.find((r) => r.family === effect.family && (r.provider === effect.provider)) ?? this.resolvers.find((r) => r.family === effect.family && r.provider === "*");
  }
}

export const NO_INDEPENDENT_READBACK = "This provider offers no independent readback for this effect, so it cannot be resolved by evidence. It stays uncertain until a readback exists.";

/**
 * Run the resolver for one effect and record what it found. Failures of the read itself are recorded as
 * `unavailable` evidence; a resolver exception never alters the effect's state.
 */
export async function runReadback(
  sql: Sql,
  registry: ResolverRegistry,
  input: { workspaceId: string; effectId: string; actor: string; signal?: AbortSignal; now?: () => Date }
): Promise<EffectRecord> {
  const effect = await store.get(sql, input.workspaceId, input.effectId);
  if (!effect) throw Object.assign(new Error("Effect not found."), { code: "not_found" });
  if (effect.state === "confirmed" || effect.state === "tombstoned") return effect;
  const now = input.now ?? (() => new Date());
  const resolver = registry.find(effect);
  let finding: ReadbackFinding;
  if (!resolver) finding = { outcome: "unavailable", source: "none", facts: {}, reason: NO_INDEPENDENT_READBACK };
  else {
    try {
      finding = await resolver.read({ effect, signal: input.signal ?? AbortSignal.timeout(60_000) });
    } catch {
      // Provider errors can carry request details; keep a fixed reason.
      finding = { outcome: "unavailable", source: `${resolver.provider}.${resolver.family}`, facts: {}, reason: "The independent read failed; try again." };
    }
  }
  const readback = buildReadback({ ...finding, observedAt: finding.observedAt ?? now().toISOString() });
  return store.recordReadback(sql, { workspaceId: input.workspaceId, effectId: input.effectId, readback, actor: input.actor });
}

/* ------------------------- cleanup: independent observations -------------------------- */

export interface ObservationFact {
  address: string;
  presence: "present" | "missing" | "unknown";
  observedAt: string;
  simulated: boolean;
}

export interface CleanupReadbackDeps {
  /** The reviewed destroy addresses (from the plan evidence of the effect's operation and plan digest). */
  reviewedAddresses(effect: EffectRecord): Promise<string[] | undefined>;
  /** latest independent (reconcile) observation per resource of the environment */
  latestObservations(workspaceId: string, environmentId: string): Promise<ObservationFact[]>;
  now?: () => Date;
}

/**
 * `cleanup_apply` effects: the apply is the destructive call; the independent readback is Zenith's own reconcile
 * observation of the reviewed addresses, taken AFTER the call could have started. Every address must have such an
 * observation. All missing -> present (the deletion is observed). All still present -> absent. A mix is reported as
 * absent with `partial`, because the destroy did not complete; resolving it only retires this effect identity, and a
 * new destroy operation is planned from observed state and approved separately.
 */
export function cleanupObservationResolver(deps: CleanupReadbackDeps): EffectResolver {
  return {
    family: "cleanup_apply",
    provider: "*",
    async read({ effect }): Promise<ReadbackFinding> {
      const environmentId = effect.environmentId;
      const source = "zenith.reconcile.observations";
      const loaded = await deps.reviewedAddresses(effect);
      const addresses = loaded ? [...new Set(loaded)].sort() : [];
      if (!environmentId || addresses.length === 0 || digest(addresses) !== effect.target.addressesDigest)
        return { outcome: "unavailable", source, facts: {}, reason: "The reviewed destroy addresses could not be loaded or no longer match the effect." };
      const dispatchedAt = Date.parse(effect.createdAt);
      const byAddress = new Map((await deps.latestObservations(effect.workspaceId, environmentId)).map((o) => [o.address, o]));
      let missing = 0, present = 0, unreadable = 0, stale = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const address of addresses) {
        const o = byAddress.get(address);
        if (!o || o.simulated || o.presence === "unknown") { unreadable++; continue; }
        const at = Date.parse(o.observedAt);
        if (!Number.isFinite(at) || at < dispatchedAt) { stale++; continue; }
        oldest = Math.min(oldest, at);
        if (o.presence === "missing") missing++; else present++;
      }
      const facts = { addresses: addresses.length, missing, present, unreadable, notNewerThanDispatch: stale, partial: missing > 0 && present > 0 };
      if (unreadable > 0 || stale > 0)
        return { outcome: "unavailable", source, facts, reason: "Every reviewed address needs a real observation taken after the destroy was dispatched. Wait for or trigger a reconcile pass." };
      if (present === 0) return { outcome: "present", source, facts, resourceId: `${environmentId}:${addresses.length}` };
      // Absence of the deletion must not be explained by a call still in flight.
      const settled = Math.max(Date.parse(effect.uncertainAt ?? effect.createdAt), dispatchedAt) + ABSENCE_SETTLE_MS;
      if (oldest < settled) return { outcome: "unavailable", source, facts: { ...facts, settledAfter: new Date(settled).toISOString() }, reason: "The observations were taken before the settle window ended; observe again after it." };
      return { outcome: "absent", source, facts };
    },
  };
}
