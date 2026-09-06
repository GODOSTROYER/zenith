"use client";
import { createContext, useContext, useId, type AriaAttributes, type ReactNode } from "react";
import { cx } from "@/lib/format";

interface FieldCtx {
  controlId: string;
  describedBy?: string;
  invalid: boolean;
  labelId: string;
  required: boolean;
}

const FieldContext = createContext<FieldCtx | null>(null);

/**
 * Props a control inside a `<Field>` should spread onto its element.
 * Controls in this kit do it automatically.
 */
export function useFieldProps(explicitId?: string, explicit: AriaAttributes = {}) {
  const f = useContext(FieldContext);
  const describedBy = [...new Set([explicit["aria-describedby"], f?.describedBy]
    .filter(Boolean).join(" ").split(/\s+/).filter(Boolean))].join(" ");
  const invalid = f?.invalid || explicit["aria-invalid"];
  return {
    id: explicitId ?? f?.controlId,
    "aria-describedby": describedBy || undefined,
    "aria-labelledby": explicit["aria-labelledby"] ?? (explicit["aria-label"] ? undefined : f?.labelId),
    "aria-invalid": invalid || undefined,
    "aria-required": explicit["aria-required"] ?? (f?.required || undefined),
    invalid: Boolean(invalid && invalid !== "false"),
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
  const labelId = `${base}-label`;
  const helpId = `${base}-help`;
  const errId = `${base}-err`;
  const describedBy = [error ? errId : help ? helpId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <FieldContext.Provider
      value={{ controlId, labelId, required, describedBy: describedBy || undefined, invalid: Boolean(error) }}
    >
      <div className={cx("space-y-1.5", className)}>
        <div className="flex items-baseline justify-between gap-3">
          <label
            id={labelId}
            htmlFor={controlId}
            className="text-[13px] font-medium text-ink"
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
