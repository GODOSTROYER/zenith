/**
 * Optimizer memory from durable records.
 *
 * Cooldown, reversal lockout and the per-window change bound must survive a
 * worker restart, so nothing here is held in process memory: the history is
 * rebuilt on every run from the control store's `service.scale` operations.
 * That includes operations nobody at the optimizer made (a person scaling the
 * same service by hand cools it down too), and operations a human rejected or
 * that expired (so a declined proposal is not re-proposed every pass).
 *
 * An operation created by the optimizer carries `input.optimizer` with the
 * exact field, from, to and cost shift. Any other scale operation is read from
 * its own `replicas` / `size`, with an unknown `from` (it still counts for
 * cooldown and window size, and can never match a reversal).
 */
import type { OperationRecord } from "@/lib/controlplane/types";
import type { BrokerStore } from "@/lib/capabilities/ports";
import type { OptimizationField, OptimizationHistoryEntry, OptimizationKind } from "@/lib/placement/optimizer";

const REJECTED: ReadonlySet<string> = new Set(["rejected", "denied", "cancelled", "expired", "failed"]);

export class OptimizerHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimizerHistoryError";
  }
}

const isScalar = (v: unknown): v is string | number => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** Pure: map operation records to history entries. `addressOfResource` maps the scoped resource id back to a graph address. */
export function historyFromOperations(ops: readonly OperationRecord[], addressOfResource: (resourceId: string) => string | undefined): OptimizationHistoryEntry[] {
  const out: OptimizationHistoryEntry[] = [];
  for (const op of ops) {
    if (op.capability !== "service.scale" || !op.resourceId) continue;
    const input = (op.proposal?.input ?? {}) as Record<string, unknown>;
    const address = addressOfResource(op.resourceId);
    if (!address) continue;
    const status: OptimizationHistoryEntry["status"] = op.status === "succeeded" ? "applied" : REJECTED.has(op.status) ? "rejected" : "proposed";
    const meta = input.optimizer as Record<string, unknown> | undefined;
    if (meta && (meta.field === "spec.size" || meta.field === "spec.replicas") && isScalar(meta.from) && isScalar(meta.to)) {
      const field = meta.field as OptimizationField;
      out.push({
        address,
        field,
        kind: (field === "spec.size" ? "rightsize_size" : "rightsize_replicas") as OptimizationKind,
        from: meta.from,
        to: meta.to,
        at: op.createdAt,
        status,
        ...(typeof meta.monthlyUsdShift === "number" ? { monthlyUsdShift: meta.monthlyUsdShift } : {}),
      });
      continue;
    }
    for (const [key, field, kind] of [
      ["replicas", "spec.replicas", "rightsize_replicas"],
      ["size", "spec.size", "rightsize_size"],
    ] as const) {
      const to = input[key];
      if (isScalar(to)) out.push({ address, field, kind, from: "unknown", to, at: op.createdAt, status });
    }
  }
  return out;
}

/**
 * Read every `service.scale` operation of an environment created at or after
 * `sinceIso`. Throws when the bounded read would be incomplete: a truncated
 * ledger is never treated as "no recent changes".
 */
export async function loadScaleOperations(
  store: Pick<BrokerStore, "listOperations">,
  workspaceId: string,
  environmentId: string,
  sinceIso: string,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<OperationRecord[]> {
  const limit = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 5;
  const since = Date.parse(sinceIso);
  const found: OperationRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await store.listOperations(workspaceId, { environmentId, capability: "service.scale" }, { limit, ...(cursor ? { cursor } : {}) });
    for (const op of res.items) if (Date.parse(op.createdAt) >= since) found.push(op);
    const oldest = res.items.at(-1);
    if (!res.nextCursor || !oldest || Date.parse(oldest.createdAt) < since) return found;
    cursor = res.nextCursor;
  }
  throw new OptimizerHistoryError("The service.scale operation history within the window is longer than the bounded read; refusing to optimize on an incomplete history.");
}
