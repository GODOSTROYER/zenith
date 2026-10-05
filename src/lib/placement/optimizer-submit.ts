/**
 * Hands optimizer proposals to the existing capability broker (ADR-0007).
 *
 * This is the only place an optimization leaves the pure optimizer, and it
 * only PROPOSES: `broker.propose` evaluates policy, persists an operation bound
 * to an immutable proposal digest and, when policy says so, waits for a human
 * browser approval. Nothing here approves, begins execution or touches a cloud.
 *
 * Exactly one path exists: container-service size or replica reductions become
 * `service.scale`, the same capability and input shape `zenith_scale_service`
 * uses, so an approved optimization compiles and executes through the
 * existing scale operation with the exact changed field. Every other kind
 * (database or instance size, site relocation) has no typed operation that
 * carries it, so it is REFUSED here with an explicit reason rather than sent
 * as an input nothing consumes.
 *
 * The request `input` is built from the optimizer's own numbers. The extra
 * `optimizer` member records the change (field, from, to, shift) so the next
 * run can rebuild cooldown, reversal and window history from the durable
 * operation records (`optimizer-history.ts`); the scale handler ignores it.
 */
import type { CapabilityRequest } from "@/lib/capabilities/catalog";
import type { ProposeContext, ProposeResult } from "@/lib/capabilities/types";
import type { Principal } from "@/lib/controlplane/types";
import type { OptimizationHistoryEntry, OptimizationProposal } from "@/lib/placement/optimizer";

/** The one broker method used; satisfied by `Broker` and by the MCP tool context's broker. */
export interface ProposalBroker {
  propose(request: unknown, principal: Principal, ctx?: ProposeContext): Promise<ProposeResult>;
}

export interface OptimizationScope {
  workspaceId: string;
  projectId: string;
  environmentId: string;
}

export interface SubmitOptions {
  broker: ProposalBroker;
  principal: Principal;
  scope: OptimizationScope;
  /** resolves a graph address to the resource id the scale capability is scoped to; undefined means "cannot scale it" */
  serviceIdFor(address: string): string | undefined;
  /** resolves a graph address to the platform resource id the operation is scoped to; defaults to the service id */
  resourceIdFor?(address: string): string | undefined;
  /** ISO time stamped on the history entries */
  now: string;
}

export interface SubmittedOptimization {
  proposalId: string;
  capability: "service.scale";
  operationId: string;
  operationStatus: string;
  policyOutcome: string;
  replayed: boolean;
  history: OptimizationHistoryEntry[];
}

export interface RefusedSubmission {
  proposalId: string;
  reason: string;
}

const UNROUTABLE = "has no existing typed operation that can carry it (only container-service size or replica changes route to service.scale); not submitted";

function requestFor(p: OptimizationProposal, o: SubmitOptions): { request: CapabilityRequest } | { refused: string } {
  const only = p.changes.length === 1 ? p.changes[0]! : undefined;
  const scaleField = only && (only.field === "spec.size" || only.field === "spec.replicas");
  if ((p.kind !== "rightsize_size" && p.kind !== "rightsize_replicas") || !only || !scaleField || p.addresses.length !== 1) return { refused: `${p.title} ${UNROUTABLE}.` };
  const serviceId = o.serviceIdFor(only.address);
  if (!serviceId) return { refused: `${only.address} has no service id to scale; not submitted.` };
  const reason = `${p.title}. Estimated saving $${p.savings.monthlyUsd.toFixed(2)}/month (an estimate from catalog ${p.savings.catalogVersion}, not an invoice).`.slice(0, 2000);
  return {
    request: {
      capability: "service.scale",
      scope: { ...o.scope, resourceId: o.resourceIdFor?.(only.address) ?? serviceId },
      input: {
        operation: "scale",
        serviceId,
        ...(only.field === "spec.replicas" ? { replicas: only.to } : { size: only.to }),
        optimizer: { id: p.id, address: only.address, field: only.field, from: only.from, to: only.to, monthlyUsdShift: Math.abs(p.savings.monthlyUsd) },
      },
      reason,
      idempotencyKey: `opt-${p.id.slice(4, 44)}`,
    },
  };
}

/** Propose each optimization through the broker. Per-proposal failures are reported, never thrown past the others. */
export async function submitOptimizationProposals(
  proposals: readonly OptimizationProposal[],
  options: SubmitOptions,
): Promise<{ submitted: SubmittedOptimization[]; refused: RefusedSubmission[] }> {
  const submitted: SubmittedOptimization[] = [];
  const refused: RefusedSubmission[] = [];
  for (const p of proposals) {
    const built = requestFor(p, options);
    if ("refused" in built) {
      refused.push({ proposalId: p.id, reason: built.refused });
      continue;
    }
    try {
      const res = await options.broker.propose(built.request, options.principal, { via: "workflow" });
      const status = res.operation.status === "denied" ? ("rejected" as const) : ("proposed" as const);
      submitted.push({
        proposalId: p.id,
        capability: "service.scale",
        operationId: res.operation.id,
        operationStatus: res.operation.status,
        policyOutcome: res.decision.outcome,
        replayed: res.replayed,
        history: res.replayed
          ? []
          : p.changes.map((c) => ({
              address: c.address,
              field: c.field,
              kind: p.kind,
              from: c.from,
              to: c.to,
              at: options.now,
              status,
              monthlyUsdShift: Math.abs(p.savings.monthlyUsd) / p.changes.length,
            })),
      });
    } catch (e) {
      refused.push({ proposalId: p.id, reason: e instanceof Error ? e.message : "the broker refused the proposal" });
    }
  }
  return { submitted, refused };
}
