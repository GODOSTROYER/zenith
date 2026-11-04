"use client";
/** Selection is local interaction; supplied rows retain separate desired, observed and runtime facts. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ResourceStateTable } from "@/components/platform/resource-state-table";
import { ResourceStateDetail } from "@/components/platform/resource-state-detail";
import { DriftList } from "@/components/platform/drift-list";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import type { ResourcesView, DriftView } from "../../_lib/read-models";
import { useNow } from "@/components/platform/clock";
import { freshness } from "../../_lib/freshness";
export function EnvironmentState({ resources, drift }: { resources: ResourcesView; drift: DriftView }) {
  const [selected, setSelected] = useState<string>();
  const router = useRouter();
  const now = useNow();
  const old = resources.rows.flatMap((r) => [r.observation?.observedAt, r.runtime?.observedAt]).filter((at): at is string => at !== undefined).filter((at) => freshness(at, now) !== "recent").length;
  const oldDrift = drift.report && freshness(drift.report.computedAt, now) !== "recent";
  return <div className="space-y-5">
    <Button variant="quiet" onClick={() => router.refresh()}>Refresh stored state</Button>
    {(old > 0 || oldDrift) && <Callout tone="warn" title="Stale or unknown observation time">Some stored reads are older than 15 minutes or have an unreadable or future timestamp. Results describe the recorded snapshot, not verified current cloud state. Refreshing this page rereads storage; it does not run a cloud observation.</Callout>}
    <ResourceStateTable rows={resources.rows} drift={drift.truncated ? undefined : drift.report ?? undefined} selectedAddress={selected} onSelect={setSelected} />
    <ResourceStateDetail row={resources.rows.find((r) => r.node.address === selected)} finding={drift.report?.findings.find((f) => f.address === selected)} />
    <DriftList report={drift.report ?? undefined} selectedAddress={selected} onSelect={setSelected} />
    {selected && !resources.rows.some((r) => r.node.address === selected) && <Callout tone="info">This finding refers to a resource outside the current page or an extra resource with no desired record.</Callout>}
    {drift.truncated && <Callout tone="warn">This drift report was truncated to 200 findings or unobserved addresses. Resources omitted from the report have no verified drift result here.</Callout>}
  </div>;
}
