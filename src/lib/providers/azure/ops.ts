/**
 * Shared plumbing for Azure day-two operations (`NativeOperation`).
 *
 * Every mutating operation, before it acts:
 *   1. finds its target by id or Zenith tags (never by name alone);
 *   2. re-checks that the object still carries THIS environment's tags
 *      (`zenith:environment`, `zenith:resource`, `zenith:managed=true`), so an
 *      operation can never touch a resource Zenith does not own here;
 *   3. validates its input against a closed shape (never passes free-form
 *      input into a URL, query or body).
 * ARM offers no idempotency key for these calls; the operation id and fence
 * token travel in `x-ms-client-request-id` (visible in the Azure Activity
 * Log) and the operations themselves are naturally idempotent (same target
 * state). Nothing is written to resource tags: `tags` is a whole-map attribute
 * in azurerm, so an extra tag would surface as drift.
 */
import type { NativeOperationResult } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { ArmError, type ArmResource } from "@/lib/providers/azure/arm";
import type { AzureCtx } from "@/lib/providers/azure/kit";

export const opFailure = (summary: string, extra: Partial<NativeOperationResult> = {}): NativeOperationResult => ({ ok: false, summary, simulated: false, ...extra });

/** Why `res` may not be operated on by this environment's operation, or undefined when it may. */
export function notManagedHere(ctx: AzureCtx, node: ResourceNode, res: ArmResource): string | undefined {
  const env = ctx.tags["zenith:environment"] ?? ctx.environmentId;
  const t = res.tags ?? {};
  if (t["zenith:managed"] !== "true") return "the target is not marked zenith:managed=true";
  if (t["zenith:environment"] !== env) return "the target belongs to a different environment";
  if (t["zenith:resource"] !== node.address) return "the target carries a different zenith:resource tag";
  return undefined;
}

/** `zenith-<operationId>[-f<token>]`, restricted to header-safe characters. */
export function clientRequestId(ctx: AzureCtx): string {
  const op = (ctx.operationId ?? "none").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 48) || "none";
  return `zenith-${op}${ctx.fence ? `-f${ctx.fence.token}` : ""}`;
}

/** An `ArmError` as an operation result (never throws past the driver boundary). */
export function opFailureFromError(e: unknown, what: string): NativeOperationResult {
  if (e instanceof ArmError) {
    return opFailure(`${what} failed: ${e.message}`, {
      requestIds: e.requestId ? [e.requestId] : undefined,
      data: { kind: e.kind, status: e.status, ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}) },
    });
  }
  return opFailure(`${what} failed.`);
}

export function intInRange(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}
