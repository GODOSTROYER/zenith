"use client";
/** Compare-and-set settings writes carry the reviewed version and browser session only. */
import { useState } from "react";
import { AutonomyControl } from "@/components/platform/autonomy-control";
import type { AutonomyView } from "@/lib/capabilities/autonomy";
import type { RoleName } from "@/components/platform/labels";
import { browserMutation, mutationError } from "../../_lib/browser-api";
export function EnvironmentAutonomy({ initial, workspaceId, viewerRole, environmentName }: { initial: AutonomyView; workspaceId: string; viewerRole: RoleName; environmentName: string }) {
  const [current, setCurrent] = useState(initial);
  return <div className="space-y-2"><p className="text-[12px] text-ink-mute">{current.defaulted ? "Using the environment class default." : "Configured by a workspace admin."} Version {current.version}.</p>
    <AutonomyControl level={current.level} viewerRole={viewerRole} environmentName={environmentName} environmentClass={current.environmentClass} onChange={async (level) => {
      try { setCurrent(await browserMutation<AutonomyView>(workspaceId, `/api/platform/v1/environments/${encodeURIComponent(current.environmentId)}/autonomy`, { level, expectedVersion: current.version }, "PUT")); }
      catch (error) { throw new Error(mutationError(error)); }
    }} />
  </div>;
}
