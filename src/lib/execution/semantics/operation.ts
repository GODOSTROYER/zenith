/**
 * Dispatch gate for the release steps (approved-source build, rollout, migration), PROD-DUR-03 and 04.
 * These run after the apply of the same operation, in separate activities and possibly on another
 * worker, so each one (1) re-derives the current semantics from the trusted authorities and compares with
 * the semantics recorded when the plan was reviewed, then (2) decides authorization again from current
 * policy, roles, standing grants and approvals through the same worker broker the apply uses. An operation
 * with no reviewed plan has nothing approved to bind and is left to the gates that already cover it. With
 * no semantics store wired (legacy worker) neither check runs; the platform composition always wires it.
 */
import type { LeaseRef } from "@/lib/workflows/types";
import { resolveConnection, type ExecContext } from "../context";
import { requireExecutable } from "../desired";
import { buildDeployWorkspace } from "../plan";
import { StepFailedError } from "../errors";
import type { Runtime } from "../runtime";
import { approvedSources } from "../source-snapshot";
import { directSemanticsArgs } from "./direct";
import { assertApprovedSemantics } from "./dispatch";

export async function assertOperationSemantics(rt: Runtime, ec: ExecContext, lease: LeaseRef, stage: string, signal?: AbortSignal): Promise<void> {
  if (!rt.d.semantics || !ec.op.planDigest) return;
  const { graph } = requireExecutable(rt, ec);
  const connection = await resolveConnection(rt, ec);
  if (ec.executableSourceDigest === undefined) await approvedSources(rt, ec, graph, lease, false, signal);
  // A Zenith-managed environment has no OpenTofu workspace: its semantics are bound with the provider-direct stand-in (direct.ts).
  if (ec.product.environment.provider === "zenith") await assertApprovedSemantics(rt, ec, directSemanticsArgs(graph, connection, ec.op.planDigest), stage);
  else {
    const { ws } = await buildDeployWorkspace(rt, ec, graph, connection);
    await assertApprovedSemantics(rt, ec, { graph, connection, ws, planDigest: ec.op.planDigest }, stage);
  }
  const authority = await rt.d.broker.approvalStatus(ec.op.id);
  if (!authority.approved || authority.rejected || (ec.op.approvalRequired && !authority.approvalId)) {
    throw new StepFailedError(`Current policy or human approval changed before ${stage}; nothing was dispatched.`);
  }
}
