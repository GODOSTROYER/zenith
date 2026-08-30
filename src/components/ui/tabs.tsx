"use client";
import type { ReactNode } from "react";
import { cx } from "@/lib/format";

export interface TabItem {
  value: string;
  label: ReactNode;
  /** trailing count or dot */
  badge?: ReactNode;
  disabled?: boolean;
  /** why it's disabled — shown as a tooltip */
  disabledReason?: string;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  /** right-aligned controls on the tab rule */
  actions?: ReactNode;
}

/** Underline tabs. Arrow keys move between tabs; the rule spans the row. */
export function Tabs({ items, value, onChange, className, actions }: TabsProps) {
  const move = (dir: 1 | -1) => {
    const usable = items.filter((i) => !i.disabled);
    const at = usable.findIndex((i) => i.value === value);
    const next = usable[(at + dir + usable.length) % usable.length];
    if (next) onChange(next.value);
  };

  return (
    <div className={cx("flex items-end justify-between gap-4 border-b border-line", className)}>
      <div role="tablist" className="flex items-end gap-1">
        {items.map((item) => {
          const active = item.value === value;
          return (
            <button
              key={item.value}
              role="tab"
              type="button"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              disabled={item.disabled}
              title={item.disabled ? (item.disabledReason ?? "Not available yet.") : undefined}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  e.preventDefault();
                  move(1);
                } else if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  move(-1);
                }
              }}
              onClick={() => !item.disabled && onChange(item.value)}
              className={cx(
                "relative -mb-px flex h-9 items-center gap-2 px-3 text-[13px] font-medium",
                "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
                item.disabled
                  ? "cursor-not-allowed text-ink-faint"
                  : active
                    ? "text-ink"
                    : "text-ink-mute hover:text-ink"
              )}
            >
              {item.label}
              {item.badge != null && (
                <span className="tnum text-[11.5px] text-ink-faint">{item.badge}</span>
              )}
              <span
                aria-hidden="true"
                className={cx(
                  "absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-opacity duration-[120ms]",
                  active ? "bg-signal opacity-100" : "opacity-0"
                )}
              />
            </button>
          );
        })}
      </div>
      {actions && <div className="flex items-center gap-2 pb-1.5">{actions}</div>}
    </div>
  );
}
