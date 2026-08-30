"use client";
import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/lib/format";
import { useFieldProps } from "./field";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  /** leading adornment (icon or unit) */
  prefix?: ReactNode;
  /** trailing adornment (unit, key hint) */
  suffix?: ReactNode;
  mono?: boolean;
}

/** 32px text input. Inside a `<Field>` it picks up the label and error wiring. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { prefix, suffix, mono = false, className, id, ...rest },
  ref
) {
  const f = useFieldProps(id);
  return (
    <div
      className={cx(
        "flex h-8 items-center gap-2 rounded-ctl border bg-bg1 px-2.5",
        "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
        f.invalid ? "border-err" : "border-line hover:border-line-strong",
        rest.disabled && "opacity-55",
        "focus-within:border-signal",
        className
      )}
    >
      {prefix && <span className="shrink-0 text-ink-faint">{prefix}</span>}
      <input
        {...rest}
        ref={ref}
        id={f.id}
        aria-describedby={f["aria-describedby"]}
        aria-invalid={f["aria-invalid"]}
        className={cx(
          "min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none",
          "placeholder:text-ink-faint disabled:cursor-not-allowed",
          mono && "font-mono text-[12.5px]"
        )}
      />
      {suffix && <span className="shrink-0 text-[12px] text-ink-faint">{suffix}</span>}
    </div>
  );
});
