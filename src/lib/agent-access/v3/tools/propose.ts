/**
 * Write tools: `zenith_plan_change`, `zenith_prepare_deploy`,
 * `zenith_restart_service` and `zenith_scale_service`.
 *
 * They PROPOSE and nothing else. Each builds an exact, bounded, secret-free
 * request and submits it to the capability broker (`propose`). The broker
 * decides (allow, require approval or deny), persists the decision and an
 * operation bound to an immutable proposal digest, and answers
 * `approved | awaiting_approval | denied`. Nothing here starts a workflow, calls
 * `beginExecution` or touches a cloud, in this call or any other: the only
 * execution path is `zenith_execute_approved_operation`, which refuses anything
 * not approved.
 *
 * What a proposal's `input` holds is chosen by this module, never copied from
 * the model's free text: ids, digests of the exact manifest and graph the
 * proposal is about, and Zenith's own cost estimate. The model's words go only
 * into `reason`, which the broker shows approvers labelled "unverified text".
 *
 * There is no tool, and no input member, that approves. The input schemas are
 * strict, so `approved: true` is refused before anything runs.
 */
import { digest } from "@/lib/controlplane/digest";
import type { ProposeResult } from "@/lib/capabilities/types";
import type { Manifest } from "@/lib/domain/types";
import { graphFor, requireEnvironment, requireRevision, type ToolContext } from "../context";
import type { ToolOutput } from "../envelope";
import { assertInGrant } from "../principal";
import type { PlanChangeArgs, PrepareDeployArgs, RestartServiceArgs, ScaleServiceArgs } from "../schemas";
import { estimateSummary, tryEstimate } from "./estimate";
import { nextStepFor } from "./operations";

interface Submission {
  capability: string;
  scope: { workspaceId: string; projectId: string; environmentId: string; resourceId?: string };
  input: Record<string, unknown>;
  reason?: string;
  idempotencyKey: string;
}

/** Does deploying this manifest need a build? Managed services sourced from git do; pinned images do not. */
export function manifestNeedsBuild(manifest: Manifest): boolean {
  return manifest.services.some((s) => s.ownership === "managed" && s.source.type === "git");
}

/** Submit to the broker and render what a model needs: the id, the status, the digest, the reasons and where a person approves. */
async function submit(ctx: ToolContext, s: Submission): Promise<ToolOutput> {
  const result: ProposeResult = await ctx.broker.propose(
    { capability: s.capability, scope: s.scope, input: s.input, ...(s.reason ? { reason: s.reason } : {}), idempotencyKey: s.idempotencyKey },
    ctx.principal.principal,
    { via: "mcp" }
  );
  return proposalOutput(ctx, result);
}

export function proposalOutput(ctx: Pick<ToolContext, "ports">, result: ProposeResult): ToolOutput {
  const op = result.operation;
  const decision = result.decision;
  const approvalUrl = `${ctx.ports.origin()}/integrations/operations/${encodeURIComponent(op.id)}`;
  const needsPerson = op.status === "awaiting_approval";
  return {
    data: {
      operationId: op.id,
      status: op.status,
      proposalDigest: op.proposalDigest,
      capability: op.capability,
      replayed: result.replayed,
      expiresAt: op.expiresAt,
      risk: decision.risk,
      decision: {
        outcome: decision.outcome,
        reasons: decision.reasons.map((r) => ({ code: r.code, message: r.message })),
        policyVersion: decision.policyVersion,
        ...(decision.environment ? { environment: decision.environment } : {}),
      },
      approval: {
        required: needsPerson,
        status: needsPerson ? "pending" : op.status === "approved" ? "not_required_by_policy" : "not_possible",
        ...(needsPerson && decision.approval ? { requirement: decision.approval } : {}),
        ...(needsPerson ? { url: approvalUrl } : {}),
      },
      executed: false,
      nextStep: nextStepFor(op, approvalUrl),
    },
    untrusted: { proposal: { summary: op.proposal.summary, details: op.proposal.details, input: op.proposal.input } },
    notes: [
      "This call only proposed. Nothing was executed.",
      ...(op.status === "approved" ? ["Current policy allows execution without a human approval; a separate execute call is still required."] : []),
      ...(result.replayed ? ["This idempotency key already produced this operation; the earlier operation is returned."] : []),
    ],
  };
}

/* ------------------------------- plan_change ------------------------------- */

export async function planChange(args: PlanChangeArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  assertInGrant(ctx.principal, target);
  const environment = await requireEnvironment(ctx, target.workspaceId, target.projectId, target.environmentId);
  const revision = await requireRevision(ctx, target.workspaceId, target.projectId, args.revisionId);
  const graph = graphFor(revision.manifest, environment);
  return submit(ctx, {
    capability: "infrastructure.plan",
    scope: { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId },
    input: {
      operation: "plan",
      revisionId: revision.id,
      revisionNumber: revision.number,
      manifestDigest: digest(revision.manifest),
      graphDigest: graph.graphDigest,
      estimate: estimateSummary(tryEstimate(graph)),
    },
    reason: args.description,
    idempotencyKey: args.idempotencyKey,
  });
}

/* ----------------------------- prepare_deploy ------------------------------ */

export async function prepareDeploy(args: PrepareDeployArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  assertInGrant(ctx.principal, target);
  const environment = await requireEnvironment(ctx, target.workspaceId, target.projectId, target.environmentId);
  const revision = await requireRevision(ctx, target.workspaceId, target.projectId, args.revisionId);
  const graph = graphFor(revision.manifest, environment);
  return submit(ctx, {
    capability: "deployment.deploy",
    scope: { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId },
    input: {
      operation: "deploy",
      revisionId: revision.id,
      revisionNumber: revision.number,
      manifestDigest: digest(revision.manifest),
      graphDigest: graph.graphDigest,
      build: manifestNeedsBuild(revision.manifest),
      ...(args.message ? { message: args.message } : {}),
      estimate: estimateSummary(tryEstimate(graph)),
    },
    idempotencyKey: args.idempotencyKey,
  });
}

/* --------------------------- restart / scale service ------------------------ */

export async function restartService(args: RestartServiceArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  assertInGrant(ctx.principal, target);
  return submit(ctx, {
    capability: "service.restart",
    scope: { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId, resourceId: args.serviceId },
    input: { operation: "restart", serviceId: args.serviceId },
    ...(args.reason ? { reason: args.reason } : {}),
    idempotencyKey: args.idempotencyKey,
  });
}

export async function scaleService(args: ScaleServiceArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  assertInGrant(ctx.principal, target);
  return submit(ctx, {
    capability: "service.scale",
    scope: { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId, resourceId: args.serviceId },
    input: { operation: "scale", serviceId: args.serviceId, replicas: args.replicas },
    ...(args.reason ? { reason: args.reason } : {}),
    idempotencyKey: args.idempotencyKey,
  });
}
