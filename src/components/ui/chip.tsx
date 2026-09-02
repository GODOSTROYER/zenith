import type { ReactNode } from "react";
import { cx } from "@/lib/format";

export type ChipTone =
  | "neutral"
  | "ok"
  | "warn"
  | "err"
  | "info"
  | "signal"
  | "nav"
  | "prod";

const TONES: Record<ChipTone, string> = {
  neutral: "bg-bg2 text-ink-mute border-line",
  ok: "bg-ok-dim text-ok border-ok/25",
  warn: "bg-warn-dim text-warn border-warn/25",
  err: "bg-err-dim text-err border-err/25",
  info: "bg-info-dim text-info border-info/25",
  signal: "bg-signal-dim text-signal border-signal/25",
  nav: "bg-nav-dim text-nav-accent border-nav-accent/25",
  prod: "bg-warn-dim text-prod border-prod/35",
};

export interface ChipProps {
  tone?: ChipTone;
  icon?: ReactNode;
  title?: string;
  /** set by `<Tooltip>` when a chip is its trigger; harmless otherwise */
  "aria-describedby"?: string;
  className?: string;
  children: ReactNode;
}

/** Small labelled pill: environment class, provider availability, counts. */
export function Chip({
  tone = "neutral",
  icon,
  title,
  className,
  children,
  "aria-describedby": describedBy,
}: ChipProps) {
  return (
    <span
      title={title}
      aria-describedby={describedBy}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
        "text-[11.5px] leading-5 font-medium tracking-[0.01em] whitespace-nowrap",
        TONES[tone],
        className
      )}
    >
      {icon}
      {children}
    </span>
  );
}
