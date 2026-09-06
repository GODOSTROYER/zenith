"use client";
import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cx } from "@/lib/format";
import { useFieldProps } from "./field";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  /** shown as a disabled first entry when the value is empty */
  placeholder?: string;
}

/** Native select — keyboard and screen-reader behaviour for free. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, className, id, ...rest },
  ref
) {
  const f = useFieldProps(id);
  return (
    <div className={cx("relative min-w-0", className)}>
      <select
        {...rest}
        ref={ref}
        id={f.id}
        aria-describedby={f["aria-describedby"]}
        aria-invalid={f["aria-invalid"]}
        className={cx(
          "ui-select h-9 w-full appearance-none rounded-ctl border bg-bg1 pr-8 pl-3 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2",
          "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
          f.invalid ? "border-err" : "border-line hover:border-line-strong focus:border-signal",
          rest.disabled && "cursor-not-allowed opacity-55"
        )}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
      />
    </div>
  );
});
