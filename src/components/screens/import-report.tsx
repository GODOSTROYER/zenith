"use client";
/**
 * The one import report. Onboarding and the map's import dialog show the same
 * three lists, because the same import has to explain itself the same way in
 * both places: what was mapped (and how confidently), what was not (and why,
 * and what to do instead), and anything the importer wants to warn about.
 *
 * Import honesty rule (see lib/importers/types.ts): every input element ends
 * up in `mapped` or `unmapped`. Nothing is silently dropped, so this component
 * never truncates either list.
 */
import { CircleDashed } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import type { ImportReport } from "@/lib/importers/types";

export function ImportReportView({ report }: { report: ImportReport }) {
  const nothing = report.mapped.length === 0 && report.unmapped.length === 0;
  return (
    <div className="space-y-6">
      {report.mapped.length > 0 && (
        <Card
          title={`${report.mapped.length} element${report.mapped.length === 1 ? "" : "s"} mapped`}
          subtitle="Exact means a faithful translation. Assumed means Zenith.ai had to guess — check those."
          padded={false}
        >
          <ul>
            {report.mapped.map((m) => (
              <li
                key={m.source}
                className="flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0"
              >
                <Chip tone={m.confidence === "exact" ? "ok" : "warn"} className="mt-0.5">
                  {m.confidence}
                </Chip>
                <div className="min-w-0">
                  <p className="font-mono text-[12.5px] text-ink">
                    {m.source} <span className="text-ink-faint">→</span> {m.result}
                  </p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">{m.note}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {report.unmapped.length > 0 && (
        <Card
          title={`${report.unmapped.length} not imported`}
          subtitle="Each one says why, and what to do instead."
          padded={false}
        >
          <ul>
            {report.unmapped.map((u) => (
              <li
                key={u.source}
                className="flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0"
              >
                <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <div className="min-w-0">
                  <p className="font-mono text-[12.5px] text-ink">{u.source}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">{u.reason}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-signal">{u.suggestion}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {report.warnings.length > 0 && (
        <ul className="space-y-1.5 rounded-card border border-warn/30 bg-warn-dim px-4 py-3 text-[13px] text-ink">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {nothing && (
        <EmptyState
          title="Nothing to report"
          body="The importer produced no mapping detail for this file."
        />
      )}
    </div>
  );
}
