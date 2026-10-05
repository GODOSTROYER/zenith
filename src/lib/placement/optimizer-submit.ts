/**
 * Hands optimizer proposals to the existing capability broker (ADR-0007).
 *
 * This is the only place an optimization leaves the pure optimizer, and it
 * only PROPOSES: `broker.propose` evaluates policy, persists an operation bound
 * to an immutable proposal digest and, when policy says so, waits for a human
 * browser approval. Nothing here approves, begins execution or touches a cloud.
 *
 * Capability mapping:
 * - container-service size or replica reductions -> `service.scale` (the
 *   same capability and input shape `zenith_scale_service` uses);
 * - everything else (database or instance size, site relocation) ->
 *   `infrastructure.plan`, so the change goes through plan, policy, approval
 *   and apply instead of a direct mutation.
 *
 * The request `input` is built here from the optimizer's own numbers (ids,
 * the change set, estimate labels). No model text is copied into it. The
 * returned history entries are what the caller persists so the next run sees
 * the cooldown, reversal lockout and window bounds.
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
  /** ISO time stamped on the history entries */
  now: string;
}

export interface SubmittedOptimization {
  proposalId: string;
  capability: "service.scale" | "infrastructure.plan";
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

function requestFor(p: OptimizationProposal, o: SubmitOptions): { request: CapabilityRequest; capability: "service.scale" | "infrastructure.plan" } | { refused: string } {
  const idempotencyKey = `opt-${p.id.slice(4, 44)}`;
  const reason = `${p.title}. Estimated saving $${p.savings.monthlyUsd.toFixed(2)}/month (an estimate from catalog ${p.savings.catalogVersion}, not an invoice).`.slice(0, 2000);
  const only = p.changes.length === 1 ? p.changes[0]! : undefined;
  if ((p.kind === "rightsize_size" || p.kind === "rightsize_replicas") && only && p.addresses.length === 1) {
    const serviceId = o.serviceIdFor(only.address);
    if (serviceId) {
      return {
        capability: "service.scale",
        request: {
          capability: "service.scale",
          scope: { ...o.scope, resourceId: serviceId },
          input: {
            operation: "scale",
            serviceId,
            ...(only.field === "spec.replicas" ? { replicas: only.to } : { size: only.to }),
          },
          reason,
          idempotencyKey,
        },
      };
    }
  }
  return {
    capability: "infrastructure.plan",
    request: {
      capability: "infrastructure.plan",
      scope: o.scope,
      input: {
        operation: "optimize",
        optimizationId: p.id,
        kind: p.kind,
        changes: p.changes,
        savings: { label: p.savings.label, monthlyUsd: p.savings.monthlyUsd, catalogVersion: p.savings.catalogVersion, oneTimeCostUsd: p.savings.oneTimeCostUsd },
      },
      reason,
      idempotencyKey,
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
        capability: built.capability,
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
