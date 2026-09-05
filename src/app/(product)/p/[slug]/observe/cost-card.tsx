"use client";
/**
 * What this environment costs: what is running now, what the working copy
 * would make it, where the money goes, and the budget it is measured against.
 * Every number is an estimate from the price table and says so.
 */
import { useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { monthlyCostUsd, nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { Manifest, Revision } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Meter } from "@/components/ui/meter";
import { Sparkline } from "@/components/ui/sparkline";
import type { RevisionMeta } from "@/components/screens/project-data";
import { ErrorNote, SimulatedChip } from "@/components/screens/shared";

export interface CostCardProps {
  working: Manifest;
  running: Revision | undefined;
  revisions: RevisionMeta[];
  budget: number | undefined;
  environmentName: string;
}

export function CostCard({
  working,
  running,
  revisions,
  budget,
  environmentName,
}: CostCardProps) {
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
      actions={<SimulatedChip />}
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
