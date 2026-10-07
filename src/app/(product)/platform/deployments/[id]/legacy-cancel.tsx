"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { executeAction } from "@/lib/client/api";
import { Button } from "@/components/ui/button";

export function LegacyCancel({ deploymentId, canCancel }: { deploymentId: string; canCancel: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirm) confirmRef.current?.focus(); }, [confirm]);
  useEffect(() => { if (message) resultRef.current?.focus(); }, [message]);
  async function cancel() {
    if (!canCancel || pending.current) return;
    pending.current = true; setBusy(true); setMessage("");
    try {
      const result = await executeAction("deploy.cancel", { input: { deploymentId } });
      if (!result.ok) throw new Error();
      setMessage("Cancellation recorded. Changes already applied remain in the environment.");
      setConfirm(false); router.refresh();
    } catch { setMessage("Cancellation could not be confirmed. Verify your authenticator and reload to check the current deployment before retrying."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section aria-labelledby="legacy-cancel-title" className="space-y-3">
    <h2 id="legacy-cancel-title" className="text-lg font-medium">Cancel deployment</h2>
    <p id="legacy-cancel-help">Cancellation stops remaining work. It does not undo changes already applied.</p>
    {!canCancel && <p id="legacy-cancel-role">An editor or admin must cancel this deployment.</p>}
    {message && <p ref={resultRef} role="status" tabIndex={-1}>{message}</p>}
    {!message.startsWith("Cancellation recorded") && (confirm ? <>
      <Button ref={confirmRef} busy={busy} variant="danger" aria-describedby="legacy-cancel-help" onClick={() => void cancel()}>Confirm cancellation</Button>
      <Button disabled={busy} disabledReason="Wait for the cancellation response." onClick={() => setConfirm(false)}>Keep deployment running</Button>
    </> : <Button disabled={!canCancel} busy={busy} disabledReason="An editor or admin must cancel this deployment." aria-describedby={!canCancel ? "legacy-cancel-role legacy-cancel-help" : "legacy-cancel-help"} onClick={() => setConfirm(true)}>Cancel deployment</Button>)}
    <Link href={`/account/mfa/challenge?next=${encodeURIComponent(`/platform/deployments/${deploymentId}`)}`} className="text-signal underline">Verify authenticator before cancelling</Link>
  </section>;
}
