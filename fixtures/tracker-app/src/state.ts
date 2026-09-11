/**
 * Pure logic behind the screen: the shape of an edit in progress, what makes
 * one invalid, what changed between two versions of a record, and how a
 * refusal from the host becomes a state a person can act on.
 *
 * Nothing here touches React or the network, so every rule below can be read
 * and tested on its own.
 */
import {
  isApiError,
  staleVersionDetails,
  TRACKER_LIMITS,
  type ApiError,
  type EquipmentRequest,
  type EquipmentRequestInput,
  type EquipmentRequestPatch,
  type RequestCategory,
  type RequestPriority,
  type RequestStatus,
  type SessionRole,
} from "./api";

/* ------------------------------------------------------------------ labels */

export type RecordField = keyof EquipmentRequestInput;

export const FIELD_LABELS: Record<RecordField, string> = {
  title: "Title",
  details: "Details",
  category: "Category",
  quantity: "Quantity",
  priority: "Priority",
  status: "Status",
  requestedFor: "Requested for",
  neededBy: "Needed by",
};

const CATEGORY_LABELS: Record<RequestCategory, string> = {
  laptop: "Laptop",
  monitor: "Monitor",
  peripheral: "Peripheral",
  software: "Software",
  furniture: "Furniture",
  other: "Other",
};

const PRIORITY_LABELS: Record<RequestPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
};

const STATUS_LABELS: Record<RequestStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  ordered: "Ordered",
  delivered: "Delivered",
  declined: "Declined",
};

export const categoryLabel = (value: RequestCategory): string => CATEGORY_LABELS[value] ?? value;
export const priorityLabel = (value: RequestPriority): string => PRIORITY_LABELS[value] ?? value;
export const statusLabel = (value: RequestStatus): string => STATUS_LABELS[value] ?? value;

/** A calendar date as a person reads it, or the raw string if it is not one. */
export function formatDay(value: string | null): string {
  if (!value) return "No date";
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at)) return value;
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** A timestamp as a person reads it, or the raw string if it is not one. */
export function formatMoment(value: string): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  return new Date(at).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fieldText(field: RecordField, record: EquipmentRequestInput): string {
  switch (field) {
    case "category":
      return categoryLabel(record.category);
    case "priority":
      return priorityLabel(record.priority);
    case "status":
      return statusLabel(record.status);
    case "quantity":
      return String(record.quantity);
    case "neededBy":
      return formatDay(record.neededBy);
    case "requestedFor":
      return record.requestedFor || "Not said";
    case "details":
      return record.details || "No details";
    default:
      return record.title;
  }
}

/* ------------------------------------------------------------- the draft */

/**
 * What the form holds while someone is typing. Every field is a string,
 * including the quantity, because a half-typed number is a real state and
 * coercing it early throws away what the person actually wrote.
 */
export interface Draft {
  title: string;
  details: string;
  category: RequestCategory;
  quantity: string;
  priority: RequestPriority;
  status: RequestStatus;
  requestedFor: string;
  neededBy: string;
}

export type DraftErrors = Partial<Record<keyof Draft, string>>;

export function emptyDraft(): Draft {
  return {
    title: "",
    details: "",
    category: "laptop",
    quantity: "1",
    priority: "normal",
    status: "requested",
    requestedFor: "",
    neededBy: "",
  };
}

export function draftFromRecord(record: EquipmentRequestInput): Draft {
  return {
    title: record.title,
    details: record.details ?? "",
    category: record.category,
    quantity: String(record.quantity),
    priority: record.priority,
    status: record.status,
    requestedFor: record.requestedFor ?? "",
    neededBy: record.neededBy ?? "",
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The same limits the host enforces, checked here so nobody loses typing to a 400. */
export function validateDraft(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  const title = draft.title.trim();
  if (!title) errors.title = "Give the request a short title.";
  else if (title.length > TRACKER_LIMITS.title)
    errors.title = `Keep the title to ${TRACKER_LIMITS.title} characters.`;

  if (draft.details.trim().length > TRACKER_LIMITS.details)
    errors.details = `Keep the details to ${TRACKER_LIMITS.details} characters.`;

  if (draft.requestedFor.trim().length > TRACKER_LIMITS.requestedFor)
    errors.requestedFor = `Keep this to ${TRACKER_LIMITS.requestedFor} characters.`;

  const quantity = Number(draft.quantity);
  if (!draft.quantity.trim() || !Number.isInteger(quantity))
    errors.quantity = "Use a whole number.";
  else if (quantity < 1 || quantity > TRACKER_LIMITS.quantityMax)
    errors.quantity = `Between 1 and ${TRACKER_LIMITS.quantityMax}.`;

  if (draft.neededBy) {
    if (!DAY.test(draft.neededBy) || Number.isNaN(Date.parse(`${draft.neededBy}T00:00:00Z`)))
      errors.neededBy = "Use a real date, or leave it empty.";
  }
  return errors;
}

export const hasErrors = (errors: DraftErrors): boolean => Object.keys(errors).length > 0;

/** How many characters are left in a bounded field; negative once it is over. */
export const remaining = (value: string, max: number): number => max - value.length;

export function draftToInput(draft: Draft): EquipmentRequestInput {
  return {
    title: draft.title.trim(),
    details: draft.details.trim(),
    category: draft.category,
    quantity: Number(draft.quantity),
    priority: draft.priority,
    status: draft.status,
    requestedFor: draft.requestedFor.trim(),
    neededBy: draft.neededBy ? draft.neededBy : null,
  };
}

const FIELDS: RecordField[] = [
  "title",
  "details",
  "category",
  "quantity",
  "priority",
  "status",
  "requestedFor",
  "neededBy",
];

/** Fields whose value differs between two versions of the same record. */
export function changedFields(
  before: EquipmentRequestInput,
  after: EquipmentRequestInput
): RecordField[] {
  return FIELDS.filter((field) => before[field] !== after[field]);
}

/** Only what the person actually changed, so an update never overwrites a field blind. */
export function patchFromDraft(
  base: EquipmentRequestInput,
  draft: Draft
): EquipmentRequestPatch {
  const next = draftToInput(draft);
  const patch: EquipmentRequestPatch = {};
  for (const field of changedFields(base, next)) {
    Object.assign(patch, { [field]: next[field] });
  }
  return patch;
}

export const isEmptyPatch = (patch: EquipmentRequestPatch): boolean =>
  Object.keys(patch).length === 0;

/* ---------------------------------------------------------- the conflict */

export interface ConflictRow {
  field: RecordField;
  label: string;
  /** the value now on the server */
  theirs: string;
  /** the value in the draft that is still on screen, or a note that it is untouched */
  mine: string;
  /** true when this person edited the same field, so re-basing would overwrite theirs */
  contested: boolean;
}

/**
 * What somebody else changed while this edit was open, next to what the draft
 * says about the same fields.
 */
export function conflictRows(
  base: EquipmentRequestInput,
  current: EquipmentRequestInput,
  draft: Draft
): ConflictRow[] {
  const mine = draftToInput(draft);
  const edited = new Set<RecordField>(changedFields(base, mine));
  return changedFields(base, current).map((field) => ({
    field,
    label: FIELD_LABELS[field],
    theirs: fieldText(field, current),
    mine: edited.has(field) ? fieldText(field, mine) : "Not changed by you",
    contested: edited.has(field),
  }));
}

/* ------------------------------------------------------- the save states */

export type DeniedReason = "view_only" | "revoked";

/**
 * `saved` is only ever set from a 2xx. Nothing in this app calls a write
 * finished because it was sent.
 */
export type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saved" }
  | { kind: "conflict"; current: EquipmentRequest }
  | { kind: "denied"; reason: DeniedReason }
  | { kind: "signed_out" }
  | { kind: "unavailable"; message: string; fix?: string }
  | { kind: "unsupported"; message: string; fix?: string };

export const IDLE: SaveState = { kind: "idle" };
export const PENDING: SaveState = { kind: "pending" };
export const SAVED: SaveState = { kind: "saved" };

const UNAVAILABLE_CODES = new Set([
  "network",
  "runtime_unavailable",
  "policy_unavailable",
  "recovering",
  "suspended",
  "quota_exceeded",
]);

/**
 * One refusal, one state. A code this version has never heard of lands in
 * `unsupported` carrying the host's own words, which is the honest thing to
 * show: the app cannot explain a rule it does not know.
 */
export function saveStateFromError(err: unknown, role: SessionRole | null): SaveState {
  if (!isApiError(err)) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { kind: "unsupported", message };
  }
  const api: ApiError = err;

  if (api.code === "sign_in_required") return { kind: "signed_out" };
  if (api.code === "forbidden" || api.code === "csrf_rejected") {
    return { kind: "denied", reason: role === "viewer" ? "view_only" : "revoked" };
  }
  const stale = staleVersionDetails(api);
  if (stale) return { kind: "conflict", current: stale.current };
  if (UNAVAILABLE_CODES.has(api.code)) {
    return { kind: "unavailable", message: api.message, fix: api.fix };
  }
  return { kind: "unsupported", message: api.message, fix: api.fix };
}

/**
 * Whether the last outcome stops being worth showing once the person types
 * again. A finished save and a failure they can retype past both go; a denial,
 * a signed-out session and an open conflict stay, because typing does not
 * change any of them.
 */
export const clearsOnEdit = (state: SaveState): boolean =>
  state.kind === "saved" || state.kind === "unsupported" || state.kind === "unavailable";

/* ------------------------------------------------------ loading the screen */

export type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "denied"; reason: DeniedReason }
  | { kind: "signed_out" }
  | { kind: "unavailable"; message: string; fix?: string }
  | { kind: "unsupported"; message: string; fix?: string };

/**
 * The same mapping as a save, minus the states a read cannot reach. Every role
 * may read, so a refused read means the grant is gone - never that the person
 * is a viewer.
 */
export function loadStateFromError(err: unknown, role: SessionRole | null): LoadState {
  const state = saveStateFromError(err, role);
  switch (state.kind) {
    case "denied":
      return { kind: "denied", reason: "revoked" };
    case "signed_out":
    case "unavailable":
    case "unsupported":
      return state;
    default:
      return { kind: "unsupported", message: "The host answered in a way this app cannot read." };
  }
}

/* ------------------------------------------------------------- write ids */

/**
 * A write id belongs to one logical operation, not to one click. Retrying the
 * same bytes must reuse it — that is what makes a lost acknowledgement safe.
 * Changing the bytes must not: replaying an id with different content is a
 * different intent, and the host refuses it.
 */
export interface WriteTicket {
  id: string;
  /** a fingerprint of exactly what will be sent */
  key: string;
}

export function ticketFor(
  previous: WriteTicket | null,
  key: string,
  mint: () => string
): WriteTicket {
  if (previous && previous.key === key) return previous;
  return { id: mint(), key };
}

export const createKey = (input: EquipmentRequestInput): string =>
  `create:${JSON.stringify(input)}`;

export const updateKey = (
  id: string,
  expectedVersion: number,
  patch: EquipmentRequestPatch
): string => `update:${id}:${expectedVersion}:${JSON.stringify(patch)}`;
