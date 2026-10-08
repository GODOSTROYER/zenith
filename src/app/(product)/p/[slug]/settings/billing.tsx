"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import type { BillingView } from "@/lib/billing/service";

type View = BillingView | { mode: "disabled"; managedTier: string; managedTierSource: "operator_configuration"; message: string };
export function BillingSection({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/platform/v1/billing", { signal: abort.signal, cache: "no-store" }).then(async r => {
      if (!r.ok) throw new Error("unavailable");
      setView(await r.json() as View);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [workspaceId]);
  return <Card><h3>Managed hosting tier</h3>
    {failed ? <p role="alert">Billing state is unavailable. New provisioning work requires a known assignment; existing workloads, reads and export remain available.</p> : !view ? <p>Loading tier assignment…</p> : view.mode === "disabled" ?
      <><p>Billing is disabled. Hosting tier: <strong>{view.managedTier}</strong>, selected by operator configuration.</p><p>{view.message}</p></> :
      <><p>Hosting tier: <strong>{view.managedTier ?? "Unknown"}</strong>. Source: {view.managedTierSource === "billing_assignment" ? "workspace billing assignment" : "assignment required"}.</p>
      <p>{view.notice}</p><p>Standing: {view.account?.status ?? "unassigned"}. {view.whatSuspensionMeans}</p><p>Tier changes govern new reviewed work. Downgrades preserve running workloads and stored data.</p></>}
  </Card>;
}
