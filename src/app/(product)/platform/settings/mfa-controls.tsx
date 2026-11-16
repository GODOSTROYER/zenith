"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { WorkspaceMfaSettings } from "@/lib/auth/mfa-policy";
import type { RoleName } from "@/components/platform/labels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function MfaControls({ workspaceId, viewerRole }: { workspaceId: string; viewerRole: RoleName }) {
  const [policy, setPolicy] = useState<WorkspaceMfaSettings>();
  const [allMutations, setAllMutations] = useState(false);
  const [maxAge, setMaxAge] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const inFlight = useRef(false);
  const alert = useRef<HTMLParagraphElement>(null);
  const success = useRef<HTMLParagraphElement>(null);
  const blocked = viewerRole !== "admin";
  useEffect(() => {
    let active = true;
    setPolicy(undefined); setError(undefined); setSaved(false);
    void api<WorkspaceMfaSettings>("/api/workspace/mfa").then((result) => {
      if (!active) return;
      if (result.workspaceId !== workspaceId) { setError("Your selected workspace changed. Reload before changing controls."); return; }
      setPolicy(result);
      setAllMutations(result.requireForAllMutations); setMaxAge(result.maxAgeSeconds === null ? "" : String(result.maxAgeSeconds));
    }).catch(() => { if (active) setError("The workspace controls could not be loaded. Reload before changing privileged settings."); });
    return () => { active = false; };
  }, [workspaceId, reload]);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);
  useEffect(() => { if (saved) success.current?.focus(); }, [saved]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || inFlight.current || !policy || policy.workspaceId !== workspaceId) return;
    setError(undefined); setSaved(false);
    const age = maxAge.trim() === "" ? null : Number(maxAge);
    if (age !== null && (!Number.isInteger(age) || age < 60 || age > 86400)) { setError("Enter whole seconds from 60 to 86400, or leave the lifetime blank."); return; }
    inFlight.current = true; setPending(true);
    try {
      const next = await api<WorkspaceMfaSettings>("/api/workspace/mfa", { method: "PUT", credentials: "same-origin", body: JSON.stringify({ workspaceId, requireForAllMutations: allMutations, maxAgeSeconds: age, expectedVersion: policy.version }) });
      if (next.workspaceId !== workspaceId) throw new Error("Workspace changed.");
      setPolicy(next); setAllMutations(next.requireForAllMutations); setMaxAge(next.maxAgeSeconds === null ? "" : String(next.maxAgeSeconds)); setSaved(true);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 403 ? "Verify your authenticator, then review and save again. Your workspace role must also allow this change."
        : failure instanceof ApiError && failure.status === 409 ? "The controls or selected workspace changed. Reload and review before saving again."
          : "The controls could not be saved. Reload before retrying.");
    } finally { inFlight.current = false; setPending(false); }
  };
  return <section aria-labelledby="workspace-mfa-title" className="space-y-3 rounded border border-line p-4">
    <h2 id="workspace-mfa-title" className="text-lg font-medium">Workspace authenticator controls</h2>
    <p>Approval, destructive actions, connections, trust and access changes require a verified authenticator in every workspace.</p>
    {policy?.workspaceId === workspaceId ? <>
      <p>{policy.requireForAllMutations ? "This workspace requires verification for all changes by people." : "This workspace requires verification for privileged changes."}</p>
      <p>{policy.maxAgeSeconds === null ? "Verification lasts for the authenticated session." : `Verification expires after ${policy.maxAgeSeconds} seconds. Verify again before submitting later changes.`}</p>
      <p>Version {policy.version}{policy.isDefault ? " · workspace defaults" : " · saved workspace controls"}. Workspace role and approval controls still apply.</p>
      <form onSubmit={(event) => void save(event)} className="space-y-3">
        <fieldset disabled={blocked || pending} className="space-y-3" aria-describedby="workspace-mfa-help">
          <legend className="font-medium">MFA enforcement</legend>
          <label htmlFor="workspace-mfa-all" className="flex items-center gap-2"><input id="workspace-mfa-all" type="checkbox" checked={allMutations} onChange={(event) => { setAllMutations(event.target.checked); setSaved(false); }} />Require verification for all changes by people</label>
          <label htmlFor="workspace-mfa-age" className="block">Verification lifetime (seconds)</label>
          <Input id="workspace-mfa-age" type="number" min={60} max={86400} step={1} value={maxAge} onChange={(event) => { setMaxAge(event.target.value); setSaved(false); }} aria-describedby="workspace-mfa-help" />
        </fieldset>
        <p id="workspace-mfa-help">Leave the lifetime blank to use your current verified session. Otherwise use 60 to 86400 seconds since authenticator verification. Privileged actions always require an authenticator.</p>
        {blocked && <p>Only a workspace admin can change these controls.</p>}
        <Button type="submit" busy={pending} disabled={blocked} disabledReason={blocked ? "Only workspace admins can change MFA controls." : undefined}>Save MFA controls</Button>
      </form>
    </> : <p role="status">Loading workspace controls…</p>}
    {error && <p ref={alert} tabIndex={-1} role="alert">{error}</p>}
    {saved && <p ref={success} tabIndex={-1} role="status">MFA controls saved at version {policy?.version}.</p>}
    <Button variant="quiet" disabled={pending} onClick={() => setReload((value) => value + 1)}>Reload MFA controls</Button>
    <Link href="/account/mfa/enrol" className="text-signal underline">Set up an authenticator</Link>{" · "}
    <Link href="/account/mfa/challenge?next=%2Fplatform%2Fsettings" className="text-signal underline">Verify before changing controls</Link>
  </section>;
}
