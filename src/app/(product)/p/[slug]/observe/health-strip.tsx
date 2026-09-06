"use client";
/**
 * Health for one environment, plus the two day-two operations that belong on
 * a running service: restart it, or change its size in the working copy.
 * Both go through the same plan-first dialog as everything else.
 */
import { useState } from "react";
import { Activity, RotateCw, Scaling } from "lucide-react";
import { useJson } from "@/lib/client/api";
import { ServiceSize, type Manifest, type Revision, type Service } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Chip } from "@/components/ui/chip";
import { ActionConfirm, ErrorNote, SimulatedChip } from "@/components/screens/shared";

/** Health polls at this base rate; `useJson` slows down while nothing changes. */
const HEALTH_MS = 5000;

export interface HealthEvent {
  at: string;
  status: "ok" | "degraded" | "absent";
  reason: string;
  revisionNumber: number;
}

export interface ServiceHealth {
  status: "ok" | "degraded";
  replicasReady: number;
  replicasDesired: number;
  latencyMs: number;
  reason: string;
  /** transitions in the last hour, oldest first (absent on older servers) */
  history?: HealthEvent[];
}

export interface HealthResponse {
  environmentId: string;
  simulated: boolean;
  services: Record<string, ServiceHealth>;
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

export interface HealthStripProps {
  environmentId: string;
  environmentName: string;
  projectId: string | undefined;
  working: Manifest;
  running: Revision | undefined;
  deployed: boolean;
}

export function HealthStrip({
  environmentId,
  environmentName,
  projectId,
  working,
  running,
  deployed,
}: HealthStripProps) {
  const health = useJson<HealthResponse>(
    deployed ? `/api/health/${environmentId}` : null,
    HEALTH_MS
  );
  /** Restart and Scale are mutations, so they plan before they apply. */
  const [op, setOp] = useState<{ kind: "restart" | "scale"; service: Service } | null>(null);

  if (!deployed)
    return (
      <Card title="Service health">
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title={`${environmentName} has never been deployed`}
          body="Health becomes available after a supported deployment. Review and deploy from the System map to start."
        />
      </Card>
    );

  if (health.error) return <Card title="Service health" actions={<Chip tone="warn">{health.data ? "Last reading unavailable" : "Unavailable"}</Chip>}><ErrorNote error={health.error} />{health.error.status !== 501 && <Button size="sm" variant="quiet" className="mt-3" onClick={health.refresh}>Retry health check</Button>}</Card>;

  const entries = Object.entries(health.data?.services ?? {});
  /** Names come from the revision that is running — the working copy may have renamed it. */
  const runningService = (id: string) => running?.manifest.services.find((s) => s.id === id);

  return (
    <Card
      title="Service health"
      subtitle={`${environmentName}${running ? ` · deployed r${running.number}` : ""} · refreshes automatically while visible`}
      actions={health.data?.simulated ? <SimulatedChip /> : undefined}
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
        <div className="divide-y divide-line">
          {entries.map(([serviceId, h]) => {
            const live = runningService(serviceId);
            const editable = working.services.find((s) => s.id === serviceId);
            const name = live?.name ?? editable?.name ?? serviceId;
            const renamed = editable && live && editable.name !== live.name;
            return (
              <div key={serviceId} className="grid gap-3 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_180px_180px] lg:gap-x-6">
                <div className="min-w-0">
                  <span className="flex min-w-0 items-start gap-2">
                    <StatusDot
                      status={h.status === "ok" ? "ok" : "warn"}
                      label={h.status === "ok" ? "Healthy" : "Degraded"}
                    />
                    <span className="break-all font-mono text-[13px] text-ink">
                      {name}
                    </span>
                  </span>
                  <p className="mt-1 text-[12px] text-ink-mute">{h.status === "ok" ? "Healthy" : "Degraded"} · {h.reason}</p>
                  {h.history && <p className="mt-1 text-[12px] leading-relaxed text-ink-faint" title={h.history.map((e) => `${e.at} — ${e.reason}`).join("\n")}>{historyLine(h.history)}</p>}
                  {renamed && <p className="mt-1 break-words text-[12px] text-warn">Named {editable.name} in the working copy. Deploy to update this environment.</p>}
                </div>
                <dl className="tnum grid grid-cols-2 content-start gap-x-5 gap-y-1 text-[12px]">
                  <div><dt className="text-ink-mute">Ready replicas</dt><dd className="mt-1 font-mono text-[16px] text-ink">{h.replicasReady}<span className="text-ink-faint">/{h.replicasDesired}</span></dd></div>
                  <div><dt className="text-ink-mute">Latency</dt><dd className="mt-1 font-mono text-[16px] text-ink">{h.latencyMs}<span className="text-[12px] text-ink-faint"> ms</span></dd></div>
                </dl>
                  <span className="flex items-start lg:justify-end">
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
