"use client";
/**
 * Drift findings by class, with severity and what Zenith would and would not do
 * about each one.
 *
 * Honesty rules (spec §39): "unknown" and "inaccessible" are drift results, not
 * silence. Resources the check could not determine are listed under their own
 * heading and a clean report never says "no drift" while any are listed. A
 * report from a simulation says so. Repairability is explained from the finding's
 * own `repairable` and `autoRepairEligible` flags, never assumed.
 */
import type { ReactNode } from "react";
import { GitCompareArrows } from "lucide-react";
import type { DriftClass, DriftFinding, DriftReport } from "@/lib/resources/types";
import { cx } from "@/lib/format";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { TimeAgo } from "@/components/ui/time-ago";
import { SimulatedChip } from "@/components/screens/badges";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import { DRIFT_CLASS_LABEL, DRIFT_CLASS_SENTENCE } from "./labels";
import { displayAttributeValue } from "./resource-state-model";
import { plural, shortDigest } from "./text";

export interface DriftListProps extends AsyncSurfaceProps {
  report?: DriftReport;
  selectedAddress?: string;
  /** makes each finding's address a button; omit for a read-only list */
  onSelect?: (address: string) => void;
  /** a slot for the host's own actions on a finding (for example "Propose a repair") */
  renderActions?: (finding: DriftFinding) => ReactNode;
  /** shown in the empty state when no report exists yet (for example a "Check now" button) */
  checkAction?: ReactNode;
  title?: string;
}

/** Most worrying first. */
const CLASS_ORDER: readonly DriftClass[] = ["missing", "changed", "extra", "inaccessible", "unknown"];

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const SEVERITY_TONE: Record<DriftFinding["severity"], ChipTone> = { high: "err", medium: "warn", low: "info" };
const SEVERITY_LABEL: Record<DriftFinding["severity"], string> = {
  high: "High severity",
  medium: "Medium severity",
  low: "Low severity",
};

/** What Zenith would do about a finding, in one sentence, from the finding's own flags. */
export function repairSentence(f: Pick<DriftFinding, "repairable" | "autoRepairEligible">): string {
  if (!f.repairable) {
    return "Zenith will not repair this. Only resources it manages, and whose state it could read, are repair candidates.";
  }
  return f.autoRepairEligible
    ? "Repairable. Eligible for automatic repair where the environment's autonomy level and policy allow it."
    : "Repairable with approval. High-risk drift (data stores, identity, firewalls open to the internet) is never repaired automatically.";
}

export function groupFindings(findings: readonly DriftFinding[]): { class: DriftClass; findings: DriftFinding[] }[] {
  return CLASS_ORDER.map((c) => ({
    class: c,
    findings: findings
      .filter((f) => f.class === c)
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)),
  })).filter((g) => g.findings.length > 0);
}

function FieldDiff({ finding }: { finding: DriftFinding }) {
  const fields = finding.fields ?? [];
  if (fields.length === 0) return null;
  const show = (attribute: string, v: unknown) =>
    v === undefined ? { text: "Not reported", masked: true } : displayAttributeValue(attribute, v);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Attributes that differ for {finding.address}</caption>
        <thead>
          <tr className="text-[12px] text-ink-mute">
            <th scope="col" className="py-1 pr-4 font-medium">
              Attribute
            </th>
            <th scope="col" className="py-1 pr-4 font-medium">
              Desired
            </th>
            <th scope="col" className="py-1 font-medium">
              Observed
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => {
            const d = show(f.attribute, f.desired);
            const o = show(f.attribute, f.observed);
            return (
              <tr key={f.attribute} className="border-t border-line align-top">
                <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                  <span className="break-all font-mono text-[12.5px] text-ink">{f.attribute}</span>
                </th>
                <td className="py-1.5 pr-4">
                  <span className={cx("break-words text-[12.5px]", d.masked ? "text-ink-faint italic" : "font-mono text-ink")}>{d.text}</span>
                </td>
                <td className="py-1.5">
                  <span className={cx("break-words text-[12.5px]", o.masked ? "text-ink-faint italic" : "font-mono text-ink")}>{o.text}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DriftList({
  report,
  selectedAddress,
  onSelect,
  renderActions,
  checkAction,
  title = "Drift",
  loading,
  error,
  onRetry,
}: DriftListProps) {
  const groups = report ? groupFindings(report.findings) : [];
  const clean = report ? report.findings.length === 0 && report.unobserved.length === 0 : false;

  return (
    <Card
      title={title}
      subtitle="Where the real infrastructure differs from the desired configuration."
      actions={report?.simulated ? <SimulatedChip title="This report was generated by a simulation; no real infrastructure was inspected." /> : undefined}
      footer={
        report ? (
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              Checked <TimeAgo iso={report.computedAt} />
            </span>
            <span>
              Configuration <code className="font-mono" title={report.graphDigest}>{shortDigest(report.graphDigest)}</code>
            </span>
          </span>
        ) : undefined
      }
    >
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="the drift report" rows={4}>
        {!report ? (
          <EmptyState
            icon={<GitCompareArrows className="h-5 w-5" aria-hidden="true" />}
            title="Drift has not been checked yet"
            body="A drift check compares the desired configuration with what the provider reports. Until one runs, Zenith cannot say whether anything differs."
            action={checkAction}
          />
        ) : (
          <div className="space-y-6">
            {clean && (
              <Callout tone={report.simulated ? "info" : "ok"} title="No drift found">
                {report.simulated
                  ? "Nothing differs in the simulation. That is a statement about the simulation, not about real infrastructure."
                  : "Everything Zenith could read matches the desired configuration."}
              </Callout>
            )}
            {!clean && report.findings.length === 0 && (
              <Callout tone="warn" title="No differences in what Zenith could read">
                {plural(report.unobserved.length, "resource")} could not be checked, so this is not a clean result.
              </Callout>
            )}

            {groups.map((g) => (
              <section key={g.class} aria-label={DRIFT_CLASS_LABEL[g.class]} data-drift-class={g.class} className="space-y-2">
                <h4 className="text-[13px] font-medium text-ink">
                  {DRIFT_CLASS_LABEL[g.class]} <span className="font-normal text-ink-faint">· {g.findings.length}</span>
                </h4>
                <p className="text-[12.5px] text-ink-mute">{DRIFT_CLASS_SENTENCE[g.class]}</p>
                <ul className="divide-y divide-line rounded-card border border-line">
                  {g.findings.map((f) => {
                    const selected = selectedAddress === f.address;
                    return (
                      <li key={`${f.class}-${f.address}`} className={cx("space-y-2 px-4 py-3", selected && "bg-signal-dim")}>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          {onSelect ? (
                            <button
                              type="button"
                              onClick={() => onSelect(f.address)}
                              aria-pressed={selected}
                              className="break-all text-left font-mono text-[13px] text-ink underline decoration-line-strong underline-offset-4 hover:text-signal"
                            >
                              {f.address}
                            </button>
                          ) : (
                            <span className="break-all font-mono text-[13px] text-ink">{f.address}</span>
                          )}
                          <Chip tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Chip>
                          <Chip title={repairSentence(f)}>
                            {f.repairable ? (f.autoRepairEligible ? "Auto-repair eligible" : "Repair needs approval") : "Not repairable"}
                          </Chip>
                        </div>
                        <p className="text-[13px] text-ink">{f.explanation}</p>
                        <FieldDiff finding={f} />
                        <p className="text-[12.5px] text-ink-mute">{repairSentence(f)}</p>
                        {renderActions && <div className="flex flex-wrap gap-2">{renderActions(f)}</div>}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            {report.unobserved.length > 0 && (
              <section aria-label="Could not be checked" className="space-y-2">
                <h4 className="text-[13px] font-medium text-ink">
                  Could not be checked <span className="font-normal text-ink-faint">· {report.unobserved.length}</span>
                </h4>
                <p className="text-[12.5px] text-ink-mute">
                  Zenith could not determine the state of these resources, so they are not reported as matching.
                </p>
                <ul className="divide-y divide-line rounded-card border border-line">
                  {report.unobserved.map((a) => (
                    <li key={a} className="px-4 py-2.5">
                      {onSelect ? (
                        <button
                          type="button"
                          onClick={() => onSelect(a)}
                          className="break-all text-left font-mono text-[13px] text-ink underline decoration-line-strong underline-offset-4 hover:text-signal"
                        >
                          {a}
                        </button>
                      ) : (
                        <span className="break-all font-mono text-[13px] text-ink">{a}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </SurfaceGate>
    </Card>
  );
}
