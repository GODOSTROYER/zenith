"use client";
import { useId, type ReactNode } from "react";
import { cx } from "@/lib/format";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** visible label — the accessible name comes from it */
  label: ReactNode;
  /** second line under the label */
  help?: ReactNode;
  disabled?: boolean;
  /** required when disabled — explains why, as a tooltip */
  disabledReason?: string;
  id?: string;
  className?: string;
}

/**
 * A real `<input type="checkbox">` with `accent-color` from the token, so the
 * browser keeps the focus ring, the indeterminate/checked semantics and every
 * assistive-tech behaviour a hand-drawn box would have to re-implement.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  help,
  disabled = false,
  disabledReason,
  id,
  className,
}: CheckboxProps) {
  const auto = useId();
  const ctl = id ?? auto;
  const helpId = `${ctl}-help`;
  return (
    <span
      className={cx("inline-flex items-start gap-2", disabled && "opacity-55", className)}
      title={disabled ? disabledReason : undefined}
    >
      <input
        id={ctl}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={help ? helpId : undefined}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer rounded-[4px] border border-line bg-bg1 accent-signal disabled:cursor-not-allowed"
      />
      <span className="min-w-0">
        <label
          htmlFor={ctl}
          className={cx("block text-[13px] text-ink", !disabled && "cursor-pointer")}
        >
          {label}
        </label>
        {help && (
          <span id={helpId} className="mt-0.5 block text-[12px] text-ink-faint">
            {help}
          </span>
        )}
      </span>
    </span>
  );
}
