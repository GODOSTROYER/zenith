"use client";
/**
 * Bind, unbind and statically inspect the workspace's GitHub source. The browser only ever
 * receives repository names, versions and detected build plans: never a token or file contents.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RoleName } from "@/components/platform/labels";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { api } from "@/lib/client/api";
import { browserMutation, mutationError } from "../_lib/browser-api";

export interface SourceBindingView {
  owner: string; repo: string; version: number; state: "connected" | "revoked";
  revokedReason?: "user_unbind" | "installation_deleted" | "installation_suspended" | "repositories_removed";
}
interface Candidate { root: string; strategy: string; dockerfile?: string; language?: string; confidence: string; note: string }
interface Inspection { owner: string; repo: string; commitSha: string; viaBinding: boolean; candidates: Candidate[]; selected?: Candidate; monorepo: boolean; unknowns: string[] }

const WHY: Record<NonNullable<SourceBindingView["revokedReason"]>, string> = {
  user_unbind: "An admin unbound this repository.",
  installation_deleted: "The GitHub App was uninstalled from the account.",
  installation_suspended: "The GitHub App installation was suspended.",
  repositories_removed: "GitHub removed this repository from the installation.",
};

export function SourcePanel({ workspaceId, viewerRole, initial }: { workspaceId: string; viewerRole: RoleName; initial: SourceBindingView | null }) {
  const router = useRouter();
  const blocked = viewerRole !== "admin" ? "Only a workspace admin can change the GitHub source." : undefined;
  const [repository, setRepository] = useState("");
  const [ref, setRef] = useState("HEAD");
  const [root, setRoot] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"bind" | "unbind" | "inspect">();
  const [result, setResult] = useState<Inspection>();
  const inFlight = useRef(false);
  const run = async (kind: "bind" | "unbind" | "inspect", action: () => Promise<void>) => {
    if (blocked || inFlight.current) return;
    inFlight.current = true; setBusy(kind); setError(undefined);
    try { await action(); } catch (failure) { setError(mutationError(failure)); }
    finally { inFlight.current = false; setBusy(undefined); }
  };
  const bind = () => run("bind", async () => {
    const out = await browserMutation<{ installUrl: string }>(workspaceId, "/api/platform/v1/github/binding", { repository: repository.trim() });
    window.location.assign(out.installUrl);
  });
  const unbind = () => run("unbind", async () => {
    if (!initial) return;
    await browserMutation(workspaceId, "/api/platform/v1/github/binding/unbind", { version: initial.version });
    router.refresh();
  });
  const inspect = () => run("inspect", async () => {
    const query = new URLSearchParams({ ref: ref.trim() || "HEAD" });
    if (root.trim()) query.set("root", root.trim());
    if (!initial) query.set("repository", repository.trim());
    setResult(await api<Inspection>(`/api/platform/v1/github/inspect?${query}`, { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId } }));
  });
  const connected = initial?.state === "connected";
  const ownerName = repository.trim().split("/").length === 2;
  return <div className="space-y-5">
    <Card title="Connection" subtitle={initial ? `${initial.owner}/${initial.repo}` : "No repository connected"}>
      <div className="space-y-4">
        {connected && <p className="text-[13px] text-ink-mute">Builds fetch this repository with a short-lived GitHub App token limited to read access on this one repository. Unbinding stops new source access; running deployments are not touched.</p>}
        {initial?.state === "revoked" && <Callout tone="warn" title="Source access is blocked">{initial.revokedReason ? WHY[initial.revokedReason] : "Source access was revoked."} New builds from this repository are refused until an admin binds a repository again.</Callout>}
        {!initial && <p className="text-[13px] text-ink-mute">Connect a repository to build from private source. Public repositories can be inspected without connecting.</p>}
        {blocked && <p className="text-[13px] text-ink-mute">{blocked}</p>}
        {connected && <Button variant="danger" onClick={() => void unbind()} busy={busy === "unbind"} disabled={Boolean(blocked)} disabledReason={blocked}>Unbind repository</Button>}
      </div>
    </Card>
    <Card title={connected ? "Replace repository" : "Bind a repository"} subtitle="Installs the Zenith GitHub App, then confirms your access on GitHub">
      <div className="space-y-4">
        <Field label="Repository (owner/name)" help="Binding replaces this workspace's current source binding.">
          <Input value={repository} onChange={(event) => setRepository(event.target.value)} maxLength={140} autoComplete="off" disabled={Boolean(blocked) || busy !== undefined} />
        </Field>
        <Button onClick={() => void bind()} busy={busy === "bind"} disabled={Boolean(blocked) || !ownerName} disabledReason={blocked ?? "Enter the repository as owner/name."}>Install and bind repository</Button>
      </div>
    </Card>
    <Card title="Inspect build setup" subtitle="Static detection only. Nothing from the repository is run.">
      <div className="space-y-4">
        <Field label="Ref" help="Branch, tag or commit."><Input value={ref} onChange={(event) => setRef(event.target.value)} maxLength={250} disabled={busy !== undefined} /></Field>
        <Field label="Subdirectory" help="For monorepos. Leave empty to list every detected build root."><Input value={root} onChange={(event) => setRoot(event.target.value)} maxLength={200} disabled={busy !== undefined} /></Field>
        <Button variant="quiet" onClick={() => void inspect()} busy={busy === "inspect"} disabled={Boolean(blocked) || initial?.state === "revoked" || (!initial && !ownerName)} disabledReason={blocked ?? (initial?.state === "revoked" ? "Source access is revoked." : "Enter a public repository as owner/name above, or bind one.")}>Inspect source</Button>
        {result && <div className="space-y-3 text-[13px]">
          <p>Commit <code>{result.commitSha.slice(0, 12)}</code> of {result.owner}/{result.repo}{result.monorepo ? " (monorepo)" : ""}.</p>
          {result.candidates.length === 0 ? <p className="text-ink-mute">No build roots were detected.</p> : <ul className="divide-y divide-line">{result.candidates.map((c) => <li key={c.root || "."} className="py-2">
            <strong>{c.root === "" ? "Repository root" : c.root}</strong>: {c.strategy === "dockerfile" ? `Dockerfile at ${c.dockerfile ?? "Dockerfile"}` : c.strategy === "buildpack" ? "Buildpack (inferred, needs a Dockerfile to build)" : c.strategy}{c.language ? ` · ${c.language}` : ""}
          </li>)}</ul>}
          {result.unknowns.map((line) => <p key={line} className="text-ink-mute">{line}</p>)}
        </div>}
      </div>
    </Card>
    {error && <Callout tone="err">{error}</Callout>}
  </div>;
}
