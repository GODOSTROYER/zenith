"use client";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeAgo } from "@/components/ui/time-ago";
import { cx } from "@/lib/format";
import type { NavigatorRun } from "@/lib/domain/types";
import { isExecutable } from "@/lib/navigator/shared";
import { NavigatorGlyph } from "./glyph";
import { gimbalPresentationFor, gimbalStateForRun } from "./gimbal-state";
import { ProviderChecks } from "./provider-checks";

export interface RunHistoryProps {
  runs?: NavigatorRun[];
  loading: boolean;
  /** the run shown in the panel above — hidden from the list */
  activeRunId?: string;
}

/** Everything the Navigator has been asked to do on this project. */
export function RunHistory({ runs, loading, activeRunId }: RunHistoryProps) {
  const past = (runs ?? []).filter((r) => r.id !== activeRunId);

  if (loading && !runs)
    return (
      <div className="space-y-2">
        <Skeleton height={44} />
        <Skeleton height={44} />
      </div>
    );

  if (past.length === 0)
    return (
      <EmptyState
        icon={<NavigatorGlyph size={18} className="text-nav-accent" />}
        title="No earlier runs"
        body="Every goal you give the Navigator is kept here with its steps, its results and its errors."
      />
    );

  return (
    <ul className="divide-y divide-line">
      {past.map((run) => (
        <HistoryRow key={run.id} run={run} />
      ))}
    </ul>
  );
}

function HistoryRow({ run }: { run: NavigatorRun }) {
  const [open, setOpen] = useState(false);
  const ran = run.steps.filter((s) => s.status === "done").length;
  const presentation = gimbalPresentationFor({ run });

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors duration-[120ms] hover:bg-bg1"
      >
        <NavigatorGlyph
          size={20}
          state={gimbalStateForRun(run)}
          className="text-nav-accent"
        />
        <ChevronRight
          className={cx(
            "h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-[200ms] [transition-timing-function:var(--ease-swift)]",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{run.goal}</span>
        <span className="tnum hidden text-[12px] text-ink-faint sm:inline">
          {ran}/{run.steps.length} done
        </span>
        <Chip tone={presentation.state === "applying" ? "info" : presentation.tone === "warm" ? "warn" : presentation.tone}>{presentation.label}</Chip>
        <TimeAgo iso={run.createdAt} className="text-[12px] text-ink-faint" />
      </button>

      {open && (
        <div className="animate-enter space-y-2 pb-3 pl-7">
          {run.summary && (
            <p className="max-w-[80ch] text-[12.5px] leading-relaxed text-ink-mute">{run.summary}</p>
          )}
          <ol className="space-y-1.5">
            {run.steps.map((s) => (
              <li key={s.id} className="flex gap-2 text-[12.5px]">
                <span className="tnum w-4 shrink-0 text-right font-mono text-ink-faint">{s.seq}</span>
                <span className="min-w-0">
                  <span className="text-ink">{s.title}</span>{" "}
                  <span className="font-mono text-[11.5px] text-ink-faint">
                    {isExecutable(s.actionId) ? s.actionId : "not executable"}
                  </span>
                  <span
                    className={cx(
                      "ml-1.5 text-[11.5px]",
                      s.status === "done"
                        ? "text-ok"
                        : s.status === "failed"
                          ? "text-err"
                          : "text-ink-faint"
                    )}
                  >
                    {s.status}
                  </span>
                  {(s.error || s.resultSummary) && (
                    <span
                      className={cx(
                        "mt-0.5 block max-w-[80ch] leading-relaxed",
                        s.error ? "text-err" : "text-ink-mute"
                      )}
                    >
                      {s.error ?? s.resultSummary}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
          <ProviderChecks run={run} />
        </div>
      )}
    </li>
  );
}
