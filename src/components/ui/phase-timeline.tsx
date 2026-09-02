import type { DeploymentStep } from "@/lib/domain/types";
import { cx, fmtDuration } from "@/lib/format";
import { StatusDot, type DotStatus } from "./status-dot";

type Phase = DeploymentStep["phase"];

const PHASES: { key: Phase; label: string }[] = [
  { key: "prepare", label: "Prepare" },
  { key: "provision", label: "Provision" },
  { key: "release", label: "Release" },
  { key: "verify", label: "Verify" },
];

type PhaseState = "idle" | "running" | "done" | "failed" | "skipped";

const BAR: Record<PhaseState, string> = {
  idle: "bg-bg3",
  running: "bg-signal",
  done: "bg-ok",
  failed: "bg-err",
  skipped: "bg-bg3",
};

const STEP_DOT: Record<DeploymentStep["status"], DotStatus> = {
  pending: "idle",
  running: "running",
  done: "ok",
  failed: "err",
  skipped: "idle",
};

function phaseState(steps: DeploymentStep[]): PhaseState {
  if (steps.length === 0) return "idle";
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "running")) return "running";
  if (steps.every((s) => s.status === "done")) return "done";
  if (steps.every((s) => s.status === "skipped")) return "skipped";
  if (steps.every((s) => s.status === "pending")) return "idle";
  return "running";
}

/** Only finished steps get a duration — a live counter would desync SSR/CSR. */
function stepMs(s: DeploymentStep): number | undefined {
  if (!s.startedAt || !s.endedAt) return undefined;
  const ms = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

const at = (iso: string | undefined): number | undefined => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/**
 * Wall-clock from the first step starting to the last one ending — not the sum
 * of the steps, which would hide waiting. Only once nothing is still moving:
 * a running total would tick, and this component renders on the server too.
 */
export function totalMs(steps: DeploymentStep[]): number | undefined {
  if (steps.some((s) => s.status === "pending" || s.status === "running")) return undefined;
  const starts = steps.map((s) => at(s.startedAt)).filter((n): n is number => n !== undefined);
  const ends = steps.map((s) => at(s.endedAt)).filter((n): n is number => n !== undefined);
  if (starts.length === 0 || ends.length === 0) return undefined;
  const span = Math.max(...ends) - Math.min(...starts);
  return span >= 0 ? span : undefined;
}

export interface PhaseTimelineProps {
  steps: DeploymentStep[];
  /** hide per-step rows and render only the four segments */
  compact?: boolean;
  selectedStepId?: string;
  onSelectStep?: (step: DeploymentStep) => void;
  className?: string;
}

/**
 * Deployment progress: four connected phase segments over per-step rows.
 * The bar only fills for work that has actually finished — progress is never
 * faked ahead of the engine.
 */
export function PhaseTimeline({
  steps,
  compact = false,
  selectedStepId,
  onSelectStep,
  className,
}: PhaseTimelineProps) {
  const byPhase = PHASES.map((p) => ({
    ...p,
    steps: steps
      .filter((s) => s.phase === p.key)
      .sort((a, b) => a.seq - b.seq),
  }));

  const total = totalMs(steps);

  return (
    <div className={cx("space-y-5", className)}>
      <div className="space-y-1.5">
        {total !== undefined && (
          <p className="flex justify-end text-[11px] text-ink-faint">
            <span title="From the first step starting to the last one ending.">
              total <span className="tnum font-mono text-ink-mute">{fmtDuration(total)}</span>
            </span>
          </p>
        )}
        <div className="flex items-end gap-1.5">
        {byPhase.map((p) => {
          const state = phaseState(p.steps);
          const done = p.steps.filter((s) => s.status === "done").length;
          const pct =
            state === "done"
              ? 100
              : state === "failed"
                ? 100
                : p.steps.length
                  ? Math.round((done / p.steps.length) * 100)
                  : 0;
          return (
            <div key={p.key} className="min-w-0 flex-1">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span
                  className={cx(
                    "truncate text-[11px] font-medium tracking-[0.06em] uppercase",
                    state === "idle" || state === "skipped" ? "text-ink-faint" : "text-ink-mute"
                  )}
                >
                  {p.label}
                </span>
                {p.steps.length > 0 && (
                  <span className="tnum shrink-0 text-[11px] text-ink-faint">
                    {done}/{p.steps.length}
                  </span>
                )}
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-bg3"
                title={
                  state === "skipped"
                    ? `${p.label}: skipped after an earlier failure.`
                    : `${p.label}: ${state}`
                }
              >
                <div
                  className={cx(
                    "h-full rounded-full transition-[width] duration-[320ms] [transition-timing-function:var(--ease-swift)]",
                    BAR[state],
                    state === "running" && "status-pulse"
                  )}
                  style={{ width: `${state === "running" ? Math.max(pct, 12) : pct}%` }}
                />
              </div>
            </div>
          );
        })}
        </div>
      </div>

      {!compact && (
        <div className="space-y-4">
          {byPhase
            .filter((p) => p.steps.length > 0)
            .map((p) => (
              <div key={p.key} className="space-y-1">
                <div className="text-[11px] font-medium tracking-[0.06em] text-ink-faint uppercase">
                  {p.label}
                </div>
                <ul className="space-y-0.5">
                  {p.steps.map((s) => {
                    const ms = stepMs(s);
                    const selectable = Boolean(onSelectStep);
                    const Row = (selectable ? "button" : "div") as "button";
                    return (
                      <li key={s.id}>
                        <Row
                          {...(selectable
                            ? { type: "button" as const, onClick: () => onSelectStep?.(s) }
                            : {})}
                          className={cx(
                            "flex w-full items-center gap-2.5 rounded-ctl px-2 py-1.5 text-left",
                            "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
                            selectable && "hover:bg-bg2",
                            selectedStepId === s.id && "bg-bg2",
                            s.status === "skipped" && "opacity-55"
                          )}
                        >
                          <StatusDot status={STEP_DOT[s.status]} />
                          <span
                            className={cx(
                              "min-w-0 flex-1 truncate text-[13px]",
                              s.status === "failed" ? "text-err" : "text-ink"
                            )}
                          >
                            {s.title}
                          </span>
                          {s.status === "skipped" && (
                            <span className="text-[11.5px] text-ink-faint">skipped</span>
                          )}
                          {ms !== undefined && s.status !== "skipped" && (
                            <span className="tnum shrink-0 font-mono text-[11.5px] text-ink-faint">
                              {fmtDuration(ms)}
                            </span>
                          )}
                        </Row>
                        {s.error && (
                          <p className="mt-0.5 mb-1 ml-[26px] text-[12px] text-err">{s.error}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
