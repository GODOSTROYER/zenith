/**
 * Shared plumbing of the mixed-run routes (PROD-MIX-03/04): the production service composition and the
 * mapping of orchestration refusals to the platform's typed HTTP errors. Refusals name codes and ids only.
 */
import { BrokerError, notFound, type BrokerErrorCode } from "@/lib/capabilities/errors";
import { isMemoryStoreEnabled, platformBroker, type Broker } from "@/lib/capabilities/platform";
import { ROLE_RANK } from "@/lib/capabilities/ports";
import type { Principal, Sql } from "@/lib/controlplane/types";
import { MixedOrchestrationError, type MixedOrchestrationErrorCode } from "@/lib/execution/mixed-orchestration/errors";
import { platformMixedRunDeps } from "@/lib/execution/mixed-orchestration/platform";
import type { MixedRunDeps } from "@/lib/execution/mixed-orchestration/service";

const STATUS: Record<MixedOrchestrationErrorCode, BrokerErrorCode> = {
  invalid_input: "invalid_request", dependency_cycle: "invalid_state", unknown_child: "not_found", contract_mismatch: "invalid_request", scope_mismatch: "invalid_request",
  output_provenance: "invalid_state", secret_value: "secret_material", producer_not_succeeded: "invalid_state", stale_digest: "plan_changed", illegal_transition: "invalid_state",
  run_terminal: "invalid_state", ordering_blocked: "invalid_state", teardown_refused: "invalid_state", approval_invalid: "approval_required", ownership: "invalid_state",
  preauthorization: "invalid_state", conflict: "conflict", unavailable: "platform_store_unavailable",
};

export function asBrokerError(error: unknown): unknown {
  if (!(error instanceof MixedOrchestrationError)) return error;
  const code = STATUS[error.code];
  if (code === "not_found") return notFound();
  return new BrokerError(code, error.message, undefined, { reason: error.code, ...(error.detail.length ? { ids: error.detail.slice(0, 20) } : {}) });
}

export interface MixedContext { broker: Broker; sql: Sql; deps: MixedRunDeps }

export async function mixedContext(): Promise<MixedContext> {
  if (isMemoryStoreEnabled()) throw new BrokerError("platform_store_unavailable", "Mixed runs need the durable platform control store.", "Configure the platform control store.");
  const broker = await platformBroker();
  const { platformDb } = await import("@/lib/controlplane/db");
  const sql = await platformDb();
  return { broker, sql, deps: platformMixedRunDeps(sql, broker) };
}

export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw asBrokerError(error);
  }
}

/**
 * Who may steer a mixed run: the operation's requester, the human an agent proposed it for, or any editor or admin
 * (the same rule as cancelling an operation). Visibility first: a foreign or missing operation is a plain 404.
 */
export async function authorizeRunControl(broker: Broker, workspaceId: string, operationId: string, principal: Principal, options: { staffOnly?: boolean } = {}): Promise<void> {
  await broker.getOperationDetail({ workspaceId, operationId, principal });
  const op = await broker.deps.store.getOperation(workspaceId, operationId);
  if (!op) throw notFound();
  const access = await broker.deps.roles.resolve(principal, workspaceId);
  const staff = principal.kind === "user" && ROLE_RANK[access.role] >= ROLE_RANK.editor;
  const requester = !options.staffOnly && ((op.principal.kind === principal.kind && op.principal.id === principal.id) || (principal.kind === "user" && (op.principal.onBehalfOf ?? op.principal.id) === principal.id));
  if (!staff && !requester) throw new BrokerError("role_insufficient", "Only the requester, or an editor or admin, can steer this run.", "Ask one of them.");
}
