"use client";
/**
 * Observe — health, logs and cost for one environment.
 *
 * Sandbox health and logs are generated from the same facts, so what this page
 * shows is what Orrery actually computed. It is labelled simulated everywhere,
 * and it reads the deployed revision rather than the working copy wherever the
 * question is "what is running": the two are not the same system.
 *
 * The page itself only resolves the environment and lays the sections out —
 * each card polls what it needs and lives in its own file beside this one.
 */
import { useJson } from "@/lib/client/api";
import { useProjectAlerts } from "@/lib/client/alerts";
import type { Revision } from "@/lib/domain/types";
import { Skeleton } from "@/components/ui/skeleton";
import { useShell } from "@/components/shell/shell-context";
import { useSelectedEnv } from "@/components/screens/project-data";
import { AlertBanner, AlertsCard } from "./alerts";
import { CostCard } from "./cost-card";
import { DriftCard } from "./drift-card";
import { HealthStrip } from "./health-strip";
import { LogsPanel } from "./logs-panel";
import { PageHeading } from "@/components/screens/page-heading";

export default function ObservePage() {
  const { data, env, projectId } = useSelectedEnv();
  const { boot } = useShell();
  const manifest = data?.project.workingManifest;

  /* What is actually running here. Everything that answers "now" reads this. */
  const deployed = useJson<{ revision: Revision }>(
    env?.deployedRevisionId ? `/api/revisions/${env.deployedRevisionId}` : null
  );
  const running = deployed.data?.revision;

  /* Alert rules for this environment. One poll, shared by the banner and the
     Alerts section — reading the route also re-evaluates, so what the banner
     shows was computed for this request, not up to a timer tick ago. */
  const alerts = useProjectAlerts(projectId, env?.id);

  const connection = boot?.connections.find((c) => c.id === env?.connectionId);
  const provider = boot?.providers.find((p) => p.id === connection?.provider);
  const providerName = provider?.displayName ?? connection?.provider ?? "this environment's provider";

  if (!data || !env || !manifest)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={220} />
      </div>
    );

  return (
    <div className="product-page mx-auto h-full w-full max-w-[1240px] space-y-6 overflow-y-auto">
      <PageHeading title="Observe" description={`Health, drift, logs, and estimated cost for ${env.name}. Provider observations and simulated results remain explicitly labeled.`} />
      <AlertBanner open={alerts.open} />

      <HealthStrip
        environmentId={env.id}
        environmentName={env.name}
        projectId={projectId}
        working={manifest}
        running={running}
        deployed={!!env.deployedRevisionId}
      />

      <DriftCard
        environmentId={env.id}
        environmentName={env.name}
        deployed={!!env.deployedRevisionId}
        providerName={providerName}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <LogsPanel
          environmentId={env.id}
          working={manifest}
          running={running}
          runningLoading={deployed.loading}
          deployed={!!env.deployedRevisionId}
          providerName={providerName}
          providerIsSandbox={connection?.provider === "sandbox"}
        />
        <CostCard
          working={manifest}
          running={running}
          revisions={data.revisions}
          budget={env.policies.budgetUsdMonthly}
          environmentName={env.name}
        />
      </div>

      <AlertsCard
        projectId={projectId}
        environmentId={env.id}
        environmentName={env.name}
        alerts={alerts}
      />
    </div>
  );
}
