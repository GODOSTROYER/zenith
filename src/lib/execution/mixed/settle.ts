/**
 * The parent's final status is a function of durable receipts, never of what a
 * caller says. `succeeded` is honoured only when every child of the plan has a
 * `succeeded` receipt; anything less is `uncertain` (evidence missing), because
 * "all done" without proof is not a claim Zenith makes.
 */
import type { Sql } from "@/lib/controlplane/types";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import type { ChildTerminalOutcome } from "./types";

export async function settleOutcome(sql: Sql, input: { workspaceId: string; planId: string; requested: ChildTerminalOutcome }): Promise<ChildTerminalOutcome> {
  if (input.requested !== "succeeded") return input.requested;
  const [children, receipts] = await Promise.all([plans.listChildren(sql, input.workspaceId, input.planId), plans.listReceipts(sql, input.workspaceId, input.planId)]);
  const ok = children.length > 0 && children.every((child) => child.state === "succeeded" && receipts.some((receipt) => receipt.partitionId === child.partitionId && receipt.outcome === "succeeded"));
  return ok ? "succeeded" : "uncertain";
}
