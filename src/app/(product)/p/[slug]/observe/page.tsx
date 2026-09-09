"use client";
/**
 * Observe — health, logs and cost for one environment.
 *
 * Sandbox health and logs are generated from the same facts, so what this page
 * shows is what Zenith actually computed. It is labelled simulated everywhere,
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
import { Chip } from "@/components/ui/chip";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/screens/shared";
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
    <div className="product-page h-full w-full space-y-6 overflow-y-auto">
      <PageHeading title="Observe" description="The running system, its signals, and the cost of what comes next." actions={<a href="#alerts" className="text-[13px] text-ink-mute underline decoration-line underline-offset-4 hover:text-ink">Manage alert rules</a>} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-line py-3 text-[13px]">
        <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="text-ink-mute">Environment</span><span className="break-all font-medium text-ink">{env.name}</span></span>
        {env.class === "production" && <Chip tone="prod">Production</Chip>}
        <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="text-ink-mute">Provider</span><span className="text-ink">{providerName}</span></span>
        <Chip tone={deployed.error ? "warn" : "neutral"}>
          {!env.deployedRevisionId ? "Not deployed" : running ? `Deployed revision ${running.number}` : deployed.error ? "Revision unavailable" : "Loading deployed revision"}
        </Chip>
        <a href="#application-logs" className="text-ink-mute underline decoration-line underline-offset-4 hover:text-ink sm:ml-auto">Application logs</a>
      </div>
      {deployed.error && <div className="space-y-2"><ErrorNote error={deployed.error} /><Button size="sm" variant="quiet" onClick={deployed.refresh}>Retry deployed revision</Button></div>}
      <AlertBanner open={alerts.open} />

      <HealthStrip
        key={`health-${env.id}`}
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

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <LogsPanel
          environmentId={env.id}
          working={manifest}
          running={running}
          runningLoading={deployed.loading}
          runningError={deployed.error}
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
          deployed={!!env.deployedRevisionId}
          runningLoading={deployed.loading}
          runningError={deployed.error}
        />
      </div>

      <AlertsCard
        key={`alerts-${env.id}`}
        projectId={projectId}
        environmentId={env.id}
        environmentName={env.name}
        alerts={alerts}
      />
    </div>
  );
}
