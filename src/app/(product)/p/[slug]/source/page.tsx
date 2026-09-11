"use client";
/**
 * Source — the system as code.
 *
 * The manifest is the one model: what you read here is exactly what the map
 * draws and what a deploy snapshots. Save validates, previews the resulting
 * changes, and replaces the working copy through project.updateManifest —
 * the same audited action pipeline the visual editor uses.
 */
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Chip } from "@/components/ui/chip";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs } from "@/components/ui/tabs";
import { PageHeading } from "@/components/screens/page-heading";
import { useSelectedEnv } from "@/components/screens/project-data";
import { DeployedTab } from "./deployed-tab";
import { WorkingTab } from "./working-tab";

const ExportPanel = dynamic(() => import("@/components/screens/export-panel").then((m) => m.ExportPanel), {
  loading: () => <Skeleton height={120} />,
});

export default function SourcePage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const [tab, setTab] = useState("working");
  const [dirty, setDirty] = useState(false);

  const working = data?.project.workingManifest;
  const workingJson = useMemo(
    () => (working ? JSON.stringify(working, null, 2) : ""),
    [working]
  );

  if (!data || !working)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={280} />
      </div>
    );

  // The payload already carries revision metadata, so the tab can name the
  // live revision without a second request for a manifest nobody is reading.
  const deployedMeta = data.revisions.find((r) => r.id === env?.deployedRevisionId);
  const deployedLabel = deployedMeta
    ? `Deployed (r${deployedMeta.number})`
    : env?.deployedRevisionId
      ? "Deployed"
      : "Deployed (none)";

  return (
    <div className="product-page h-full w-full overflow-y-auto">
      <PageHeading title="Source" description="The same system, expressed as code. Edit the working definition, inspect a deployed snapshot, or export it." actions={<Chip tone={dirty ? "warn" : "neutral"}>{dirty ? "Unsaved changes" : "Working copy saved"}</Chip>} />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          {
            value: "working",
            label: "Working copy",
            badge: dirty ? <Chip tone="warn">unsaved</Chip> : undefined,
          },
          { value: "deployed", label: deployedLabel },
          { value: "export", label: "Export" },
        ]}
      />

      <div className="mt-5">
        {/*
          The working copy stays mounted: switching tabs with unsaved text used
          to unmount the editor and throw the text away silently. Hidden, not
          discarded — the tab badge above says it is still there.
        */}
        <div hidden={tab !== "working"}>
          <WorkingTab
            active={tab === "working"}
            json={workingJson}
            manifest={working}
            manifestHash={data.manifestHash}
            projectId={projectId}
            slug={slug}
            onDirtyChange={setDirty}
            refresh={refresh}
          />
        </div>

        {tab === "deployed" && (
          <DeployedTab
            revisions={data.revisions}
            deployedRevisionId={env?.deployedRevisionId}
            envName={env?.name}
            working={working}
          />
        )}

        {tab === "export" && (
          <ExportPanel
            environmentId={env?.id}
            environmentName={env?.name}
            workingManifest={working}
          />
        )}
      </div>
    </div>
  );
}
