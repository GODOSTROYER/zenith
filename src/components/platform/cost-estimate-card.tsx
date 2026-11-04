"use client";
/**
 * A monthly cost estimate, always titled "Estimate".
 *
 * Honesty rules (spec §38, ADR-0013):
 *  - the heading is "Estimate" and the total says "estimate"; nothing here is an
 *    invoice or a quote, and the card says so;
 *  - every line shows its basis (why that quantity) and where its unit price came
 *    from; weak price evidence (remembered, derived or assumed prices) is flagged
 *    on the line and summarised above the table with its share of the total;
 *  - what was included and what was NOT modelled are both listed, and an empty
 *    exclusion list is reported as "none recorded", not as "nothing is excluded";
 *  - the catalog version and computation time are shown so the number can be traced.
 */
import { Calculator } from "lucide-react";
import { cx, fmtUsd } from "@/lib/format";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { TimeAgo } from "@/components/ui/time-ago";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import {
  evidenceFor,
  fmtUnitUsd,
  midSentence,
  PRICE_EVIDENCE,
  summarizeWeakEvidence,
  unitLabel,
  type PricedCostEstimate,
} from "./price-evidence";
import { humanizeToken, plural } from "./text";

/** Everything below the heading: the total, the weak-evidence notice, lines, included and excluded. */
export function CostEstimateBody({ estimate, compact = false }: { estimate: PricedCostEstimate; compact?: boolean }) {
  const weak = summarizeWeakEvidence(estimate);
  const assumptions = Object.entries(estimate.assumptions);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tnum font-mono text-[24px] text-ink">{fmtUsd(estimate.monthlyUsd)}</span>
        <span className="text-[13px] text-ink-mute">per month, estimate</span>
        <Chip title="The version of the price catalog this estimate used.">Catalog {estimate.catalogVersion}</Chip>
        <span className="text-[12px] text-ink-faint">
          Computed <TimeAgo iso={estimate.computedAt} />
        </span>
      </div>

      {weak.weak > 0 && (
        <Callout tone="warn" title="Some prices rest on weak evidence">
          <p>
            {weak.weak} of {plural(weak.total, "line")}
            {weak.weakSharePercent !== undefined ? ` (${weak.weakSharePercent}% of this estimate)` : ""} use prices that were not read from a
            price feed: {weak.classes.map((c) => midSentence(PRICE_EVIDENCE[c].label)).join(", ")}. Treat the total as a rough guide and
            refresh the catalog before relying on it.
          </p>
        </Callout>
      )}

      {!compact &&
        (estimate.lines.length === 0 ? (
          <p className="text-[13px] text-ink-mute">This estimate has no priced lines.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Estimated monthly cost by line, with the basis and price source of each</caption>
              <thead>
                <tr className="text-[12px] text-ink-mute">
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    Item
                  </th>
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    Basis
                  </th>
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    Price source
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Monthly
                  </th>
                </tr>
              </thead>
              <tbody>
                {estimate.lines.map((l, i) => {
                  const ev = evidenceFor(l);
                  return (
                    <tr
                      key={`${l.sku}-${l.address ?? ""}-${i}`}
                      data-weak-price={ev.weak ? "true" : undefined}
                      className={cx("border-t border-line align-top", ev.weak && "bg-warn-dim")}
                    >
                      <th scope="row" className="py-2 pr-4 text-left font-normal">
                        <div className="text-[13px] text-ink">{l.description}</div>
                        {l.address && <div className="break-all font-mono text-[11.5px] text-ink-faint">{l.address}</div>}
                      </th>
                      <td className="py-2 pr-4 text-[12.5px] text-ink-mute">
                        <div>{l.basis}</div>
                        <div className="tnum text-ink-faint">
                          {l.quantity} × {fmtUnitUsd(l.unitUsd)} {unitLabel(l.unit)}
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        <Chip tone={ev.weak ? "warn" : "neutral"} title={ev.sentence}>
                          {ev.weak ? `Weak: ${midSentence(ev.label)}` : ev.label}
                        </Chip>
                      </td>
                      <td className="tnum py-2 text-right font-mono text-[13px] text-ink">{fmtUsd(l.monthlyUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Included costs" className="space-y-1.5">
          <h4 className="text-[13px] font-medium text-ink-mute">Included in this estimate</h4>
          {estimate.included.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink">
              {estimate.included.map((x, i) => (
                <li key={`${i}-${x}`}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-ink-mute">No included costs were listed.</p>
          )}
        </section>
        <section aria-label="Excluded costs" className="space-y-1.5">
          <h4 className="text-[13px] font-medium text-ink-mute">Not included, so real bills can be higher</h4>
          {estimate.excluded.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink">
              {estimate.excluded.map((x, i) => (
                <li key={`${i}-${x}`}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-ink-mute">No exclusions were recorded. That does not mean every cost is covered.</p>
          )}
        </section>
      </div>

      {assumptions.length > 0 && (
        <section aria-label="Usage assumptions" className="space-y-1.5">
          <h4 className="text-[13px] font-medium text-ink-mute">Usage this estimate assumes</h4>
          <dl className="tnum grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[13px]">
            {assumptions.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-mute">{humanizeToken(k)}</dt>
                <dd className="font-mono text-ink">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

export interface CostEstimateCardProps extends AsyncSurfaceProps {
  estimate?: PricedCostEstimate;
  /** what the estimate is for, for example "Standard SaaS on AWS in ap-south-1" */
  context?: string;
  /** omit the per-line table (totals, evidence summary and lists only) */
  compact?: boolean;
}

export function CostEstimateCard({ estimate, context, compact, loading, error, onRetry }: CostEstimateCardProps) {
  return (
    <Card
      title="Estimate"
      subtitle={context ? `${context}. List prices, not an invoice.` : "Monthly cost from list prices. This is not an invoice or a quote."}
    >
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="the estimate" rows={4}>
        {!estimate ? (
          <EmptyState
            icon={<Calculator className="h-5 w-5" aria-hidden="true" />}
            title="No estimate yet"
            body="An estimate appears here once Zenith has priced the configuration."
          />
        ) : (
          <CostEstimateBody estimate={estimate} compact={compact} />
        )}
      </SurfaceGate>
    </Card>
  );
}
