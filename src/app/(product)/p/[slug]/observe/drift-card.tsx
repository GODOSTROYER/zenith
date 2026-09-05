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
