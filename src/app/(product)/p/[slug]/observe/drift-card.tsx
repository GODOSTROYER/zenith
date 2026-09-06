"use client";
/**
 * Drift — the deployed revision against what the provider actually finds.
 *
 * The honesty burden here is heavier than anywhere else on Observe, because
 * "no drift" is a claim about someone else's infrastructure. So: the subtitle
 * says which provider was asked and whether the answer was measured or
 * invented, a provider that cannot read refuses in full rather than reporting
 * a reassuring empty list, and nothing here writes anything.
 */
import { Activity, RotateCw } from "lucide-react";
import { useJson } from "@/lib/client/api";
import { DRIFT_POLL_MS, type DriftItem, type DriftResponse } from "@/lib/drift";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorNote, SimulatedChip } from "@/components/screens/shared";
import { fmtDate } from "@/lib/format";

const SEVERITY_TONE = { high: "err", medium: "warn", low: "info" } as const;

/** What the row is, in one word, from the environment's point of view. */
const KIND_LABEL: Record<DriftItem["kind"], string> = {
  missing: "missing",
  changed: "changed",
  extra: "unmanaged",
};

export interface DriftCardProps {
  environmentId: string;
  environmentName: string;
  deployed: boolean;
  providerName: string;
}

export function DriftCard({
  environmentId,
  environmentName,
  deployed,
  providerName,
}: DriftCardProps) {
  const drift = useJson<DriftResponse>(
    deployed ? `/api/environments/${environmentId}/drift` : null,
    DRIFT_POLL_MS
  );

  if (!deployed)
    return (
      <Card title="Configuration drift">
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
      {drift.data?.simulated && <SimulatedChip />}
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
      <Card title="Configuration drift" subtitle={cannotRead ? `${providerName} cannot read infrastructure state.` : "The provider could not return a current observation."} actions={actions}>
        <p className="mb-3 text-[13px] text-warn">{cannotRead ? "Observation unavailable" : drift.data ? "Last observation is stale. Check again to confirm the current state." : "No current observation"}</p>
        <ErrorNote error={drift.error} />
      </Card>
    );

  if (!drift.data)
    return (
      <Card title="Configuration drift" actions={actions}>
        <Skeleton height={64} />
      </Card>
    );

  const { items, simulated, revision, observedAt } = drift.data;
  const subtitle = simulated
    ? `Generated comparison against r${revision.number}; no real infrastructure was inspected.`
    : `${providerName} readback compared with deployed r${revision.number}.`;

  return (
    <Card title="Configuration drift" subtitle={subtitle} actions={actions} footer={<span>Observed <time dateTime={observedAt} title={observedAt}>{fmtDate(observedAt)}</time> · {items.length} difference{items.length === 1 ? "" : "s"}</span>}>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-mute">
          Everything {providerName} reports matches r{revision.number}.
          {simulated ? " In a simulation, that is a statement about the simulation." : ""}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((it, i) => (
            <li
              key={`${it.kind}-${it.nodeId || it.externalRef || it.nodeName}-${i}`}
              className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0 sm:flex-nowrap"
            >
              <Chip tone={SEVERITY_TONE[it.severity]}>{KIND_LABEL[it.kind]}</Chip>
              <div className="min-w-0 flex-1">
                <div className="break-all font-mono text-[13px] text-ink">
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
