"use client";
import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cx } from "@/lib/format";
import { useFieldProps } from "./field";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** code, manifests, compose files */
  mono?: boolean;
}

/** Multi-line input. Inside a `<Field>` it picks up the label and error wiring. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono = false, className, id, rows = 4, ...rest },
  ref
) {
  const f = useFieldProps(id, rest);
  return (
    <textarea
      {...rest}
      ref={ref}
      id={f.id}
      rows={rows}
      aria-describedby={f["aria-describedby"]}
      aria-labelledby={f["aria-labelledby"]}
      aria-invalid={f["aria-invalid"]}
      aria-required={f["aria-required"]}
      className={cx(
        "ui-textarea w-full resize-y rounded-card border bg-bg1 p-3 text-[13px] leading-[1.6] text-ink focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2",
        "transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)]",
        "placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-55",
        f.invalid ? "border-err" : "border-line hover:border-line-strong focus-visible:border-signal",
        mono && "font-mono",
        className
      )}
    />
  );
});
