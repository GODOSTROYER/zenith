/**
 * Event service: small, stable helpers over the events repository so other
 * subsystems emit consistent, correlated events without re-deriving ids.
 *
 * Convention: one `correlationId` per logical flow (a deploy, an incident); an
 * operation's events use the operation's own correlation id; `causationId`
 * names the event/operation that caused this one.
 */
import { randomUUID } from "node:crypto";
import type { OperationRecord, PlatformEventType, Principal, Sql } from "@/lib/controlplane/types";
import { append, list, type AppendEventInput, type ListEventsFilter } from "@/lib/controlplane/db/repos/events";

export { append, list };
export type { AppendEventInput, ListEventsFilter };

/** A fresh correlation id for a new logical flow. */
export function newCorrelationId(): string {
  return `corr_${randomUUID()}`;
}

/** Append an event about an operation, inheriting its scope and correlation id. Returns `seq`. */
export async function emitForOperation(
  sql: Sql,
  op: Pick<OperationRecord, "id" | "workspaceId" | "projectId" | "environmentId" | "resourceId" | "correlationId">,
  type: PlatformEventType,
  extra: { actor?: Principal; causationId?: string; data?: Record<string, unknown> } = {}
): Promise<number> {
  return append(sql, {
    type,
    workspaceId: op.workspaceId,
    projectId: op.projectId,
    environmentId: op.environmentId,
    resourceId: op.resourceId,
    operationId: op.id,
    correlationId: op.correlationId,
    causationId: extra.causationId,
    actor: extra.actor,
    data: extra.data,
  });
}
