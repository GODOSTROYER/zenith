"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import type { RoleName } from "@/components/platform/labels";
import type { ConnectionView } from "@/lib/connections/service";
import { connectionMutation, parseConnectionHandoff, type ConnectionDraft } from "@/lib/connections/handoff";
import { browserMutation, mutationError } from "../../_lib/browser-api";

const TITLES = { "connection.createRunner": "Create runner connection", "connection.verify": "Verify connection", "connection.rotate": "Stage and verify new access", "connection.promoteRotation": "Promote new access", "connection.abortRotation": "Discard staged access", "connection.revoke": "Revoke connection" };

export function ConnectionConfirmation({ workspaceId, viewerRole, connections }: { workspaceId: string; viewerRole: RoleName; connections: ConnectionView[] }) {
  const [draft, setDraft] = useState<ConnectionDraft>();
  const [error, setError] = useState<string>();
  const [reviewed, setReviewed] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; summary: string; error?: string }>();
  const generation = useRef(0);
  useEffect(() => {
    const read = () => {
      generation.current++;
      setReviewed(false); setTyped(""); setResult(undefined); setDraft(undefined); setError(undefined);
      try {
        const next = parseConnectionHandoff(window.location.hash);
        if (next.workspaceId && next.workspaceId !== workspaceId) throw new Error();
        setDraft(next);
      } catch { setError("This draft is invalid or belongs to another workspace. Ask for a new draft, or use Cloud connections."); }
    };
    read(); window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [workspaceId]);
  const request = draft?.request;
  const connectionId = request && request.action !== "connection.createRunner" ? request.input.connectionId : undefined;
  const connection = connections.find(c => c.id === connectionId);
  const requiredRole = request?.action === "connection.verify" ? "editor" : "admin";
  const roleAllowed = viewerRole === "admin" || (requiredRole === "editor" && viewerRole === "editor");
  const unavailable = request && request.action !== "connection.createRunner" && (!connection || connection.status === "revoked");
  const invalidRotation = request && (request.action === "connection.promoteRotation" || request.action === "connection.abortRotation") && (connection?.rotation?.id !== request.input.rotationId || (request.action === "connection.promoteRotation" && connection?.rotation?.status !== "verified"));
  const blocked = !roleAllowed ? `A current workspace ${requiredRole} must confirm this change.` : unavailable ? "This connection is unavailable or revoked. Create a new connection to restore access." : invalidRotation ? "The staged access changed or is not verified. Open Cloud connections and review it again." : undefined;
  const consent = reviewed && (request?.action !== "connection.revoke" || typed === connectionId);
  async function confirm() {
    if (!request || blocked || !consent || busy || result?.ok) return;
    setBusy(true); setResult(undefined);
    const submittedGeneration = generation.current;
    try {
      // Changing the fragment never changes an in-flight request or grants consent to the next draft.
      const mutation = connectionMutation(request);
      const answer = await browserMutation<{ ok: boolean; summary: string; error?: string }>(workspaceId, mutation.path, mutation.body);
      if (submittedGeneration === generation.current) setResult(answer);
    } catch (failure) { if (submittedGeneration === generation.current) setResult({ ok: false, summary: "Change not completed", error: mutationError(failure) }); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4" aria-label="Connection confirmation">
    <p className="text-[13px] text-ink-mute">This is an unapproved draft from a CLI or agent. Review the exact identifiers below. Nothing happens until you confirm in this signed-in browser.</p>
    <p className="break-all text-[13px]">Workspace: {workspaceId}</p>
    {error && <div role="alert"><Callout tone="err" title="Draft unavailable">{error}</Callout></div>}
    {request && <>
      <h2 className="text-[16px] font-medium">{TITLES[request.action]}</h2>
      {connection && <p className="break-all text-[13px]">{connection.label} · {connection.provider} · {connection.mode} · {connection.status}</p>}
      <dl className="divide-y divide-line border-y border-line text-[13px]">{Object.entries(request.input).map(([key, value]) => <div key={key} className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]"><dt className="text-ink-mute">{key}</dt><dd className="min-w-0 whitespace-pre-wrap break-all">{typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}</dd></div>)}</dl>
      <Callout tone={request.action === "connection.revoke" ? "warn" : "info"} title={request.action === "connection.revoke" ? "Revocation is permanent" : "What this confirms"}>
        {request.action === "connection.revoke" ? "The next dispatch is refused immediately. Create a new connection to use this cloud again." : "Runner verification checks registration, heartbeat, protocol, advertised job kind and custody. It does not prove cloud identity, connectivity or permissions. Rotation preserves the current access until verified new access is promoted."}
      </Callout>
      {blocked && <div role="alert"><Callout tone="warn" title="Confirmation unavailable">{blocked}</Callout></div>}
      {request.action === "connection.revoke" && <label className="block space-y-1 text-[13px]">Type the connection id to confirm<Input value={typed} disabled={!!blocked || busy || result?.ok} onChange={e => setTyped(e.target.value)} placeholder={connectionId} /></label>}
      <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" checked={reviewed} disabled={!!blocked || busy || result?.ok} onChange={e => setReviewed(e.target.checked)} />I reviewed these exact identifiers and the selected workspace.</label>
      <Button variant={request.action === "connection.revoke" ? "danger" : "primary"} busy={busy} disabled={!consent || !!blocked || busy || result?.ok} disabledReason={blocked ?? (result?.ok ? "This draft was already confirmed." : "Review the identifiers, check the confirmation box and type the id for revocation.")} onClick={() => void confirm()}>Confirm {TITLES[request.action].toLowerCase()}</Button>
    </>}
    {result && <div role={result.ok ? "status" : "alert"}><Callout tone={result.ok ? "ok" : "err"} title={result.ok ? "Change confirmed" : "Change not completed"}>{result.summary}{result.error && <p>{result.error}</p>}</Callout></div>}
    <Link href="/platform/connections" className="inline-block text-[13px] text-signal underline">Return to Cloud connections to verify, rotate or revoke</Link>
  </section>;
}
