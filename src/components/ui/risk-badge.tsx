import { cx } from "@/lib/format";

export type RiskLevel = "low" | "medium" | "high";

const STYLES: Record<RiskLevel, string> = {
  low: "bg-bg2 text-ink-mute border-line",
  medium: "bg-warn-dim text-warn border-warn/25",
  high: "bg-err-dim text-err border-err/30",
};

const EXPLAIN: Record<RiskLevel, string> = {
  low: "Low risk — additive or easily reversed.",
  medium: "Medium risk — changes or removes running infrastructure.",
  high: "High risk — destroys stateful resources; rollback alone will not restore the data.",
};

export interface RiskBadgeProps {
  level: RiskLevel;
  className?: string;
}

/** Risk label for changesets, actions and Navigator steps. Self-explaining on hover. */
export function RiskBadge({ level, className }: RiskBadgeProps) {
  return (
    <span
      title={EXPLAIN[level]}
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-0.5",
        "text-[11px] font-medium tracking-[0.03em] uppercase",
        STYLES[level],
        className
      )}
    >
      {level}
    </span>
  );
}
