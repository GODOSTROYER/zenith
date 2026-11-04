/**
 * Trusted teardown review: only original, non-simulated execution evidence in
 * this workspace/environment can supply policy facts. Client facts are ignored.
 */
import { z } from "zod";
import { ReviewFactsSchema } from "@/lib/controlplane/db/repos/operation-review";
import type { Scope } from "@/lib/controlplane/types";
import { BrokerError, notFound } from "./errors";
import type { BrokerDeps } from "./ports";
import { findSecret } from "./secret-guard";
import type { ProposeContext } from "./types";

const refs = z.array(z.string().min(1).max(500)).max(10_000);
const Summary = z.object({
  stage: z.literal("plan"), destroy: z.literal(true),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  facts: ReviewFactsSchema, destroyAddresses: refs,
  retained: refs.optional(), statefulDeletes: refs,
});

export async function loadDestroyPlan(deps: BrokerDeps, scope: Scope, ref: NonNullable<ProposeContext["destroyPlan"]>) {
  if (!ref.operationId || !/^[a-f0-9]{64}$/.test(ref.planDigest)) throw new BrokerError("invalid_request", "The destroy-plan reference is invalid.");
  const op = await deps.store.getOperation(scope.workspaceId, ref.operationId);
  if (!op || op.environmentId !== scope.environmentId || (scope.projectId && op.projectId !== scope.projectId)) throw notFound();
  if (!["infrastructure.plan", "infrastructure.destroy"].includes(op.capability) ||
      ["denied", "rejected", "cancelled", "expired", "failed", "uncertain"].includes(op.status) ||
      Date.parse(op.expiresAt) <= deps.clock.now().getTime() || op.planDigest !== ref.planDigest) {
    throw new BrokerError("invalid_state", "A current recorded destroy plan is required. Run a new destroy review before proposing teardown.");
  }
  const row = await deps.store.getPlanEvidence(scope.workspaceId, op.id, ref.planDigest);
  const parsed = Summary.safeParse(row?.summary);
  if (!row || row.workspaceId !== scope.workspaceId || row.operationId !== op.id || row.kind !== "tofu_plan" ||
      row.simulated || row.digest !== ref.planDigest || !parsed.success || parsed.data.planDigest !== ref.planDigest || findSecret(parsed.data)) {
    throw new BrokerError("invalid_state", "The recorded evidence is not a verifiable destroy plan.");
  }
  const { facts, statefulDeletes } = parsed.data;
  if (facts.create || facts.update || facts.replace || facts.destroysData !== (facts.destroyedStatefulAddresses.length > 0) ||
      [...statefulDeletes].sort().join("\n") !== [...facts.destroyedStatefulAddresses].sort().join("\n")) {
    throw new BrokerError("invalid_state", "The destroy-plan facts are inconsistent.");
  }
  return { operationId: op.id, evidenceId: row.id, planDigest: ref.planDigest, facts,
    retained: [...(parsed.data.retained ?? [])], destroyAddresses: [...parsed.data.destroyAddresses] };
}
