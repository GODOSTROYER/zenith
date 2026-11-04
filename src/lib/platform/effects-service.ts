/**
 * External-effect service over explicit parts (PROD-DUR-07 / PROD-DUR-08): listing, read-only readback and
 * evidence-bound resolution. The platform composition (`./effects`) and the route tests share this one
 * implementation, so the role rules, the human-only resolution and the error mapping cannot drift.
 * Light on purpose: no broker, credential or provider imports.
 */
import type { Principal, Sql } from "@/lib/controlplane/types";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { repos } from "@/lib/controlplane/db";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { createEffectLedger, type EffectLedger } from "@/lib/effects/ledger";
import { ResolverRegistry, runReadback } from "@/lib/effects/readback";
import { effectView, type EffectView } from "@/lib/effects/view";
import type { ResolutionDecision } from "@/lib/effects/types";

export interface PlatformEffects {
  ledger: EffectLedger;
  list(principal: Principal, workspaceId: string, filter?: { operationId?: string; unresolvedOnly?: boolean }): Promise<EffectView[]>;
  get(principal: Principal, workspaceId: string, effectId: string): Promise<EffectView>;
  /** Read-only independent evidence; editors and admins. */
  readback(principal: Principal, workspaceId: string, effectId: string, signal?: AbortSignal): Promise<EffectView>;
  /** Evidence-based resolution; a verified human admin only. */
  resolve(input: { principal: Principal; workspaceId: string; effectId: string; decision: ResolutionDecision; bindingDigest: string; reason: string }): Promise<EffectView>;
}

export type EffectNeed = "viewer" | "editor" | "admin";

/**
 * The service over explicit parts. The platform composition above and the route tests share it, so the role
 * rules, the human-only resolution and the error mapping are one implementation.
 */
export function createPlatformEffects(deps: { db: Sql; registry: ResolverRegistry; authorize(principal: Principal, workspaceId: string, need: EffectNeed): Promise<void> }): PlatformEffects {
  const { db, registry, authorize } = deps;
  const ledger = createEffectLedger(db);
  const viewOf = async (workspaceId: string, effectId: string): Promise<EffectView> => {
    const effect = await repos.externalEffects.get(db, workspaceId, effectId);
    if (!effect) throw notFound();
    const [events, resolutions, live] = await Promise.all([
      repos.externalEffects.listEvents(db, workspaceId, effectId), repos.externalEffects.listResolutions(db, workspaceId, effectId), repos.externalEffects.isFenceLive(db, workspaceId, effectId),
    ]);
    return effectView(effect, { fenceLive: live, events, resolutions });
  };
  const mapped = <T>(fn: () => Promise<T>): Promise<T> => fn().catch((e: unknown) => {
    if (e instanceof ControlStoreError) {
      if (e.code === "not_found") throw notFound();
      if (e.code === "digest_mismatch") throw new BrokerError("digest_mismatch", e.message);
      if (e.code === "invalid_state" || e.code === "approval_required" || e.code === "conflict") throw new BrokerError("invalid_state", e.message);
      if (e.code === "invalid_input") throw new BrokerError("invalid_request", e.message);
    }
    throw e;
  });

  return {
    ledger,
    list: (principal, workspaceId, filter = {}) => mapped(async () => {
      await authorize(principal, workspaceId, "viewer");
      const rows = await repos.externalEffects.list(db, workspaceId, {
        ...(filter.operationId ? { operationId: filter.operationId } : {}),
        ...(filter.unresolvedOnly ? { states: ["pending", "accepted", "uncertain", "conflict"], includeContradicted: true } : {}),
      });
      return Promise.all(rows.map(async (e) => effectView(e, { fenceLive: await repos.externalEffects.isFenceLive(db, workspaceId, e.effectId) })));
    }),
    get: (principal, workspaceId, effectId) => mapped(async () => {
      await authorize(principal, workspaceId, "viewer");
      return viewOf(workspaceId, effectId);
    }),
    readback: (principal, workspaceId, effectId, signal) => mapped(async () => {
      await authorize(principal, workspaceId, "editor");
      if (!(await repos.externalEffects.get(db, workspaceId, effectId))) throw notFound();
      await runReadback(db, registry, { workspaceId, effectId, actor: `${principal.kind}:${principal.id}`, signal });
      return viewOf(workspaceId, effectId);
    }),
    resolve: (input) => mapped(async () => {
      if (input.principal.kind !== "user") throw new BrokerError("browser_session_required", "Only a signed-in person can resolve an uncertain effect.");
      await authorize(input.principal, input.workspaceId, "admin");
      await repos.externalEffects.resolve(db, { workspaceId: input.workspaceId, effectId: input.effectId, decision: input.decision, bindingDigest: input.bindingDigest, approverId: input.principal.id, reason: input.reason });
      return viewOf(input.workspaceId, input.effectId);
    }),
  };
}
