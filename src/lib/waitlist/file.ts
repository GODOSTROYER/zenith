import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { ApiError } from "@/lib/server/errors";
import type { WaitlistEntry, WaitlistPage, WaitlistRepository, WaitlistStatus, WaitlistSubmission } from "./types";
import { waitlistListSchema, waitlistSubmissionSchema } from "./validation";

type Row = {
  id: string; email: string; occupation: string; use_case: string; position: number;
  status: WaitlistStatus; created_at: string; admitted_at: string | null; admitted_by: string | null;
};

function entry(row: Row): WaitlistEntry {
  return {
    id: row.id, email: row.email, occupation: row.occupation, useCase: row.use_case,
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
      CREATE TABLE IF NOT EXISTS waitlist_rate_limits (
        key TEXT NOT NULL, window_seconds INTEGER NOT NULL, bucket INTEGER NOT NULL,
        count INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(key,window_seconds,bucket)
      );
      CREATE INDEX IF NOT EXISTS waitlist_rate_expiry ON waitlist_rate_limits(expires_at);
    `);
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
      (id,email,occupation,use_case,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(email) DO NOTHING`).run(
      randomUUID(), parsed.email, parsed.occupation, parsed.useCase, new Date(this.clock()).toISOString()
    );
  }

  async list(options: { status?: WaitlistStatus; after?: number; limit: number }): Promise<WaitlistPage> {
    const { status, after = 0, limit } = waitlistListSchema.parse(options);
    return this.transaction(() => {
      const rows = this.sql.prepare(`SELECT * FROM waitlist_entries
        WHERE position > ? AND (? IS NULL OR status=?) ORDER BY position LIMIT ?`)
        .all(after, status ?? null, status ?? null, limit + 1) as Row[];
      const counts = this.sql.prepare(`SELECT count(*) AS total,
        coalesce(sum(CASE WHEN status='queued' THEN 1 ELSE 0 END),0) AS queued,
        coalesce(sum(CASE WHEN status='admitted' THEN 1 ELSE 0 END),0) AS admitted
        FROM waitlist_entries`).get() as { total: number; queued: number; admitted: number };
      return {
        entries: rows.slice(0, limit).map(entry), ...counts,
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
        .get(requestId) as { actor_id: string; requested_count: number; entries_json: string } | undefined;
      if (previous) {
        if (previous.actor_id !== actorId || previous.requested_count !== count)
          throw new ApiError("This admission request was already used with different parameters.", 409);
        return JSON.parse(previous.entries_json) as WaitlistEntry[];
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