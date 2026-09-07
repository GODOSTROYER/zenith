/**
 * Form controls. Every one has a real <label>, an id that ties the two
 * together, and room for an error and a hint that screen readers reach through
 * aria-describedby. Bounded fields say how much room is left as you type.
 *
 * Workstream W4 (hosted R3)
 */
import type { ReactNode, Ref } from "react";

interface FieldShellProps {
  id: string;
  label: string;
  error?: string;
  hint?: ReactNode;
  counter?: ReactNode;
  required?: boolean;
  children: (described: string | undefined) => ReactNode;
}

function FieldShell({ id, label, error, hint, counter, required, children }: FieldShellProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const described = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <div className="field-head">
        <label className="field-label" htmlFor={id}>
          {label}
          {required ? <span className="field-required"> (required)</span> : null}
        </label>
        {counter}
      </div>
      {children(described)}
      {hint ? (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Counter({ left }: { left: number }) {
  const over = left < 0;
  return (
    <span className={over ? "field-counter is-over" : "field-counter"}>
      {over ? `${-left} over` : `${left} left`}
    </span>
  );
}

export interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  max?: number;
  error?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
}

export function TextField({
  id,
  label,
  value,
  max,
  error,
  hint,
  required,
  disabled,
  inputRef,
  onChange,
}: TextFieldProps) {
  return (
    <FieldShell
      id={id}
      label={label}
      error={error}
      hint={hint}
      required={required}
      counter={max ? <Counter left={max - value.length} /> : undefined}
    >
      {(described) => (
        <input
          className="control"
          id={id}
          ref={inputRef}
          type="text"
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldShell>
  );
}

export interface TextAreaFieldProps {
  id: string;
  label: string;
  value: string;
  max: number;
  rows?: number;
  error?: string;
  hint?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function TextAreaField({
  id,
  label,
  value,
  max,
  rows = 4,
  error,
  hint,
  disabled,
  onChange,
}: TextAreaFieldProps) {
  return (
    <FieldShell
      id={id}
      label={label}
      error={error}
      hint={hint}
      counter={<Counter left={max - value.length} />}
    >
      {(described) => (
        <textarea
          className="control control-area"
          id={id}
          rows={rows}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldShell>
  );
}

export interface SelectFieldProps<T extends string> {
  id: string;
  label: string;
  value: T;
  options: readonly T[];
  labelFor: (value: T) => string;
  error?: string;
  hint?: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  labelFor,
  error,
  hint,
  disabled,
  onChange,
}: SelectFieldProps<T>) {
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      {(described) => (
        <select
          className="control"
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {labelFor(option)}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}

export interface PlainFieldProps {
  id: string;
  label: string;
  value: string;
  type: "number" | "date";
  min?: number;
  max?: number;
  error?: string;
  hint?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function PlainField({
  id,
  label,
  value,
  type,
  min,
  max,
  error,
  hint,
  disabled,
  onChange,
}: PlainFieldProps) {
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      {(described) => (
        <input
          className="control"
          id={id}
          type={type}
          value={value}
          min={min}
          max={max}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldShell>
  );
}
