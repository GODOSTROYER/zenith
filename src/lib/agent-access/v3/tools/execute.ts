/**
 * `zenith_execute_approved_operation`: the only way MCP starts real work.
 *
 * It refuses unless ALL of these hold, checked in this order and before
 * anything is claimed:
 *
 *  1. the operation is visible to this grant (the broker's uniform `not_found`
 *     otherwise) and was proposed for the same person this connection acts for;
 *  2. its proposal digest equals `expectedDigest` — what the model was shown and
 *     what a person approved is what runs;
 *  3. its capability is one the workflow layer can run (deploy, restart, scale);
 *  4. its status is `approved`/`queued` (claim before starting), or `running`
 *     (a retry of an execution already claimed);
 *  5. the workflow engine is reachable — probed BEFORE the claim, so an outage
 *     does not consume an approval.
 *
 * Then `beginExecution` re-evaluates CURRENT policy, re-validates the approvals
 * against the current requirement and atomically consumes them (single use),
 * moving the operation to `running`; and the matching workflow is started
 * through the workflows client (`deployment.deploy` → `startDeploy`; day-two
 * capabilities → `startDayTwo`).
 *
 * Idempotent on retry. The workflow id is derived from the operation id, so a
 * second call finds the operation already `running`, skips `beginExecution`
 * (an approval is never consumed twice) and asks the client to start the same
 * workflow again — which returns the existing execution (`USE_EXISTING`). A
 * call that fails between the claim and the start leaves the operation
 * `running`; calling again starts or finds the workflow.
 *
 * What is NOT done: the capability grant `beginExecution` returns is a bearer
 * for executing surfaces. It is dropped here — never returned to the model,
 * never logged, never put in a workflow payload (payloads carry ids only).
 * Authority inside the workflow is the workflow's own: it re-checks policy and
 * approval through its activities. There is no approve tool and this one takes
 * no approval field (the schema is strict).
 */
import { BrokerError, isBrokerError, notFound } from "@/lib/capabilities/errors";
import type { OperationView } from "@/lib/capabilities/types";
import { WORKFLOW_ID, type DayTwoWorkflowInput, type DeployWorkflowInput } from "@/lib/workflows/types";
import { z } from "zod/v4";
import { requireEnvironment, type ToolContext } from "../context";
import type { ToolOutput } from "../envelope";
import { McpToolError } from "../errors";
import { assertInGrant } from "../principal";
import type { ExecuteApprovedOperationArgs } from "../schemas";
import { nextStepFor } from "./operations";

type Kind = "deploy" | "day_two";

/** The capabilities this tool will start, and which workflow runs them. */
export const EXECUTABLE: Readonly<Record<string, Kind>> = {
  "deployment.deploy": "deploy",
  "service.restart": "day_two",
  "service.scale": "day_two",
};

/** What `zenith_prepare_deploy` put in the proposal; an operation proposed some other way is refused, not guessed at. */
const DeployInput = z.object({ operation: z.literal("deploy"), revisionId: z.string().min(1).max(100), build: z.boolean() }).loose();

const FINISHED_AFTER_START: ReadonlySet<string> = new Set(["succeeded", "failed", "uncertain"]);

function digestMismatch(): BrokerError {
  return new BrokerError(
    "digest_mismatch",
    "The operation's proposal digest is not the expectedDigest you passed. Nothing was executed.",
    "Use the proposalDigest returned by the propose tool for this operation, exactly. If the operation was re-proposed, it is a different operation."
  );
}

async function deployInput(ctx: ToolContext, op: OperationView): Promise<DeployWorkflowInput> {
  const parsed = DeployInput.safeParse(op.proposal.input);
  if (!parsed.success || !op.projectId || !op.environmentId) {
    throw new McpToolError("operation_input_invalid", "This deployment operation was not prepared by zenith_prepare_deploy and cannot be started from MCP.", 409, "Propose it again with zenith_prepare_deploy.");
  }
  const environment = await requireEnvironment(ctx, op.workspaceId, op.projectId, op.environmentId);
  return {
    operationId: op.id,
    workspaceId: op.workspaceId,
    projectId: op.projectId,
    environmentId: op.environmentId,
    revisionId: parsed.data.revisionId,
    // The product-store projection the UI follows is keyed by this id; nothing in MCP creates the row.
    deploymentId: `dep-${op.id}`,
    connectionId: environment.connectionId,
    preApproved: !op.approvalRequired,
    build: parsed.data.build,
  };
}

function dayTwoInput(op: OperationView): DayTwoWorkflowInput {
  if (!op.environmentId) throw new McpToolError("operation_input_invalid", "This operation has no environment and cannot be started.", 409);
  return { operationId: op.id, workspaceId: op.workspaceId, environmentId: op.environmentId, capability: op.capability };
}

/** The workflow input, built and validated BEFORE anything is claimed: a malformed operation must not burn an approval. */
async function prepareStart(ctx: ToolContext, kind: Kind, op: OperationView): Promise<() => Promise<{ workflowId: string; runId: string }>> {
  if (kind === "deploy") {
    const input = await deployInput(ctx, op);
    return () => ctx.ports.workflows.startDeploy(input);
  }
  const input = dayTwoInput(op);
  return () => ctx.ports.workflows.startDayTwo(input);
}

export async function executeApprovedOperation(args: ExecuteApprovedOperationArgs, ctx: ToolContext): Promise<ToolOutput> {
  assertInGrant(ctx.principal, { workspaceId: args.workspaceId });

  const detail = await ctx.broker.getOperationDetail({ workspaceId: args.workspaceId, operationId: args.operationId, principal: ctx.principal.principal });
  const op = detail.operation;
  assertInGrant(ctx.principal, op);

  // Only what was proposed for the person this connection acts for, and only by an integration (not a person in the UI or the Navigator).
  const requester = op.principal.onBehalfOf ?? op.principal.id;
  if (op.principal.kind !== "integration" || requester !== ctx.principal.principal.onBehalfOf) throw notFound();

  if (op.proposalDigest !== args.expectedDigest) throw digestMismatch();

  const kind = EXECUTABLE[op.capability];
  if (!kind) {
    throw new McpToolError(
      "not_executable",
      `${op.capability} operations cannot be started from MCP. A plan is a record for review; to deploy, propose it with zenith_prepare_deploy.`,
      409
    );
  }

  const approvalUrl = `${ctx.ports.origin()}/integrations/operations/${encodeURIComponent(op.id)}`;

  if (op.status === "expired") throw new BrokerError("operation_expired", "The operation expired before it could be executed.", "Propose it again.");

  if (FINISHED_AFTER_START.has(op.status)) {
    // Answering a retry whose first response was lost. Nothing is started: the workflow id is derived from the operation id.
    return {
      data: { operationId: op.id, status: op.status, startedNow: false, workflow: { id: WORKFLOW_ID(op.id), kind }, nextStep: nextStepFor(op, approvalUrl) },
      notes: [`This operation already finished as ${op.status}. Nothing was started by this call.`],
    };
  }
  if (op.status === "awaiting_approval") {
    throw new BrokerError("approval_required", "This operation has not been approved. A person must approve it in the Zenith web app.", `Ask the person to open ${approvalUrl}. A yes in chat is not an approval.`, { status: op.status });
  }
  if (op.status !== "approved" && op.status !== "queued" && op.status !== "running") {
    throw new BrokerError("invalid_state", `This operation is ${op.status}; only an approved operation can be executed.`, "Propose it again if the change is still wanted.", { status: op.status });
  }

  // Probe BEFORE claiming: an engine outage must not consume an approval.
  const availability = await ctx.ports.workflows.available();
  if (!availability.available) {
    throw new McpToolError(
      "execution_unavailable",
      "The workflow engine is not reachable, so nothing was started and no approval was consumed.",
      503,
      "Try again later with the same arguments; this call did not claim the operation.",
      { operationStatus: op.status, reason: availability.reason },
      true
    );
  }

  const start = await prepareStart(ctx, kind, op);

  let startedNow = false;
  if (op.status === "approved" || op.status === "queued") {
    try {
      // The returned grant is deliberately not kept: it is a bearer for executing surfaces and has no business in a model-visible process.
      await ctx.broker.beginExecution({ workspaceId: op.workspaceId, operationId: op.id, holder: `mcp:${ctx.principal.principal.integrationId ?? ctx.principal.principal.id}`, audience: "worker" });
      startedNow = true;
    } catch (error) {
      // Another caller claimed it first: this is a retry of a claimed operation; fall through and find the workflow.
      if (!(isBrokerError(error) && error.code === "already_claimed")) throw error;
    }
  }

  let started;
  try {
    started = await start();
  } catch (error) {
    if (error instanceof McpToolError || isBrokerError(error)) throw error;
    throw new McpToolError(
      "workflow_start_failed",
      "The operation is claimed but its workflow could not be confirmed started.",
      503,
      "Call this tool again with the same arguments. It is idempotent: it starts the workflow if there is none and returns the existing one otherwise. Do not propose a new operation.",
      { operationStatus: startedNow ? "running" : op.status },
      true
    );
  }

  return {
    data: {
      operationId: op.id,
      status: "running",
      startedNow,
      workflow: { id: started.workflowId, runId: started.runId, kind },
      poll: {
        tools: ["zenith_get_operation", "zenith_get_operation_events"],
        hint: "Poll zenith_get_operation every few seconds: it carries the workflow's step progress. The operation ends as succeeded, failed or uncertain; succeeded is not proof of health, so check logs and metrics afterwards.",
      },
    },
    notes: startedNow
      ? ["The operation was claimed and its workflow start was confirmed."]
      : ["The operation was already claimed; this call requested the same workflow, returning any existing execution."],
  };
}
