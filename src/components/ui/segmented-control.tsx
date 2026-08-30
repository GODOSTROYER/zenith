"use client";
import type { ReactNode } from "react";
import { cx } from "@/lib/format";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  /** why it's disabled — becomes the tooltip */
  disabledReason?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  /** accessible name for the group */
  label?: string;
  className?: string;
}

/** Compact exclusive choice — view modes, stream filters, ranges. */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  label,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        "inline-flex items-center gap-0.5 rounded-ctl border border-line bg-bg1 p-0.5",
        className
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            title={o.disabled ? (o.disabledReason ?? "Not available here.") : o.title}
            onClick={() => !o.disabled && onChange(o.value)}
            className={cx(
              "rounded-[6px] font-medium whitespace-nowrap",
              "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
              size === "sm" ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[12.5px]",
              o.disabled
                ? "cursor-not-allowed text-ink-faint"
                : active
                  ? "bg-bg3 text-ink shadow-card"
                  : "text-ink-mute hover:text-ink"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
