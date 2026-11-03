/** Source-derived context requires explicit export consent, project scope, policy, and a current GitHub grant. */
import { normalizeInspectionRoot } from "@/lib/sources/github/inspect";
import { redactSourceValue, redactSourceText } from "@/lib/coding-agent/redaction";
import type { ToolContext } from "../context";
import { authorizedSourceContext as context } from "../source-context";
import { McpToolError, requestCancelled } from "../errors";
import type { ToolOutput } from "../envelope";
import type { GetSourceContextArgs, SubmitSourceProposalArgs } from "../source-schema";
import { submit } from "./propose";

export async function getSourceContext(args: GetSourceContextArgs, ctx: ToolContext): Promise<ToolOutput> {
  const handoff = await context(args, ctx);
  return {
    data: { runId: handoff.id, runVersion: handoff.runVersion, digest: handoff.digest, expiresAt: handoff.expiresAt, target: handoff.context.target, baseManifestHash: handoff.context.baseManifestHash },
    untrusted: { source: handoff.context.source, task: handoff.context.task, returnContract: handoff.context.returnContract },
    notes: ["This context grants no local GitHub write permission or deployment authority. Verify the checkout origin and exact commit; preserve local edits."],
  };
}

export async function getAnalysis(args: GetSourceContextArgs, ctx: ToolContext): Promise<ToolOutput> {
  const handoff = await context(args, ctx);
  return { data: { runId: handoff.id, runVersion: handoff.runVersion, digest: handoff.digest, expiresAt: handoff.expiresAt, redactionVersion: handoff.context.redactionVersion },
    untrusted: { analysis: handoff.context.analysis }, notes: ["Analysis is bounded and may be incomplete. Model conclusions and client verification claims need review."] };
}

export async function getHandoff(args: GetSourceContextArgs, ctx: ToolContext): Promise<ToolOutput> {
  const handoff = await context(args, ctx);
  return { data: { runId: handoff.id, runVersion: handoff.runVersion, digest: handoff.digest, expiresAt: handoff.expiresAt, schemaVersion: handoff.schemaVersion },
    untrusted: { context: handoff.context, markdown: handoff.markdown }, notes: ["A handoff continues a task. It does not transfer a model conversation, credentials, or approvals."] };
}

export async function submitSourceProposal(args: SubmitSourceProposalArgs, ctx: ToolContext): Promise<ToolOutput> {
  if (ctx.signal?.aborted || ctx.cancel?.aborted) throw requestCancelled();
  const handoff = await context(args, ctx);
  if (args.baseCommit !== handoff.context.source.commit) throw new McpToolError("source_mismatch", "The returned proposal does not use the handoff's exact base commit.", 409);
  if (args.result.kind === "commit" && args.result.newCommit === args.baseCommit) throw new McpToolError("invalid_input", "A returned commit must identify changed source.", 400);
  for (const file of args.changedFiles) {
    try { if (!normalizeInspectionRoot(file.path)) throw new Error("empty"); }
    catch { throw new McpToolError("invalid_input", "Changed-file paths must remain inside the repository.", 400); }
  }
  if (new Set(args.changedFiles.map(f => f.path)).size !== args.changedFiles.length) throw new McpToolError("invalid_input", "Each changed-file path must be listed once.", 400);
  const output = await submit(ctx, {
    capability: "infrastructure.plan", scope: args.target, idempotencyKey: args.idempotencyKey,
    input: {
      operation: "plan", stage: "coding_agent_source_return", runId: handoff.id, runVersion: handoff.runVersion,
      handoffDigest: handoff.digest, baseManifestHash: handoff.context.baseManifestHash,
      source: handoff.context.source, baseCommit: args.baseCommit, result: args.result,
      changedFiles: redactSourceValue(args.changedFiles), verification: redactSourceValue(args.verification), description: redactSourceText(args.description),
    },
    reason: "A coding client returned source changes for human review. Reanalysis is required before adoption or deployment.",
  });
  output.data.nextStep = "Review this source-return proposal in Zenith, then reanalyze the returned commit or locally applied patch. A separate reviewed deployment plan is required.";
  output.notes = [...(output.notes ?? []), "The returned commit/patch and verification results are client claims. No source was pushed, patch applied, model run started, or deployment approved."];
  return output;
}
