/**
 * The "new request" form. It owns the draft, checks the same limits the host
 * checks, and refuses to call anything saved until the host says so.
 *
 * Workstream W4 (hosted R3)
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  REQUEST_CATEGORIES,
  REQUEST_PRIORITIES,
  TRACKER_LIMITS,
  type RequestCategory,
  type RequestPriority,
} from "../api";
import {
  categoryLabel,
  clearsOnEdit,
  emptyDraft,
  hasErrors,
  priorityLabel,
  validateDraft,
  type Draft,
  type SaveState,
} from "../state";
import { PlainField, SelectField, TextAreaField, TextField } from "./fields";
import { LiveNote, Notice } from "./notice";
import { SaveStateNotice } from "./save-state-notice";

export function NewRequestForm({
  state,
  onCreate,
  onDirty,
  onCancel,
}: {
  state: SaveState;
  onCreate: (draft: Draft) => Promise<boolean>;
  onDirty: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [showErrors, setShowErrors] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const errors = validateDraft(draft);
  const pending = state.kind === "pending";

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const edit = (patch: Partial<Draft>) => {
    if (clearsOnEdit(state)) onDirty();
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setShowErrors(true);
    if (hasErrors(errors)) {
      titleRef.current?.focus();
      return;
    }
    const ok = await onCreate(draft);
    if (ok) {
      setDraft(emptyDraft());
      setShowErrors(false);
      titleRef.current?.focus();
    }
  };

  const shown = (field: keyof Draft): string | undefined =>
    showErrors ? errors[field] : undefined;

  return (
    <form className="panel form" onSubmit={submit} noValidate>
      <h2 className="panel-title">New request</h2>

      <TextField
        id="new-title"
        label="Title"
        value={draft.title}
        max={TRACKER_LIMITS.title}
        required
        error={shown("title")}
        hint="What is being asked for, in a few words."
        inputRef={titleRef}
        disabled={pending}
        onChange={(title) => edit({ title })}
      />

      <TextAreaField
        id="new-details"
        label="Details"
        value={draft.details}
        max={TRACKER_LIMITS.details}
        error={shown("details")}
        hint="Model, size, reason - anything the person approving will want."
        disabled={pending}
        onChange={(details) => edit({ details })}
      />

      <div className="form-grid">
        <SelectField<RequestCategory>
          id="new-category"
          label="Category"
          value={draft.category}
          options={REQUEST_CATEGORIES}
          labelFor={categoryLabel}
          disabled={pending}
          onChange={(category) => edit({ category })}
        />
        <PlainField
          id="new-quantity"
          label="Quantity"
          type="number"
          min={1}
          max={TRACKER_LIMITS.quantityMax}
          value={draft.quantity}
          error={shown("quantity")}
          disabled={pending}
          onChange={(quantity) => edit({ quantity })}
        />
        <SelectField<RequestPriority>
          id="new-priority"
          label="Priority"
          value={draft.priority}
          options={REQUEST_PRIORITIES}
          labelFor={priorityLabel}
          disabled={pending}
          onChange={(priority) => edit({ priority })}
        />
        <TextField
          id="new-requested-for"
          label="Requested for"
          value={draft.requestedFor}
          max={TRACKER_LIMITS.requestedFor}
          error={shown("requestedFor")}
          hint="A name, a team, or leave it empty."
          disabled={pending}
          onChange={(requestedFor) => edit({ requestedFor })}
        />
        <PlainField
          id="new-needed-by"
          label="Needed by"
          type="date"
          value={draft.neededBy}
          error={shown("neededBy")}
          disabled={pending}
          onChange={(neededBy) => edit({ neededBy })}
        />
      </div>

      {showErrors && hasErrors(errors) ? (
        <Notice tone="warn" title="Check the fields marked above." live />
      ) : null}

      <SaveStateNotice state={state} what="request" />

      <div className="form-actions">
        <button type="submit" className="button primary" disabled={pending}>
          {pending ? "Saving\u2026" : "Add request"}
        </button>
        <button type="button" className="button quiet" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <LiveNote
          tone={state.kind === "saved" ? "good" : "info"}
          message={
            pending ? "Saving your request\u2026" : state.kind === "saved" ? "Request saved." : ""
          }
        />
      </div>
    </form>
  );
}
