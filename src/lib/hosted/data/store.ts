/**
 * `TrackerDataStore` — the fixed broker's data layer for one hosted app.
 *
 * Everything a hosted app may do to customer data goes through this class:
 * validated against the frozen contract, checked against the caller's app role,
 * versioned so a second editor cannot silently overwrite the first, idempotent
 * under a retried write id, and accounted against the app's storage quota — all
 * inside the same transaction as the write itself, so an acknowledged change is
 * durable and a refused one leaves nothing behind.
 *
 * What this class does NOT do: decide who the caller is. Admission — host, app
 * state, quota, session cookie, live grant — is the gateway's job (W6), and a
 * caller with no grant never reaches here. The role check below is the second
 * line of defence, not the first.
 *
 * One instance serves exactly one app's database. There is no statement in
 * `sql.ts` that names an app, so the only way to reach another app's data is to
 * open that app's file with `openAppData()`.
 *
 * Workstream W3 (hosted R3).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  APP_ROLE_RANK,
  type AppDataStore,
  CreateRequestBody,
  DEFAULT_LIMITS,
  type DataContext,
  type EquipmentRequest,
  HostedError,
  ListRequestsQuery,
  type ListRequestsResult,
  type RequestCategory,
  type RequestPriority,
  type RequestStatus,
  type StaleVersionDetails,
  TRACKER_LIMITS,
  UpdateRequestBody,
} from "@/lib/hosted/contracts";
import type { DataBackend } from "./backend";
import { LOGICAL_BYTES_DISCLOSURE, logicalBytes } from "./bytes";
import { writeIntentHash } from "./intent";
import { readSchemaVersion } from "./schema";
import {
  DELETE_WRITES_BEFORE,
  INSERT_REQUEST_WITHIN_QUOTA,
  INSERT_WRITE,
  SELECT_REQUESTS_PAGE,
  SELECT_REQUEST_BY_ID,
  SELECT_STORAGE_BYTES,
  SELECT_WRITE_BY_ID,
  UPDATE_REQUEST_CAS,
  UPDATE_STORAGE_ADD,
} from "./sql";

/** How a request row comes back from SQL. Snake case, exactly the stored columns. */
interface RequestRow {
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

/** How a write-ledger row comes back from SQL. */
interface WriteRow {
  write_id: string;
  subject: string;
  op: string;
  record_id: string | null;
  intent_hash: string;
  status_code: number;
  result: string;
  created_at: string;
}

/** What a mutation answers: the record, and whether this was a replay of an earlier write id. */
export interface MutationResult {
  record: EquipmentRequest;
  replayed: boolean;
}

/*
 * The three request types below are the contract schemas' *input* types, not
 * their parsed output. This class is the validating boundary — the gateway
 * hands it `await request.json()` — so a caller may leave out every field the
 * contract gives a default, exactly as a browser would. Each method parses
 * before it does anything else, and the parsed value is what gets stored and
 * what gets hashed into the write intent.
 */

/** The body `create` accepts: `{ writeId, record }` with contract defaults optional. */
export type CreateRequestInput = z.input<typeof CreateRequestBody>;
/** The body `update` accepts: `{ writeId, expectedVersion, patch }`. */
export type UpdateRequestInput = z.input<typeof UpdateRequestBody>;
/** The query `list` accepts; `limit` arrives as an unparsed query-string value. */
export type ListRequestsInput = z.input<typeof ListRequestsQuery>;

/** Construction arguments for {@link TrackerDataStore}. */
export interface TrackerDataStoreOptions {
  /** The open database for this one app. */
  backend: DataBackend;
  /** The app this store serves. Every `DataContext` must name the same app. */
  appId: string;
  /** Overrides for the enforced limits. Defaults come from `DEFAULT_LIMITS`. */
  limits?: { storageBytes: number };
}

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
 * The fixed broker's `AppDataStore` over one app's SQL database.
 *
 * ponytail: the write-id ledger grows until `purgeExpiredWrites()` is called;
 * nothing in this class schedules that sweep. The release ticker (W7) or an ops
 * job has to run it, otherwise the ledger keeps every write id for the life of
 * the app rather than for the contract's 30 days.
 */
export class TrackerDataStore implements AppDataStore {
  /** The app whose database this store is bound to. */
  readonly appId: string;
  /** The enforced storage ceiling for this app, in logical bytes. */
  readonly storageLimitBytes: number;

  private readonly backend: DataBackend;

  constructor(options: TrackerDataStoreOptions) {
    this.backend = options.backend;
    this.appId = options.appId;
    this.storageLimitBytes = options.limits?.storageBytes ?? DEFAULT_LIMITS.storageBytes;
  }

  /**
   * A page of equipment requests, newest first.
   *
   * Keyset pagination on `(created_at DESC, id DESC)` — never `OFFSET`, so a
   * record created while the caller pages does not shift the window and make it
   * skip or repeat a row. `nextCursor` is present only when another page exists.
   *
   * ponytail: `status` and `category` are filtered by scanning the ordering
   * index, because a filtered index would have to be chosen per query and the
   * pilot's row counts do not justify it. A very large app would want an index
   * per filter combination, or a covering index on `(status, created_at, id)`.
   *
   * ponytail: two requests created in the same millisecond share a `created_at`
   * and are ordered by id, not by which was written first. The order is still
   * total and stable — pagination is correct — but "newest first" is only
   * millisecond-accurate. Fixing it needs either a monotonic sequence column or
   * a deliberately distorted timestamp, both of which change the frozen v1
   * record shape.
   */
  async list(ctx: DataContext, query: ListRequestsInput): Promise<ListRequestsResult> {
    this.assertApp(ctx.appId);
    this.assertGranted(ctx);
    const parsed = parseOrThrow(ListRequestsQuery, query, "list query");
    const cursor = parsed.cursor === undefined ? null : decodeCursor(parsed.cursor);

    const rows = this.backend.all<RequestRow>(SELECT_REQUESTS_PAGE, [
      parsed.status ?? null,
      parsed.status ?? null,
      parsed.category ?? null,
      parsed.category ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      parsed.limit + 1,
    ]);

    const items = rows.slice(0, parsed.limit).map(toRecord);
    const hasMore = rows.length > parsed.limit && items.length > 0;
    return hasMore ? { items, nextCursor: encodeCursor(items[items.length - 1]) } : { items };
  }

  /** One equipment request, or null when this app has no record with that id. */
  async get(ctx: DataContext, id: string): Promise<EquipmentRequest | null> {
    this.assertApp(ctx.appId);
    this.assertGranted(ctx);
    const row = this.backend.get<RequestRow>(SELECT_REQUEST_BY_ID, [id]);
    return row ? toRecord(row) : null;
  }

  /**
   * Creates one equipment request.
   *
   * Editor or owner only. In one transaction: replay the write id if it has
   * been seen (refusing it outright when the same id carries a different
   * intent), insert the record only if it fits the storage quota, move the
   * logical-byte counter, and record the write id with its result. A caller who
   * never sees the response can retry the same write id and gets the same
   * record back rather than a second one.
   */
  async create(ctx: DataContext, body: CreateRequestInput): Promise<MutationResult> {
    this.assertApp(ctx.appId);
    this.assertEditor(ctx, "create");
    const parsed = parseOrThrow(CreateRequestBody, body, "create request body");
    const intentHash = writeIntentHash("create", this.appId, ctx.subject, null, parsed);

    return this.backend.transaction(() => {
      const replayed = this.replayOf(parsed.writeId, intentHash);
      if (replayed) return replayed;

      const now = new Date().toISOString();
      const record: EquipmentRequest = {
        id: randomUUID(),
        ...parsed.record,
        version: 1,
        createdBy: ctx.subject,
        createdByEmail: ctx.email,
        createdAt: now,
        updatedBy: ctx.subject,
        updatedByEmail: ctx.email,
        updatedAt: now,
      };
      const bytes = logicalBytes(record);

      const inserted = this.backend.run(INSERT_REQUEST_WITHIN_QUOTA, [
        ...insertColumns(record, bytes),
        bytes,
        this.storageLimitBytes,
      ]);
      // The quota comparison is part of the INSERT, so zero rows means the
      // quota and nothing else. Throwing rolls the whole transaction back.
      if (inserted.changes !== 1) throw this.quotaExceeded(bytes);

      this.backend.run(UPDATE_STORAGE_ADD, [bytes]);
      this.recordWrite(parsed.writeId, ctx.subject, "create", record.id, intentHash, 201, record, now);
      return { record, replayed: false };
    });
  }

  /**
   * Applies a patch to one equipment request.
   *
   * Editor or owner only. The caller states the version it edited; a mismatch
   * is `stale_version` carrying the current record, and nothing is written —
   * not even the write id, because the caller has to re-base and retry under a
   * *new* write id, and reserving the old one would refuse that retry.
   */
  async update(ctx: DataContext, id: string, body: UpdateRequestInput): Promise<MutationResult> {
    this.assertApp(ctx.appId);
    this.assertEditor(ctx, "update");
    const parsed = parseOrThrow(UpdateRequestBody, body, "update request body");
    const patch = parsed.patch;
    const named = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);
    if (named.length === 0) {
      throw new HostedError("invalid_input", "The patch names no fields, so there is nothing to change.", {
        fix: "Include at least one of title, details, category, quantity, priority, status, requestedFor or neededBy in the patch.",
        details: { issues: [{ path: "patch", code: "too_small", message: "must name at least one field" }] },
      });
    }
    const intentHash = writeIntentHash("update", this.appId, ctx.subject, id, parsed);

    return this.backend.transaction(() => {
      const replayed = this.replayOf(parsed.writeId, intentHash);
      if (replayed) return replayed;

      const currentRow = this.backend.get<RequestRow>(SELECT_REQUEST_BY_ID, [id]);
      if (!currentRow) throw notFound(id);
      const current = toRecord(currentRow);
      if (current.version !== parsed.expectedVersion) {
        throw staleVersion(parsed.expectedVersion, current);
      }

      const now = new Date().toISOString();
      const next: EquipmentRequest = {
        ...current,
        title: patch.title ?? current.title,
        details: patch.details ?? current.details,
        category: patch.category ?? current.category,
        quantity: patch.quantity ?? current.quantity,
        priority: patch.priority ?? current.priority,
        status: patch.status ?? current.status,
        requestedFor: patch.requestedFor ?? current.requestedFor,
        neededBy: "neededBy" in patch ? (patch.neededBy ?? null) : current.neededBy,
        version: current.version + 1,
        updatedBy: ctx.subject,
        updatedByEmail: ctx.email,
        updatedAt: now,
      };
      const bytes = logicalBytes(next);
      const delta = bytes - currentRow.logical_bytes;
      // Only growth can breach the quota; a patch that shrinks a record is
      // always allowed, which is what lets an app at its ceiling recover.
      if (delta > 0 && this.currentStorageBytes() + delta > this.storageLimitBytes) {
        throw this.quotaExceeded(delta);
      }

      const swapped = this.backend.run(UPDATE_REQUEST_CAS, [
        next.title,
        next.details,
        next.category,
        next.quantity,
        next.priority,
        next.status,
        next.requestedFor,
        next.neededBy,
        next.updatedBy,
        next.updatedByEmail,
        next.updatedAt,
        bytes,
        id,
        parsed.expectedVersion,
      ]);
      if (swapped.changes !== 1) {
        // The version moved between the read and the swap. Re-read and answer
        // with what is actually stored now, rather than what we had read.
        const reread = this.backend.get<RequestRow>(SELECT_REQUEST_BY_ID, [id]);
        if (!reread) throw notFound(id);
        throw staleVersion(parsed.expectedVersion, toRecord(reread));
      }

      this.backend.run(UPDATE_STORAGE_ADD, [delta]);
      this.recordWrite(parsed.writeId, ctx.subject, "update", id, intentHash, 200, next, now);
      return { record: next, replayed: false };
    });
  }

  /** Logical bytes currently stored by this app. See `bytes.ts` for what that measures. */
  async storageBytes(appId: string): Promise<number> {
    this.assertApp(appId);
    return this.currentStorageBytes();
  }

  /** The tracker schema version this app's data was migrated to. */
  async schemaVersion(appId: string): Promise<number> {
    this.assertApp(appId);
    return readSchemaVersion(this.backend);
  }

  /**
   * Drops write-ledger rows older than `TRACKER_LIMITS.writeIdRetentionMs` and
   * returns how many went. After a write id is purged, a retry carrying it is
   * treated as a new write — which is exactly why the retention window is part
   * of the published contract.
   */
  async purgeExpiredWrites(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - TRACKER_LIMITS.writeIdRetentionMs).toISOString();
    return this.backend.transaction(() => this.backend.run(DELETE_WRITES_BEFORE, [cutoff]).changes);
  }

  /* ------------------------------- internals ------------------------------ */

  /**
   * The stored result for a write id, or null when this id is new.
   *
   * ponytail: a replay returns the record JSON exactly as it was recorded at
   * the time of the original write. After an additive migration adds a nullable
   * column, a replay of a write made before it still answers the pre-migration
   * shape, until that write id ages out of the retention window. Re-reading the
   * record instead would be wrong in the other direction — it would answer with
   * changes the original caller never made.
   */
  private replayOf(writeId: string, intentHash: string): MutationResult | null {
    const row = this.backend.get<WriteRow>(SELECT_WRITE_BY_ID, [writeId]);
    if (!row) return null;
    if (row.intent_hash !== intentHash) {
      throw new HostedError(
        "idempotency_conflict",
        "This writeId was already used for a different change, so it cannot be reused for this one.",
        {
          fix: "Send this change with a new writeId. Reuse a writeId only to retry the identical request.",
          details: { writeId, firstUsedAt: row.created_at, firstOperation: row.op },
        }
      );
    }
    return { record: JSON.parse(row.result) as EquipmentRequest, replayed: true };
  }

  private recordWrite(
    writeId: string,
    subject: string,
    op: "create" | "update",
    recordId: string,
    intentHash: string,
    statusCode: number,
    record: EquipmentRequest,
    now: string
  ): void {
    this.backend.run(INSERT_WRITE, [
      writeId,
      subject,
      op,
      recordId,
      intentHash,
      statusCode,
      JSON.stringify(record),
      now,
    ]);
  }

  private currentStorageBytes(): number {
    return Number(this.backend.get<{ logical_bytes: number }>(SELECT_STORAGE_BYTES)?.logical_bytes ?? 0);
  }

  private quotaExceeded(required: number): HostedError {
    const used = this.currentStorageBytes();
    return new HostedError(
      "quota_exceeded",
      `This app has used ${used} of its ${this.storageLimitBytes} logical bytes and this change needs ${required} more. ` +
        `${LOGICAL_BYTES_DISCLOSURE} Nothing was deleted — every request already stored is retained.`,
      {
        fix: "Free space by shortening or removing details on requests that are finished, or ask Zenith to raise this app's storage limit.",
        details: {
          usedLogicalBytes: used,
          limitLogicalBytes: this.storageLimitBytes,
          requiredLogicalBytes: required,
        },
      }
    );
  }

  private assertApp(appId: string): void {
    if (appId === this.appId) return;
    throw new HostedError(
      "forbidden",
      `This data store serves app ${this.appId}, but the request named app ${appId}.`,
      { fix: "Open the other app's store with openAppData(appId); one store never reaches another app's database." }
    );
  }

  private assertGranted(ctx: DataContext): void {
    if (roleRank(ctx.role) !== undefined) return;
    throw new HostedError(
      "forbidden",
      `"${String(ctx.role)}" is not a role this app grants, so it cannot read this app's requests.`,
      { fix: "Ask an owner of this app to invite you as a viewer, editor or owner." }
    );
  }

  private assertEditor(ctx: DataContext, verb: "create" | "update"): void {
    const rank = roleRank(ctx.role);
    if (rank !== undefined && rank >= APP_ROLE_RANK.editor) return;
    const role = rank === undefined ? `"${String(ctx.role)}", which is not a role this app grants` : ctx.role;
    throw new HostedError(
      "forbidden",
      `Your role on this app is ${role}; viewers can read equipment requests but cannot ${verb} them.`,
      { fix: "Ask an owner of this app to change your role to editor, then try again." }
    );
  }
}

/* -------------------------------- helpers --------------------------------- */

/**
 * The rank of a role, or undefined when it is not one this app grants.
 *
 * Deliberately an own-property check rather than `APP_ROLE_RANK[role]`: plain
 * bracket access finds inherited keys, so a context carrying the role
 * `"constructor"` or `"toString"` would otherwise read as a known role.
 */
function roleRank(role: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(APP_ROLE_RANK, role)
    ? APP_ROLE_RANK[role as keyof typeof APP_ROLE_RANK]
    : undefined;
}

/** The 17 bound values of `INSERT_REQUEST_WITHIN_QUOTA`, in column order. */
function insertColumns(record: EquipmentRequest, bytes: number): (string | number | null)[] {
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
function toRecord(row: RequestRow): EquipmentRequest {
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

/**
 * The opaque page cursor: base64url of the last row's ordering key.
 *
 * ponytail: the cursor is opaque but unauthenticated — it carries no
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

function cursorRejected(): HostedError {
  return new HostedError("invalid_input", "That page cursor is not one this app issued.", {
    fix: "Drop the cursor to start from the first page, or use the nextCursor value exactly as it was returned.",
    details: { issues: [{ path: "cursor", code: "custom", message: "not a cursor issued by this app" }] },
  });
}

function notFound(id: string): HostedError {
  return new HostedError("not_found", `This app has no equipment request with id ${id}.`, {
    fix: "Reload the list — the id may belong to another app, or the request may never have been created.",
  });
}

function staleVersion(expectedVersion: number, current: EquipmentRequest): HostedError {
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
function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
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
