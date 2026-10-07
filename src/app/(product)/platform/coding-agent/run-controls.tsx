"use client";
/**
 * Browser-only controls for coding-agent runs: start, resume, cancel, adopt, and a
 * polite auto-refresh while a run is working. Every decision is server-checked
 * (admin role, live browser session, approved broker operation for adopt); this
 * only drives the browser-only routes. Results are announced in a status region
 * and focus stays on the control that was used.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { mutationError } from "../_lib/browser-api";

const BASE = "/api/platform/v1/coding-agent/runs";

function useCall(workspaceId: string) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const call = async <T,>(key: string, path: string, body: unknown): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      return await api<T>(path, { method: "POST", credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId }, body: JSON.stringify(body) });
    } catch (failure) {
      setError(mutationError(failure));
      return undefined;
    } finally {
      inFlight.current = false;
      setBusy(undefined);
    }
  };
  return { call, busy, error, notice, setNotice };
}

const Status = ({ error, notice }: { error?: string; notice?: string }) => (
  <div aria-live="polite" className="min-h-5">
    {error && <Callout tone="err">{error}</Callout>}
    {notice && <p role="status" className="text-[13px] text-ink-mute">{notice}</p>}
  </div>
);

/** Re-reads the page every few seconds while a run is working; paused when the tab is hidden. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 5_000);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}

export interface RunControlsProps {
  workspaceId: string;
  runId: string;
  resumable: boolean;
  cancellable: boolean;
  /** the broker operation is approved and still names this run's manifest */
  adoptReady: boolean;
  /** why adopt is unavailable, shown with the disabled button */
  adoptReason: string;
  hasProject: boolean;
}

export function RunControls({ workspaceId, runId, resumable, cancellable, adoptReady, adoptReason, hasProject }: RunControlsProps) {
  const router = useRouter();
  const { call, busy, error, notice, setNotice } = useCall(workspaceId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const done = (message: string) => {
    setNotice(message);
    router.refresh();
  };
  return (
    <div className="space-y-3" role="group" aria-label="Run actions">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" busy={busy === "resume"} disabled={!resumable || !!busy} disabledReason="Only a run stopped by a budget or an error can be resumed."
          onClick={async () => { if (await call("resume", `${BASE}/${encodeURIComponent(runId)}/resume`, {})) done("Resumed from the last checkpoint with the same budgets."); }}>
          Resume
        </Button>
        <Button variant="quiet" size="sm" busy={busy === "resume-more"} disabled={!resumable || !!busy} disabledReason="Only a run stopped by a budget or an error can be resumed."
          onClick={async () => { if (await call("resume-more", `${BASE}/${encodeURIComponent(runId)}/resume`, { limits: { inputTokens: 600_000, outputTokens: 80_000, toolCalls: 80, wallTimeMs: 6 * 60_000, spendMicroUsd: 4_000_000 } })) done("Resumed with raised budgets (still within platform ceilings)."); }}>
          Resume with higher budgets
        </Button>
        <Button variant="quiet" size="sm" busy={busy === "adopt"} disabled={!adoptReady || !!busy} disabledReason={adoptReason}
          onClick={async () => { if (await call("adopt", `${BASE}/${encodeURIComponent(runId)}/adopt`, {})) done("Adopted into the project working copy. Review it in the project, then plan and deploy as usual."); }}>
          Adopt into project
        </Button>
        {!confirmCancel ? (
          <Button variant="ghost" size="sm" disabled={!cancellable || !!busy} disabledReason="This run already finished." onClick={() => setConfirmCancel(true)}>
            Cancel run
          </Button>
        ) : (
          <span role="group" aria-label="Confirm cancel" className="flex items-center gap-2">
            <Button variant="danger" size="sm" autoFocus busy={busy === "cancel"} disabled={!!busy}
              onClick={async () => { if (await call("cancel", `${BASE}/${encodeURIComponent(runId)}/cancel`, {})) { setConfirmCancel(false); done("Cancelled. Nothing was deployed."); } }}>
              Confirm cancel
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)} onKeyDown={(e) => { if (e.key === "Escape") setConfirmCancel(false); }}>
              Keep running
            </Button>
          </span>
        )}
      </div>
      {!hasProject && <p className="text-[12px] text-ink-mute">This run has no target project, so nothing was submitted for approval and there is nothing to adopt.</p>}
      <Status error={error} notice={notice} />
    </div>
  );
}

export interface StartTarget {
  environmentId: string;
  projectId: string;
  label: string;
}

export function StartRun({ workspaceId, targets }: { workspaceId: string; targets: StartTarget[] }) {
  const router = useRouter();
  const { call, busy, error } = useCall(workspaceId);
  const [task, setTask] = useState("Analyze this repository and propose how to deploy it.");
  const [repository, setRepository] = useState("");
  const [ref, setRef] = useState("HEAD");
  const [target, setTarget] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const chosen = targets.find((t) => t.environmentId === target);
    const run = await call<{ id: string }>("start", BASE, { task, repository: repository.trim(), ref: ref.trim() || "HEAD", ...(chosen ? { target: { projectId: chosen.projectId, environmentId: chosen.environmentId } } : {}) });
    if (run) router.push(`/platform/coding-agent/${encodeURIComponent(run.id)}`);
  };
  const label = "mb-1 block text-[12px] font-medium text-ink";
  const control = "w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal";
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Start a coding agent run">
      <div>
        <label htmlFor="car-task" className={label}>Task</label>
        <textarea id="car-task" required maxLength={2000} rows={2} value={task} onChange={(e) => setTask(e.target.value)} className={control} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="car-repo" className={label}>Repository (owner/name)</label>
          <input id="car-repo" required pattern="[A-Za-z0-9._\-]+/[A-Za-z0-9._\-]+" value={repository} onChange={(e) => setRepository(e.target.value)} className={control} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="car-ref" className={label}>Branch, tag or commit</label>
          <input id="car-ref" value={ref} onChange={(e) => setRef(e.target.value)} className={control} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="car-target" className={label}>Submit the proposal for approval in</label>
          <select id="car-target" value={target} onChange={(e) => setTarget(e.target.value)} className={control}>
            <option value="">Do not submit (keep in the run)</option>
            {targets.map((t) => <option key={t.environmentId} value={t.environmentId}>{t.label}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="md" busy={busy === "start"} disabled={!!busy}>Start run</Button>
        <p className="text-[12px] text-ink-mute">The run pins the commit, then continues in the background with default budgets. Nothing is deployed.</p>
      </div>
      <div aria-live="polite">{error && <Callout tone="err">{error}</Callout>}</div>
    </form>
  );
}
