"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { WorkspaceMfaControl } from "@/lib/auth/mfa-policy";

export function MfaControls({ workspaceId }: { workspaceId: string }) {
  const [policy, setPolicy] = useState<WorkspaceMfaControl>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void api<WorkspaceMfaControl & { workspaceId: string }>("/api/workspace/mfa").then((result) => {
      if (!active) return;
      if (result.workspaceId !== workspaceId) { setFailed(true); return; }
      setPolicy(result);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [workspaceId]);
  return <section aria-labelledby="workspace-mfa-title" className="space-y-3 rounded border border-line p-4">
    <h2 id="workspace-mfa-title" className="text-lg font-medium">Workspace authenticator controls</h2>
    <p>Approval, destructive actions, connections, trust and access changes require a verified authenticator in every workspace.</p>
    {failed ? <p role="alert">The workspace controls could not be loaded. Reload before changing privileged settings.</p> : policy ? <>
      <p>{policy.requireForAllMutations ? "This workspace requires verification for all changes by people." : "This workspace requires verification for privileged changes."}</p>
      <p>{policy.maxAgeSeconds === null ? "Verification lasts for the authenticated session." : `Verification expires after ${policy.maxAgeSeconds} seconds. Verify again before submitting later changes.`}</p>
      <p>These requirements are managed by your deployment operator. Workspace role and approval controls still apply.</p>
    </> : <p role="status">Loading workspace controls…</p>}
    <Link href="/account/mfa/enrol" className="text-signal underline">Set up an authenticator</Link>{" · "}
    <Link href="/account/mfa/challenge?next=%2Fplatform%2Fsettings" className="text-signal underline">Verify before changing controls</Link>
  </section>;
}
