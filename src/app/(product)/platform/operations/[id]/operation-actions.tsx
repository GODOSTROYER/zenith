"use client";
/** Decisions use the reviewed digest and browser cookies; the API enforces live identity and Origin. */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApprovalRecord, OperationRecord, PolicyDecisionRecord } from "@/lib/controlplane/types";
import type { PlanView } from "@/lib/tofu/plan";
import { ApprovalCard, type ApprovalDecisionInput } from "@/components/platform/approval-card";
import type { ApprovalViewer } from "@/components/platform/approval-eligibility";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { browserMutation, mutationError } from "../../_lib/browser-api";

export function OperationActions({ operation, decision, approvals, viewer, workspaceId, plan, planCostDeltaUsd }: {
  operation: OperationRecord; decision?: PolicyDecisionRecord; approvals: ApprovalRecord[]; viewer: ApprovalViewer; workspaceId: string; plan?: PlanView; planCostDeltaUsd?: number | null;
}) {
  const router = useRouter();
  const [recorded, setRecorded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const decide = async (kind: "approve" | "reject", input: ApprovalDecisionInput) => {
    if (inFlight.current || recorded) return;
    inFlight.current = true; setPending(true);
    try {
      await browserMutation(workspaceId, `/api/platform/v1/operations/${encodeURIComponent(operation.id)}/${kind}`, { proposalDigest: input.proposalDigest, ...(kind === "approve" && input.planDigest ? { planDigest: input.planDigest } : {}), ...(input.reason ? { reason: input.reason } : {}) });
      setRecorded(true); router.refresh();
    } catch (failure) { throw new Error(mutationError(failure)); }
    finally { inFlight.current = false; setPending(false); }
  };
  const cancellable = ["proposed", "awaiting_approval", "approved", "queued"].includes(operation.status);
  const allowed = viewer.role === "admin" || viewer.role === "editor" || operation.principal.id === viewer.id || operation.principal.onBehalfOf === viewer.id;
  const cancelReason = !cancellable ? "Only an operation that has not started can be cancelled here." : !allowed ? "Only the requester, an editor or an admin can cancel this operation." : undefined;
  const cancel = async () => {
    if (cancelReason || inFlight.current || recorded) return;
    inFlight.current = true; setPending(true); setError(undefined);
    try {
      await browserMutation(workspaceId, `/api/platform/v1/operations/${encodeURIComponent(operation.id)}/cancel`, {});
      setRecorded(true); router.refresh();
    } catch (failure) { setError(mutationError(failure)); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <div className="space-y-4">
    <ApprovalCard operation={operation} decision={decision} approvals={approvals} viewer={viewer} plan={plan} planCostDeltaUsd={planCostDeltaUsd} onApprove={(input) => decide("approve", input)} onReject={(input) => decide("reject", input)} loading={recorded || pending} />
    {recorded && <p role="status" className="text-[13px] text-ink-mute">Decision recorded. Refreshing the latest state…</p>}
    <Button onClick={() => void cancel()} busy={pending} disabled={Boolean(cancelReason) || recorded} disabledReason={cancelReason}>Cancel operation</Button>
    {cancelReason && <p className="text-[12px] text-ink-mute">{cancelReason}</p>}
    {error && <Callout tone="err">{error}</Callout>}
    <Button variant="quiet" onClick={() => router.refresh()}>Refresh details</Button>
  </div>;
}
