/**
 * Error translation for the mixed-plan routes: the services refuse with
 * `MixedPlanError` or `ControlStoreError`; the HTTP layer speaks `BrokerError`.
 * A foreign id and a missing id stay the same 404.
 */
import { BrokerError, isBrokerError, notFound } from "@/lib/capabilities/errors";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { MixedPlanError } from "@/lib/execution/mixed/types";

export function toBroker(error: unknown): unknown {
  if (isBrokerError(error)) return error;
  if (error instanceof MixedPlanError) {
    if (error.code === "not_found") return notFound();
    if (error.code === "invalid_input") return new BrokerError("invalid_request", error.message);
    return new BrokerError(error.code === "conflict" ? "conflict" : "invalid_state", error.message, "Fix what the message names, or plan again; nothing was started.", { reason: error.code });
  }
  if (error instanceof ControlStoreError) {
    if (error.code === "not_found" || error.code === "tenant_mismatch") return notFound();
    if (error.code === "invalid_input") return new BrokerError("invalid_request", error.message);
    return new BrokerError(error.code === "conflict" ? "conflict" : error.code === "digest_mismatch" ? "digest_mismatch" : "invalid_state", error.message);
  }
  return error;
}

export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) { throw toBroker(error); }
}
