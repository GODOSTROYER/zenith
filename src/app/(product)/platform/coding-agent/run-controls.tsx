"use client";
/** Browser-only Gimbal controls. Source and execution authority are always rechecked by the server. */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { RepositoryPicker, type RepositoryDraft, type RepositorySelection } from "@/components/sources/repository-picker";
import { DEFAULT_LIMITS, HARD_CEILINGS } from "@/lib/coding-agent/budget";
import type { BudgetLimits } from "@/lib/coding-agent/types";
import { mutationError } from "../_lib/browser-api";

const BASE = "/api/platform/v1/coding-agent/runs";

function useCall(workspaceId: string, runId?: string) {
  const inFlight = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const scope = JSON.stringify([workspaceId, runId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    inFlight.current = false;
    setBusy(undefined); setError(undefined); setNotice(undefined);
    return () => controller.abort();
  }, [scope]);
  const call = async <T,>(key: string, path: string, body: unknown, method: "POST" | "DELETE" = "POST", idempotencyKey?: string): Promise<T | undefined> => {
    const controller = lifetime.current;
    const current = () => controller !== null && !controller.signal.aborted && lifetime.current === controller && currentScope.current === scope;
    if (inFlight.current || !current()) return undefined;
    inFlight.current = true; setBusy(key); setError(undefined); setNotice(undefined);
    try {
      const result = await api<T>(path, { method, credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) }, body: JSON.stringify(body) });
      return current() ? result : undefined;
    }
    catch (failure) {
      if (!current()) return undefined;
      const status = failure instanceof Error && "status" in failure ? failure.status : undefined;
      setError(key === "start" && (status === undefined || (typeof status === "number" && status >= 500))
        ? "The run could not be confirmed. Submit the same inputs again to safely check this request."
        : mutationError(failure));
      return undefined;
    }
    finally { if (current()) { inFlight.current = false; setBusy(undefined); } }
  };
  return { call, busy, error, notice, setNotice };
}

const Status = ({ error, notice }: { error?: string; notice?: string }) => <div aria-live="polite" className="min-h-5">{error && <Callout tone="err">{error}</Callout>}{notice && <p role="status" className="text-[13px] text-ink-mute">{notice}</p>}</div>;

/** Pause background refresh when the browser tab is hidden. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, 5_000);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}

interface Handoff { digest: string; expiresAt: string; filename: string; markdown: string; mcp: { path: string; tool: string; arguments: unknown } | null }
export interface RunControlsProps {
  workspaceId: string;
  runId: string;
  resumable: boolean;
  cancellable: boolean;
  adoptReady: boolean;
  adoptReason: string;
  hasProject: boolean;
  handoffReady?: boolean;
  planningHref?: string;
  runVersion?: number;
  contentDeletable?: boolean;
  /** Captured when the proposal's base was read. Never replaced with a fresh current hash. */
  baseManifestHash?: string;
  limits?: BudgetLimits;
  usage?: BudgetLimits;
}

export function RunControls({ workspaceId, runId, resumable, cancellable, adoptReady, adoptReason, hasProject, handoffReady = true, planningHref, runVersion, contentDeletable = false, baseManifestHash, limits = DEFAULT_LIMITS, usage }: RunControlsProps) {
  const router = useRouter();
  const { call, busy, error, notice, setNotice } = useCall(workspaceId, runId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmBudget, setConfirmBudget] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [handoff, setHandoff] = useState<Handoff>();
  useEffect(() => {
    setHandoff(undefined); setConfirmCancel(false); setConfirmBudget(false); setConfirmDelete(false);
  }, [workspaceId, runId]);
  const hasBase = typeof baseManifestHash === "string" && /^[a-f0-9]{8,64}$/.test(baseManifestHash);
  const nextLimits = Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, Math.min(value * 2, HARD_CEILINGS[key as keyof BudgetLimits])])) as unknown as BudgetLimits;
  const canRaise = Object.keys(limits).some(key => nextLimits[key as keyof BudgetLimits] > limits[key as keyof BudgetLimits]);
  const usd = (value: number) => `$${(value / 1_000_000).toFixed(2)}`;
  const done = (message: string) => { setNotice(message); router.refresh(); };
  const download = () => {
    if (!handoff) return;
    const url = URL.createObjectURL(new Blob([handoff.markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url;
    link.download = /^[A-Za-z0-9._-]{1,180}$/.test(handoff.filename) ? handoff.filename : "zenith-handoff.md";
    link.click(); URL.revokeObjectURL(url);
  };
  return <div className="space-y-3" role="group" aria-label="Run actions">
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" size="sm" busy={busy === "resume"} disabled={!resumable || !!busy} disabledReason="Only a run stopped by a budget or an error can be resumed." onClick={async () => { if (await call("resume", `${BASE}/${encodeURIComponent(runId)}/resume`, {})) done("Resumed from the checkpoint with the same total budgets."); }}>Resume</Button>
      <Button variant="quiet" size="sm" disabled={!resumable || !canRaise || !!busy} disabledReason="Resume requires a stopped run and room within platform budget ceilings." onClick={() => setConfirmBudget(true)}>Review higher budgets</Button>
      <Button variant="quiet" size="sm" busy={busy === "adopt"} disabled={!adoptReady || !hasBase || !!busy} disabledReason={!hasBase ? "This run has no recorded project revision. Start a new plan against the current project." : adoptReason} onClick={async () => { if (await call("adopt", `${BASE}/${encodeURIComponent(runId)}/adopt`, { expectedHash: baseManifestHash })) done("Adopted into the project working copy. Review the project, then plan and deploy as usual."); }}>Adopt into project</Button>
      <Button variant="quiet" size="sm" busy={busy === "handoff"} disabled={!!busy || !handoffReady} disabledReason="Wait for the run to stop before preparing continuation context." onClick={async () => { const out = await call<Handoff>("handoff", `${BASE}/${encodeURIComponent(runId)}/handoff`, {}); if (out) { setHandoff(out); setNotice("Continuation context prepared. Your Claude Code connection has its own permissions."); } }}>Continue in Claude Code</Button>
      {runVersion !== undefined && <Button variant="ghost" size="sm" disabled={!contentDeletable || !!busy} disabledReason="Wait for the run to stop before deleting retained analysis content." onClick={() => setConfirmDelete(true)}>Delete analysis content</Button>}
      {!confirmCancel ? <Button variant="ghost" size="sm" disabled={!cancellable || !!busy} disabledReason="This run already finished." onClick={() => setConfirmCancel(true)}>Cancel run</Button> : <span role="group" aria-label="Confirm cancel" className="flex items-center gap-2"><Button variant="danger" size="sm" autoFocus busy={busy === "cancel"} disabled={!!busy} onClick={async () => { if (await call("cancel", `${BASE}/${encodeURIComponent(runId)}/cancel`, {})) { setConfirmCancel(false); done("Cancelled. No deployment was started by this run."); } }}>Confirm cancel</Button><Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)} onKeyDown={event => { if (event.key === "Escape") setConfirmCancel(false); }}>Keep running</Button></span>}
    </div>
    {confirmBudget && <section aria-label="Review increased analysis budget" className="space-y-3 rounded-card border border-line bg-bg2 p-4">
      <h3 className="text-[14px] font-semibold">Review the new total allowance</h3>
      <p className="text-[13px]">Estimated model spend: {usd(usage?.spendMicroUsd ?? 0)} used. Total ceiling changes from {usd(limits.spendMicroUsd)} to <strong>{usd(nextLimits.spendMicroUsd)}</strong>, an increase of {usd(nextLimits.spendMicroUsd - limits.spendMicroUsd)}.</p>
      <p className="text-[12px] text-ink-mute">Total tool calls: {limits.toolCalls} → {nextLimits.toolCalls}. Total active time: {Math.round(limits.wallTimeMs / 60_000)} → {Math.round(nextLimits.wallTimeMs / 60_000)} minutes. Input tokens: {limits.inputTokens.toLocaleString()} → {nextLimits.inputTokens.toLocaleString()}. Output tokens: {limits.outputTokens.toLocaleString()} → {nextLimits.outputTokens.toLocaleString()}.</p>
      <div className="flex flex-wrap gap-2"><Button busy={busy === "resume-more"} disabled={!!busy} onClick={async () => { if (await call("resume-more", `${BASE}/${encodeURIComponent(runId)}/resume`, { limits: nextLimits })) { setConfirmBudget(false); done("Resumed with the reviewed total budgets."); } }}>Approve budget and resume</Button><Button variant="ghost" disabled={!!busy} onClick={() => setConfirmBudget(false)}>Keep current budgets</Button></div>
    </section>}
    {confirmDelete && <section aria-label="Confirm analysis content deletion" className="space-y-3 rounded-card border border-line p-4">
      <h3 className="text-[14px] font-semibold">Delete retained analysis content?</h3>
      <p className="text-[13px] text-ink-mute">This removes stored task, transcript, and result content. The run cannot be resumed or handed off afterwards. Minimal audit records remain. GitHub access and running applications are managed separately.</p>
      <div className="flex flex-wrap gap-2"><Button variant="danger" busy={busy === "delete-content"} disabled={!!busy} onClick={async () => { if (await call("delete-content", `${BASE}/${encodeURIComponent(runId)}`, { expectedVersion: runVersion }, "DELETE")) { setHandoff(undefined); setConfirmDelete(false); router.push("/platform/coding-agent"); router.refresh(); } }}>Confirm delete analysis content</Button><Button variant="ghost" disabled={!!busy} onClick={() => setConfirmDelete(false)}>Keep analysis</Button></div>
    </section>}
    {handoff && <section aria-label="Claude Code continuation" className="space-y-3 rounded-card border border-line bg-bg2 p-4">
      <h3 className="text-[14px] font-semibold">Continue with the same source and decisions</h3>
      <p className="text-[13px] text-ink-mute">Download or copy this context into your local Claude Code task. Verify its repository and commit against your checkout. Changed code must return through analysis and review before deployment.</p>
      <p className="text-[12px] text-ink-mute">{handoff.mcp ? <>For authenticated MCP retrieval, connect your client under <Link href="/integrations" className="text-signal hover:underline">Agent integrations</Link>.</> : <>This analysis has no project target. Use the downloaded context to continue locally; project-scoped MCP retrieval requires a target project.</>} You can revoke that connection independently of GitHub repository access. Context expires {new Date(handoff.expiresAt).toLocaleString()}.</p>
      <label className="block space-y-1 text-[12px] text-ink-mute"><span>Continuation context</span><textarea readOnly value={handoff.markdown} rows={8} className="w-full rounded-ctl border border-line bg-bg p-3 font-mono text-[12px] text-ink" /></label>
      <div className="flex flex-wrap gap-2"><Button size="sm" onClick={download}>Download context</Button><Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(handoff.markdown); setNotice("Continuation context copied."); } catch { setNotice("Clipboard is unavailable. Select the context above or download it."); } }}>Copy context</Button><Button variant="ghost" size="sm" onClick={() => setHandoff(undefined)}>Close context</Button></div>
    </section>}
    {!hasProject && <p className="text-[12px] text-ink-mute">Analysis-only run: findings and Claude continuation are available here. To create a deployment proposal, choose a project and environment in a new run using this same commit. {planningHref && <Link href={planningHref} className="text-signal hover:underline">Choose a project for this source</Link>}</p>}
    <Status error={error} notice={notice} />
  </div>;
}

export interface StartTarget { environmentId: string; projectId: string; label: string }

export function StartRun({ workspaceId, targets, initialSource, initialEnvironmentId }: { workspaceId: string; targets: StartTarget[]; initialSource?: RepositoryDraft; initialEnvironmentId?: string }) {
  const router = useRouter();
  const { call, busy, error } = useCall(workspaceId);
  const [task, setTask] = useState("Analyze this repository and propose how to deploy it.");
  const [selection, setSelection] = useState<RepositorySelection | null>(null);
  const [target, setTarget] = useState(targets.some(item => item.environmentId === initialEnvironmentId) ? initialEnvironmentId! : "");
  const [intent, setIntent] = useState<"analysis" | "plan">(initialEnvironmentId ? "plan" : "analysis");
  const [mode, setMode] = useState<"static" | "model">("static");
  const chosen = intent === "plan" ? targets.find(item => item.environmentId === target) : undefined;
  // A lost response may still have started a run. Reuse this key while retrying
  // the same draft; editing inputs or opening a new form starts a new request.
  const requestKey = useRef<string | undefined>(undefined);
  useEffect(() => { requestKey.current = undefined; }, [workspaceId, selection, task, intent, target, mode, chosen?.projectId]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selection || (intent === "plan" && !chosen)) return;
    requestKey.current ??= crypto.randomUUID();
    const run = await call<{ id: string }>("start", BASE, {
      task, mode,
      accessKind: selection.bindingId ? "installed" : "public",
      repository: selection.repository, repositoryId: selection.repositoryId, ref: selection.ref, root: selection.root,
      ...(selection.bindingId ? { bindingId: selection.bindingId, bindingVersion: selection.bindingVersion } : {}),
      ...(selection.contextDir !== undefined ? { contextDir: selection.contextDir } : {}),
      ...(selection.contextDigest ? { contextDigest: selection.contextDigest, dockerfile: selection.inspection.buildSource?.dockerfile } : {}),
      ...(chosen ? { target: { projectId: chosen.projectId, environmentId: chosen.environmentId } } : {}),
    }, "POST", requestKey.current);
    if (run) router.push(`/platform/coding-agent/${encodeURIComponent(run.id)}`);
  };
  return <form onSubmit={submit} className="space-y-5" aria-label="Start a coding agent run">
    <RepositoryPicker workspaceId={workspaceId} initialSource={initialSource} disabled={!!busy} onChange={setSelection} />
    <fieldset className="space-y-2"><legend className="mb-2 text-[13px] font-medium">What should Gimbal prepare?</legend><div className="flex flex-wrap gap-4 text-[13px]"><label className="flex items-center gap-2"><input type="radio" name="gimbal-intent" value="analysis" checked={intent === "analysis"} onChange={() => setIntent("analysis")} disabled={!!busy} />Analyze only</label><label className="flex items-center gap-2"><input type="radio" name="gimbal-intent" value="plan" checked={intent === "plan"} onChange={() => setIntent("plan")} disabled={!!busy} />Create deployment plan</label></div></fieldset>
    {intent === "plan" && <Field label="Target project and environment" help="The proposal is reviewed against this project's current infrastructure before adoption."><Select value={target} onChange={event => setTarget(event.target.value)} disabled={!!busy} placeholder="Choose a target" options={targets.map(item => ({ value: item.environmentId, label: item.label }))} />{targets.length === 0 && <p className="text-[12px] text-ink-mute">You can analyze first, then <Link href="/onboarding?step=3" className="text-signal hover:underline">create a project and environment</Link> for a deployment proposal.</p>}</Field>}
    <label className="block space-y-1.5 text-[13px] font-medium"><span>Task and constraints</span><textarea required maxLength={2000} rows={3} value={task} onChange={event => setTask(event.target.value)} disabled={!!busy} className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-[13px] font-normal text-ink focus-visible:outline-2 focus-visible:outline-signal" /><span className="block text-[12px] font-normal text-ink-mute">Include hosting preferences, region, budget, and availability requirements when you know them.</span></label>
    <fieldset className="space-y-2 rounded-card border border-line p-4"><legend className="px-1 text-[13px] font-medium">Analysis method</legend><label className="flex items-start gap-2 text-[13px]"><input type="radio" name="gimbal-mode" value="static" checked={mode === "static"} onChange={() => setMode("static")} disabled={!!busy} className="mt-1" /><span><strong>Static analysis</strong><span className="block text-[12px] text-ink-mute">Inspect manifests and source patterns without a model request. No repository code is executed.</span></span></label><label className="flex items-start gap-2 text-[13px]"><input type="radio" name="gimbal-mode" value="model" checked={mode === "model"} onChange={() => setMode("model")} disabled={!!busy} className="mt-1" /><span><strong>Gimbal reasoning with Claude</strong><span className="block text-[12px] text-ink-mute">Send selected, redacted code and your task to the model provider to investigate requirements. Redaction cannot detect every secret.</span></span></label>{mode === "model" && <p className="text-[12px] text-ink-mute">Default ceilings: ${(DEFAULT_LIMITS.spendMicroUsd / 1_000_000).toFixed(2)} estimated model spend, {DEFAULT_LIMITS.toolCalls} tool calls, and {Math.round(DEFAULT_LIMITS.wallTimeMs / 60_000)} minutes of active analysis. If a budget is reached, review a new allowance before continuing.</p>}</fieldset>
    <div className="flex flex-wrap items-center gap-3"><Button type="submit" variant="primary" size="md" busy={busy === "start"} disabled={!!busy || !selection || (intent === "plan" && !chosen)} disabledReason={!selection ? "Inspect a repository and choose its application root first." : "Choose a project and environment for the deployment proposal."}>{intent === "plan" ? "Prepare deployment proposal" : "Analyze repository"}</Button><p className="text-[12px] text-ink-mute">The run uses the inspected commit and rechecks access. Deployment requires a separate reviewed action.</p></div>
    <Status error={error} />
  </form>;
}
