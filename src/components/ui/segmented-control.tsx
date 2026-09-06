"use client";
import { useRef, type ReactNode } from "react";
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

/**
 * Compact exclusive choice — view modes, stream filters, ranges.
 *
 * A radio group is one tab stop: Tab reaches the checked option, arrow keys
 * move between them (and select, as radios do). Same roving-focus contract as
 * Tabs.
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  label,
  className,
}: SegmentedControlProps<T>) {
  const group = useRef<HTMLDivElement>(null);

  const move = (dir: 1 | -1) => {
    const usable = options.filter((o) => !o.disabled);
    if (usable.length === 0) return;
    const at = usable.findIndex((o) => o.value === value);
    const next = usable[(at + dir + usable.length) % usable.length];
    if (!next) return;
    onChange(next.value);
    // Focus follows selection, or the arrow key would leave focus on a button
    // that is no longer the group's tab stop.
    group.current
      ?.querySelector<HTMLElement>(`[data-seg="${CSS.escape(next.value)}"]`)
      ?.focus();
  };

  // Nothing checked (a value outside the options) would leave the group
  // unreachable by Tab, so the first usable option holds the tab stop.
  const checked = options.some((o) => o.value === value && !o.disabled);
  const tabStop = checked ? value : options.find((o) => !o.disabled)?.value;

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      className={cx(
        "ui-segments inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-ctl border border-line bg-bg1 p-0.5",
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
            data-seg={o.value}
            aria-checked={active}
            tabIndex={o.value === tabStop ? 0 : -1}
            disabled={o.disabled}
            title={o.disabled ? (o.disabledReason ?? "Not available here.") : o.title}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
              }
            }}
            onClick={() => !o.disabled && onChange(o.value)}
            className={cx(
              "rounded-ctl font-medium whitespace-nowrap",
              "transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)]",
              size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[12.5px]",
              o.disabled
                ? "cursor-not-allowed text-ink-faint"
                : active
                  ? "bg-bg3 text-ink ring-1 ring-line-strong"
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
