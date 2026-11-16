"use client";
/**
 * Every resource in an environment, with its desired, observed and runtime
 * state in their own columns.
 *
 * What the columns promise:
 *  - Desired: who owns the resource and how many settings the configuration gives it.
 *  - Observed: whether the provider has it, when it was read, and - so unknowns
 *    are visible at a glance - how many attributes could not be read. A resource
 *    nobody has read says "Not observed yet"; it is never shown as present.
 *  - Runtime: health in words and the counts actually read ("running 2 of desired 3").
 *  - Drift (only when a report is given): the worst finding, or "Not checked" for
 *    a resource the report could not determine. Absence of a finding is not
 *    claimed for a resource the report never looked at.
 * Anything produced by a simulation carries the "simulated" label.
 */
import { Boxes } from "lucide-react";
import type { DriftReport } from "@/lib/resources/types";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, type TableColumn } from "@/components/ui/table";
import { SimulatedChip } from "@/components/screens/badges";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import { DRIFT_CLASS_LABEL, KIND_LABEL, OWNERSHIP_LABEL, OWNERSHIP_SENTENCE, PROVIDER_LABEL } from "./labels";
import {
  compareAttributes,
  describeCounts,
  driftLookup,
  tally,
  type ResourceStateRow,
} from "./resource-state-model";
import { HealthBadge, PresenceBadge, ReadMeta } from "./state-badges";
import { flattenObject, plural } from "./text";

export interface ResourceStateTableProps extends AsyncSurfaceProps {
  rows: readonly ResourceStateRow[];
  /** adds a Drift column */
  drift?: DriftReport;
  selectedAddress?: string;
  /** makes rows selectable; omit for a read-only list */
  onSelect?: (address: string) => void;
  /** heading; defaults to "Resource state" */
  title?: string;
}

export function ResourceStateTable({
  rows,
  drift,
  selectedAddress,
  onSelect,
  title = "Resource state",
  loading,
  error,
  onRetry,
}: ResourceStateTableProps) {
  const lookup = driftLookup(drift);

  const columns: TableColumn<ResourceStateRow>[] = [
    {
      key: "resource",
      header: "Resource",
      sortable: true,
      sortValue: (r) => r.node.address,
      render: (r) => (
        <div className="min-w-0">
          <div className="break-all font-mono text-[12.5px] text-ink">{r.node.address}</div>
          <div className="text-[12px] text-ink-mute">
            {KIND_LABEL[r.node.kind]} · {PROVIDER_LABEL[r.node.provider]} · <span className="font-mono">{r.node.region}</span>
          </div>
        </div>
      ),
    },
    {
      key: "desired",
      header: "Desired",
      render: (r) => (
        <div className="space-y-1">
          <Chip title={OWNERSHIP_SENTENCE[r.node.ownership]}>{OWNERSHIP_LABEL[r.node.ownership]}</Chip>
          <div className="text-[12px] text-ink-mute">
            {plural(Object.keys(flattenObject(r.node.spec)).length, "setting")}
          </div>
        </div>
      ),
    },
    {
      key: "observed",
      header: "Observed",
      render: (r) => {
        const t = tally(compareAttributes(r.node, r.observation));
        return (
          <div className="space-y-1">
            <PresenceBadge presence={r.observation?.presence} />
            {r.observation ? (
              <div className="space-y-0.5">
                <ReadMeta at={r.observation.observedAt} simulated={r.observation.simulated} />
                {(t.notObserved > 0 || t.differs > 0) && (
                  <div className="text-[12px] text-ink-mute">
                    {t.differs > 0 && <span className="text-warn">{t.differs} differ</span>}
                    {t.differs > 0 && t.notObserved > 0 && " · "}
                    {t.notObserved > 0 && <span>{t.notObserved} not observed</span>}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[12px] text-ink-mute">Nothing has read it yet.</div>
            )}
          </div>
        );
      },
    },
    {
      key: "runtime",
      header: "Runtime",
      render: (r) => (
        <div className="space-y-1">
          <HealthBadge health={r.runtime?.health} />
          {r.runtime && (
            <div className="space-y-0.5">
              {describeCounts(r.runtime.counts).length > 0 && (
                <div className="tnum text-[12px] text-ink-mute">
                  {describeCounts(r.runtime.counts)
                    .map((c) => `${c.label.toLowerCase()} ${c.value}`)
                    .join(" · ")}
                </div>
              )}
              <ReadMeta at={r.runtime.observedAt} simulated={r.runtime.simulated} />
            </div>
          )}
        </div>
      ),
    },
  ];

  if (drift) {
    columns.push({
      key: "drift",
      header: "Drift",
      render: (r) => {
        const cell = lookup(r.node.address);
        if (cell.kind === "finding") {
          return (
            <Chip
              tone={cell.finding.severity === "high" ? "err" : cell.finding.severity === "medium" ? "warn" : "info"}
              title={cell.finding.explanation}
            >
              {DRIFT_CLASS_LABEL[cell.finding.class]} · {cell.finding.severity}
            </Chip>
          );
        }
        if (cell.kind === "not_checked") {
          return (
            <Chip tone="neutral" title="The drift check could not determine this resource's state, so it is not reported as matching.">
              Not checked
            </Chip>
          );
        }
        return <span className="text-[12.5px] text-ink-mute" title="The drift report lists no difference for this resource.">No drift reported</span>;
      },
    });
  }

  const anySimulated = rows.some((r) => r.observation?.simulated || r.runtime?.simulated);

  return (
    <Card
      title={title}
      subtitle="Desired is what the configuration asks for, observed is what the provider reports, runtime is what is running now."
      actions={anySimulated ? <SimulatedChip title="Some of this state was generated by a simulation." /> : undefined}
      padded={false}
    >
      <div className="p-5">
        <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="resource state" rows={4}>
          {rows.length === 0 ? (
            <EmptyState
              icon={<Boxes className="h-5 w-5" aria-hidden="true" />}
              title="No resources in this environment yet"
              body="Resources appear here once the configuration has been expanded into infrastructure."
            />
          ) : (
            <Table<ResourceStateRow>
              caption={`${title}: desired, observed and runtime state per resource`}
              columns={columns}
              rows={[...rows]}
              rowKey={(r) => r.node.address}
              defaultSort={{ key: "resource", dir: "asc" }}
              selectedKey={selectedAddress}
              onSelectRow={onSelect ? (r) => onSelect(r.node.address) : undefined}
            />
          )}
        </SurfaceGate>
      </div>
    </Card>
  );
}
