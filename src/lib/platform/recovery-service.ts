/**
 * Operator continuation after a restore (PROD-OPS-04), over explicit parts: the status of the recovery epoch, the
 * work list a restore opened, and the human decision on one item. The platform composition (`./recovery`) and the
 * route tests share this implementation, so the role rules, the human-only decision and the error mapping cannot
 * drift. The epoch itself is bumped only by the restore runbook (`scripts/ops/recovery.ts restore`), never here.
 */
import type { Principal, Sql } from "@/lib/controlplane/types";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import {
  decideItem, getRecoveryItem, listRecoveryItems, recoveryStatus,
  type RecoveryDecision, type RecoveryItem, type RecoveryItemState, type RecoveryStatus,
} from "@/lib/controlplane/recovery";

export type RecoveryNeed = "viewer" | "editor" | "admin";

export interface PlatformRecovery {
  status(principal: Principal, workspaceId: string): Promise<RecoveryStatus>;
  list(principal: Principal, workspaceId: string, filter?: { state?: RecoveryItemState; limit?: number }): Promise<RecoveryItem[]>;
  get(principal: Principal, workspaceId: string, itemId: string): Promise<RecoveryItem>;
  /** A signed-in human admin only; bound to the exact item state they reviewed. */
  decide(input: { principal: Principal; workspaceId: string; itemId: string; decision: RecoveryDecision; bindingDigest: string; reason: string }): Promise<RecoveryItem>;
}

export function createPlatformRecovery(deps: { db: Sql; authorize(principal: Principal, workspaceId: string, need: RecoveryNeed): Promise<void> }): PlatformRecovery {
  const { db, authorize } = deps;
  const mapped = <T>(fn: () => Promise<T>): Promise<T> => fn().catch((e: unknown) => {
    if (e instanceof ControlStoreError) {
      if (e.code === "not_found") throw notFound();
      if (e.code === "digest_mismatch") throw new BrokerError("digest_mismatch", e.message);
      if (e.code === "invalid_state" || e.code === "conflict") throw new BrokerError("invalid_state", e.message);
      if (e.code === "invalid_input") throw new BrokerError("invalid_request", e.message);
    }
    throw e;
  });
  return {
    status: (principal, workspaceId) => mapped(async () => {
      await authorize(principal, workspaceId, "viewer");
      return recoveryStatus(db, workspaceId);
    }),
    list: (principal, workspaceId, filter = {}) => mapped(async () => {
      await authorize(principal, workspaceId, "viewer");
      return listRecoveryItems(db, workspaceId, filter);
    }),
    get: (principal, workspaceId, itemId) => mapped(async () => {
      await authorize(principal, workspaceId, "viewer");
      const item = await getRecoveryItem(db, workspaceId, itemId);
      if (!item) throw notFound();
      return item;
    }),
    decide: (input) => mapped(async () => {
      if (input.principal.kind !== "user") throw new BrokerError("browser_session_required", "Only a signed-in person can decide what happens to work that was in flight at a restore.");
      await authorize(input.principal, input.workspaceId, "admin");
      return decideItem(db, { workspaceId: input.workspaceId, itemId: input.itemId, decision: input.decision, actor: `${input.principal.kind}:${input.principal.id}`, reason: input.reason, bindingDigest: input.bindingDigest });
    }),
  };
}
