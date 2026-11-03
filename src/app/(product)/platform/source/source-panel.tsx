"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RoleName } from "@/components/platform/labels";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { api } from "@/lib/client/api";
import { RepositoryPicker, githubUrl, sourceError, type RepositorySelection, type SourceBindingView } from "@/components/sources/repository-picker";
import { browserMutation } from "../_lib/browser-api";

export type { SourceBindingView } from "@/components/sources/repository-picker";

interface DiscoveredRepository { repositoryId: number; owner: string; repo: string; private: boolean; defaultBranch: string }
interface DiscoveryPage { repositories: DiscoveredRepository[]; nextCursor?: string | null; expiresAt: string; truncated?: boolean }
const WHY: Record<NonNullable<SourceBindingView["revokedReason"]>, string> = {
  user_unbind: "An admin stopped workspace access.",
  installation_deleted: "The GitHub App was uninstalled from this account.",
  installation_suspended: "The GitHub App installation is suspended.",
  repositories_removed: "This repository was removed from the GitHub App installation.",
};

function GithubDiscovery({ workspaceId, session, disabled, onAuthorize }: { workspaceId: string; session: string; disabled: boolean; onAuthorize: (repositoryId: number) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<DiscoveryPage>();
  const [activeQuery, setActiveQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  const load = useCallback(async (search: string, cursor?: string) => {
    const current = ++request.current;
    const signal = lifetime.current?.signal;
    setBusy(true); setError(undefined);
    const params = new URLSearchParams({ session, q: search });
    if (cursor) params.set("cursor", cursor);
    try {
      const next = await api<DiscoveryPage>(`/api/platform/v1/github/discovery?${params}`, { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId }, signal });
      if (current === request.current && !signal?.aborted) { setPage(next); setActiveQuery(search); }
    } catch (failure) { if (current === request.current && !signal?.aborted) setError(sourceError(failure)); }
    finally { if (current === request.current && !signal?.aborted) setBusy(false); }
  }, [session, workspaceId]);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; void load(""); return () => controller.abort(); }, [load]);
  return <section aria-label="Choose an authorized repository" className="space-y-4">
    <p className="text-[13px] text-ink-mute">Choose a repository you administer from the access granted on GitHub. Connecting it makes it available to authorized source workflows in this workspace. GitHub will verify your permission again.</p>
    <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); void load(query.trim()); }}>
      <div className="min-w-0 flex-1"><Field label="Search authorized repositories"><Input value={query} onChange={event => setQuery(event.target.value)} maxLength={140} disabled={busy || disabled} autoComplete="off" /></Field></div>
      <Button type="submit" busy={busy} disabled={disabled}>Search</Button>
    </form>
    {page && <>
      {page.truncated && <Callout tone="warn">This discovery reached its repository limit. A repository may be missing from this list. Use the connection-by-name option and verify the exact repository on GitHub.</Callout>}
      <p className="text-[12px] text-ink-mute">Selection expires {new Date(page.expiresAt).toLocaleString()}. Missing a repository? Check the selected repositories and organization approval in GitHub settings.</p>
      {page.repositories.length ? <ul className="divide-y divide-line rounded-ctl border border-line">{page.repositories.map(repo => <li key={repo.repositoryId} className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="min-w-0 text-[13px]"><strong className="break-all">{repo.owner}/{repo.repo}</strong><span className="block text-ink-mute">{repo.private ? "Private" : "Public"} · default branch {repo.defaultBranch}</span></div>
        <Button size="sm" disabled={disabled || busy} onClick={() => void onAuthorize(repo.repositoryId)} aria-label={`Connect ${repo.owner}/${repo.repo}`}>Connect repository</Button>
      </li>)}</ul> : <p className="text-[13px] text-ink-mute">No matching authorized repositories. Change your search or update the GitHub App’s selected repositories.</p>}
      {page.nextCursor && <Button variant="quiet" onClick={() => void load(activeQuery, page.nextCursor ?? undefined)} disabled={disabled} busy={busy}>Next repositories</Button>}
    </>}
    <div aria-live="polite">{busy && <p role="status" className="text-[13px] text-ink-mute">Reading authorized repositories…</p>}{error && <Callout tone="err">{error}</Callout>}</div>
  </section>;
}

export function SourcePanel({ workspaceId, viewerRole, discoverySession }: { workspaceId: string; viewerRole: RoleName; discoverySession?: string }) {
  const router = useRouter();
  const blocked = viewerRole !== "admin";
  const [bindings, setBindings] = useState<SourceBindingView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [appConfigured, setAppConfigured] = useState(false);
  const [repository, setRepository] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [confirmRevoke, setConfirmRevoke] = useState<string>();
  const [selection, setSelection] = useState<RepositorySelection | null>(null);
  const inFlight = useRef(false);
  const lifetime = useRef(0);
  const readRequest = useRef(0);
  const scope = `${workspaceId}:${viewerRole}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const load = useCallback(async (signal?: AbortSignal, cursor?: string) => {
    if (blocked || currentScope.current !== scope) return;
    const epoch = lifetime.current, request = ++readRequest.current;
    const current = () => !signal?.aborted && epoch === lifetime.current && request === readRequest.current && currentScope.current === scope;
    try {
      const url = "/api/platform/v1/github/binding" + (cursor ? `?${new URLSearchParams({ cursor })}` : "");
      const out = await api<{ appConfigured: boolean; bindings: SourceBindingView[]; nextCursor?: string | null }>(url, { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId }, signal });
      if (!current()) return;
      setBindings(previous => [...new Map([...(cursor ? previous : []), ...(out.bindings ?? [])].map(binding => [binding.bindingId, binding])).values()]);
      setNextCursor(out.nextCursor ?? null); setAppConfigured(out.appConfigured); setSelection(null);
    } catch (failure) { if (current()) setError(sourceError(failure)); }
  }, [workspaceId, blocked, scope]);
  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++lifetime.current;
    inFlight.current = false;
    setBindings([]); setNextCursor(null); setAppConfigured(false); setRepository(""); setSelection(null); setConfirmRevoke(undefined);
    setBusy(undefined); setError(undefined); setNotice(undefined);
    void load(controller.signal);
    return () => { controller.abort(); lifetime.current = epoch + 1; };
  }, [load]);
  const run = async (key: string, action: (current: () => boolean) => Promise<void>) => {
    if (blocked || inFlight.current) return;
    const epoch = lifetime.current;
    const current = () => epoch === lifetime.current && currentScope.current === scope;
    inFlight.current = true; setBusy(key); setError(undefined); setNotice(undefined);
    try { await action(current); } catch (failure) { if (current()) setError(sourceError(failure)); }
    finally { if (current()) { inFlight.current = false; setBusy(undefined); } }
  };
  const redirect = (raw: string | undefined) => {
    const destination = githubUrl(raw);
    if (!destination) throw new Error("Invalid provider destination");
    window.location.assign(destination);
  };
  const begin = () => run("connect", async current => {
    const out = await browserMutation<{ installUrl: string }>(workspaceId, "/api/platform/v1/github/discovery", { returnTo: "/platform/source" });
    if (current()) redirect(out.installUrl);
  });
  const bind = () => run("bind", async current => {
    const out = await browserMutation<{ installUrl: string }>(workspaceId, "/api/platform/v1/github/binding", { repository: repository.trim(), returnTo: "/platform/source" });
    if (current()) redirect(out.installUrl);
  });
  const authorize = (repositoryId: number) => run("authorize", async current => {
    const out = await browserMutation<{ authorizeUrl: string }>(workspaceId, "/api/platform/v1/github/discovery", { session: discoverySession, repositoryId });
    if (current()) redirect(out.authorizeUrl);
  });
  const verify = (binding: SourceBindingView) => run(`verify-${binding.bindingId}`, async current => {
    const out = await browserMutation<{ state: "connected"; verifiedAt: string }>(workspaceId, "/api/platform/v1/github/binding/sync", { bindingId: binding.bindingId, version: binding.version });
    if (!current()) return;
    await load();
    if (current()) setNotice(`GitHub access to ${binding.owner}/${binding.repo} was verified at ${new Date(out.verifiedAt).toLocaleString()}.`);
  });
  const revoke = (binding: SourceBindingView) => run(`revoke-${binding.bindingId}`, async current => {
    await browserMutation(workspaceId, "/api/platform/v1/github/binding/unbind", { bindingId: binding.bindingId, version: binding.version });
    if (!current()) return;
    setConfirmRevoke(undefined);
    await load();
    if (!current()) return;
    setNotice(`Workspace source access to ${binding.owner}/${binding.repo} has stopped. Running applications continue.`);
    router.refresh();
  });
  const continueHref = selection ? `/platform/coding-agent?${new URLSearchParams({ ...(selection.bindingId ? { bindingId: selection.bindingId } : { repository: selection.repository }), ref: selection.ref, root: selection.root, contextDir: selection.contextDir ?? "" })}` : undefined;

  if (blocked) return <Callout tone="info" title="Repository access requires an admin">Only workspace admins can connect, inspect, or stop repository access. Ask an admin to attach the source your project needs.</Callout>;
  return <div className="space-y-5">
    <Card title="Connect repository access" subtitle="GitHub access is separate from your Google or GitHub sign-in.">
      <div className="space-y-4">
        <p className="text-[13px] text-ink-mute">On GitHub, choose <strong>Only select repositories</strong> and grant access to the repositories you want Zenith to read. Each connection is managed independently; adding one keeps your other connections. A GitHub repository administrator must authorize shared code access for this workspace.</p>
        <div className="flex flex-wrap gap-2"><Button onClick={() => void begin()} busy={busy === "connect"} disabled={!appConfigured || !!busy} disabledReason="The workspace's GitHub App must be configured before connecting.">Connect GitHub repositories</Button><Button variant="ghost" onClick={() => void run("refresh", () => load())} busy={busy === "refresh"} disabled={!!busy}>Refresh connections</Button></div>
        {!appConfigured && <p className="text-[12px] text-ink-mute">A Zenith operator needs to configure the GitHub App before private repositories can be connected.</p>}
        <details className="text-[13px]"><summary className="cursor-pointer text-ink-mute">Connect a repository by name</summary><div className="mt-3 space-y-3"><Field label="Repository (owner/name)" help="GitHub verifies your access before adding this repository to the workspace."><Input value={repository} onChange={event => setRepository(event.target.value)} maxLength={140} autoComplete="off" disabled={!!busy} /></Field><Button onClick={() => void bind()} busy={busy === "bind"} disabled={!appConfigured || !!busy || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repository.trim())}>Install and connect repository</Button></div></details>
      </div>
    </Card>
    {discoverySession && <Card title="Choose a repository"><GithubDiscovery key={`${workspaceId}:${discoverySession}`} workspaceId={workspaceId} session={discoverySession} disabled={!!busy} onAuthorize={authorize} /></Card>}
    <Card title="Workspace repositories" subtitle="Stopping workspace access leaves the GitHub repository and running applications intact.">
      {!bindings.length ? <p className="text-[13px] text-ink-mute">No repositories connected yet.</p> : <ul className="divide-y divide-line">{bindings.map(binding => <li key={binding.bindingId} className="space-y-3 py-4 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-all text-[14px] font-semibold">{binding.owner}/{binding.repo}</h3><p className="text-[12px] text-ink-mute">{binding.state === "connected" ? "Connected · read access" : "Access revoked"} · permission version {binding.version}{binding.affectedProjectCount !== undefined ? ` · ${binding.affectedProjectCount} attached project${binding.affectedProjectCount === 1 ? "" : "s"}` : ""}</p></div>
          <div className="flex flex-wrap gap-2">{githubUrl(binding.manageUrl) && <a href={githubUrl(binding.manageUrl)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center rounded-ctl border border-line px-3 text-[13px] text-signal hover:underline">Manage access on GitHub</a>}{binding.state === "connected" && <Button size="sm" busy={busy === `verify-${binding.bindingId}`} disabled={!!busy} onClick={() => void verify(binding)} aria-label={`Verify access to ${binding.owner}/${binding.repo}`}>Verify access</Button>}{binding.state === "connected" && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirmRevoke(binding.bindingId)} aria-label={`Stop workspace access to ${binding.owner}/${binding.repo}`}>Stop workspace access</Button>}</div>
        </div>
        {binding.state === "revoked" && <Callout tone="warn">{binding.revokedReason ? WHY[binding.revokedReason] : "Source access was revoked."} Reconnect explicitly to authorize new analysis or builds. Previous approvals do not regain authority.</Callout>}
        {binding.nameCurrent === false && <p className="text-[12px] text-ink-mute">Historical grant for repository ID {binding.repositoryId}. This name now belongs to a different connected repository; the previous grant remains revoked.</p>}
        {confirmRevoke === binding.bindingId && <div role="group" aria-label={`Confirm access removal for ${binding.owner}/${binding.repo}`} className="space-y-3 rounded-ctl border border-line p-3"><p className="text-[13px]">Stop this workspace from reading {binding.owner}/{binding.repo}? Projects using this connection will need reconnection before new source analysis or builds. Other repository connections and running applications continue.</p><div className="flex gap-2"><Button variant="danger" autoFocus busy={busy === `revoke-${binding.bindingId}`} disabled={!!busy} onClick={() => void revoke(binding)}>Confirm stop access</Button><Button variant="ghost" disabled={!!busy} onClick={() => setConfirmRevoke(undefined)}>Keep access</Button></div></div>}
      </li>)}</ul>}
      {nextCursor && <Button variant="ghost" busy={busy === "more-connections"} disabled={!!busy} onClick={() => void run("more-connections", () => load(undefined, nextCursor))}>Load more connections</Button>}
    </Card>
    <Card title="Inspect and analyze a repository" subtitle="Select an exact source before Gimbal prepares a deployment proposal.">
      <RepositoryPicker workspaceId={workspaceId} initialBindings={bindings} initialNextCursor={nextCursor} disabled={!!busy} onChange={setSelection} />
      {continueHref && <Link className="mt-4 inline-flex min-h-9 items-center rounded-ctl bg-signal px-3 text-[13px] font-medium text-on-signal" href={continueHref}>Continue with Gimbal</Link>}
    </Card>
    <div aria-live="polite">{error && <Callout tone="err">{error}</Callout>}{notice && <p role="status" className="text-[13px] text-ink-mute">{notice}</p>}</div>
  </div>;
}
