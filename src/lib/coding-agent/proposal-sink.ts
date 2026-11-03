/**
 * The proposal sink and the adoption check (PROD-MACH-06).
 *
 * A finished agent run may leave one proposal artifact (a manifest). It becomes
 * a capability-broker proposal (`infrastructure.plan`, non-mutating) whose
 * `input` is built here from source identifiers, digests and counts. Model
 * prose stays in the source-authorized run, so generic operation/audit reads
 * cannot expose it through the proposal's reason. The broker's policy, autonomy and approval rules
 * decide the outcome exactly as for a person's or an MCP client's proposal.
 *
 * Adoption (copying the manifest into a project's working copy) is a separate,
 * human, browser-session step that re-checks that the broker operation is
 * approved and still names this run's exact manifest digest.
 */
import { digest } from "@/lib/controlplane/digest";
import type { Broker } from "@/lib/capabilities/platform";
import type { OperationView } from "@/lib/capabilities/types";
import type { Principal } from "@/lib/controlplane/types";
import type { ProposalSink } from "./runner";
import type { AgentSourceRef, ProposalArtifact } from "./types";

export const AGENT_PLAN_STAGE = "coding_agent_manifest";

export interface BrokerSinkOptions {
  broker: Pick<Broker, "propose">;
  principal: Principal;
  runId: string;
  baseManifestHash?: string;
  scope: { workspaceId: string; projectId: string; environmentId: string };
  via?: "rest" | "mcp";
}

const approvedSource = (source: AgentSourceRef) => ({
  repository: source.repository, commit: source.commit, ...(source.root ? { root: source.root } : {}),
  ...(source.sourceIdentity ? { identity: source.sourceIdentity } : {}),
  ...(source.bindingId ? { bindingId: source.bindingId, bindingVersion: source.bindingVersion } : {}),
  ...(source.contextDigest ? { contextDir: source.contextDir ?? "", contextDigest: source.contextDigest, dockerfile: source.dockerfile } : {}),
});

export function agentProposalInput(artifact: ProposalArtifact, source: AgentSourceRef, runId: string, baseManifestHash?: string): Record<string, unknown> {
  return {
    operation: "plan",
    stage: AGENT_PLAN_STAGE,
    runId,
    manifestDigest: artifact.manifestDigest,
    requirementsDigest: artifact.requirementsDigest,
    source: approvedSource(source),
    ...(baseManifestHash ? { baseManifestHash } : {}),
    environmentClass: artifact.environmentClass,
    confidence: artifact.confidence,
    unresolvedCount: artifact.unresolved.length,
  };
}

export function createBrokerProposalSink(options: BrokerSinkOptions): ProposalSink {
  return {
    async submit(artifact, context) {
      const result = await options.broker.propose(
        {
          capability: "infrastructure.plan",
          scope: options.scope,
          input: agentProposalInput(artifact, context.source, options.runId, options.baseManifestHash),
          reason: "Gimbal repository analysis proposal. Review the authorized analysis and manifest diff before adoption.",
          idempotencyKey: `agent-run:${options.runId}:${artifact.manifestDigest.slice(0, 32)}`,
        },
        options.principal,
        { via: options.via ?? "rest" }
      );
      return { operationId: result.operation.id, status: result.operation.status, decision: result.decision.outcome };
    },
  };
}

export class AdoptionRefused extends Error {
  constructor(readonly code: "not_completed" | "no_proposal" | "not_approved" | "digest_mismatch" | "wrong_operation", message: string) {
    super(message);
    this.name = "AdoptionRefused";
  }
}

/** Throws unless the stored artifact is exactly what an approved broker operation names. Pure; the caller supplies the operation it read. */
export function assertAdoptable(run: { id: string; status: string; result?: { artifact?: ProposalArtifact } | null; proposalOperationId?: string | null; source?: AgentSourceRef; baseManifestHash?: string }, operation: Pick<OperationView, "id" | "capability" | "status" | "proposal">): ProposalArtifact {
  if (run.status !== "completed") throw new AdoptionRefused("not_completed", "The run has not completed.");
  const artifact = run.result?.artifact;
  if (!artifact || !run.proposalOperationId) throw new AdoptionRefused("no_proposal", "The run left no proposal to adopt.");
  if (operation.id !== run.proposalOperationId || operation.capability !== "infrastructure.plan") throw new AdoptionRefused("wrong_operation", "This is not the run's proposal operation.");
  if (operation.status !== "approved") throw new AdoptionRefused("not_approved", `The proposal is ${operation.status}; it must be approved first.`);
  const input = operation.proposal.input as { stage?: unknown; runId?: unknown; manifestDigest?: unknown; source?: unknown; baseManifestHash?: unknown } | null;
  if (!input || input.stage !== AGENT_PLAN_STAGE || input.runId !== run.id || input.manifestDigest !== artifact.manifestDigest || digest(artifact.manifest) !== artifact.manifestDigest) {
    throw new AdoptionRefused("digest_mismatch", "The approved proposal does not match the stored manifest.");
  }
  if ((run.source && digest(input.source ?? null) !== digest(approvedSource(run.source))) || (run.baseManifestHash && input.baseManifestHash !== run.baseManifestHash)) {
    throw new AdoptionRefused("digest_mismatch", "The approved source or reviewed project revision does not match this run.");
  }
  return artifact;
}
