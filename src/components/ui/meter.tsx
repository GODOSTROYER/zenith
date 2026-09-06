import { cx } from "@/lib/format";

export type MeterTone = "signal" | "ok" | "warn" | "err" | "info";

const FILL: Record<MeterTone, string> = {
  signal: "bg-signal",
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  info: "bg-info",
};

export interface MeterProps {
  value: number;
  max?: number;
  /** overrides the automatic tone (≥90% err, ≥75% warn) */
  tone?: MeterTone;
  label?: string;
  /** right-aligned value text, e.g. "$62.00 of $100.00" */
  hint?: string;
  className?: string;
}

/** Thin progress/utilisation bar. Auto-tints as it approaches the limit. */
export function Meter({ value, max = 100, tone, label, hint, className }: MeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const auto: MeterTone = ratio >= 0.9 ? "err" : ratio >= 0.75 ? "warn" : "signal";
  const pct = Math.round(ratio * 100);
  return (
    <div className={cx("w-full", className)}>
      {(label || hint) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[12px]">
          {label && <span className="text-ink-mute">{label}</span>}
          {hint && <span className="tnum text-ink-faint">{hint}</span>}
        </div>
      )}
      <div
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
        title={`${pct}%`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg3"
      >
        <div
          className={cx(
            "h-full rounded-full transition-[width] duration-[var(--dur-base)] [transition-timing-function:var(--ease-swift)]",
            FILL[tone ?? auto]
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
