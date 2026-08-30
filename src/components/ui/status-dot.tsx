import { cx } from "@/lib/format";

export type DotStatus = "ok" | "warn" | "err" | "info" | "idle" | "running";

const COLORS: Record<DotStatus, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  info: "bg-info",
  idle: "bg-ink-faint",
  running: "bg-signal",
};

const LABELS: Record<DotStatus, string> = {
  ok: "Healthy",
  warn: "Needs attention",
  err: "Failing",
  info: "Information",
  idle: "Idle",
  running: "In progress",
};

export interface StatusDotProps {
  status: DotStatus;
  /** force the pulse on/off; `running` pulses by default */
  pulse?: boolean;
  /** accessible label — defaults to a plain-language status name */
  label?: string;
  size?: number;
  className?: string;
}

/** 8px status dot. Pulses only while something is genuinely in progress. */
export function StatusDot({
  status,
  pulse,
  label,
  size = 8,
  className,
}: StatusDotProps) {
  const alive = pulse ?? status === "running";
  const text = label ?? LABELS[status];
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      className={cx("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <span
        className={cx("absolute inset-0 rounded-full", COLORS[status], alive && "status-pulse")}
      />
      {alive && (
        <span
          aria-hidden="true"
          className={cx("absolute rounded-full opacity-25", COLORS[status], "status-pulse")}
          style={{ inset: -size * 0.5 }}
        />
      )}
    </span>
  );
}
