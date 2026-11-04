/**
 * The operator-facing progress panel for ANY projected journey (platform operation,
 * legacy deployment, runbook run). It renders a `JourneyView` and nothing else, so the
 * three record shapes cannot drift apart on screen.
 *
 * Accessibility:
 *  - a labelled region with its own heading;
 *  - one polite live region carries the stage sentence, so a change is announced once;
 *    uncertain and failed outcomes use a notice of their own (warn = status, err = alert);
 *  - every step prints its state as text beside the glyph: colour is never the only carrier;
 *  - steps are an ordered list; the running step is marked `aria-current="step"`.
 */
import { useId, type ReactNode } from "react";
import { cx } from "@/lib/format";
import { Callout } from "@/components/ui/callout";
import { Chip, type ChipTone } from "@/components/ui/chip";
import type { JourneyStepState, JourneyView } from "@/lib/platform/operator-journey";

const STEP_WORD: Record<JourneyStepState, string> = {
  pending: "Not started",
  running: "In progress",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  uncertain: "Outcome unknown",
};
const STEP_MARK: Record<JourneyStepState, string> = { pending: "○", running: "◔", done: "✓", failed: "✕", skipped: "–", uncertain: "?" };
const STEP_INK: Record<JourneyStepState, string> = { pending: "text-ink-faint", running: "text-signal", done: "text-ok", failed: "text-err", skipped: "text-ink-faint", uncertain: "text-warn" };
const TONE: Record<JourneyView["tone"], ChipTone> = { neutral: "neutral", info: "info", warn: "warn", ok: "ok", err: "err" };

export interface JourneyPanelProps {
  view: JourneyView;
  /** extra controls (cancel, refresh) rendered under the steps */
  actions?: ReactNode;
  /** shown above everything, e.g. the replan notice */
  notice?: ReactNode;
  /** true while a poll is in flight */
  refreshing?: boolean;
  /** time of the last successful read, as an ISO string */
  updatedAt?: string;
  /** a read failed: the screen keeps the last known state and says so */
  stale?: boolean;
  heading?: string;
}

export function JourneyPanel({ view, actions, notice, refreshing, updatedAt, stale, heading = "Progress" }: JourneyPanelProps) {
  const id = useId();
  const headingId = `${id}-h`;
  return (
    <section aria-labelledby={headingId} aria-busy={refreshing ? "true" : undefined} className="space-y-4 rounded-card border border-line bg-bg1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-[15px] font-medium text-ink">{heading}</h2>
        <Chip tone={TONE[view.tone]}>{view.label}</Chip>
      </div>
      {notice}
      {/* Announced on change only: the text is the stage and its sentence. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="text-[13px] text-ink" data-testid="journey-live">
        {view.label}. {view.sentence}
      </p>
      {stale && (
        <Callout tone="warn" compact title="Live updates paused">
          Zenith could not refresh this screen. What is shown was current at the last successful read. Use Refresh to try again.
        </Callout>
      )}
      {view.stage === "uncertain" && (
        <Callout tone="warn" title="Outcome uncertain: do not assume it failed or succeeded">
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            {view.nextSteps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </Callout>
      )}
      {view.stage === "failed" && (
        <Callout tone="err" title="What to do next">
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            {view.nextSteps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </Callout>
      )}
      {view.stage !== "uncertain" && view.stage !== "failed" && view.nextSteps.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-ink-mute">
          {view.nextSteps.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}
      {view.steps.length > 0 && (
        <ol aria-label="Steps" className="divide-y divide-line rounded-ctl border border-line">
          {view.steps.map((s) => (
            <li key={s.id} aria-current={s.state === "running" ? "step" : undefined} className="flex items-baseline gap-3 px-3 py-2 text-[13px]">
              <span aria-hidden="true" className={cx("w-4 text-center font-mono", STEP_INK[s.state])}>{STEP_MARK[s.state]}</span>
              <span className="min-w-0 flex-1 break-words text-ink">{s.title}{s.detail ? <span className="text-ink-mute"> ({s.detail})</span> : null}</span>
              <span className="shrink-0 text-[12px] text-ink-mute">{STEP_WORD[s.state]}</span>
            </li>
          ))}
        </ol>
      )}
      {updatedAt && <p className="text-[12px] text-ink-faint">Last read <time dateTime={updatedAt}>{updatedAt}</time>.{view.terminal ? "" : " Updating automatically while this page is open."}</p>}
      {actions}
    </section>
  );
}
