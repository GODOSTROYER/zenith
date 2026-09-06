"use client";
import { useRef, type ReactNode } from "react";
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
  const group = useRef<HTMLDivElement>(null);
  const tabStop = items.some((item) => item.value === value && !item.disabled)
    ? value : items.find((item) => !item.disabled)?.value;
  const move = (key: string, from: string) => {
    const usable = items.filter((i) => !i.disabled);
    if (!usable.length) return;
    const at = usable.findIndex((i) => i.value === from);
    const next = usable[key === "Home" ? 0 : key === "End" ? usable.length - 1 :
      (at + (key === "ArrowRight" ? 1 : -1) + usable.length) % usable.length];
    onChange(next.value);
    const target = Array.from(group.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
      .find((button) => button.dataset.value === next.value);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  return (
    <div className={cx("flex min-w-0 flex-wrap items-end justify-between gap-x-4 border-b border-line", className)}>
      <div ref={group} role="tablist" className="flex min-w-0 max-w-full items-end gap-1 overflow-x-auto overflow-y-hidden">
        {items.map((item) => {
          const active = item.value === value;
          return (
            <button
              key={item.value}
              role="tab"
              type="button"
              aria-selected={active}
              data-value={item.value}
              tabIndex={item.value === tabStop ? 0 : -1}
              disabled={item.disabled}
              title={item.disabled ? (item.disabledReason ?? "Not available yet.") : undefined}
              onKeyDown={(e) => {
                if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) {
                  e.preventDefault();
                  move(e.key, item.value);
                }
              }}
              onClick={() => !item.disabled && onChange(item.value)}
              className={cx(
                "relative flex h-9 shrink-0 items-center gap-2 whitespace-nowrap px-3 text-[13px] font-medium focus-visible:-outline-offset-2",
                "transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)]",
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
                  "absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-opacity duration-[var(--dur-fast)]",
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
