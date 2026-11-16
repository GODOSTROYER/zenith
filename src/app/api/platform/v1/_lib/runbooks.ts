/**
 * Shared plumbing for the /runbooks routes: composition access and the mapping of
 * `RunbookError` onto the broker's stable error codes (so the platform error body
 * and the foreign-id-equals-missing-id rule stay exactly as everywhere else).
 */
import { BrokerError, notFound, type BrokerErrorCode } from "@/lib/capabilities/errors";
import { platformRunbooks, type PlatformRunbooks } from "@/lib/platform/runbooks";
import { RunbookError, type RunbookErrorCode } from "@/lib/machines/runbooks";

const CODE: Record<RunbookErrorCode, BrokerErrorCode> = {
  invalid_definition: "invalid_request",
  invalid_binding: "invalid_request",
  signature_invalid: "invalid_state",
  not_found: "not_found",
  conflict: "conflict",
  approval_required: "approval_required",
  approval_invalid: "approval_required",
  outside_window: "invalid_state",
  forbidden: "role_insufficient",
};

export async function withRunbooks<T>(fn: (rb: PlatformRunbooks) => Promise<T>): Promise<T> {
  let rb: PlatformRunbooks;
  try {
    rb = await platformRunbooks();
  } catch (e) {
    if (e instanceof RunbookError) throw new BrokerError("platform_store_unavailable", e.message);
    throw e;
  }
  try {
    return await fn(rb);
  } catch (e) {
    if (e instanceof RunbookError) {
      if (e.code === "not_found") throw notFound();
      throw new BrokerError(CODE[e.code], e.message, undefined, e.issues.length ? { issues: [...e.issues] } : undefined);
    }
    throw e;
  }
}

const ROUTE_ID = /^[A-Za-z0-9_-]{1,100}$/;
export function routeId(id: string): string {
  if (!ROUTE_ID.test(id)) throw notFound();
  return id;
}
