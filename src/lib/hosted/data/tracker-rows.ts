/**
 * The tracker's row shapes, its column order, its page cursor and the four
 * refusals its store throws.
 *
 * Everything here is pure: given a row, or a record, or a string, it answers —
 * it never touches a backend, a transaction or a caller's role. That is the
 * point of the separation. `tracker-store.ts` is about *when* a write is
 * allowed; this file is about *what* is written and what a stored row means,
 * which is the half a reader has to check against `sql.ts` column by column.
 *
 * `insertColumns` is the one that earns its keep: the 17 bound values of
 * `INSERT_REQUEST_WITHIN_QUOTA`, in column order, exported so the export
 * writer builds its rows from the same list rather than from a second copy
 * that drifts.
 */
import { z } from "zod";
import {
  APP_ROLE_RANK,
  type EquipmentRequest,
  HostedError,
  type RequestCategory,
  type RequestPriority,
  type RequestStatus,
  type StaleVersionDetails,
} from "@/lib/hosted/contracts";

/** How a request row comes back from SQL. Snake case, exactly the stored columns. */
export interface RequestRow {
  id: string;
  title: string;
  details: string;
  category: string;
  quantity: number;
  priority: string;
  status: string;
  requested_for: string;
  needed_by: string | null;
  version: number;
  created_by: string;
  created_by_email: string;
  created_at: string;
  updated_by: string;
  updated_by_email: string;
  updated_at: string;
  logical_bytes: number;
}

/* --------------------------------- roles ---------------------------------- */

/**
 * The rank of a role, or undefined when it is not one this app grants.
 *
 * Deliberately an own-property check rather than `APP_ROLE_RANK[role]`: plain
 * bracket access finds inherited keys, so a context carrying the role
 * `"constructor"` or `"toString"` would otherwise read as a known role.
 */
export function roleRank(role: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(APP_ROLE_RANK, role)
    ? APP_ROLE_RANK[role as keyof typeof APP_ROLE_RANK]
    : undefined;
}

/* -------------------------------- row shape ------------------------------- */

/** The 17 bound values of `INSERT_REQUEST_WITHIN_QUOTA`, in column order. */
export function insertColumns(record: EquipmentRequest, bytes: number): (string | number | null)[] {
  return [
    record.id,
    record.title,
    record.details,
    record.category,
    record.quantity,
    record.priority,
    record.status,
    record.requestedFor,
    record.neededBy,
    record.version,
    record.createdBy,
    record.createdByEmail,
    record.createdAt,
    record.updatedBy,
    record.updatedByEmail,
    record.updatedAt,
    bytes,
  ];
}

/**
 * SQL row → contract record. The enum casts are safe because the CHECK
 * constraints in `sql.ts` refuse any other value at write time; they are the
 * reason this does not re-validate every row it reads.
 */
export function toRecord(row: RequestRow): EquipmentRequest {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    category: row.category as RequestCategory,
    quantity: Number(row.quantity),
    priority: row.priority as RequestPriority,
    status: row.status as RequestStatus,
    requestedFor: row.requested_for,
    neededBy: row.needed_by,
    version: Number(row.version),
    createdBy: row.created_by,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
  };
}

/* --------------------------------- cursors -------------------------------- */

/** Cursor payload version, so a future change to the shape is detectable rather than silent. */
const CURSOR_VERSION = 1;

const CursorPayload = z
  .object({
    v: z.literal(CURSOR_VERSION),
    at: z.string().min(1).max(40),
    id: z.string().min(1).max(200),
  })
  .strict();
/** What a decoded page cursor holds: the ordering key of the last row of a page. */
export type CursorPayload = z.infer<typeof CursorPayload>;

/**
 * The opaque page cursor: base64url of the last row's ordering key.
 *
 * TODO(ceiling): the cursor is opaque but unauthenticated — it carries no
 * privileges, only a position inside rows the caller may already read, so the
 * worst a tampered cursor can do to its own sender is skip or repeat their own
 * app's rows. Signing it would need a key this module deliberately does not
 * hold.
 */
export function encodeCursor(record: EquipmentRequest): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, at: record.createdAt, id: record.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decodes a page cursor, refusing anything this store did not produce. */
export function decodeCursor(raw: string): CursorPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw cursorRejected();
  }
  const parsed = CursorPayload.safeParse(decoded);
  if (!parsed.success) throw cursorRejected();
  return parsed.data;
}

/* -------------------------------- refusals -------------------------------- */

export function cursorRejected(): HostedError {
  return new HostedError("invalid_input", "That page cursor is not one this app issued.", {
    fix: "Drop the cursor to start from the first page, or use the nextCursor value exactly as it was returned.",
    details: { issues: [{ path: "cursor", code: "custom", message: "not a cursor issued by this app" }] },
  });
}

export function notFound(id: string): HostedError {
  return new HostedError("not_found", `This app has no equipment request with id ${id}.`, {
    fix: "Reload the list — the id may belong to another app, or the request may never have been created.",
  });
}

export function staleVersion(expectedVersion: number, current: EquipmentRequest): HostedError {
  const details: StaleVersionDetails = { expectedVersion, current };
  return new HostedError(
    "stale_version",
    `Someone else changed this request first: you edited version ${expectedVersion}, and it is now at version ${current.version}.`,
    {
      fix: "Reload the request, apply your change on top of the current version and send it again with a new writeId.",
      details,
    }
  );
}

/** Validates against a contract schema, turning zod issues into `invalid_input` details. */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  }));
  const summary = issues.map((issue) => `${issue.path || "(body)"}: ${issue.message}`).join("; ");
  throw new HostedError("invalid_input", `The ${what} does not match the equipment-request contract — ${summary}.`, {
    fix: "Correct the fields named above and send the request again.",
    details: { issues },
  });
}
