import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { ApiError } from "@/lib/server/errors";
import type { WaitlistAdmissionHistory, WaitlistAdmissionHistoryDetail, WaitlistAdmissionPreview, WaitlistAdmissionResult, WaitlistAdmissionSelection, WaitlistEntry, WaitlistPage, WaitlistRepository, WaitlistStatus, WaitlistSubmission } from "./types";
import { waitlistHistoryDetailSchema, waitlistHistorySchema, waitlistListSchema, waitlistPreviewIdSchema, waitlistPreviewSchema, waitlistSubmissionSchema } from "./validation";
import { WaitlistPreviewExpiredError } from "./errors";

type Row = {
  id: string; email: string; name: string; features_json: string; occupation: string; use_case: string; position: number;
  status: WaitlistStatus; created_at: string; admitted_at: string | null; admitted_by: string | null;
};

type BatchRow = {
  request_id: string; actor_id: string; requested_count: number; admitted_count: number;
  created_at: string; mode: WaitlistAdmissionSelection["mode"];
};

function batch(row: BatchRow): WaitlistAdmissionHistory["batches"][number] {
  return {
    requestId: row.request_id, actorId: row.actor_id, requestedCount: row.requested_count,
    admittedCount: row.admitted_count, createdAt: row.created_at, mode: row.mode,
  };
}

function entry(row: Row): WaitlistEntry {
  return {
    id: row.id, email: row.email, name: row.name, features: JSON.parse(row.features_json) as string[],
    occupation: row.occupation, useCase: row.use_case,
    position: row.position, status: row.status, createdAt: row.created_at,
    admittedAt: row.admitted_at, admittedBy: row.admitted_by,
  };
}

/**
 * The embedded waitlist is its own SQLite file. BEGIN IMMEDIATE serializes
 * admissions across connections/processes and commit precedes every response.
 * File storage requires a persistent local disk; serverless uses Postgres.
 */
export class FileWaitlistRepository implements WaitlistRepository {
  private readonly sql: DatabaseSync;

  constructor(file: string, private readonly clock: () => number = Date.now) {
    if (file !== ":memory:") {
      if (!path.isAbsolute(file)) throw new Error("Waitlist storage requires an absolute path.");
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (!existsSync(file)) {
        try { closeSync(openSync(file, "wx", 0o600)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Waitlist storage must be a regular private file.");
    }
    this.sql = new DatabaseSync(file);
    this.sql.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS waitlist_entries (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE CHECK(email=lower(trim(email))),
        occupation TEXT NOT NULL,
        use_case TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','admitted')),
        created_at TEXT NOT NULL,
        admitted_at TEXT,
        admitted_by TEXT,
        CHECK ((status='queued' AND admitted_at IS NULL AND admitted_by IS NULL)
          OR (status='admitted' AND admitted_at IS NOT NULL AND admitted_by IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS waitlist_status_position ON waitlist_entries(status,position);
      CREATE TABLE IF NOT EXISTS waitlist_batches (
        request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, requested_count INTEGER NOT NULL,
        entries_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS waitlist_previews (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, mode TEXT NOT NULL,
        entry_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS waitlist_rate_limits (
        key TEXT NOT NULL, window_seconds INTEGER NOT NULL, bucket INTEGER NOT NULL,
        count INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(key,window_seconds,bucket)
      );
      CREATE INDEX IF NOT EXISTS waitlist_rate_expiry ON waitlist_rate_limits(expires_at);
    `);
    // Upgrade existing local queues without rewriting entries or admission history.
    // The write lock also serializes first-open upgrades across processes.
    this.transaction(() => {
      const columns = this.sql.prepare("PRAGMA table_info(waitlist_entries)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "name"))
        this.sql.exec("ALTER TABLE waitlist_entries ADD COLUMN name TEXT NOT NULL DEFAULT ''");
      if (!columns.some((column) => column.name === "features_json"))
        this.sql.exec("ALTER TABLE waitlist_entries ADD COLUMN features_json TEXT NOT NULL DEFAULT '[]'");
      const batchColumns = this.sql.prepare("PRAGMA table_info(waitlist_batches)").all() as Array<{ name: string }>;
      if (!batchColumns.some((column) => column.name === "preview_id"))
        this.sql.exec("ALTER TABLE waitlist_batches ADD COLUMN preview_id TEXT");
      if (!batchColumns.some((column) => column.name === "mode"))
        this.sql.exec("ALTER TABLE waitlist_batches ADD COLUMN mode TEXT NOT NULL DEFAULT 'next'");
      this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS waitlist_batch_preview ON waitlist_batches(preview_id) WHERE preview_id IS NOT NULL");
    });
  }

  close(): void { this.sql.close(); }

  private transaction<T>(body: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.sql.exec("COMMIT");
      return result;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  async join(input: WaitlistSubmission): Promise<void> {
    const parsed = waitlistSubmissionSchema.parse(input);
    this.sql.prepare(`INSERT INTO waitlist_entries
      (id,email,name,occupation,features_json,use_case,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(email) DO NOTHING`).run(
      randomUUID(), parsed.email, parsed.name, parsed.occupation, JSON.stringify(parsed.features), parsed.useCase, new Date(this.clock()).toISOString()
    );
  }

  async list(options: { status?: WaitlistStatus; after?: number; limit: number; q?: string }): Promise<WaitlistPage> {
    const { status, after = 0, limit, q = "" } = waitlistListSchema.parse(options);
    return this.transaction(() => {
      // instr treats percent and underscore as literal text, not LIKE wildcards.
      const filter = `(? IS NULL OR status=?) AND (
        instr(lower(email), lower(?)) > 0 OR instr(lower(name), lower(?)) > 0
        OR instr(lower(occupation), lower(?)) > 0 OR instr(lower(use_case), lower(?)) > 0
        OR EXISTS (SELECT 1 FROM json_each(features_json) WHERE instr(lower(value), lower(?)) > 0)
      )`;
      const args = [status ?? null, status ?? null, q, q, q, q, q];
      const rows = this.sql.prepare(`SELECT * FROM waitlist_entries
        WHERE position > ? AND ${filter} ORDER BY position LIMIT ?`)
        .all(after, ...args, limit + 1) as Row[];
      const counts = this.sql.prepare(`SELECT count(*) AS total,
        coalesce(sum(CASE WHEN status='queued' THEN 1 ELSE 0 END),0) AS queued,
        coalesce(sum(CASE WHEN status='admitted' THEN 1 ELSE 0 END),0) AS admitted
        FROM waitlist_entries`).get() as { total: number; queued: number; admitted: number };
      const matched = this.sql.prepare(`SELECT count(*) AS count FROM waitlist_entries WHERE ${filter}`)
        .get(...args) as { count: number };
      return {
        entries: rows.slice(0, limit).map(entry), ...counts, matched: matched.count,
        nextCursor: rows.length > limit ? rows[limit - 1].position : null,
      };
    });
  }

  async admit(count: number, actorId: string, requestId: string): Promise<WaitlistEntry[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000
      || !actorId.trim() || actorId.length > 200 || !requestId.trim() || requestId.length > 128)
      throw new ApiError("Invalid waitlist admission request.", 400);
    return this.transaction(() => {
      const previous = this.sql.prepare("SELECT * FROM waitlist_batches WHERE request_id=?")
        .get(requestId) as { actor_id: string; requested_count: number; entries_json: string; preview_id: string | null } | undefined;
      if (previous) {
        if (previous.actor_id !== actorId || previous.requested_count !== count || previous.preview_id !== null)
          throw new ApiError("This admission request was already used with different parameters.", 409);
        return (JSON.parse(previous.entries_json) as WaitlistEntry[])
          .map((saved) => ({ ...saved, name: saved.name ?? "", features: saved.features ?? [] }));
      }
      const queued = this.sql.prepare("SELECT * FROM waitlist_entries WHERE status='queued' ORDER BY position LIMIT ?")
        .all(count) as Row[];
      const now = new Date(this.clock()).toISOString();
      const update = this.sql.prepare("UPDATE waitlist_entries SET status='admitted',admitted_at=?,admitted_by=? WHERE position=?");
      const admitted = queued.map((row) => {
        update.run(now, actorId, row.position);
        return entry({ ...row, status: "admitted", admitted_at: now, admitted_by: actorId });
      });
      this.sql.prepare("INSERT INTO waitlist_batches(request_id,actor_id,requested_count,entries_json,created_at) VALUES(?,?,?,?,?)")
        .run(requestId, actorId, count, JSON.stringify(admitted), now);
      return admitted;
    });
  }

  async preview(selection: WaitlistAdmissionSelection, actorId: string): Promise<WaitlistAdmissionPreview> {
    const parsed = waitlistPreviewSchema.safeParse(selection);
    if (!parsed.success || !actorId.trim() || actorId.length > 200)
      throw new ApiError("Invalid waitlist approval preview.", 400);
    return this.transaction(() => {
      const selected = parsed.data;
      let ids: string[];
      if (selected.mode === "selected") {
        const rows = this.sql.prepare(`SELECT id,status FROM waitlist_entries
          WHERE id IN (SELECT value FROM json_each(?)) ORDER BY position`)
          .all(JSON.stringify(selected.entryIds)) as Array<{ id: string; status: WaitlistStatus }>;
        if (rows.length !== selected.entryIds.length)
          throw new ApiError("One or more selected waitlist entries no longer exist.", 400);
        ids = rows.filter((row) => row.status === "queued").map((row) => row.id);
      } else {
        ids = (this.sql.prepare(`SELECT id FROM waitlist_entries WHERE status='queued' ORDER BY position LIMIT ?`)
          .all(selected.mode === "next" ? selected.count : -1) as Array<{ id: string }>).map((row) => row.id);
      }
      const id = randomUUID();
      const createdAt = new Date(this.clock()).toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + 86_400_000).toISOString();
      this.sql.prepare(`INSERT INTO waitlist_previews(id,actor_id,mode,entry_ids_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?)`).run(id, actorId, selected.mode, JSON.stringify(ids), createdAt, expiresAt);
      const rows = this.sql.prepare(`SELECT * FROM waitlist_entries
        WHERE id IN (SELECT value FROM json_each(?)) ORDER BY position`)
        .all(JSON.stringify(ids.slice(0, 100))) as Row[];
      return { id, mode: selected.mode, count: ids.length, entries: rows.map(entry), createdAt, expiresAt };
    });
  }

  async admitPreview(previewId: string, actorId: string, requestId: string): Promise<WaitlistAdmissionResult> {
    if (!waitlistPreviewIdSchema.safeParse(previewId).success
      || !actorId.trim() || actorId.length > 200 || !requestId.trim() || requestId.length > 128)
      throw new ApiError("Invalid waitlist admission request.", 400);
    previewId = previewId.toLowerCase();
    return this.transaction(() => {
      const previous = this.sql.prepare(`SELECT actor_id,preview_id,json_array_length(entries_json) AS admitted_count
        FROM waitlist_batches WHERE request_id=?`)
        .get(requestId) as { actor_id: string; preview_id: string | null; admitted_count: number } | undefined;
      if (previous) {
        if (previous.actor_id !== actorId || previous.preview_id !== previewId)
          throw new ApiError("This admission request was already used with different parameters.", 409);
        return { count: previous.admitted_count, requestId };
      }
      const preview = this.sql.prepare("SELECT * FROM waitlist_previews WHERE id=?").get(previewId) as {
        actor_id: string; mode: WaitlistAdmissionSelection["mode"]; entry_ids_json: string; expires_at: string;
      } | undefined;
      if (!preview || preview.actor_id !== actorId)
        throw new ApiError("This approval preview is unavailable. Review a new preview.", 409);
      if (this.sql.prepare("SELECT 1 FROM waitlist_batches WHERE preview_id=?").get(previewId))
        throw new ApiError("This preview has already been approved. Refresh the queue.", 409);
      if (Date.parse(preview.expires_at) <= this.clock()) throw new WaitlistPreviewExpiredError();
      const queued = this.sql.prepare(`SELECT * FROM waitlist_entries WHERE status='queued'
        AND id IN (SELECT value FROM json_each(?)) ORDER BY position`).all(preview.entry_ids_json) as Row[];
      const now = new Date(this.clock()).toISOString();
      const update = this.sql.prepare("UPDATE waitlist_entries SET status='admitted',admitted_at=?,admitted_by=? WHERE position=?");
      const admitted = queued.map((row) => {
        update.run(now, actorId, row.position);
        return entry({ ...row, status: "admitted", admitted_at: now, admitted_by: actorId });
      });
      this.sql.prepare(`INSERT INTO waitlist_batches
        (request_id,actor_id,requested_count,entries_json,created_at,preview_id,mode) VALUES(?,?,?,?,?,?,?)`)
        .run(requestId, actorId, (JSON.parse(preview.entry_ids_json) as string[]).length,
          JSON.stringify(admitted), now, previewId, preview.mode);
      return { count: admitted.length, requestId };
    });
  }

  async history(options: { limit: number }): Promise<WaitlistAdmissionHistory> {
    const parsed = waitlistHistorySchema.safeParse(options);
    if (!parsed.success) throw new ApiError("Invalid approval history query.", 400);
    const rows = this.sql.prepare(`SELECT request_id,actor_id,requested_count,created_at,mode,
      json_array_length(entries_json) AS admitted_count FROM waitlist_batches
      ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(parsed.data.limit) as BatchRow[];
    return { batches: rows.map(batch) };
  }

  async historyDetail(requestId: string, options: { offset?: number; limit?: number } = {}): Promise<WaitlistAdmissionHistoryDetail> {
    const parsed = waitlistHistoryDetailSchema.safeParse(options);
    if (!parsed.success || !requestId.trim() || requestId.length > 128)
      throw new ApiError("Invalid approval history request.", 400);
    const row = this.sql.prepare(`SELECT request_id,actor_id,requested_count,created_at,mode,
      json_array_length(entries_json) AS admitted_count FROM waitlist_batches WHERE request_id=?`)
      .get(requestId) as BatchRow | undefined;
    if (!row) throw new ApiError("This approval batch was not found.", 404);
    const { offset, limit } = parsed.data;
    // Slice the immutable audit in SQLite, so large batches never cross this
    // adapter boundary as an unbounded profile array, including after a retry.
    const rows = this.sql.prepare(`SELECT value FROM json_each(
      (SELECT entries_json FROM waitlist_batches WHERE request_id=?))
      ORDER BY CAST(key AS INTEGER) LIMIT ? OFFSET ?`).all(requestId, limit, offset) as Array<{ value: string }>;
    const entries = rows.map(({ value }) => {
      const saved = JSON.parse(value) as WaitlistEntry;
      return { ...saved, name: saved.name ?? "", features: saved.features ?? [] };
    });
    return {
      batch: batch(row), entries,
      nextOffset: offset + entries.length < row.admitted_count ? offset + entries.length : null,
    };
  }

  async admitted(email: string): Promise<boolean> {
    return Boolean(this.sql.prepare("SELECT 1 FROM waitlist_entries WHERE email=? AND status='admitted'")
      .get(email.trim().toLowerCase()));
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (!key || key.length > 128 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000
      || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86400)
      throw new ApiError("Invalid waitlist rate-limit configuration.", 503);
    return this.transaction(() => {
      const now = Math.floor(this.clock() / 1000);
      const bucket = Math.floor(now / windowSeconds);
      this.sql.prepare("DELETE FROM waitlist_rate_limits WHERE expires_at <= ?").run(now);
      this.sql.prepare(`INSERT INTO waitlist_rate_limits(key,window_seconds,bucket,count,expires_at)
        VALUES(?,?,?,1,?) ON CONFLICT(key,window_seconds,bucket)
        DO UPDATE SET count=min(waitlist_rate_limits.count+1,?)`)
        .run(key, windowSeconds, bucket, (bucket + 1) * windowSeconds, limit + 1);
      const row = this.sql.prepare("SELECT count FROM waitlist_rate_limits WHERE key=? AND window_seconds=? AND bucket=?")
        .get(key, windowSeconds, bucket) as { count: number };
      return row.count <= limit;
    });
  }
}