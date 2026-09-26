"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client/api";
import { useShell } from "@/components/shell/shell-context";
import { WorkspaceSharing } from "@/components/workspace/workspace-sharing";
import { PageHeading } from "@/components/screens/page-heading";
import { ErrorNote } from "@/components/screens/action-confirm";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function WorkspaceAccessPage({ requestedWorkspaceId }: { requestedWorkspaceId?: string }) {
  const { boot, error: bootError, refresh } = useShell();
  const [switchError, setSwitchError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const attempted = useRef("");
  const currentId = boot?.workspace.id;
  const target = boot?.workspaces.find((workspace) => workspace.id === requestedWorkspaceId);
  const needsSwitch = !!requestedWorkspaceId && !!boot && requestedWorkspaceId !== currentId;
  const unavailable = needsSwitch && !target;

  useEffect(() => {
    if (!needsSwitch || unavailable || !requestedWorkspaceId) {
      attempted.current = "";
      setSwitchError(undefined);
      return;
    }
    const key = requestedWorkspaceId + ":" + retry;
    if (attempted.current === key) return;
    attempted.current = key;
    setSwitchError(undefined);
    void api("/api/workspace/select", { method: "POST", body: JSON.stringify({ workspaceId: requestedWorkspaceId }) })
      .then(() => refresh())
      .catch(setSwitchError);
  }, [requestedWorkspaceId, needsSwitch, unavailable, refresh, retry]);

  return <div className="product-page h-full overflow-y-auto"><div className="mx-auto max-w-5xl space-y-6">
    <PageHeading title={boot && !needsSwitch ? "Share " + boot.workspace.name : "Workspace sharing"} description="Invite people, review access, and manage ownership across your workspace." />
    {boot && boot.workspaces.length > 1 && <Card title="Your workspaces" padded={false}>
      <ul>{boot.workspaces.map((workspace) => <li key={workspace.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 last:border-0">
        <div className="min-w-0"><p className="break-words text-sm font-medium text-ink">{workspace.name}</p><p className="mt-1 text-xs text-ink-mute">{workspace.role}{workspace.id === currentId ? " · Current workspace" : ""}</p></div>
        <Link href={"/workspace?workspace=" + encodeURIComponent(workspace.id)} aria-label={"Share " + workspace.name} className="inline-flex min-h-9 items-center rounded-ctl border border-line px-3 text-sm font-medium text-ink hover:bg-bg2">Share</Link>
      </li>)}</ul>
    </Card>}
    {unavailable ? <Card title="This workspace is not available to your account"><p className="text-sm text-ink-mute">A workspace link does not grant access. Ask the owner or an admin to invite the email you use to sign in.</p><Link href="/invite" className="mt-3 inline-block text-sm text-signal underline">View your invitations</Link></Card>
      : switchError ? <div className="space-y-3"><ErrorNote error={switchError} /><Button onClick={() => setRetry((value) => value + 1)}>Retry selecting workspace</Button></div>
      : needsSwitch ? <div role="status" aria-label="Selecting workspace"><Skeleton height={240} /></div>
      : bootError ? <div className="space-y-3"><ErrorNote error={bootError} /><Link href="/invite" className="text-sm text-signal underline">View your invitations</Link><Button onClick={refresh}>Retry loading workspace</Button></div>
      : <WorkspaceSharing boot={boot} refresh={refresh} />}
    <p className="text-sm text-ink-mute">Invited to another team? <Link href="/invite" className="text-signal underline">View your invitations</Link>.</p>
  </div></div>;
}
