"use client";
/** Approval uses the reviewed binding digest and browser cookies; the API enforces live identity, Origin and the non-requester rule. */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { browserMutation, mutationError } from "../../_lib/browser-api";

export function ReleaseActions({ releaseId, bindingDigest, workspaceId, disabledReason, migrationClass }: { releaseId: string; bindingDigest: string; workspaceId: string; disabledReason?: string; migrationClass: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const approve = async () => {
    if (inFlight.current || done || disabledReason) return;
    inFlight.current = true; setPending(true); setError(undefined);
    try {
      await browserMutation(workspaceId, `/api/platform/v1/releases/${encodeURIComponent(releaseId)}/approve-migration`, { bindingDigest });
      setDone(true); router.refresh();
    } catch (failure) { setError(mutationError(failure)); }
    finally { inFlight.current = false; setPending(false); }
  };
  return (
    <div className="space-y-2">
      <Button onClick={() => void approve()} busy={pending} disabled={Boolean(disabledReason) || done} disabledReason={disabledReason}>Approve {migrationClass} migration</Button>
      {disabledReason && <p className="text-[12px] text-ink-mute">{disabledReason}</p>}
      {done && <p role="status" className="text-[13px] text-ink-mute">Approval recorded. Deploy again to run the migration.</p>}
      {error && <Callout tone="err">{error}</Callout>}
    </div>
  );
}
