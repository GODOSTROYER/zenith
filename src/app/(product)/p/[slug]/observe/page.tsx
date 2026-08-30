"use client";
/**
 * Observe — health, logs and cost for one environment.
 *
 * Sandbox health and logs are generated from the same facts, so what this page
 * shows is what Orrery actually computed. It is labelled simulated everywhere.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, RotateCw } from "lucide-react";
import { useEventStream, useJson } from "@/lib/client/api";
import { monthlyCostUsd, nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { Manifest } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  LogViewer,
  Meter,
  Select,
  Skeleton,
  StatusDot,
  type LogLine,
} from "@/components/ui";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ErrorNote, useRunAction } from "@/components/screens/shared";

const LOG_EVENTS = ["log", "error"];

interface ServiceHealth {
  status: "ok" | "degraded";
  replicasReady: number;
  replicasDesired: number;
  latencyMs: number;
  reason: string;
}

interface HealthResponse {
  environmentId: string;
  simulated: boolean;
  services: Record<string, ServiceHealth>;
}

export default function ObservePage() {
  const { data, env, projectId } = useSelectedEnv();
  const manifest = data?.project.workingManifest;

  if (!data || !env || !manifest)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={220} />
      </div>
    );

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[1180px] space-y-6 px-6 py-6">
      <HealthStrip
        environmentId={env.id}
        environmentName={env.name}
        projectId={projectId}
        manifest={manifest}
        deployed={!!env.deployedRevisionId}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <LogsPanel
          environmentId={env.id}
          manifest={manifest}
          deployed={!!env.deployedRevisionId}
        />
        <CostCard
          manifest={manifest}
          budget={env.policies.budgetUsdMonthly}
          environmentName={env.name}
        />
      </div>
    </div>
  );
}

/* --------------------------------- health --------------------------------- */

function HealthStrip({
  environmentId,
  environmentName,
  projectId,
  manifest,
  deployed,
}: {
  environmentId: string;
  environmentName: string;
  projectId: string | undefined;
  manifest: Manifest;
  deployed: boolean;
}) {
  const health = useJson<HealthResponse>(
    deployed ? `/api/health/${environmentId}` : null,
    5000
  );
  const { run, busyId } = useRunAction(health.refresh);

  if (!deployed)
    return (
      <Card title="Health">
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title={`${environmentName} has never been deployed`}
          body="Health appears once a revision is live here. Deploy from the System map to start."
        />
      </Card>
    );

  if (health.error) return <ErrorNote error={health.error} />;

  const entries = Object.entries(health.data?.services ?? {});

  return (
    <Card
      title="Health"
      subtitle={`${environmentName} · refreshed every 5s`}
      actions={health.data?.simulated ? <Chip tone="info">simulated</Chip> : undefined}
    >
      {!health.data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton height={92} />
          <Skeleton height={92} />
          <Skeleton height={92} />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-[13px] text-ink-mute">
          The live revision has no managed services to report on.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map(([serviceId, h]) => {
            const name =
              manifest.services.find((s) => s.id === serviceId)?.name ?? serviceId;
            return (
              <div key={serviceId} className="rounded-card border border-line bg-bg1 p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusDot
                      status={h.status === "ok" ? "ok" : "warn"}
                      label={h.status === "ok" ? "Healthy" : "Degraded"}
                    />
                    <span className="truncate font-mono text-[13px] text-ink">{name}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busyId === serviceId}
                    icon={<RotateCw className="h-3.5 w-3.5" />}
                    title={`Restart ${name} in ${environmentName}`}
                    onClick={() =>
                      run(
                        "ops.restartService",
                        { input: { serviceId }, scope: { projectId, environmentId } },
                        { busyKey: serviceId }
                      )
                    }
                  >
                    Restart
                  </Button>
                </div>
                <dl className="tnum mt-3 grid grid-cols-2 gap-y-1 text-[12.5px]">
                  <dt className="text-ink-faint">replicas</dt>
                  <dd className="text-right text-ink">
                    {h.replicasReady}/{h.replicasDesired}
                  </dd>
                  <dt className="text-ink-faint">latency</dt>
                  <dd className="text-right text-ink">{h.latencyMs} ms</dd>
                </dl>
                <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">{h.reason}</p>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------- logs ---------------------------------- */

function LogsPanel({
  environmentId,
  manifest,
  deployed,
}: {
  environmentId: string;
  manifest: Manifest;
  deployed: boolean;
}) {
  const services = manifest.services;
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [streamError, setStreamError] = useState<string>();

  useEffect(() => {
    setLines([]);
    setStreamError(undefined);
  }, [serviceId, environmentId]);

  const onEvent = useCallback((type: string, raw: unknown) => {
    if (type === "error") {
      const e = raw as { message?: string; fix?: string };
      setStreamError([e.message, e.fix].filter(Boolean).join(" "));
      return;
    }
    const l = raw as { seq: number; ts: string; line: string };
    // The viewer's two lanes are Orrery narration vs raw output; an app's
    // stdout/stderr is raw output, so it all lands in the provider lane.
    setLines((prev) => [...prev, { seq: l.seq, ts: l.ts, line: l.line, stream: "provider" }]);
  }, []);

  const { connected } = useEventStream(
    deployed && serviceId ? `/api/logs/${environmentId}/${serviceId}` : null,
    LOG_EVENTS,
    onEvent
  );

  return (
    <Card
      title="Application logs"
      subtitle="Generated by the sandbox from the running revision."
      actions={
        <>
          <Chip tone="info">simulated</Chip>
          {deployed && (
            <Chip tone={connected ? "signal" : "neutral"}>
              {connected ? "streaming" : "idle"}
            </Chip>
          )}
        </>
      }
    >
      {services.length === 0 ? (
        <p className="text-[13px] text-ink-mute">This system has no services yet.</p>
      ) : !deployed ? (
        <p className="text-[13px] text-ink-mute">
          Nothing is running in this environment yet — deploy it and logs start here.
        </p>
      ) : (
        <div className="space-y-3">
          <Select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            aria-label="Service"
            options={services.map((s) => ({ value: s.id, label: `${s.name} (${s.kind})` }))}
          />
          {streamError && <ErrorNote error={new Error(streamError)} />}
          <LogViewer
            lines={lines}
            height={380}
            emptyMessage="Waiting for the next line — the sandbox emits one every couple of seconds."
          />
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------- cost ---------------------------------- */

function CostCard({
  manifest,
  budget,
  environmentName,
}: {
  manifest: Manifest;
  budget: number | undefined;
  environmentName: string;
}) {
  const total = monthlyCostUsd(manifest);

  const top = useMemo(() => {
    const nodes = [
      ...manifest.services.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      ...manifest.resources.map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
    ];
    return nodes
      .map((n) => ({ ...n, usd: nodeMonthlyCostUsd(manifest, n.id) }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);
  }, [manifest]);

  const pct = budget ? Math.round((total / budget) * 100) : 0;
  const tone = !budget ? "signal" : pct > 100 ? "err" : pct > 80 ? "warn" : "ok";

  return (
    <Card
      title="Cost"
      subtitle="Estimates from the working copy, not a bill."
      actions={<Chip tone="info">simulated</Chip>}
    >
      <p className="tnum text-[28px] leading-none font-medium text-ink">{fmtUsd(total)}</p>
      <p className="mt-1 text-[12.5px] text-ink-faint">est. per month, if deployed as it stands</p>

      <div className="mt-5 space-y-3">
        <h4 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
          Most expensive nodes
        </h4>
        {top.length === 0 ? (
          <p className="text-[13px] text-ink-mute">Nothing in the system yet.</p>
        ) : (
          top.map((n) => (
            <Meter
              key={n.id}
              value={n.usd}
              max={top[0].usd || 1}
              tone="signal"
              label={`${n.name} · ${n.kind}`}
              hint={`${fmtUsd(n.usd)}/mo est.`}
            />
          ))
        )}
      </div>

      <div className="mt-6 border-t border-line pt-4">
        <h4 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Budget</h4>
        {budget ? (
          <div className="mt-2">
            <Meter
              value={Math.min(total, budget * 1.5)}
              max={budget}
              tone={tone}
              label={`${environmentName} budget`}
              hint={`${fmtUsd(total)} of ${fmtUsd(budget)} (${pct}%)`}
            />
            {pct > 80 && (
              <p className={`mt-2 text-[12.5px] ${pct > 100 ? "text-err" : "text-warn"}`}>
                {pct > 100
                  ? "Over budget. Resize a node, or raise the budget in Settings → Environments."
                  : "Close to the budget. A deploy that adds anything will be flagged."}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-[12.5px] text-ink-mute">
            No budget on {environmentName}. Set one in Settings → Environments to get warned
            before a plan gets expensive.
          </p>
        )}
      </div>
    </Card>
  );
}
