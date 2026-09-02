"use client";
/**
 * Observe — health, logs and cost for one environment.
 *
 * Sandbox health and logs are generated from the same facts, so what this page
 * shows is what Orrery actually computed. It is labelled simulated everywhere,
 * and it reads the deployed revision rather than the working copy wherever the
 * question is "what is running": the two are not the same system.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, RotateCw, Scaling } from "lucide-react";
import { api, useEventStream, useJson } from "@/lib/client/api";
import { useProjectAlerts } from "@/lib/client/alerts";
import { monthlyCostUsd, nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import { DRIFT_POLL_MS, type DriftItem, type DriftResponse } from "@/lib/drift";
import { ServiceSize, type Manifest, type Revision, type Service } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import {
  Button,
  Callout,
  Card,
  Chip,
  EmptyState,
  Field,
  LogViewer,
  Meter,
  Select,
  Skeleton,
  Sparkline,
  StatusDot,
  type LogLine,
} from "@/components/ui";
import { useShell } from "@/components/shell/shell-context";
import { useSelectedEnv, type RevisionMeta } from "@/components/screens/project-data";
import { ActionConfirm, ErrorNote } from "@/components/screens/shared";
import { AlertBanner, AlertsCard } from "./alerts";

const LOG_EVENTS = ["log", "error"];
const ALL_SERVICES = "__all__";

/** Health polls at this base rate; `useJson` slows down while nothing changes. */
const HEALTH_MS = 5000;

interface HealthEvent {
  at: string;
  status: "ok" | "degraded" | "absent";
  reason: string;
  revisionNumber: number;
}

interface ServiceHealth {
  status: "ok" | "degraded";
  replicasReady: number;
  replicasDesired: number;
  latencyMs: number;
  reason: string;
  /** transitions in the last hour, oldest first (absent on older servers) */
  history?: HealthEvent[];
}

interface HealthResponse {
  environmentId: string;
  simulated: boolean;
  services: Record<string, ServiceHealth>;
}

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
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[1180px] space-y-6 px-6 py-6">
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

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
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

/* --------------------------------- drift ---------------------------------- */

const SEVERITY_TONE = { high: "err", medium: "warn", low: "info" } as const;

/** What the row is, in one word, from the environment's point of view. */
const KIND_LABEL: Record<DriftItem["kind"], string> = {
  missing: "missing",
  changed: "changed",
  extra: "unmanaged",
};

/**
 * Drift — the deployed revision against what the provider actually finds.
 *
 * The honesty burden here is heavier than anywhere else on this page, because
 * "no drift" is a claim about someone else's infrastructure. So: the subtitle
 * says which provider was asked and whether the answer was measured or
 * invented, a provider that cannot read refuses in full rather than reporting
 * a reassuring empty list, and nothing here writes anything.
 */
function DriftCard({
  environmentId,
  environmentName,
  deployed,
  providerName,
}: {
  environmentId: string;
  environmentName: string;
  deployed: boolean;
  providerName: string;
}) {
  const drift = useJson<DriftResponse>(
    deployed ? `/api/environments/${environmentId}/drift` : null,
    DRIFT_POLL_MS
  );

  if (!deployed)
    return (
      <Card title="Drift">
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title={`${environmentName} has never been deployed`}
          body="Drift is the difference between the revision deployed here and what the provider actually finds. Nothing is deployed, so there is nothing to compare."
        />
      </Card>
    );

  // 501 means this provider cannot read back at all (AWS Preview reads no
  // account). Offering "Check now" there would be a button that can only fail.
  const cannotRead = drift.error?.status === 501;

  const actions = (
    <div className="flex items-center gap-2">
      {drift.data?.simulated && <Chip tone="info">simulated</Chip>}
      {!cannotRead && (
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCw className="h-3.5 w-3.5" />}
          busy={drift.loading}
          onClick={drift.refresh}
          title={`Ask ${providerName} again, right now.`}
        >
          Check now
        </Button>
      )}
    </div>
  );

  if (drift.error)
    return (
      <Card title="Drift" actions={actions}>
        <ErrorNote error={drift.error} />
      </Card>
    );

  if (!drift.data)
    return (
      <Card title="Drift" actions={actions}>
        <Skeleton height={64} />
      </Card>
    );

  const { items, simulated, revision, observedAt } = drift.data;
  const subtitle = simulated
    ? `Simulated: ${providerName} has nothing real to inspect, so these differences are generated to show what drift looks like. Compared against r${revision.number}.`
    : `Read from ${providerName} against r${revision.number} — these differences are real. Checked ${new Date(observedAt).toLocaleTimeString()}.`;

  return (
    <Card title="Drift" subtitle={subtitle} actions={actions}>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-mute">
          Everything {providerName} reports matches r{revision.number}.
          {simulated ? " In a simulation, that is a statement about the simulation." : ""}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li
              key={`${it.kind}-${it.nodeId || it.externalRef || it.nodeName}-${i}`}
              className="flex gap-3 rounded-md border border-line px-3 py-2"
            >
              <Chip tone={SEVERITY_TONE[it.severity]}>{KIND_LABEL[it.kind]}</Chip>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-ink">
                  {it.nodeName}{" "}
                  <span className="font-normal text-ink-mute">({it.nodeKind})</span>
                </div>
                <p className="mt-0.5 text-[12.5px] text-ink-mute">{it.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* --------------------------------- health --------------------------------- */

function HealthStrip({
  environmentId,
  environmentName,
  projectId,
  working,
  running,
  deployed,
}: {
  environmentId: string;
  environmentName: string;
  projectId: string | undefined;
  working: Manifest;
  running: Revision | undefined;
  deployed: boolean;
}) {
  const health = useJson<HealthResponse>(
    deployed ? `/api/health/${environmentId}` : null,
    HEALTH_MS
  );
  /** Restart and Scale are mutations, so they plan before they apply. */
  const [op, setOp] = useState<{ kind: "restart" | "scale"; service: Service } | null>(null);

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
  /** Names come from the revision that is running — the working copy may have renamed it. */
  const runningService = (id: string) => running?.manifest.services.find((s) => s.id === id);

  return (
    <Card
      title="Health"
      subtitle={`${environmentName}${running ? ` · r${running.number}` : ""} · checked every 5s while it changes, less often while it does not`}
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
            const live = runningService(serviceId);
            const editable = working.services.find((s) => s.id === serviceId);
            const name = live?.name ?? editable?.name ?? serviceId;
            const renamed = editable && live && editable.name !== live.name;
            return (
              <div key={serviceId} className="rounded-card border border-line bg-bg1 p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusDot
                      status={h.status === "ok" ? "ok" : "warn"}
                      label={h.status === "ok" ? "Healthy" : "Degraded"}
                    />
                    <span className="truncate font-mono text-[13px] text-ink" title={name}>
                      {name}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Scaling className="h-3.5 w-3.5" />}
                      disabled={!editable}
                      disabledReason={`${name} is running here but is not in the working copy, so there is nothing to scale.`}
                      title={`Change ${name}'s size or replica count in the working copy`}
                      onClick={() => editable && setOp({ kind: "scale", service: editable })}
                    >
                      Scale
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<RotateCw className="h-3.5 w-3.5" />}
                      title={`Preview and restart ${name} in ${environmentName}`}
                      onClick={() =>
                        setOp({
                          kind: "restart",
                          service: live ?? editable ?? ({ id: serviceId, name } as Service),
                        })
                      }
                    >
                      Restart
                    </Button>
                  </span>
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
                {h.history && (
                  <p
                    className="mt-1 text-[11.5px] leading-relaxed text-ink-faint"
                    title={h.history.map((e) => `${localTime(e.at)} — ${e.reason}`).join("\n")}
                  >
                    {historyLine(h.history)}
                  </p>
                )}
                {renamed && (
                  <p className="mt-1 text-[11.5px] text-warn">
                    Renamed to {editable.name} in the working copy — deploy to make that the name
                    here.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {op?.kind === "restart" && (
        <ActionConfirm
          open
          onClose={() => setOp(null)}
          actionId="ops.restartService"
          input={{ serviceId: op.service.id }}
          scope={{ projectId, environmentId }}
          title={`Restart ${op.service.name} in ${environmentName}`}
          description="A sandbox restart is recorded — it shows up in Activity and in this environment's history — but the generated logs and health here are computed from the deployed revision, so they will read exactly the same afterwards."
          confirmLabel="Restart"
          onDone={() => {
            setOp(null);
            health.refresh();
          }}
        />
      )}

      {op?.kind === "scale" && (
        <ScaleDialog
          service={op.service}
          running={running?.manifest.services.find((s) => s.id === op.service.id)}
          environmentName={environmentName}
          projectId={projectId}
          environmentId={environmentId}
          onClose={() => setOp(null)}
        />
      )}
    </Card>
  );
}

const localTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
};

const HISTORY_WORD: Record<HealthEvent["status"], string> = {
  ok: "healthy",
  degraded: "degraded",
  absent: "not deployed",
};

/** One line of "what this service has done in the last hour". */
function historyLine(history: HealthEvent[]): string {
  if (history.length === 0) return "No recorded change in the last hour.";
  if (history.length === 1)
    return `${HISTORY_WORD[history[0].status]} since ${localTime(history[0].at)} (r${history[0].revisionNumber}).`;
  return `Last hour: ${history.map((e) => `${HISTORY_WORD[e.status]} ${localTime(e.at)}`).join(" → ")}`;
}

/**
 * Scale through the same plan-first path as everything else. The controls sit
 * inside the confirmation, so the plan (and its cost) re-reads every time the
 * numbers change — you never confirm a plan for different numbers than the
 * ones on screen.
 */
function ScaleDialog({
  service,
  running,
  environmentName,
  projectId,
  environmentId,
  onClose,
}: {
  service: Service;
  running: Service | undefined;
  environmentName: string;
  projectId: string | undefined;
  environmentId: string;
  onClose: () => void;
}) {
  const [replicas, setReplicas] = useState(service.replicas);
  const [size, setSize] = useState(service.size);
  const unchanged = replicas === service.replicas && size === service.size;

  return (
    <ActionConfirm
      open
      onClose={onClose}
      actionId="ops.scaleService"
      input={{ projectId, serviceId: service.id, replicas, size }}
      scope={{ projectId, environmentId }}
      title={`Scale ${service.name}`}
      description={`This edits the working copy. ${environmentName} keeps running ${running ? `${running.replicas}× ${running.size}` : "what it has"} until you deploy the change.`}
      confirmLabel="Apply to working copy"
      onDone={onClose}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Replicas">
          <Select
            value={String(replicas)}
            onChange={(e) => setReplicas(Number(e.target.value))}
            options={Array.from({ length: 11 }, (_, n) => ({
              value: String(n),
              label: n === 0 ? "0 — stopped" : String(n),
            }))}
          />
        </Field>
        <Field label="Size">
          <Select
            value={size}
            onChange={(e) => setSize(e.target.value as Service["size"])}
            options={ServiceSize.options.map((s) => ({ value: s, label: s }))}
          />
        </Field>
      </div>
      <p className="mt-2 text-[12px] text-ink-faint">
        {unchanged
          ? `Currently ${service.replicas}× ${service.size} in the working copy — change something for this to do anything.`
          : `From ${service.replicas}× ${service.size} to ${replicas}× ${size} in the working copy.`}
      </p>
    </ActionConfirm>
  );
}

/* ---------------------------------- logs ---------------------------------- */

interface WireLine {
  seq: number;
  ts: string;
  line: string;
  stream?: string;
  /** SEAM (B12): the server does not send this yet; when it does, it wins. */
  simulated?: boolean;
}

function LogsPanel({
  environmentId,
  working,
  running,
  runningLoading,
  deployed,
  providerName,
  providerIsSandbox,
}: {
  environmentId: string;
  working: Manifest;
  running: Revision | undefined;
  runningLoading: boolean;
  deployed: boolean;
  providerName: string;
  providerIsSandbox: boolean;
}) {
  const liveServices = useMemo(() => running?.manifest.services ?? [], [running]);
  const undeployed = useMemo(
    () => working.services.filter((s) => !liveServices.some((d) => d.id === s.id)),
    [working, liveServices]
  );

  // Deep link from the inspector: /observe?service=<id>. Read once, the same
  // way the System Map reads ?select=, so this page needs no Suspense boundary.
  const [serviceId, setServiceId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("service") ?? "";
  });
  useEffect(() => {
    // Default to something that is actually running, not services[0] of the
    // working copy — an undeployed service streams nothing, forever. A deep
    // link that names a real service (live or undeployed) is kept.
    setServiceId((current) =>
      current && [...liveServices, ...undeployed].some((s) => s.id === current)
        ? current
        : (liveServices[0]?.id ?? "")
    );
  }, [liveServices, undeployed]);

  const allMode = serviceId === ALL_SERVICES;
  const chosenIsUndeployed = undeployed.some((s) => s.id === serviceId);
  const serviceName = liveServices.find((s) => s.id === serviceId)?.name ?? "service";

  const [lines, setLines] = useState<LogLine[]>([]);
  const [streamError, setStreamError] = useState<string>();
  /** undefined = the stream says nothing about it; see WireLine.simulated. */
  const [wireSimulated, setWireSimulated] = useState<boolean>();

  useEffect(() => {
    setLines([]);
    setStreamError(undefined);
    setWireSimulated(undefined);
  }, [serviceId, environmentId]);

  const addLines = useCallback((incoming: LogLine[], simulated?: boolean) => {
    if (typeof simulated === "boolean") setWireSimulated(simulated);
    setLines((prev) => [...prev, ...incoming]);
  }, []);

  const onEvent = useCallback(
    (type: string, raw: unknown) => {
      if (type === "error") {
        const e = raw as { message?: string; fix?: string };
        setStreamError([e.message, e.fix].filter(Boolean).join(" "));
        return;
      }
      const l = raw as WireLine;
      // The generator says which handle a line came out of; keep that, so stderr
      // stays visibly stderr and the viewer's stream filter has something to do.
      addLines(
        [
          {
            seq: l.seq,
            ts: l.ts,
            line: l.line,
            stream: l.stream === "stderr" ? "stderr" : "stdout",
          },
        ],
        l.simulated
      );
    },
    [addLines]
  );

  const { connected } = useEventStream(
    deployed && serviceId && !allMode && !chosenIsUndeployed
      ? `/api/logs/${environmentId}/${serviceId}`
      : null,
    LOG_EVENTS,
    onEvent
  );

  /** In all-services mode every service gets its own stream; see LogFeed. */
  const merged = useMemo(
    () => (allMode ? [...lines].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? "")) : lines),
    [allMode, lines]
  );

  const perMinute = useMemo(() => ratePerMinute(merged), [merged]);
  const errors = merged.filter((l) => l.stream === "stderr").length;

  const options = [
    ...(liveServices.length > 1
      ? [{ value: ALL_SERVICES, label: `All ${liveServices.length} deployed services` }]
      : []),
    ...liveServices.map((s) => ({ value: s.id, label: `${s.name} (${s.kind})` })),
    ...undeployed.map((s) => ({
      value: s.id,
      label: `${s.name} (${s.kind}) — not deployed here`,
    })),
  ];

  return (
    <Card
      title="Application logs"
      subtitle={
        providerIsSandbox
          ? `Generated by Orrery's sandbox from r${running?.number ?? "?"} — not read from a running process.`
          : `Generated by Orrery's sandbox simulator. ${providerName} does not stream logs to Orrery; these lines were never produced by it.`
      }
      actions={
        <>
          <Chip
            tone={wireSimulated === false ? "ok" : "info"}
            title={
              wireSimulated === undefined
                ? "The log stream does not label itself yet; everything Orrery generates here is simulated."
                : "The stream labels its own frames."
            }
          >
            {wireSimulated === false ? "live" : "simulated"}
          </Chip>
          {deployed && !allMode && !chosenIsUndeployed && (
            <Chip tone={connected ? "signal" : "warn"}>
              {connected ? "streaming" : "reconnecting"}
            </Chip>
          )}
        </>
      }
    >
      {working.services.length === 0 ? (
        <p className="text-[13px] text-ink-mute">This system has no services yet.</p>
      ) : !deployed ? (
        <p className="text-[13px] text-ink-mute">
          Nothing is running in this environment yet — deploy it and logs start here.
        </p>
      ) : runningLoading && !running ? (
        <Skeleton height={380} />
      ) : liveServices.length === 0 ? (
        <p className="text-[13px] text-ink-mute">
          r{running?.number ?? "?"} has no services in it, so nothing is running to log
          {undeployed.length > 0
            ? ` — the ${undeployed.length} service${undeployed.length === 1 ? "" : "s"} in the working copy start logging once you deploy.`
            : "."}
        </p>
      ) : (
        <div className="space-y-3">
          <Select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            aria-label="Service"
            options={options}
          />

          {allMode &&
            liveServices.map((s) => (
              <LogFeed
                key={s.id}
                url={`/api/logs/${environmentId}/${s.id}`}
                name={s.name}
                onLines={addLines}
              />
            ))}

          {chosenIsUndeployed ? (
            <Callout tone="warn">
              {working.services.find((s) => s.id === serviceId)?.name} is in the working copy but
              not in r{running?.number ?? "?"}, so nothing is running to log. Deploy this
              environment to see its output.
            </Callout>
          ) : (
            <>
              {streamError && <ErrorNote error={new Error(streamError)} />}
              <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-bg1 px-3 py-2">
                <Sparkline
                  points={perMinute.points}
                  label={`Lines per minute over the last ${perMinute.points.length} minutes of the sample`}
                />
                <span className="tnum text-[12.5px] text-ink">
                  {perMinute.current}/min
                  <span className="text-ink-faint"> in this sample</span>
                </span>
                <span className="tnum text-[12.5px] text-ink-faint">
                  {errors} on stderr of {merged.length}
                </span>
                <Chip tone="info" className="ml-auto">
                  synthetic
                </Chip>
              </div>
              <LogViewer
                lines={merged}
                height={380}
                label={allMode ? "all services, application logs" : `${serviceName} application logs`}
                downloadName={`${allMode ? "all-services" : serviceName}-logs.txt`}
                emptyMessage="Waiting for the next line — the sandbox emits one every couple of seconds."
              />
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                On connect the sandbox replays its last 200 lines per service (about seven minutes)
                and streams from there; anything older than that was never stored. Search, level and
                stream filters — and Download — work on the {merged.length} line
                {merged.length === 1 ? "" : "s"} loaded here, not on the server.
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * One service's stream, rendered as nothing. All-services mode needs one
 * EventSource per service and hooks cannot be called in a loop — a component
 * per feed is the honest way to say "N streams".
 */
function LogFeed({
  url,
  name,
  onLines,
}: {
  url: string;
  name: string;
  onLines: (lines: LogLine[], simulated?: boolean) => void;
}) {
  const onEvent = useCallback(
    (type: string, raw: unknown) => {
      if (type !== "log") return;
      const l = raw as WireLine;
      onLines(
        [
          {
            // no seq: sequence numbers are per service and would collide here
            ts: l.ts,
            line: `[${name}] ${l.line}`,
            stream: l.stream === "stderr" ? "stderr" : "stdout",
          },
        ],
        l.simulated
      );
    },
    [name, onLines]
  );
  useEventStream(url, LOG_EVENTS, onEvent);
  return null;
}

/** Lines per minute over the sample that is loaded, oldest bucket first. */
function ratePerMinute(lines: LogLine[]): { points: number[]; current: number } {
  const counts = new Map<number, number>();
  for (const l of lines) {
    const t = l.ts ? Date.parse(l.ts) : NaN;
    if (Number.isNaN(t)) continue;
    const minute = Math.floor(t / 60000);
    counts.set(minute, (counts.get(minute) ?? 0) + 1);
  }
  if (counts.size === 0) return { points: [], current: 0 };
  const minutes = [...counts.keys()].sort((a, b) => a - b);
  const points: number[] = [];
  for (let m = minutes[0]; m <= minutes[minutes.length - 1]; m++) points.push(counts.get(m) ?? 0);
  // The newest minute is still filling up, so the rate is the one before it.
  return { points, current: points.length > 1 ? points[points.length - 2] : points[0] };
}

/* ---------------------------------- cost ---------------------------------- */

function CostCard({
  working,
  running,
  revisions,
  budget,
  environmentName,
}: {
  working: Manifest;
  running: Revision | undefined;
  revisions: RevisionMeta[];
  budget: number | undefined;
  environmentName: string;
}) {
  const total = monthlyCostUsd(working);
  const deployedTotal = running ? monthlyCostUsd(running.manifest) : undefined;
  const delta = deployedTotal === undefined ? 0 : Math.round((total - deployedTotal) * 100) / 100;

  const top = useMemo(() => {
    const nodes = [
      ...working.services.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      ...working.resources.map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
    ];
    return nodes
      .map((n) => ({ ...n, usd: nodeMonthlyCostUsd(working, n.id) }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);
  }, [working]);

  const pct = budget ? Math.round((total / budget) * 100) : 0;
  const tone = !budget ? "signal" : pct > 100 ? "err" : pct > 80 ? "warn" : "ok";

  return (
    <Card
      title="Cost"
      subtitle="Estimates from the price table, not a bill."
      actions={<Chip tone="info">simulated</Chip>}
    >
      {deployedTotal === undefined ? (
        <>
          <p className="tnum text-[28px] leading-none font-medium text-ink">{fmtUsd(total)}</p>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            est. per month for the working copy — nothing is deployed to {environmentName} yet
          </p>
        </>
      ) : (
        <>
          <p className="tnum text-[28px] leading-none font-medium text-ink">
            {fmtUsd(deployedTotal)}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            est. per month running now — r{running?.number} in {environmentName}
          </p>
          <p className="mt-2 text-[12.5px] text-ink-mute">
            {delta === 0
              ? "The working copy costs the same; nothing pending changes the bill."
              : `The working copy would make it ${fmtUsd(total)} — ${delta > 0 ? "+" : "−"}${fmtUsd(Math.abs(delta))}/month once deployed.`}
          </p>
        </>
      )}

      <div className="mt-5 space-y-3">
        <h4 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
          Most expensive nodes (working copy)
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

      <RevisionCostTrend revisions={revisions} />

      <div className="mt-6 border-t border-line pt-4">
        <h4 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Budget</h4>
        {budget ? (
          <div className="mt-2">
            {/* The bar saturates at 100% — the percentage and the overage below
                it are what stay true at 150% and at 400%. */}
            <Meter
              value={total}
              max={budget}
              tone={tone}
              label={`${environmentName} budget`}
              hint={`${fmtUsd(total)} of ${fmtUsd(budget)} (${pct}%)`}
            />
            {pct > 80 && (
              <p className={`mt-2 text-[12.5px] ${pct > 100 ? "text-err" : "text-warn"}`}>
                {pct > 100
                  ? `${fmtUsd(total - budget)} over the ${fmtUsd(budget)} budget — ${pct}% of it. Resize a node, or raise the budget in Settings → Environments.`
                  : `${fmtUsd(budget - total)} left of the ${fmtUsd(budget)} budget. A deploy that adds anything will be flagged.`}
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

const TREND_REVISIONS = 8;

/**
 * Estimated cost of the last few revisions, priced now. Each revision's
 * manifest is a separate request, so it is fetched when asked for rather than
 * on every visit to this page.
 */
function RevisionCostTrend({ revisions }: { revisions: RevisionMeta[] }) {
  const recent = useMemo(
    () => [...revisions].sort((a, b) => a.number - b.number).slice(-TREND_REVISIONS),
    [revisions]
  );
  const [series, setSeries] = useState<{ number: number; usd: number }[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const load = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const loaded = await Promise.all(
        recent.map((r) => api<{ revision: Revision }>(`/api/revisions/${r.id}`))
      );
      setSeries(
        loaded.map((l) => ({
          number: l.revision.number,
          usd: monthlyCostUsd(l.revision.manifest),
        }))
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (recent.length < 2) return null;

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Across revisions</h4>
        {!series && (
          <Button size="sm" variant="quiet" busy={busy} onClick={load}>
            Price the last {recent.length}
          </Button>
        )}
      </div>
      {error ? <ErrorNote error={error} className="mt-2" /> : null}
      {series && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-3">
            <Sparkline
              points={series.map((s) => s.usd)}
              width={140}
              label={`Estimated monthly cost, r${series[0].number} to r${series[series.length - 1].number}`}
            />
            <span className="tnum text-[12.5px] text-ink">
              {fmtUsd(series[0].usd)} → {fmtUsd(series[series.length - 1].usd)}
            </span>
          </div>
          <p className="text-[11.5px] leading-relaxed text-ink-faint">
            r{series[0].number}–r{series[series.length - 1].number}, each priced with today&apos;s
            estimate table — not what anything was billed at the time.
          </p>
        </div>
      )}
    </div>
  );
}
