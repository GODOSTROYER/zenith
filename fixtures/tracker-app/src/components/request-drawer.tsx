/**
 * The detail and edit drawer. It is a modal panel: Escape closes it, Tab stays
 * inside it, and focus goes back to the row that opened it.
 *
 * It is also where a conflict is settled. When the host refuses a stale write
 * the draft is left exactly as it was typed, the fields somebody else changed
 * are listed beside it, and the person chooses which version wins.
 *
 * Workstream W4 (hosted R3)
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  REQUEST_CATEGORIES,
  REQUEST_PRIORITIES,
  REQUEST_STATUSES,
  TRACKER_LIMITS,
  type EquipmentRequest,
  type RequestCategory,
  type RequestPriority,
  type RequestStatus,
} from "../api";
import {
  categoryLabel,
  clearsOnEdit,
  conflictRows,
  draftFromRecord,
  formatMoment,
  hasErrors,
  priorityLabel,
  statusLabel,
  validateDraft,
  type Draft,
  type SaveState,
} from "../state";
import { PlainField, SelectField, TextAreaField, TextField } from "./fields";
import { LiveNote } from "./notice";
import { SaveStateNotice } from "./save-state-notice";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
].join(", ");

const VIEW_ONLY = "Your access is view-only, so this is not something you can change.";

export interface RequestDrawerProps {
  record: EquipmentRequest;
  canWrite: boolean;
  state: SaveState;
  onSave: (draft: Draft) => Promise<boolean>;
  onResolveConflict: (draft: Draft) => Promise<boolean>;
  onDiscardConflict: () => EquipmentRequest | null;
  onClose: () => void;
  onDirty: () => void;
  /** the control that opened the drawer; focus goes back to it on close */
  returnFocusTo?: HTMLElement | null;
}

export function RequestDrawer({
  record,
  canWrite,
  state,
  onSave,
  onResolveConflict,
  onDiscardConflict,
  onClose,
  onDirty,
  returnFocusTo,
}: RequestDrawerProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFromRecord(record));
  const [showErrors, setShowErrors] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const errors = validateDraft(draft);
  const pending = state.kind === "pending";
  const locked = !canWrite || pending;

  // A modal owns the viewport while it is open: the page behind it does not
  // scroll, focus starts on the close control, and it goes back where it came
  // from on the way out.
  useEffect(() => {
    const fallback = document.activeElement as HTMLElement | null;
    const scroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = scroll;
      const target = returnFocusTo ?? fallback;
      if (target && document.contains(target)) target.focus();
    };
  }, [returnFocusTo]);

  // A committed version is the truth. When the record moves forward - our own
  // save landing, or a conflict being discarded - the draft is re-read from it,
  // so a field this person never touched cannot be pushed back later.
  const synced = useRef(record.version);
  useEffect(() => {
    if (record.version === synced.current) return;
    synced.current = record.version;
    setDraft(draftFromRecord(record));
    setShowErrors(false);
  }, [record]);

  const edit = (patch: Partial<Draft>) => {
    if (clearsOnEdit(state)) onDirty();
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    setShowErrors(true);
    if (hasErrors(errors)) return;
    await onSave(draft);
  };

  const shown = (field: keyof Draft): string | undefined =>
    showErrors ? errors[field] : undefined;

  const conflict = state.kind === "conflict" ? state.current : null;
  const rows = conflict ? conflictRows(record, conflict, draft) : [];

  const discard = () => {
    const current = onDiscardConflict();
    if (current) {
      setDraft(draftFromRecord(current));
      setShowErrors(false);
    }
  };

  return (
    <div className="drawer-layer">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="drawer-head">
          <h2 className="drawer-title" id="drawer-title">
            {record.title}
          </h2>
          <button
            type="button"
            className="button quiet"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close request details"
          >
            Close
          </button>
        </div>

        <p className="drawer-meta">
          Version {record.version} &middot; opened by {record.createdByEmail} on{" "}
          {formatMoment(record.createdAt)} &middot; last change by {record.updatedByEmail} on{" "}
          {formatMoment(record.updatedAt)}
        </p>

        {canWrite ? null : (
          <SaveStateNotice state={{ kind: "denied", reason: "view_only" }} what="request" />
        )}

        {conflict ? (
          <div className="conflict" role="alert">
            <p className="notice-title">Someone changed this while you were editing</p>
            <p>
              {conflict.updatedByEmail} saved version {conflict.version} on{" "}
              {formatMoment(conflict.updatedAt)}. Nothing of yours was lost - your edits are
              still in the fields below.
            </p>
            {rows.length > 0 ? (
              <table className="conflict-table">
                <caption>What changed while you were editing</caption>
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Now on the server</th>
                    <th scope="col">In your draft</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.field} className={row.contested ? "is-contested" : undefined}>
                      <th scope="row">{row.label}</th>
                      <td>{row.theirs}</td>
                      <td>{row.mine}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <div className="notice-actions">
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  void onResolveConflict(draft);
                }}
              >
                Reload and keep my edits
              </button>
              <button type="button" className="button quiet" onClick={discard}>
                Discard my edits
              </button>
            </div>
          </div>
        ) : null}

        <form className="form" onSubmit={submit} noValidate>
          <TextField
            id="edit-title"
            label="Title"
            value={draft.title}
            max={TRACKER_LIMITS.title}
            required
            error={shown("title")}
            disabled={locked}
            onChange={(title) => edit({ title })}
          />
          <TextAreaField
            id="edit-details"
            label="Details"
            value={draft.details}
            max={TRACKER_LIMITS.details}
            error={shown("details")}
            disabled={locked}
            onChange={(details) => edit({ details })}
          />
          <div className="form-grid">
            <SelectField<RequestStatus>
              id="edit-status"
              label="Status"
              value={draft.status}
              options={REQUEST_STATUSES}
              labelFor={statusLabel}
              hint="There is no delete. Decline a request instead."
              disabled={locked}
              onChange={(status) => edit({ status })}
            />
            <SelectField<RequestCategory>
              id="edit-category"
              label="Category"
              value={draft.category}
              options={REQUEST_CATEGORIES}
              labelFor={categoryLabel}
              disabled={locked}
              onChange={(category) => edit({ category })}
            />
            <PlainField
              id="edit-quantity"
              label="Quantity"
              type="number"
              min={1}
              max={TRACKER_LIMITS.quantityMax}
              value={draft.quantity}
              error={shown("quantity")}
              disabled={locked}
              onChange={(quantity) => edit({ quantity })}
            />
            <SelectField<RequestPriority>
              id="edit-priority"
              label="Priority"
              value={draft.priority}
              options={REQUEST_PRIORITIES}
              labelFor={priorityLabel}
              disabled={locked}
              onChange={(priority) => edit({ priority })}
            />
            <TextField
              id="edit-requested-for"
              label="Requested for"
              value={draft.requestedFor}
              max={TRACKER_LIMITS.requestedFor}
              error={shown("requestedFor")}
              disabled={locked}
              onChange={(requestedFor) => edit({ requestedFor })}
            />
            <PlainField
              id="edit-needed-by"
              label="Needed by"
              type="date"
              value={draft.neededBy}
              error={shown("neededBy")}
              disabled={locked}
              onChange={(neededBy) => edit({ neededBy })}
            />
          </div>

          <SaveStateNotice state={state} what="request" />

          <div className="form-actions">
            <button
              type="submit"
              className="button primary"
              disabled={locked}
              title={canWrite ? undefined : VIEW_ONLY}
              aria-describedby={canWrite ? undefined : "drawer-view-only"}
            >
              {pending ? "Saving\u2026" : "Save changes"}
            </button>
            {canWrite ? null : (
              <span className="hint" id="drawer-view-only">
                {VIEW_ONLY}
              </span>
            )}
            <LiveNote
              tone={state.kind === "saved" ? "good" : "info"}
              message={
                pending
                  ? "Saving your changes\u2026"
                  : state.kind === "saved"
                    ? "Changes saved."
                    : ""
              }
            />
          </div>
        </form>
      </div>
    </div>
  );
}
