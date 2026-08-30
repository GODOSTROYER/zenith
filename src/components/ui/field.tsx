"use client";
import { createContext, useContext, useId, type ReactNode } from "react";
import { cx } from "@/lib/format";

interface FieldCtx {
  controlId: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldCtx | null>(null);

/**
 * Props a control inside a `<Field>` should spread onto its element.
 * Controls in this kit do it automatically.
 */
export function useFieldProps(explicitId?: string) {
  const f = useContext(FieldContext);
  return {
    id: explicitId ?? f?.controlId,
    "aria-describedby": f?.describedBy,
    "aria-invalid": f?.invalid || undefined,
    invalid: f?.invalid ?? false,
  };
}

export interface FieldProps {
  label: ReactNode;
  /** neutral guidance shown under the control */
  help?: ReactNode;
  /** error text — states what to do next, never just what went wrong */
  error?: string;
  required?: boolean;
  /** right-aligned label extra, e.g. a cost hint */
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Label + control + help/error, wired with `htmlFor`, `aria-describedby`, `aria-invalid`. */
export function Field({
  label,
  help,
  error,
  required = false,
  hint,
  className,
  children,
}: FieldProps) {
  const base = useId();
  const controlId = `${base}-ctl`;
  const helpId = `${base}-help`;
  const errId = `${base}-err`;
  const describedBy = [error ? errId : null, help ? helpId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <FieldContext.Provider
      value={{ controlId, describedBy: describedBy || undefined, invalid: Boolean(error) }}
    >
      <div className={cx("space-y-1.5", className)}>
        <div className="flex items-baseline justify-between gap-3">
          <label
            htmlFor={controlId}
            className="text-[12px] font-medium tracking-[0.02em] text-ink-mute uppercase"
          >
            {label}
            {required && (
              <span aria-hidden="true" className="ml-1 text-err">
                *
              </span>
            )}
          </label>
          {hint && <span className="tnum text-[11.5px] text-ink-faint">{hint}</span>}
        </div>
        {children}
        {error ? (
          <p id={errId} className="text-[12px] text-err">
            {error}
          </p>
        ) : (
          help && (
            <p id={helpId} className="text-[12px] text-ink-faint">
              {help}
            </p>
          )
        )}
      </div>
    </FieldContext.Provider>
  );
}
