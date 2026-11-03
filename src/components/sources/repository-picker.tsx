"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

/** Safe browser projection. Credentials and source file contents never enter this component. */
export interface SourceBindingView {
  bindingId: string;
  owner: string;
  repo: string;
  repositoryId: number;
  installationId: number;
  version: number;
  state: "connected" | "revoked";
  manageUrl?: string;
  affectedProjectCount?: number;
  revokedReason?: "user_unbind" | "installation_deleted" | "installation_suspended" | "repositories_removed";
}

export interface BuildCandidate {
  root: string;
  strategy: string;
  dockerfile?: string;
  language?: string;
  needsDockerfile?: boolean;
  confidence: string;
  note: string;
}

export interface SourceInspection {
  owner: string;
  repo: string;
  repositoryId: number;
  bindingId?: string;
  bindingVersion?: number;
  commitSha: string;
  viaBinding: boolean;
  candidates: BuildCandidate[];
  selected?: BuildCandidate;
  monorepo: boolean;
  truncated: boolean;
  unknowns: string[];
  buildSource?: { repo: string; ref: string; dockerfile: string; contextDir: string; contextDigest: string };
}

export interface RepositorySelection {
  repository: string;
  repositoryId: number;
  bindingId?: string;
  bindingVersion?: number;
  /** The exact inspected commit; never the moving branch from the input. */
  ref: string;
  requestedRef: string;
  root: string;
  contextDir?: string;
  contextDigest?: string;
  inspection: SourceInspection;
}

export interface RepositoryDraft {
  bindingId?: string;
  repository?: string;
  ref?: string;
  root?: string;
  contextDir?: string;
}

export function sourceError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Sign in again, then reload before retrying.";
    if (error.status === 403) return "Access was refused. Check your workspace role, GitHub repository access, and any required security verification, then retry.";
    if (error.status === 404) return "This repository or connection is unavailable in this workspace. Refresh connections or ask an admin to grant access.";
    if (error.status === 409) return "The source or its permission changed. Refresh connections and inspect the repository again.";
    if (error.status === 410) return "This selection session expired. Connect GitHub again to refresh the repository list.";
    if (error.status === 503) return "Repository access is temporarily unavailable. Retry after the connection service is restored.";
  }
  return "The source could not be confirmed. Check the repository, ref, and connection, then retry.";
}

/** GitHub is the only permitted destination for provider authorization links. */
export function githubUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function RepositoryPicker({ workspaceId, initialBindings, initialSource, disabled = false, onChange }: {
  workspaceId: string;
  initialBindings?: SourceBindingView[];
  initialSource?: RepositoryDraft;
  disabled?: boolean;
  onChange: (selection: RepositorySelection | null) => void;
}) {
  const id = useId();
  const [bindings, setBindings] = useState<SourceBindingView[]>(initialBindings ?? []);
  const [bindingId, setBindingId] = useState(initialSource?.bindingId ?? "");
  const [publicRepository, setPublicRepository] = useState(initialSource?.repository ?? "");
  const [requestedRef, setRequestedRef] = useState(initialSource?.ref ?? "HEAD");
  const [root, setRoot] = useState(initialSource?.root ?? "");
  const [contextDir, setContextDir] = useState(initialSource?.contextDir ?? "");
  const [inspection, setInspection] = useState<SourceInspection>();
  const [candidates, setCandidates] = useState<BuildCandidate[]>([]);
  const [branchPage, setBranchPage] = useState<{ workspaceId: string; bindingId: string; branches: { name: string; commitSha: string; protected: boolean }[]; nextCursor?: string | null }>();
  const [branchBusy, setBranchBusy] = useState(false);
  const [busy, setBusy] = useState<"connections" | "inspect">();
  const [error, setError] = useState<string>();
  const serial = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    const controller = new AbortController();
    serial.current++;
    abort.current?.abort();
    const cancel = () => { controller.abort(); abort.current?.abort(); };
    setInspection(undefined);
    setCandidates([]);
    setError(undefined);
    setBusy(undefined);
    change.current(null);
    if (initialBindings !== undefined) {
      setBindings(initialBindings);
      return cancel;
    }
    setBindings([]);
    setBusy("connections");
    void api<{ bindings: SourceBindingView[] }>("/api/platform/v1/github/binding", { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId }, signal: controller.signal })
      .then(out => { if (!controller.signal.aborted) setBindings(out.bindings ?? []); })
      .catch(failure => { if (!controller.signal.aborted) setError(sourceError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(undefined); });
    return cancel;
  }, [workspaceId, initialBindings]);

  const binding = bindings.find(row => row.bindingId === bindingId);
  const isPublic = bindingId === "public";
  const location = isPublic ? publicRepository.trim() : binding ? `${binding.owner}/${binding.repo}` : "";
  const validLocation = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(location);
  const usable = isPublic || binding?.state === "connected";
  const visibleBranches = branchPage?.bindingId === bindingId && branchPage.workspaceId === workspaceId ? branchPage : undefined;

  const browseBranches = async (cursor?: string) => {
    if (!binding || binding.state !== "connected" || disabled || branchBusy) return;
    setBranchBusy(true); setError(undefined);
    try {
      const query = new URLSearchParams({ bindingId: binding.bindingId });
      if (cursor) query.set("cursor", cursor);
      const out = await api<{ branches: { name: string; commitSha: string; protected: boolean }[]; nextCursor?: string | null }>(`/api/platform/v1/github/branches?${query}`, { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId } });
      setBranchPage(previous => ({ workspaceId, bindingId: binding.bindingId, nextCursor: out.nextCursor, branches: [...new Map([...(cursor && previous?.bindingId === binding.bindingId && previous.workspaceId === workspaceId ? previous.branches : []), ...out.branches].map(branch => [branch.name, branch])).values()] }));
    } catch (failure) { setError(sourceError(failure)); }
    finally { setBranchBusy(false); }
  };

  const invalidate = () => {
    serial.current++;
    abort.current?.abort();
    setInspection(undefined);
    setCandidates([]);
    setError(undefined);
    setBusy(undefined);
    onChange(null);
  };

  const inspect = async (selectedRoot = root, pinnedCommit?: string) => {
    if (disabled || !usable || !validLocation || busy) return;
    const request = ++serial.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy("inspect");
    setError(undefined);
    onChange(null);
    const query = new URLSearchParams({ repository: location, accessKind: isPublic ? "public" : "installed", ref: pinnedCommit ?? (requestedRef.trim() || "HEAD"), root: selectedRoot });
    // Empty means repository root, distinct from the selected application's root.
    query.set("contextDir", contextDir.trim());
    try {
      const out = await api<SourceInspection>(`/api/platform/v1/github/inspect?${query}`, { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId }, signal: controller.signal });
      if (request !== serial.current || controller.signal.aborted) return;
      if (!/^[a-f0-9]{40}$/.test(out.commitSha) || `${out.owner}/${out.repo}`.toLowerCase() !== location.toLowerCase() || (binding && (out.repositoryId !== binding.repositoryId || !out.viaBinding || out.bindingId !== binding.bindingId || out.bindingVersion !== binding.version)) || (isPublic && out.viaBinding)) {
        throw new ApiError("Source changed", 409);
      }
      setInspection(out);
      if (!pinnedCommit) setCandidates(out.candidates);
      setRoot(selectedRoot);
      // A whole-repository analysis remains useful even when no deployable root is detected.
      // Multiple detected apps require an explicit root before continuing.
      const unverifiedContext = !["", "."].includes(contextDir.trim()) && !out.buildSource;
      if (!unverifiedContext && (out.selected || out.candidates.length <= 1 || selectedRoot !== "")) {
        onChange({
          repository: `${out.owner}/${out.repo}`, repositoryId: out.repositoryId,
          ...(binding ? { bindingId: binding.bindingId, bindingVersion: binding.version } : {}),
          ref: out.commitSha, requestedRef: requestedRef.trim() || "HEAD", root: selectedRoot,
          ...(out.buildSource ? { contextDir: out.buildSource.contextDir, contextDigest: out.buildSource.contextDigest } : { contextDir: contextDir.trim() }),
          inspection: out,
        });
      }
    } catch (failure) {
      if (request === serial.current && !controller.signal.aborted) { setError(sourceError(failure)); setInspection(undefined); }
    } finally {
      if (request === serial.current && !controller.signal.aborted) setBusy(undefined);
    }
  };

  return <div className="space-y-4" aria-label="Repository input">
    <Field label="Repository" help="Only repositories connected to this workspace can be used as private source.">
      <Select value={bindingId} disabled={disabled || !!busy} placeholder="Select a repository" onChange={event => { invalidate(); setBindingId(event.target.value); setRoot(""); setContextDir(""); }} options={[
        ...bindings.map(row => ({ value: row.bindingId, label: `${row.owner}/${row.repo}${row.state === "revoked" ? " · access revoked" : ""}`, disabled: row.state !== "connected" })),
        { value: "public", label: "Inspect a public repository" },
      ]} />
    </Field>
    {!bindings.length && busy !== "connections" && <p className="text-[13px] text-ink-mute">No private repositories connected. <Link href="/platform/source" className="text-signal hover:underline">Connect GitHub access</Link> to choose which repositories Zenith may read.</p>}
    {isPublic && <Field label="Public repository (owner/name)" help="Choose public access explicitly. A revoked private connection never falls back to public access.">
      <Input value={publicRepository} maxLength={140} autoComplete="off" disabled={disabled || !!busy} onChange={event => { invalidate(); setPublicRepository(event.target.value); }} />
    </Field>}
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Branch, tag or commit" help="Inspection resolves this to the exact commit that Gimbal will analyze."><Input value={requestedRef} maxLength={250} autoComplete="off" disabled={disabled || !!busy} onChange={event => { invalidate(); setRequestedRef(event.target.value); }} /></Field>
      <Field label="Build context directory" help="Leave empty for the repository root, including shared packages and lockfiles. The application root is selected after inspection."><Input value={contextDir} maxLength={200} placeholder="Repository root" autoComplete="off" disabled={disabled || !!busy} onChange={event => { invalidate(); setContextDir(event.target.value); }} /></Field>
    </div>
    {binding?.state === "connected" && <div className="space-y-3">
      <Button size="sm" variant="ghost" busy={branchBusy} disabled={disabled || !!busy} onClick={() => void browseBranches()}>Browse branches</Button>
      {visibleBranches && <div className="space-y-2"><Field label="Available branches" help="Choose a branch or enter a tag or commit above. Inspection still resolves the exact source commit."><Select value={visibleBranches.branches.some(branch => branch.name === requestedRef) ? requestedRef : ""} placeholder="Choose a branch" disabled={disabled || !!busy || branchBusy} options={visibleBranches.branches.map(branch => ({ value: branch.name, label: `${branch.name}${branch.protected ? " · protected" : ""}` }))} onChange={event => { invalidate(); setRequestedRef(event.target.value); }} /></Field>{visibleBranches.nextCursor && <Button size="sm" variant="ghost" busy={branchBusy} disabled={disabled || !!busy} onClick={() => void browseBranches(visibleBranches.nextCursor ?? undefined)}>Load more branches</Button>}</div>}
    </div>}
    <Button variant="quiet" onClick={() => void inspect()} busy={busy === "inspect"} disabled={disabled || busy === "connections" || !usable || !validLocation} disabledReason="Select an authorized repository and a ref to inspect.">Inspect repository</Button>
    <div aria-live="polite" aria-atomic="true">
      {busy === "connections" && <p role="status" className="text-[13px] text-ink-mute">Loading authorized repositories…</p>}
      {busy === "inspect" && <p role="status" className="text-[13px] text-ink-mute">Resolving the commit and detecting applications. Repository code is not executed.</p>}
      {error && <Callout tone="err">{error}</Callout>}
    </div>
    {inspection && <section className="space-y-3 rounded-card border border-line bg-bg2 p-4" aria-labelledby={`${id}-result`}>
      <h3 id={`${id}-result`} className="text-[14px] font-semibold">Source inspection</h3>
      <p className="break-all text-[13px]">{inspection.owner}/{inspection.repo} at <code>{inspection.commitSha}</code>{inspection.monorepo ? " · Multiple applications detected" : ""}</p>
      {inspection.truncated && <Callout tone="warn" title="Partial analysis">The source exceeded an analysis limit. Review skipped or unresolved requirements before using the proposed plan.</Callout>}
      {!["", "."].includes(contextDir.trim()) && !inspection.buildSource && <Callout tone="warn" title="Build context needs verification">This custom build context has no verified Dockerfile. Clear the build context to analyze the repository, or select an application with a Dockerfile and inspect again.</Callout>}
      {candidates.length > 0 ? <fieldset className="space-y-2">
        <legend className="mb-2 text-[13px] font-medium">Application root</legend>
        {candidates.map(candidate => <label key={candidate.root || "."} className="flex cursor-pointer items-start gap-3 rounded-ctl border border-line p-3">
          <input type="radio" name={`${id}-root`} value={candidate.root} checked={inspection.selected?.root === candidate.root} disabled={disabled || !!busy} onChange={() => void inspect(candidate.root, inspection.commitSha)} className="mt-1 accent-signal" />
          <span className="min-w-0 space-y-1 text-[13px]"><strong className="block break-all">{candidate.root || "Repository root"}</strong><span className="block text-ink-mute">{candidate.language ? `${candidate.language} · ` : ""}{candidate.strategy} · {candidate.confidence} confidence</span><span className="block text-ink-mute">{candidate.note}</span>{candidate.needsDockerfile && <span className="block text-warn">A Dockerfile is required before deployment.</span>}</span>
        </label>)}
      </fieldset> : <p className="text-[13px] text-ink-mute">No supported build root detected. Analysis can continue and explain missing or unsupported requirements.</p>}
      {inspection.buildSource && <p className="break-all text-[12px] text-ink-mute">Verified Dockerfile: {inspection.buildSource.dockerfile}. Build context: {inspection.buildSource.contextDir || "repository root"}.</p>}
      {inspection.unknowns.length > 0 && <details className="text-[13px] text-ink-mute"><summary className="cursor-pointer">Questions and support limits ({inspection.unknowns.length})</summary><ul className="mt-2 list-disc space-y-1 pl-5">{inspection.unknowns.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
      <p className="text-[12px] text-ink-mute">Changing the repository, ref, or context clears this inspection. Starting a run rechecks source access.</p>
    </section>}
  </div>;
}
