/**
 * Shared plumbing for the /releases routes: the release service, the role floor, and the mapping
 * of `ReleaseSafetyError` onto the broker's stable error codes (so the platform error body and the
 * foreign-id-equals-missing-id rule stay as everywhere else).
 */
import type { Principal } from "@/lib/controlplane/types";
import { platformBroker } from "@/lib/capabilities/platform";
import { ROLE_RANK } from "@/lib/capabilities/ports";
import { BrokerError, notFound, type BrokerErrorCode } from "@/lib/capabilities/errors";
import { platformReleaseSafety } from "@/lib/platform/release-safety";
import { ReleaseSafetyError, type ReleaseErrorCode, type ReleaseSafetyService } from "@/lib/release-safety";

const CODE: Record<ReleaseErrorCode, BrokerErrorCode> = {
  invalid_input: "invalid_request",
  invalid_transition: "invalid_state",
  digest_immutable: "conflict",
  provenance_unverified: "invalid_state",
  migration_approval_required: "approval_required",
  approval_invalid: "digest_mismatch",
  rollout_unsupported: "invalid_state",
  rollback_unsafe: "invalid_state",
  not_found: "not_found",
  conflict: "conflict",
  forbidden: "separation_of_duties",
};

export async function withReleases<T>(fn: (svc: ReleaseSafetyService) => Promise<T>): Promise<T> {
  const svc = await platformReleaseSafety();
  if (!svc) throw new BrokerError("platform_store_unavailable", "The platform store is not configured; release records are unavailable.");
  try {
    return await fn(svc);
  } catch (e) {
    if (e instanceof ReleaseSafetyError) {
      if (e.code === "not_found") throw notFound();
      throw new BrokerError(CODE[e.code], e.message);
    }
    throw e;
  }
}

/** The caller's role in the workspace, re-asked on every call. An agent credential needs the matching scope. */
export async function requireRole(principal: Principal, workspaceId: string, min: "viewer" | "admin", scope: "read" | "write"): Promise<void> {
  const broker = await platformBroker();
  const access = await broker.deps.roles.resolve(principal, workspaceId);
  if (ROLE_RANK[access.role] < ROLE_RANK[min]) throw new BrokerError("role_insufficient", `This needs the ${min} role.`);
  if (principal.kind === "integration" && !access.integrationScopes?.includes(scope)) throw new BrokerError("role_insufficient", `This credential lacks the ${scope} scope.`);
}

const ROUTE_ID = /^[A-Za-z0-9_-]{1,100}$/;
export function routeId(id: string): string {
  if (!ROUTE_ID.test(id)) throw notFound();
  return id;
}
