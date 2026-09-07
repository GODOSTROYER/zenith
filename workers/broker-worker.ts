/**
 * The fixed broker, as a Cloudflare Worker over D1.
 *
 * This is the trusted half of the platform on the edge: one script per app,
 * uploaded by Zenith, holding the app's only data capability (`DB`). Nothing an
 * app author writes runs here, and the release script that does run their code
 * has no database binding at all — that separation is the whole isolation
 * argument, and `readBindings()` in the Cloudflare runtime is what checks it.
 *
 * **The SQL is not rewritten for D1.** Every statement below is copied
 * character for character from `src/lib/hosted/data/sql.ts`, and
 * `tests/hosted/runtime/workers.test.ts` asserts they are still identical. Two
 * runtimes that answer the same contract with different SQL is exactly how a
 * conflict rule ends up firing on one and not the other.
 *
 * What is different, and why, is D1's lack of interactive transactions: a batch
 * is one transaction, but a conditional `INSERT` that matches no row is not a
 * failure, so it commits alongside its neighbours. The create path therefore
 * compensates — see `D1_DELETE_WRITE` — and that compensation is the one
 * statement here that is *not* shared. It is also the reason the "data
 * transactions" gate in docs/hosted/DECISIONS.md stays open until this runs
 * against real D1.
 *
 * NOT VERIFIED LIVE. See README.md in this directory.
 *
 * Workstream W6 (hosted R3).
 */

/* ------------------------- SQL copied from sql.ts ------------------------- */

/** Copied from `src/lib/hosted/data/sql.ts`. */
const REQUEST_COLUMNS = `id, title, details, category, quantity, priority, status,
  requested_for, needed_by, version, created_by, created_by_email, created_at,
  updated_by, updated_by_email, updated_at, logical_bytes`;

/**
 * The statements this worker issues, byte-identical to the local runtime's.
 * The test that guards this compares each entry with `trackerSql`.
 */
export const BROKER_SQL = {
  SELECT_REQUEST_BY_ID: `SELECT ${REQUEST_COLUMNS} FROM equipment_requests WHERE id = ?`,

  SELECT_REQUESTS_PAGE: `
SELECT ${REQUEST_COLUMNS}
FROM equipment_requests
WHERE (? IS NULL OR status = ?)
  AND (? IS NULL OR category = ?)
  AND (? IS NULL OR (created_at < ? OR (created_at = ? AND id < ?)))
ORDER BY created_at DESC, id DESC
LIMIT ?`,

  INSERT_REQUEST_WITHIN_QUOTA: `
INSERT INTO equipment_requests (${REQUEST_COLUMNS})
SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
WHERE (SELECT logical_bytes FROM storage WHERE id = 1) + ? <= ?`,

  UPDATE_REQUEST_CAS: `
UPDATE equipment_requests
SET title = ?, details = ?, category = ?, quantity = ?, priority = ?, status = ?,
    requested_for = ?, needed_by = ?,
    version = version + 1,
    updated_by = ?, updated_by_email = ?, updated_at = ?, logical_bytes = ?
WHERE id = ? AND version = ?`,

  SELECT_STORAGE_BYTES: "SELECT logical_bytes FROM storage WHERE id = 1",

  UPDATE_STORAGE_ADD: "UPDATE storage SET logical_bytes = logical_bytes + ? WHERE id = 1",

  SELECT_WRITE_BY_ID: `
SELECT write_id, subject, op, record_id, intent_hash, status_code, result, created_at
FROM writes WHERE write_id = ?`,

  INSERT_WRITE: `
INSERT INTO writes (write_id, subject, op, record_id, intent_hash, status_code, result, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
} as const;

/**
 * The one statement here that has no counterpart in `sql.ts`.
 *
 * D1 has no interactive transaction, so a conditional insert that the storage
 * quota rejected commits its neighbours anyway. This undoes the write-ledger
 * row so the caller's write id is free to be retried once space exists. The
 * storage total is undone with `UPDATE_STORAGE_ADD` and a negative delta.
 */
export const D1_DELETE_WRITE = "DELETE FROM writes WHERE write_id = ?";

/* ----------------------- contract constants (copied) ---------------------- */

const LIMITS = { title: 120, details: 2000, requestedFor: 120, quantityMax: 99, listMax: 100, listDefault: 25 };
const CATEGORIES = ["laptop", "monitor", "peripheral", "software", "furniture", "other"];
const PRIORITIES = ["low", "normal", "high"];
const STATUSES = ["requested", "approved", "ordered", "delivered", "declined"];
const SCHEMA_VERSION = 1;
const ROW_OVERHEAD_BYTES = 64;
const STORAGE_LIMIT_BYTES = 100 * 1_048_576;
const BODY_LIMIT_BYTES = 1_048_576;
const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };

/** Bindings this worker is deployed with. Exactly one, and it is the app's own database. */
export interface BrokerWorkerEnv {
  DB: D1Database;
}

/** What the dispatch worker tells this one about the admitted caller. */
export interface BrokerIdentity {
  subject: string;
  email: string;
  role: string;
  releaseId: string;
}

interface Refusal {
  status: number;
  code: string;
  message: string;
  fix: string;
  details?: Record<string, unknown>;
}

class BrokerError extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

const bad = (status: number, code: string, message: string, fix: string, details?: Record<string, unknown>): BrokerError =>
  new BrokerError({ status, code, message, fix, details });

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", ...headers },
  });

/* --------------------------------- record --------------------------------- */

/** One equipment request as the contract defines it. */
export interface EquipmentRecord {
  id: string;
  title: string;
  details: string;
  category: string;
  quantity: number;
  priority: string;
  status: string;
  requestedFor: string;
  neededBy: string | null;
  version: number;
  createdBy: string;
  createdByEmail: string;
  createdAt: string;
  updatedBy: string;
  updatedByEmail: string;
  updatedAt: string;
}

/** Copied from `src/lib/hosted/data/bytes.ts`: fixed key order, UTF-8, plus a flat allowance. */
export function logicalBytes(record: EquipmentRecord): number {
  const canonical = {
    id: record.id,
    title: record.title,
    details: record.details,
    category: record.category,
    quantity: record.quantity,
    priority: record.priority,
    status: record.status,
    requestedFor: record.requestedFor,
    neededBy: record.neededBy,
    version: record.version,
    createdBy: record.createdBy,
    createdByEmail: record.createdByEmail,
    createdAt: record.createdAt,
    updatedBy: record.updatedBy,
    updatedByEmail: record.updatedByEmail,
    updatedAt: record.updatedAt,
  };
  return new TextEncoder().encode(JSON.stringify(canonical)).length + ROW_OVERHEAD_BYTES;
}

/** Copied from `src/lib/hosted/data/intent.ts`: keys sorted at every depth. */
export function stableStringify(value: unknown): string {
  const sortDeep = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortDeep);
    if (input === null || typeof input !== "object") return input;
    const source = input as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      sorted[key] = sortDeep(source[key]);
    }
    return sorted;
  };
  return JSON.stringify(sortDeep(value));
}

/** SHA-256 hex over the canonical write intent, using the Workers crypto. */
export async function writeIntentHash(
  op: "create" | "update",
  appId: string,
  subject: string,
  recordId: string | null,
  body: unknown
): Promise<string> {
  const intent = { v: SCHEMA_VERSION, op, appId, subject, recordId, body };
  const bytes = new TextEncoder().encode(stableStringify(intent));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SQL row → contract record. The CHECK constraints are what make the casts safe. */
function toRecord(row: Record<string, unknown>): EquipmentRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    details: String(row.details),
    category: String(row.category),
    quantity: Number(row.quantity),
    priority: String(row.priority),
    status: String(row.status),
    requestedFor: String(row.requested_for),
    neededBy: row.needed_by === null || row.needed_by === undefined ? null : String(row.needed_by),
    version: Number(row.version),
    createdBy: String(row.created_by),
    createdByEmail: String(row.created_by_email),
    createdAt: String(row.created_at),
    updatedBy: String(row.updated_by),
    updatedByEmail: String(row.updated_by_email),
    updatedAt: String(row.updated_at),
  };
}

/** The 17 bound values of `INSERT_REQUEST_WITHIN_QUOTA`, in column order. */
function insertColumns(record: EquipmentRecord, bytes: number): unknown[] {
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

/* ------------------------------- validation ------------------------------- */

const asObject = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw bad(400, "invalid_input", `The ${what} must be a JSON object.`, `Send ${what} as a JSON object.`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, field: string, max: number, fallback?: string): string => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string")
    throw bad(400, "invalid_input", `${field} must be text.`, `Send ${field} as a string of at most ${max} characters.`);
  const trimmed = value.trim();
  if (trimmed.length > max)
    throw bad(400, "invalid_input", `${field} is longer than ${max} characters.`, `Shorten ${field} to ${max} characters or fewer.`);
  return trimmed;
};

const oneOf = (value: unknown, field: string, allowed: string[], fallback?: string): string => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value))
    throw bad(400, "invalid_input", `${field} is not one of the values this app accepts.`, `Use one of: ${allowed.join(", ")}.`);
  return value;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate the fields of a record, applying the contract's defaults. */
function validateInput(input: Record<string, unknown>, base?: EquipmentRecord): Omit<EquipmentRecord, "id" | "version" | "createdBy" | "createdByEmail" | "createdAt" | "updatedBy" | "updatedByEmail" | "updatedAt"> {
  const neededByRaw = "neededBy" in input ? input.neededBy : (base?.neededBy ?? null);
  if (neededByRaw !== null && (typeof neededByRaw !== "string" || !DATE_RE.test(neededByRaw)))
    throw bad(400, "invalid_input", "neededBy must be a calendar date.", "Send neededBy as YYYY-MM-DD, or null for no date.");
  const quantityRaw = input.quantity === undefined ? (base?.quantity ?? 1) : input.quantity;
  if (typeof quantityRaw !== "number" || !Number.isInteger(quantityRaw) || quantityRaw < 1 || quantityRaw > LIMITS.quantityMax)
    throw bad(400, "invalid_input", `quantity must be a whole number from 1 to ${LIMITS.quantityMax}.`, `Send a quantity between 1 and ${LIMITS.quantityMax}.`);
  return {
    title: text(input.title, "title", LIMITS.title, base?.title),
    details: text(input.details, "details", LIMITS.details, base?.details ?? ""),
    category: oneOf(input.category, "category", CATEGORIES, base?.category),
    quantity: quantityRaw,
    priority: oneOf(input.priority, "priority", PRIORITIES, base?.priority ?? "normal"),
    status: oneOf(input.status, "status", STATUSES, base?.status ?? "requested"),
    requestedFor: text(input.requestedFor, "requestedFor", LIMITS.requestedFor, base?.requestedFor ?? ""),
    neededBy: neededByRaw as string | null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const writeIdOf = (body: Record<string, unknown>): string => {
  const value = body.writeId;
  if (typeof value !== "string" || !UUID_RE.test(value))
    throw bad(400, "invalid_input", "Every change needs a writeId.", "Send a UUID writeId and reuse it only to retry the identical change.");
  return value;
};

/* -------------------------------- the store ------------------------------- */

/** The identity headers the dispatch worker sets, having stripped any the client sent. */
export function identityOf(request: Request): BrokerIdentity {
  const subject = request.headers.get("x-zenith-subject") ?? "";
  const role = request.headers.get("x-zenith-role") ?? "";
  if (!subject || ROLE_RANK[role] === undefined)
    throw bad(
      401,
      "sign_in_required",
      "This request did not arrive with an admitted identity.",
      "The broker is only reachable through Zenith's dispatch worker; open the app from your Zenith apps page."
    );
  return {
    subject,
    email: request.headers.get("x-zenith-email") ?? "",
    role,
    releaseId: request.headers.get("x-zenith-release") ?? "",
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > BODY_LIMIT_BYTES)
    throw bad(413, "body_too_large", "That change is larger than one request may carry.", `Requests are limited to ${BODY_LIMIT_BYTES} bytes.`);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > BODY_LIMIT_BYTES)
    throw bad(413, "body_too_large", "That change is larger than one request may carry.", `Requests are limited to ${BODY_LIMIT_BYTES} bytes.`);
  try {
    return asObject(JSON.parse(raw || "{}"), "request body");
  } catch (err) {
    if (err instanceof BrokerError) throw err;
    throw bad(400, "invalid_input", "That request body was not valid JSON.", "Send a JSON object.");
  }
}

/** A replayed write, or null when this write id is new. Refuses a reused id with new content. */
async function replayOf(env: BrokerWorkerEnv, writeId: string, intentHash: string): Promise<EquipmentRecord | null> {
  const row = await env.DB.prepare(BROKER_SQL.SELECT_WRITE_BY_ID).bind(writeId).first<Record<string, unknown>>();
  if (!row) return null;
  if (String(row.intent_hash) !== intentHash)
    throw bad(
      409,
      "idempotency_conflict",
      "This writeId was already used for a different change, so it cannot be reused for this one.",
      "Send this change with a new writeId. Reuse a writeId only to retry the identical request.",
      { writeId }
    );
  return JSON.parse(String(row.result)) as EquipmentRecord;
}

async function storageBytes(env: BrokerWorkerEnv): Promise<number> {
  const row = await env.DB.prepare(BROKER_SQL.SELECT_STORAGE_BYTES).first<{ logical_bytes: number }>();
  return Number(row?.logical_bytes ?? 0);
}

async function listRequests(env: BrokerWorkerEnv, url: URL): Promise<Response> {
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? LIMITS.listDefault : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listMax)
    throw bad(400, "invalid_input", `limit must be a whole number from 1 to ${LIMITS.listMax}.`, `Ask for between 1 and ${LIMITS.listMax} requests.`);
  const status = url.searchParams.get("status");
  const category = url.searchParams.get("category");
  if (status !== null && !STATUSES.includes(status))
    throw bad(400, "invalid_input", "That status filter is not one this app uses.", `Filter by one of: ${STATUSES.join(", ")}.`);
  if (category !== null && !CATEGORIES.includes(category))
    throw bad(400, "invalid_input", "That category filter is not one this app uses.", `Filter by one of: ${CATEGORIES.join(", ")}.`);

  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const page = await env.DB.prepare(BROKER_SQL.SELECT_REQUESTS_PAGE)
    .bind(
      status,
      status,
      category,
      category,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1
    )
    .all<Record<string, unknown>>();
  const rows = page.results ?? [];
  const items = rows.slice(0, limit).map(toRecord);
  const hasMore = rows.length > limit && items.length > 0;
  const last = items[items.length - 1];
  return json(
    200,
    hasMore && last ? { items, nextCursor: encodeCursor(last) } : { items }
  );
}

/** The keyset cursor: the ordering key of the last row of a page, base64url. */
function encodeCursor(record: EquipmentRecord): string {
  return btoa(JSON.stringify({ v: 1, at: record.createdAt, id: record.id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(raw: string | null): { at: string; id: string } | null {
  if (!raw) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(padded)) as { v?: number; at?: string; id?: string };
    if (parsed.v !== 1 || typeof parsed.at !== "string" || typeof parsed.id !== "string") throw new Error("shape");
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw bad(400, "invalid_input", "That page cursor is not one this app issued.", "Start from the first page; cursors come from a previous response's nextCursor.");
  }
}

async function createRequest(
  env: BrokerWorkerEnv,
  appId: string,
  who: BrokerIdentity,
  body: Record<string, unknown>
): Promise<Response> {
  const writeId = writeIdOf(body);
  const input = validateInput(asObject(body.record, "record"));
  const intentHash = await writeIntentHash("create", appId, who.subject, null, { writeId, record: input });

  const replayed = await replayOf(env, writeId, intentHash);
  if (replayed) return json(201, { record: replayed }, { "x-zenith-replayed": "true" });

  const now = new Date().toISOString();
  const record: EquipmentRecord = {
    id: crypto.randomUUID(),
    ...input,
    version: 1,
    createdBy: who.subject,
    createdByEmail: who.email,
    createdAt: now,
    updatedBy: who.subject,
    updatedByEmail: who.email,
    updatedAt: now,
  };
  const bytes = logicalBytes(record);

  const results = await env.DB.batch([
    env.DB.prepare(BROKER_SQL.INSERT_REQUEST_WITHIN_QUOTA).bind(...insertColumns(record, bytes), bytes, STORAGE_LIMIT_BYTES),
    env.DB.prepare(BROKER_SQL.UPDATE_STORAGE_ADD).bind(bytes),
    env.DB.prepare(BROKER_SQL.INSERT_WRITE).bind(writeId, who.subject, "create", record.id, intentHash, 201, JSON.stringify(record), now),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    // The quota refused the row, and D1 committed its neighbours anyway.
    await env.DB.batch([
      env.DB.prepare(BROKER_SQL.UPDATE_STORAGE_ADD).bind(-bytes),
      env.DB.prepare(D1_DELETE_WRITE).bind(writeId),
    ]);
    const used = await storageBytes(env);
    throw bad(
      429,
      "quota_exceeded",
      `This app has used ${used} of its ${STORAGE_LIMIT_BYTES} logical bytes and this change needs ${bytes} more.`,
      "Free space by shortening or removing details on requests that are finished, or ask Zenith to raise this app's storage limit.",
      { usedLogicalBytes: used, limitLogicalBytes: STORAGE_LIMIT_BYTES, requiredLogicalBytes: bytes }
    );
  }
  return json(201, { record });
}

async function updateRequest(
  env: BrokerWorkerEnv,
  appId: string,
  who: BrokerIdentity,
  id: string,
  body: Record<string, unknown>
): Promise<Response> {
  const writeId = writeIdOf(body);
  const expectedVersion = body.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1)
    throw bad(400, "invalid_input", "An update must say which version it edited.", "Send expectedVersion, the version number of the record you read.");
  const patch = asObject(body.patch, "patch");
  if (Object.keys(patch).length === 0)
    throw bad(400, "invalid_input", "The patch names no fields, so there is nothing to change.", "Include at least one field in the patch.");

  const intentHash = await writeIntentHash("update", appId, who.subject, id, { writeId, expectedVersion, patch });
  const replayed = await replayOf(env, writeId, intentHash);
  if (replayed) return json(200, { record: replayed }, { "x-zenith-replayed": "true" });

  const currentRow = await env.DB.prepare(BROKER_SQL.SELECT_REQUEST_BY_ID).bind(id).first<Record<string, unknown>>();
  if (!currentRow) throw notFound(id);
  const current = toRecord(currentRow);
  if (current.version !== expectedVersion) throw stale(expectedVersion, current);

  const now = new Date().toISOString();
  const next: EquipmentRecord = {
    ...current,
    ...validateInput(patch, current),
    version: current.version + 1,
    updatedBy: who.subject,
    updatedByEmail: who.email,
    updatedAt: now,
  };
  const bytes = logicalBytes(next);
  const delta = bytes - Number(currentRow.logical_bytes ?? 0);
  if (delta > 0 && (await storageBytes(env)) + delta > STORAGE_LIMIT_BYTES)
    throw bad(
      429,
      "quota_exceeded",
      `This change needs ${delta} more logical bytes than this app has left.`,
      "Free space by shortening details on requests that are finished, or ask Zenith to raise this app's storage limit."
    );

  const results = await env.DB.batch([
    env.DB.prepare(BROKER_SQL.UPDATE_REQUEST_CAS).bind(
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
      expectedVersion
    ),
    env.DB.prepare(BROKER_SQL.UPDATE_STORAGE_ADD).bind(delta),
    env.DB.prepare(BROKER_SQL.INSERT_WRITE).bind(writeId, who.subject, "update", id, intentHash, 200, JSON.stringify(next), now),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    await env.DB.batch([
      env.DB.prepare(BROKER_SQL.UPDATE_STORAGE_ADD).bind(-delta),
      env.DB.prepare(D1_DELETE_WRITE).bind(writeId),
    ]);
    const reread = await env.DB.prepare(BROKER_SQL.SELECT_REQUEST_BY_ID).bind(id).first<Record<string, unknown>>();
    if (!reread) throw notFound(id);
    throw stale(expectedVersion, toRecord(reread));
  }
  return json(200, { record: next });
}

const notFound = (id: string): BrokerError =>
  bad(404, "not_found", "That equipment request no longer exists.", "Go back to the list and open it again.", { id });

const stale = (expectedVersion: number, current: EquipmentRecord): BrokerError =>
  bad(
    409,
    "stale_version",
    "Someone changed this request before you did, so your edit was not applied.",
    "Look at the current version below, decide what you still want to change, and send it again with a new writeId.",
    { expectedVersion, current }
  );

/* --------------------------------- routing -------------------------------- */

const PREFIX = "/_zenith/data/v1/requests";

const brokerWorker = {
  async fetch(request: Request, env: BrokerWorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    void ctx;
    const url = new URL(request.url);
    const appId = request.headers.get("x-zenith-app") ?? url.host;
    try {
      const who = identityOf(request);
      if (!url.pathname.startsWith(PREFIX))
        throw bad(404, "not_found", "That is not one of this app's data paths.", `The broker serves ${PREFIX} and ${PREFIX}/:id.`);
      const rest = url.pathname.slice(PREFIX.length);
      const id = rest === "" || rest === "/" ? null : rest.replace(/^\//, "");
      if (id !== null && id.includes("/"))
        throw bad(404, "not_found", "That is not one of this app's data paths.", `The broker serves ${PREFIX} and ${PREFIX}/:id.`);

      const method = request.method.toUpperCase();
      const allowed = id === null ? ["GET", "POST"] : ["GET", "PATCH"];
      if (!allowed.includes(method))
        return json(
          405,
          { error: { code: "invalid_input", message: "That path does not answer this method.", fix: `Use one of: ${allowed.join(", ")}.` } },
          { allow: allowed.join(", ") }
        );

      if (method === "GET") {
        if (id === null) return await listRequests(env, url);
        const row = await env.DB.prepare(BROKER_SQL.SELECT_REQUEST_BY_ID).bind(id).first<Record<string, unknown>>();
        if (!row) throw notFound(id);
        return json(200, { record: toRecord(row) });
      }

      if ((ROLE_RANK[who.role] ?? -1) < ROLE_RANK.editor)
        throw bad(
          403,
          "forbidden",
          `Your role on this app is ${who.role}; viewers can read equipment requests but cannot change them.`,
          "Ask an owner of this app to change your role to editor, then try again."
        );

      const body = await readBody(request);
      return method === "POST"
        ? await createRequest(env, appId, who, body)
        : await updateRequest(env, appId, who, id as string, body);
    } catch (err) {
      if (err instanceof BrokerError) {
        const { status, code, message, fix, details } = err.refusal;
        return json(status, { error: { code, message, fix, details } });
      }
      return json(500, {
        error: {
          code: "internal",
          message: "Something went wrong on the server while handling this request.",
          fix: "Try again. If it keeps happening, tell the app's owner what you were doing.",
        },
      });
    }
  },
};

export default brokerWorker;
