"use client";
/** Approve or pause one schedule. The binding digest the person reviewed travels with the approval. */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { browserMutation, mutationError } from "../_lib/browser-api";

export function ScheduleActions({ workspaceId, scheduleId, bindingDigest, status, canApprove }: {
  workspaceId: string; scheduleId: string; bindingDigest: string; status: string; canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const hintId = useId();
  useEffect(() => { if (done) statusRef.current?.focus(); }, [done]);
  const needs = status === "pending_approval";
  const reason = !needs ? "This schedule is not waiting for approval." : !canApprove ? "Only a workspace admin who did not create the schedule can approve it." : undefined;
  const approve = async () => {
    if (inFlight.current || reason) return;
    inFlight.current = true; setPending(true); setError(undefined);
    try {
      await browserMutation(workspaceId, `/api/platform/v1/runbooks/schedules/${encodeURIComponent(scheduleId)}/approve`, { bindingDigest });
      setDone("Schedule approval recorded for exactly the bounds shown. Refreshing the latest state.");
      router.refresh();
    } catch (failure) { setError(mutationError(failure)); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <div className="space-y-2">
    <Button size="sm" onClick={() => void approve()} busy={pending} disabled={Boolean(reason) || Boolean(done)} disabledReason={reason} aria-describedby={reason ? hintId : undefined}>Approve schedule</Button>
    {reason && <p id={hintId} className="text-[12px] text-ink-mute">{reason}</p>}
    {done && <p ref={statusRef} tabIndex={-1} role="status" className="text-[12.5px] text-ink-mute outline-none focus-visible:ring-2 focus-visible:ring-signal">{done}</p>}
    {error && <Callout tone="err" compact>{error}</Callout>}
  </div>;
}
