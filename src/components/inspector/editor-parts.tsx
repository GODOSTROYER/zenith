"use client";
/**
 * The pieces every inspector editor shares: the one cost hint shape, the size
 * picker, the fact list, and the guard that stops a dirty form from putting
 * stale values back over someone else's change.
 *
 * Nothing here is a screen of its own — each editor file owns one entity, and
 * imports what it needs from here.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CostDelta } from "@/components/ui/cost-delta";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SIZE_SPECS, nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { Manifest, Resource, Service, ServiceSize } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";

const SIZES: ServiceSize[] = ["nano", "small", "standard", "performance"];

export const sizeOptions = SIZES.map((s) => ({
  value: s,
  label: `${s} — ${SIZE_SPECS[s].vcpu} vCPU · ${SIZE_SPECS[s].memoryMb} MB`,
}));

export const KIND_OPTIONS = [
  { value: "web", label: "web — serves HTTP" },
  { value: "worker", label: "worker — long-running background process" },
  { value: "cron", label: "cron — runs on a schedule" },
  { value: "static", label: "static — prebuilt files" },
];

/**
 * One hint shape for every cost-affecting field: what it costs, and — once you
 * have moved it — what that costs compared to now. Size used to read as an
 * absolute while replicas read as a delta, so the same money looked like two
 * different numbers on one screen.
 */
export function CostHint({ monthlyUsd, deltaUsd }: { monthlyUsd?: number; deltaUsd?: number }) {
  if (monthlyUsd === undefined) return null;
  return (
    <>
      {fmtUsd(monthlyUsd)}/mo est.
      {deltaUsd !== undefined && deltaUsd !== 0 && (
        <>
          {" "}
          <CostDelta usd={deltaUsd} />
        </>
      )}
    </>
  );
}

/**
 * What a node costs now, and what the draft would cost. One node is rebuilt
 * shallowly — a structuredClone of the whole manifest on every keystroke was
 * doing deep work for a function that only reads three fields.
 */
export function serviceCost(m: Manifest, id: string, patch: Partial<Service>) {
  const probe: Manifest = { ...m, services: m.services.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
  return { current: nodeMonthlyCostUsd(m, id), projected: nodeMonthlyCostUsd(probe, id) };
}

export function resourceCost(m: Manifest, id: string, patch: Partial<Resource>) {
  const probe: Manifest = { ...m, resources: m.resources.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
  return { current: nodeMonthlyCostUsd(m, id), projected: nodeMonthlyCostUsd(probe, id) };
}

/** Cost-affecting defaults are always visible, never buried. */
export function SizeField({
  value,
  onChange,
  monthlyUsd,
  deltaUsd,
}: {
  value: ServiceSize;
  onChange: (v: ServiceSize) => void;
  monthlyUsd?: number;
  deltaUsd?: number;
}) {
  return (
    <Field
      label="Size"
      hint={<CostHint monthlyUsd={monthlyUsd} deltaUsd={deltaUsd} />}
      help={`${SIZE_SPECS[value].vcpu} vCPU · ${SIZE_SPECS[value].memoryMb} MB per replica.`}
    >
      <Select
        options={sizeOptions}
        value={value}
        onChange={(e) => onChange(e.target.value as ServiceSize)}
      />
    </Field>
  );
}

export function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-line rounded-card border border-line">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 px-3 py-2">
          <dt className="text-[12px] tracking-[0.02em] text-ink-faint uppercase">{k}</dt>
          <dd className="tnum min-w-0 truncate text-right text-[12.5px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ----------------------- editing against a moving target -------------------- */

/**
 * The project payload polls every 5 seconds, so a Navigator run or a second
 * tab can change an entity while its editor is open. A clean editor just
 * follows the newer values; a dirty one must never submit the stale fields it
 * still shows, so the caller is told and the user decides.
 */
export function useUpstreamGuard<T extends { id: string }>(
  entity: T,
  dirty: boolean,
  reset: () => void
): { stale: boolean; reload: () => void; keepMine: () => void } {
  const upstream = JSON.stringify(entity);
  const [base, setBase] = useState(upstream);
  const resetRef = useRef(reset);
  resetRef.current = reset;

  // A different node in the inspector always starts a fresh draft.
  useEffect(() => {
    resetRef.current();
    setBase(JSON.stringify(entity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id]);

  useEffect(() => {
    if (dirty || upstream === base) return;
    resetRef.current();
    setBase(upstream);
  }, [upstream, base, dirty]);

  return {
    stale: upstream !== base,
    reload: () => {
      resetRef.current();
      setBase(upstream);
    },
    keepMine: () => setBase(upstream),
  };
}

export function StaleNotice({
  name,
  onReload,
  onKeepMine,
}: {
  name: string;
  onReload: () => void;
  onKeepMine: () => void;
}) {
  return (
    // An edit collision arrives while the operator is typing into this form, so
    // it interrupts rather than waiting to be read.
    <Callout
      tone="warn"
      live="alert"
      actions={
        <>
          <Button size="sm" variant="quiet" onClick={onReload}>
            Load the new values
          </Button>
          <Button size="sm" variant="ghost" onClick={onKeepMine}>
            Keep mine
          </Button>
        </>
      }
    >
      <p>
        {name} changed somewhere else while you were editing — a Navigator run, or another tab.
        Applying what is on screen now would put the older values back.
      </p>
    </Callout>
  );
}
