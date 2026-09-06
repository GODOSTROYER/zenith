"use client";
import { useRef, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { Bootstrap } from "./types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorNote } from "../shared";

export function StepWorkspace({ boot, loading, onDone }: {
  boot: Bootstrap | undefined; loading: boolean; onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<unknown>();
  const [creating, setCreating] = useState(false);
  const existing = boot?.workspace;
  const submit = async (workspaceId?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await api(workspaceId ? "/api/workspace/select" : "/api/workspace", {
        method: "POST", body: JSON.stringify(workspaceId ? { workspaceId } : { name: name.trim() }),
      });
      onDone();
    } catch (cause) {
      // Creation has no server idempotency key: reconcile interrupted responses.
      if (!workspaceId && (!(cause instanceof ApiError) || cause.status >= 500)) setUncertain(true);
      setError(cause instanceof ApiError && cause.status === 409
        ? new ApiError(cause.message, 409, "Use your existing workspace. Multiple workspaces require configured authentication.") : cause);
    } finally { inFlight.current = false; setBusy(false); }
  };
  if (loading) return <Skeleton height={180} />;
  return <div className="max-w-[680px] space-y-6">
    <p className="text-sm leading-relaxed text-ink-mute">A workspace holds your team’s projects, connections and history. Choose one you belong to, or create a space for a new team.</p>
    {existing && boot && <div className="space-y-3">{(boot.workspaces.length ? boot.workspaces : [{ ...existing, role: boot.role }]).map((w) => <div key={w.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-bg1 p-4">
      <div className="min-w-0"><p className="break-words font-medium text-ink">{w.name}</p><p className="mt-1 text-xs text-ink-faint">{w.role ?? "No role"}{w.id === existing.id ? " · Current workspace" : ""}</p></div>
      <Button variant={w.id === existing.id ? "primary" : "quiet"} busy={busy} onClick={() => w.id === existing.id ? onDone() : submit(w.id)}>{w.id === existing.id ? "Continue here" : "Use workspace"}</Button>
    </div>)}</div>}
    {existing && boot?.auth.configured && !creating && <Button variant="quiet" onClick={() => setCreating(true)}>Create another workspace</Button>}
    {(!existing || creating) && <div className="space-y-4 border-y border-line bg-bg2 p-5">
      <Field label="Workspace name" help="Creating a workspace also creates a local sandbox connection for optional simulation. It does not provision cloud resources."><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Your team" /></Field>
      <Button busy={busy} disabled={!name.trim() || uncertain} disabledReason={uncertain ? "Check your workspaces before attempting another creation." : "Give the workspace a name first."} onClick={() => submit()}>Create workspace</Button>
      {existing && <Button variant="quiet" disabled={busy} onClick={() => setCreating(false)}>Cancel</Button>}
    </div>}
    {error ? <ErrorNote error={error} /> : null}
    {uncertain && <p className="text-sm text-ink-mute">The response was interrupted. <a href="/onboarding?step=1" className="text-signal underline">Reload your workspace list</a> to check whether creation succeeded before trying again.</p>}
    {existing && !boot?.auth.configured && <p className="text-xs text-ink-faint">This installation is in demo mode with one workspace. Authenticated installations support separate team memberships.</p>}
  </div>;
}
