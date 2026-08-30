"use client";
import { cx } from "@/lib/format";
import { useFieldProps } from "./field";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** required when disabled — explains why, as a tooltip */
  disabledReason?: string;
  /** accessible name when there is no surrounding `<Field>` */
  label?: string;
  id?: string;
  className?: string;
}

/** Boolean toggle. Applies immediately — never pair it with a Save button. */
export function Switch({
  checked,
  onChange,
  disabled = false,
  disabledReason,
  label,
  id,
  className,
}: SwitchProps) {
  const f = useFieldProps(id);
  return (
    <button
      type="button"
      role="switch"
      id={f.id}
      aria-checked={checked}
      aria-label={label}
      aria-describedby={f["aria-describedby"]}
      disabled={disabled}
      title={disabled ? (disabledReason ?? "Locked by policy.") : undefined}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border",
        "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
        checked ? "border-transparent bg-signal" : "border-line bg-bg3",
        disabled && "cursor-not-allowed opacity-55",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "absolute h-3.5 w-3.5 rounded-full transition-transform duration-[120ms] [transition-timing-function:var(--ease-swift)]",
          checked ? "translate-x-[18px] bg-on-signal" : "translate-x-[3px] bg-ink-mute"
        )}
      />
    </button>
  );
}
