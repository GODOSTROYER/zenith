/** Pure source-stage detection and provenance matching, shared by transport projections. */
import { digest } from "@/lib/controlplane/digest";
import type { RunHandoff } from "./handoff";

export type SourceOperation = { capability: string; proposal: { input: unknown } };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function isSourceOperation(operation: SourceOperation): boolean {
  const stage = record(operation.proposal.input).stage;
  return operation.capability === "infrastructure.plan" && (stage === "coding_agent_manifest" || stage === "coding_agent_source_return");
}

export function sourceOperationInput(operation: SourceOperation): Record<string, unknown> {
  return record(operation.proposal.input);
}

/** A valid run id alone cannot authorize unrelated source text embedded in an operation. */
export function sourceOperationMatches(operation: SourceOperation, handoff: RunHandoff): boolean {
  const input = sourceOperationInput(operation);
  const source = record(input.source);
  const expected = handoff.context.source;
  return isSourceOperation(operation) && input.runId === handoff.id
    && input.baseManifestHash === handoff.context.baseManifestHash
    && source.repository === expected.repository && source.commit === expected.commit
    && digest(source.identity ?? source.sourceIdentity ?? null) === digest(expected.sourceIdentity)
    && (source.root ?? "") === (expected.root ?? "")
    && (source.bindingId ?? null) === (expected.bindingId ?? null)
    && (source.bindingVersion ?? null) === (expected.bindingVersion ?? null)
    && (source.contextDir ?? "") === (expected.contextDir ?? "")
    && (source.contextDigest ?? null) === (expected.contextDigest ?? null)
    && (source.dockerfile ?? null) === (expected.dockerfile ?? null);
}
