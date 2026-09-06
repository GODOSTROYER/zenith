"use client";
import { cloneElement, isValidElement, useId, type ReactNode } from "react";
import { cx } from "@/lib/format";

export interface TooltipProps {
  /** tooltip content — keep it to a short sentence */
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  children: ReactNode;
}

const SIDES: Record<NonNullable<TooltipProps["side"]>, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

/**
 * CSS-only tooltip (hover + keyboard focus, no JS, no dependency).
 *
 * The label is bound to the trigger with `aria-describedby`, so a screen
 * reader announces it with the control instead of leaving a `role="tooltip"`
 * floating in the tree with nothing pointing at it. When the child is a single
 * element the attribute goes on that element; otherwise it falls back to the
 * wrapper, which is still in the accessibility tree ahead of the label.
 */
export function Tooltip({ label, side = "top", className, children }: TooltipProps) {
  const id = useId();
  const single = isValidElement<{ "aria-describedby"?: string }>(children);
  const trigger = single
    ? cloneElement(children, {
        "aria-describedby":
          [children.props["aria-describedby"], id].filter(Boolean).join(" ") || undefined,
      })
    : children;

  return (
    <span
      className={cx("group/tip relative inline-flex", className)}
      aria-describedby={single ? undefined : id}
    >
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={cx(
          "pointer-events-none absolute z-50 w-max max-w-[260px] rounded-ctl border border-line bg-bg3 px-2.5 py-1.5",
          "text-[12px] leading-snug text-ink shadow-overlay",
          "opacity-0 transition-opacity duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)]",
          "group-hover/tip:opacity-100 group-focus-within/tip:opacity-100",
          SIDES[side]
        )}
      >
        {label}
      </span>
    </span>
  );
}
