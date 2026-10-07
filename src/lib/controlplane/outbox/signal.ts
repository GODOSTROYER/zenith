/**
 * Durable signal path used by the bridge gateway (PROD-DUR-01).
 *
 * The request is committed as a `workflow_signal` intent BEFORE any transport,
 * then delivered immediately through the same claim/settle path the relay uses.
 * If the process dies, Temporal is down or the workflow is not yet visible, the
 * row stays pending and the relay (critical maintenance job `runner-reaper`)
 * delivers it later. The caller learns the true state: delivered, or recorded
 * and pending, never a silent loss.
 */
import { randomUUID } from "node:crypto";
import { platformDb } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { SIGNALS } from "@/lib/workflows/types";
import { enqueueIntent, getIntent, relayOnce, type IntentHandlers } from "./index";
import { createTemporalIntentHandlers } from "./temporal";

export type DurableSignalResult =
  | { delivered: true }
  | { delivered: false; reason: "not_found" | "pending" };

export async function signalDurably(
  input: { workspaceId: string; operationId: string; signal: keyof typeof SIGNALS; key: string },
  deps: { sql?: Sql; handlers?: IntentHandlers } = {}
): Promise<DurableSignalResult> {
  const sql = deps.sql ?? await platformDb();
  const intent = await enqueueIntent(sql, {
    workspaceId: input.workspaceId, operationId: input.operationId, kind: "workflow_signal",
    idempotencyKey: input.key, payload: { signal: SIGNALS[input.signal] },
  });
  if (intent.state === "delivered") return { delivered: true };
  if (intent.state === "dead") return { delivered: false, reason: intent.outcome === "not_found" ? "not_found" : "pending" };
  await relayOnce(sql, deps.handlers ?? createTemporalIntentHandlers({ sql }), {
    holder: `inline:${randomUUID()}`, only: { workspaceId: input.workspaceId, id: intent.id }, adopt: false,
  });
  const after = await getIntent(sql, input.workspaceId, "workflow_signal", input.key);
  if (after?.state === "delivered") return { delivered: true };
  return { delivered: false, reason: after?.state === "dead" && after.outcome === "not_found" ? "not_found" : "pending" };
}

/** One signal per recorded approval: the key moves with each approval so a second approver's wake-up is not collapsed into the first. */
export async function approvalSignalKey(sql: Sql, workspaceId: string, operationId: string): Promise<string> {
  const rows = await sql.query<{ approval_round: number; n: string | number }>(
    `select o.approval_round, (select count(*) from platform.approvals a where a.workspace_id = o.workspace_id and a.operation_id = o.id and a.approval_round = o.approval_round) as n
       from platform.operations o where o.workspace_id = $1 and o.id = $2`, [workspaceId, operationId]);
  return `approval:${operationId}:${rows[0]?.approval_round ?? 0}:${Number(rows[0]?.n ?? 0)}`;
}
