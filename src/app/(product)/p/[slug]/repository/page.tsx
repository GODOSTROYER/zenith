"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useProjectData } from "@/components/shell/project-context";
import { useShell } from "@/components/shell/shell-context";
import { PageHeading } from "@/components/screens/page-heading";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { api } from "@/lib/client/api";
import { RepositoryPicker, sourceError, type RepositorySelection } from "@/components/sources/repository-picker";

interface ProjectSource {
  projectId: string;
  bindingId: string;
  repositoryId: number;
  repository: string;
  ref: string;
  root: string;
  contextDir: string;
  version: number;
}

/** Project attachment is distinct from the workspace's GitHub authorization grant. */
export default function ProjectRepositoryPage() {
  const { project, selectedEnvId } = useProjectData();
  const { boot } = useShell();
  const workspaceId = project.workspaceId;
  const admin = boot?.role === "admin" || (boot?.auth.configured === false && boot.role === null);
  const [source, setSource] = useState<ProjectSource | null>(null);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [selection, setSelection] = useState<RepositorySelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const inFlight = useRef(false);
  const lifetime = useRef(0);
  const scope = `${workspaceId}:${project.id}:${admin}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++lifetime.current;
    const current = () => !controller.signal.aborted && epoch === lifetime.current && currentScope.current === scope;
    inFlight.current = false;
    setBusy(false);
    setSource(null); setSourceVersion(0); setConfirmDetach(false); setSelection(null); setLoading(true); setError(undefined); setNotice(undefined);
    const cancel = () => { controller.abort(); lifetime.current++; };
    if (!admin) { setLoading(false); return cancel; }
    const query = new URLSearchParams({ projectId: project.id });
    void api<{ source: ProjectSource | null; version: number }>(`/api/platform/v1/github/project-source?${query}`, { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId }, signal: controller.signal })
      .then(out => { if (current()) { setSource(out.source); setSourceVersion(out.version); } })
      .catch(failure => { if (current()) setError(sourceError(failure)); })
      .finally(() => { if (current()) setLoading(false); });
    return cancel;
  }, [project.id, workspaceId, admin, scope]);

  const attach = async () => {
    if (!selection?.bindingId || !admin || loading || inFlight.current) return;
    const epoch = lifetime.current;
    const current = () => epoch === lifetime.current && currentScope.current === scope;
    inFlight.current = true; setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const out = await api<{ source: ProjectSource; version: number }>("/api/platform/v1/github/project-source", {
        method: "POST", credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId },
        body: JSON.stringify({ projectId: project.id, bindingId: selection.bindingId, expectedVersion: sourceVersion, ref: selection.requestedRef, root: selection.root, contextDir: selection.contextDir ?? "" }),
      });
      if (!current()) return;
      setSource(out.source); setSourceVersion(out.version);
      setNotice("Repository attached to this project. The infrastructure and running deployments have not changed.");
    } catch (failure) { if (current()) setError(sourceError(failure)); }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };
  const detach = async () => {
    if (!source || !admin || inFlight.current) return;
    const epoch = lifetime.current;
    const current = () => epoch === lifetime.current && currentScope.current === scope;
    inFlight.current = true; setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const out = await api<{ source: null; version: number }>("/api/platform/v1/github/project-source", {
        method: "POST", credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId },
        body: JSON.stringify({ projectId: project.id, expectedVersion: sourceVersion, detach: true }),
      });
      if (!current()) return;
      setSource(null); setSourceVersion(out.version); setSelection(null); setConfirmDetach(false);
      setNotice("Repository removed from this project. Workspace access, other projects, and running applications remain separately managed.");
    } catch (failure) { if (current()) setError(sourceError(failure)); }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };
  const draft = selection ? { bindingId: selection.bindingId, repository: selection.bindingId ? undefined : selection.repository, ref: selection.ref, root: selection.root, contextDir: selection.contextDir ?? "" } : source;
  const query = new URLSearchParams({ ...(selectedEnvId ? { environmentId: selectedEnvId } : {}) });
  if (draft?.bindingId) query.set("bindingId", draft.bindingId);
  else if (draft?.repository) query.set("repository", draft.repository);
  if (draft) { query.set("ref", draft.ref); query.set("root", draft.root); query.set("contextDir", draft.contextDir); }

  return <div className="product-page h-full w-full space-y-5 overflow-y-auto">
    <PageHeading title="Repository" description="Attach application code, inspect its exact commit, and ask Gimbal to prepare a deployment proposal." actions={<Link href="/platform/source" className="text-[13px] text-signal hover:underline">Manage workspace access</Link>} />
    {!admin ? <Callout tone="info">Ask a workspace admin to connect or analyze repository source for this project.</Callout> : <>
      <Card title="Project source" subtitle={source?.repository ?? "No repository attached"}>
        {loading ? <p role="status" className="text-[13px] text-ink-mute">Reading this project’s source…</p> : source ? <div className="space-y-2 text-[13px]"><p>Tracked ref: <code>{source.ref}</code>. Application root: <code>{source.root || "."}</code>. Build context: <code>{source.contextDir || "."}</code>.</p><p className="text-ink-mute">A tracked ref can move. Each analysis resolves and reviews one exact commit before a deployment plan is used.</p><Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDetach(true)}>Remove from project</Button>{confirmDetach && <div role="group" aria-label="Confirm repository detachment" className="space-y-2 rounded-ctl border border-line p-3"><p>Remove this project’s repository attachment? Workspace GitHub access and running applications remain unchanged.</p><div className="flex gap-2"><Button variant="danger" busy={busy} onClick={() => void detach()}>Confirm remove from project</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirmDetach(false)}>Keep attachment</Button></div></div>}</div> : <p className="text-[13px] text-ink-mute">Select an authorized repository below. Connecting code does not approve an infrastructure change.</p>}
      </Card>
      {!loading && <Card title={source ? "Inspect or change source" : "Attach a repository"}>
        <RepositoryPicker key={`${workspaceId}:${project.id}:${sourceVersion}`} workspaceId={workspaceId} initialSource={source ?? undefined} disabled={busy} onChange={setSelection} />
        <div className="mt-4 flex flex-wrap items-center gap-3"><Button onClick={() => void attach()} busy={busy} disabled={!selection?.bindingId || !!error} disabledReason="Inspect a connected repository first. If the saved source changed, reload before replacing it.">{source ? "Update project source" : "Attach to project"}</Button>{draft && <Link href={`/platform/coding-agent?${query}`} className="inline-flex min-h-9 items-center rounded-ctl border border-line px-3 text-[13px] text-signal hover:underline">Analyze with Gimbal</Link>}</div>
        {selection && !selection.bindingId && <p className="mt-2 text-[12px] text-ink-mute">Public source can be analyzed now. Connect the repository to the workspace to save a managed project attachment.</p>}
      </Card>}
    </>}
    <div aria-live="polite">{error && <Callout tone="err">{error} <button className="underline" onClick={() => window.location.reload()}>Reload project source</button></Callout>}{notice && <p role="status" className="text-[13px] text-ink-mute">{notice}</p>}</div>
  </div>;
}
