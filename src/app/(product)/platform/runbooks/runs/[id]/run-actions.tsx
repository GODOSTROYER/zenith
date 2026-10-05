"use client";
/**
 * Approve or cancel one runbook run. Approval carries the binding digest the person reviewed; the API
 * refuses it if the run's binding moved, and refuses an approver who is the requester or not an admin.
 * This control only mirrors those rules so a disabled button always says why.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { browserMutation, mutationError } from "../../../_lib/browser-api";

export function RunActions({ workspaceId, runId, bindingDigest, approve, cancel }: {
  workspaceId: string; runId: string; bindingDigest: string;
  approve: { eligible: boolean; reason?: string };
  cancel: { available: boolean; reason?: string };
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "cancel" | null>(null);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const hintId = useId();
  useEffect(() => { if (done) statusRef.current?.focus(); }, [done]);
  const run = async (kind: "approve" | "cancel") => {
    if (inFlight.current || done) return;
    inFlight.current = true; setPending(kind); setError(undefined);
    try {
      await browserMutation(workspaceId, `/api/platform/v1/runbooks/runs/${encodeURIComponent(runId)}/${kind}`, kind === "approve" ? { bindingDigest } : { reason: "cancelled from the operator console" });
      setDone(kind === "approve" ? "Approval recorded for exactly the effect shown on this page. Refreshing the latest state." : "Cancellation requested. A step already in flight is aborted and no further step starts. Refreshing the latest state.");
      router.refresh();
    } catch (failure) { setError(mutationError(failure)); }
    finally { inFlight.current = false; setPending(null); }
  };
  const hint = [approve.eligible ? undefined : approve.reason, cancel.available ? undefined : cancel.reason].filter(Boolean).join(" ");
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => void run("approve")} busy={pending === "approve"} disabled={!approve.eligible || Boolean(done)} disabledReason={approve.reason} aria-describedby={hint ? hintId : undefined}>Approve this run</Button>
      <Button variant="quiet" onClick={() => void run("cancel")} busy={pending === "cancel"} disabled={!cancel.available || Boolean(done)} disabledReason={cancel.reason} aria-describedby={hint ? hintId : undefined}>Cancel run</Button>
    </div>
    {hint && <p id={hintId} className="text-[12.5px] text-ink-mute">{hint}</p>}
    {done && <p ref={statusRef} tabIndex={-1} role="status" className="text-[13px] text-ink-mute outline-none focus-visible:ring-2 focus-visible:ring-signal">{done}</p>}
    {error && <Callout tone="err">{error}</Callout>}
  </div>;
}
