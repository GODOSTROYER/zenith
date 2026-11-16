"use client";
/**
 * One resource: desired, observed and runtime state side by side, and every
 * attribute compared.
 *
 * The rules that matter here:
 *  - An attribute that was not read is "Not observed (reason)". It is never blank
 *    and never "matches": matching needs a known observed value AND a desired value.
 *  - A resource that is missing or not accessible says so once and every attribute
 *    row explains that nothing could be read, instead of pretending to compare.
 *  - Secret-looking attributes are masked; a secret reference (vault:, ARN) is
 *    shown as a reference, never as a value.
 *  - Runtime is a separate fact (what is running now); it is shown next to the
 *    other two, not forced into the attribute table where no honest mapping exists.
 *  - Simulated observations and runtime carry the "simulated" label.
 */
import { Boxes } from "lucide-react";
import type { DriftFinding } from "@/lib/resources/types";
import { cx } from "@/lib/format";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import { Fact } from "./badges";
import { DRIFT_CLASS_LABEL, KIND_LABEL, OWNERSHIP_LABEL, OWNERSHIP_SENTENCE, PROVIDER_LABEL } from "./labels";
import {
  compareAttributes,
  describeCounts,
  describeSignal,
  displayAttributeValue,
  notObservedText,
  tally,
  type AttributeComparison,
  type AttributeStatus,
  type ResourceStateRow,
} from "./resource-state-model";
import { HealthBadge, PresenceBadge, ReadMeta } from "./state-badges";
import { flattenObject, plural, shortDigest } from "./text";

export interface ResourceStateDetailProps extends AsyncSurfaceProps {
  row?: ResourceStateRow;
  /** the drift finding for this resource, when a drift report exists */
  finding?: DriftFinding;
}

const STATUS: Record<AttributeStatus, { label: string; tone: ChipTone; title: string }> = {
  matches: { label: "Matches", tone: "ok", title: "The observed value equals the desired value." },
  differs: { label: "Differs", tone: "warn", title: "The provider reports a different value from the configuration." },
  not_observed: {
    label: "Unknown",
    tone: "neutral",
    title: "Zenith could not read this value, so it cannot say whether it matches.",
  },
  observed_only: {
    label: "Not in configuration",
    tone: "info",
    title: "The provider reports this attribute, but the configuration does not set it.",
  },
};

function DesiredCell({ row }: { row: AttributeComparison }) {
  if (!row.desired.specified) return <span className="text-[12.5px] text-ink-faint italic">Not specified</span>;
  const v = displayAttributeValue(row.path, row.desired.value);
  return <span className={cx("break-words text-[12.5px]", v.masked ? "text-ink-faint italic" : "font-mono text-ink")}>{v.text}</span>;
}

function ObservedCell({ row }: { row: AttributeComparison }) {
  if (row.observed.state === "unknown") {
    return (
      <span className="text-[12.5px] text-ink-mute italic">{notObservedText(row.observed.reason, row.observed.detail)}</span>
    );
  }
  const v = displayAttributeValue(row.path, row.observed.value);
  return <span className={cx("break-words text-[12.5px]", v.masked ? "text-ink-faint italic" : "font-mono text-ink")}>{v.text}</span>;
}

export function ResourceStateDetail({ row, finding, loading, error, onRetry }: ResourceStateDetailProps) {
  const attrs = row ? compareAttributes(row.node, row.observation) : [];
  const t = tally(attrs);
  const obs = row?.observation;
  const runtime = row?.runtime;
  const simulated = Boolean(obs?.simulated || runtime?.simulated);

  return (
    <Card
      title={row ? <span className="break-all font-mono text-[15px]">{row.node.address}</span> : "Resource"}
      subtitle={row ? `${KIND_LABEL[row.node.kind]} · ${PROVIDER_LABEL[row.node.provider]} · ${row.node.region}` : undefined}
      actions={
        row ? (
          <>
            <PresenceBadge presence={obs?.presence} />
            <HealthBadge health={runtime?.health} />
          </>
        ) : undefined
      }
    >
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="this resource" rows={5}>
        {!row ? (
          <EmptyState
            icon={<Boxes className="h-5 w-5" aria-hidden="true" />}
            title="Select a resource"
            body="Choose a resource from the list to compare its desired, observed and runtime state."
          />
        ) : (
          <div className="space-y-6">
            {simulated && (
              <Callout tone="info" compact>
                Some of this state comes from a simulation. No real infrastructure was read for those values.
              </Callout>
            )}
            {obs?.error && (
              <Callout tone="warn" title="Reading this resource failed" compact>
                <span className="break-words">{obs.error}</span>
              </Callout>
            )}
            {finding && (
              <Callout tone={finding.severity === "high" ? "err" : "warn"} title={`Drift: ${DRIFT_CLASS_LABEL[finding.class]}`} compact>
                {finding.explanation}
              </Callout>
            )}

            <div className="grid gap-4 md:grid-cols-3" role="group" aria-label="Desired, observed and runtime state">
              <section aria-label="Desired" className="space-y-2 rounded-card border border-line p-4">
                <h4 className="text-[13px] font-medium text-ink-mute">Desired</h4>
                <dl className="space-y-2">
                  <Fact label="Ownership">
                    <span title={OWNERSHIP_SENTENCE[row.node.ownership]}>{OWNERSHIP_LABEL[row.node.ownership]}</span>
                    <p className="mt-0.5 text-[12px] text-ink-mute">{OWNERSHIP_SENTENCE[row.node.ownership]}</p>
                  </Fact>
                  <Fact label="Configuration">
                    {plural(Object.keys(flattenObject(row.node.spec)).length, "setting")}
                    <span className="ml-2 font-mono text-[12px] text-ink-faint" title={row.node.specDigest}>
                      {shortDigest(row.node.specDigest, 8)}
                    </span>
                  </Fact>
                  {row.node.externalRef && (
                    <Fact label="Provider reference">
                      <span className="break-all font-mono text-[12px]">{row.node.externalRef}</span>
                    </Fact>
                  )}
                </dl>
              </section>

              <section aria-label="Observed" className="space-y-2 rounded-card border border-line p-4">
                <h4 className="text-[13px] font-medium text-ink-mute">Observed</h4>
                {obs ? (
                  <dl className="space-y-2">
                    <Fact label="At the provider">
                      <PresenceBadge presence={obs.presence} />
                    </Fact>
                    {obs.externalId && (
                      <Fact label="Provider id">
                        <span className="break-all font-mono text-[12px]">{obs.externalId}</span>
                      </Fact>
                    )}
                    <Fact label="Read">
                      <ReadMeta at={obs.observedAt} simulated={obs.simulated} prefix="" />
                      <span className="mt-0.5 block font-mono text-[12px] text-ink-faint">{obs.source}</span>
                    </Fact>
                  </dl>
                ) : (
                  <p className="text-[13px] text-ink-mute">Not observed yet. Nothing has read this resource at the provider.</p>
                )}
              </section>

              <section aria-label="Runtime" className="space-y-2 rounded-card border border-line p-4">
                <h4 className="text-[13px] font-medium text-ink-mute">Runtime</h4>
                {runtime ? (
                  <div className="space-y-2">
                    <HealthBadge health={runtime.health} />
                    {describeCounts(runtime.counts).length > 0 ? (
                      <dl className="tnum grid grid-cols-2 gap-x-3 gap-y-1 text-[13px]">
                        {describeCounts(runtime.counts).map((c) => (
                          <div key={c.label} className="contents">
                            <dt className="text-ink-mute">{c.label}</dt>
                            <dd className="font-mono text-ink">{c.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="text-[12.5px] text-ink-mute">No counts were reported.</p>
                    )}
                    {runtime.signals.length > 0 && (
                      <ul className="list-disc space-y-0.5 pl-5 text-[12.5px] text-ink">
                        {runtime.signals.map((s) => (
                          <li key={s} title={s}>
                            {describeSignal(s)}
                          </li>
                        ))}
                      </ul>
                    )}
                    <ReadMeta at={runtime.observedAt} simulated={runtime.simulated} />
                  </div>
                ) : (
                  <p className="text-[13px] text-ink-mute">Runtime not read. Nothing has reported what is running.</p>
                )}
              </section>
            </div>

            <section aria-label="Attributes" className="space-y-2">
              <h4 className="text-[13px] font-medium text-ink-mute">Desired against observed, attribute by attribute</h4>
              <p className="text-[12.5px] text-ink-mute">
                <span className="tnum">{t.matches}</span> match, <span className="tnum">{t.differs}</span> differ,{" "}
                <span className="tnum">{t.notObserved}</span> unknown
                {t.observedOnly > 0 ? (
                  <>
                    , <span className="tnum">{t.observedOnly}</span> not in the configuration
                  </>
                ) : null}
                . Runtime is a separate fact about what is running, so it is not compared attribute by attribute.
              </p>
              {attrs.length === 0 ? (
                <p className="text-[13px] text-ink-mute">
                  This resource has no configured settings and no observed attributes to compare.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left">
                    <caption className="sr-only">Desired and observed settings for {row.node.address}</caption>
                    <thead>
                      <tr className="text-[12px] text-ink-mute">
                        <th scope="col" className="py-1.5 pr-4 font-medium">
                          Attribute
                        </th>
                        <th scope="col" className="py-1.5 pr-4 font-medium">
                          Desired
                        </th>
                        <th scope="col" className="py-1.5 pr-4 font-medium">
                          Observed
                        </th>
                        <th scope="col" className="py-1.5 font-medium">
                          Result
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {attrs.map((a) => (
                        <tr
                          key={a.path}
                          data-status={a.status}
                          className={cx("border-t border-line align-top", a.status === "differs" && "bg-warn-dim")}
                        >
                          <th scope="row" className="py-2 pr-4 text-left font-normal">
                            <span className="break-all font-mono text-[12.5px] text-ink">{a.path}</span>
                          </th>
                          <td className="py-2 pr-4">
                            <DesiredCell row={a} />
                          </td>
                          <td className="py-2 pr-4">
                            <ObservedCell row={a} />
                          </td>
                          <td className="py-2">
                            <Chip tone={STATUS[a.status].tone} title={STATUS[a.status].title}>
                              {STATUS[a.status].label}
                            </Chip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </SurfaceGate>
    </Card>
  );
}
