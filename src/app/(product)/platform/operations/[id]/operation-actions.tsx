"use client";
/** Decisions use the reviewed digest and browser cookies; the API enforces live identity and Origin. */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApprovalRecord, OperationRecord, PolicyDecisionRecord } from "@/lib/controlplane/types";
import type { PlanView } from "@/lib/tofu/plan";
import { ApprovalCard, type ApprovalDecisionInput } from "@/components/platform/approval-card";
import type { ApprovalViewer } from "@/components/platform/approval-eligibility";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { browserMutation, mutationError } from "../../_lib/browser-api";

export function OperationActions({ operation, decision, approvals, viewer, workspaceId, plan, planCostDeltaUsd, semanticsDigest }: {
  operation: OperationRecord; decision?: PolicyDecisionRecord; approvals: ApprovalRecord[]; viewer: ApprovalViewer; workspaceId: string; plan?: PlanView; planCostDeltaUsd?: number | null; semanticsDigest?: string;
}) {
  const router = useRouter();
  const [recorded, setRecorded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const reasonId = useId();
  // Keyboard and screen-reader users land on the confirmation, not on a control that just disappeared or went stale.
  useEffect(() => { if (recorded) statusRef.current?.focus(); }, [recorded]);
  const decide = async (kind: "approve" | "reject", input: ApprovalDecisionInput) => {
    if (inFlight.current || recorded) return;
    inFlight.current = true; setPending(true);
    try {
      await browserMutation(workspaceId, `/api/platform/v1/operations/${encodeURIComponent(operation.id)}/${kind}`, { proposalDigest: input.proposalDigest, ...(kind === "approve" && input.planDigest ? { planDigest: input.planDigest } : {}), ...(kind === "approve" && input.semanticsDigest ? { semanticsDigest: input.semanticsDigest } : {}), ...(input.reason ? { reason: input.reason } : {}) });
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
    <ApprovalCard operation={operation} decision={decision} approvals={approvals} viewer={viewer} plan={plan} semanticsDigest={semanticsDigest} planCostDeltaUsd={planCostDeltaUsd} onApprove={(input) => decide("approve", input)} onReject={(input) => decide("reject", input)} loading={recorded || pending} />
    {recorded && <p ref={statusRef} tabIndex={-1} role="status" className="text-[13px] text-ink-mute outline-none focus-visible:ring-2 focus-visible:ring-signal">Decision recorded. Refreshing the latest state…</p>}
    <Button onClick={() => void cancel()} busy={pending} disabled={Boolean(cancelReason) || recorded} disabledReason={cancelReason} aria-describedby={cancelReason ? reasonId : undefined}>Cancel operation</Button>
    {cancelReason && <p id={reasonId} className="text-[12px] text-ink-mute">{cancelReason}</p>}
    {error && <Callout tone="err">{error}</Callout>}
    <Button variant="quiet" onClick={() => router.refresh()}>Refresh details</Button>
  </div>;
}
