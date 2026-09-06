"use client";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/lib/format";

export type ButtonVariant = "primary" | "quiet" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** swaps the label for a spinner without changing the button's width */
  busy?: boolean;
  /** required by product law when `disabled`: says why, shown as a tooltip */
  disabledReason?: string;
  icon?: ReactNode;
  /** stretch to the container width */
  block?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-signal text-on-signal hover:bg-signal-strong border border-transparent",
  quiet:
    "bg-bg2 text-ink border border-line hover:bg-bg3 hover:border-line-strong",
  ghost:
    "bg-transparent text-ink-mute border border-transparent hover:bg-bg2 hover:text-ink",
  danger: "bg-err text-on-danger border border-transparent hover:brightness-110",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-[12.5px]",
  md: "h-9 px-3.5 text-[13px]",
};

const GAPS: Record<ButtonSize, string> = { sm: "gap-1.5", md: "gap-2" };

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The one button. Disabled buttons always explain themselves via `disabledReason`. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "quiet",
    size = "md",
    busy = false,
    disabled = false,
    disabledReason,
    icon,
    block = false,
    className,
    children,
    title,
    type = "button",
    ...rest
  },
  ref
) {
  const isDisabled = disabled || busy;
  const tip = busy
    ? (title ?? "Working…")
    : disabled
      ? (disabledReason ??
        title ??
        "Unavailable right now — nothing here to act on yet.")
      : title;

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-disabled={isDisabled || undefined}
      aria-busy={busy || undefined}
      title={tip}
      className={cx(
        "ui-button relative inline-flex items-center justify-center rounded-ctl font-medium whitespace-nowrap",
        "transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)]",
        "disabled:opacity-55 disabled:cursor-not-allowed",
        SIZES[size],
        VARIANTS[variant],
        block && "w-full",
        className
      )}
    >
      <span className={cx("inline-flex items-center", GAPS[size], busy && "opacity-0")}>
        {icon}
        {children}
      </span>
      {busy && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      )}
    </button>
  );
});
