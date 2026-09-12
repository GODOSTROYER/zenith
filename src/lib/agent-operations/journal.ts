/** Durable review receipts. Only the Zenith process opens this journal.
 *
 * A dispatch marker commits BEFORE an action is invoked. If that process dies,
 * the operation needs reconciliation; it is never automatically invoked again.
 * This is at-most-once dispatch, not a claim of cross-store exactly-once effects.
 */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export class OperationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message); this.name = "OperationError";
  }
}
export type IntentKind = "manifest" | "import" | "deploy" | "rollback" | "cancel" | "publish" | "rollback_app";
export interface Owner {
  subject: string; credentialId: string; workspaceId: string;
  projectId?: string; environmentId?: string; authorizationHash: string;
}
export interface Intent { kind: IntentKind; input: Record<string, unknown> }
export interface Preview {
  summary: string; details: string[]; risk: "low" | "medium" | "high";
  costDeltaUsd: number; warnings: string[]; requiredRole: "editor" | "admin";
  blocked?: string; requiresApproval: true;
}
export interface Receipt {
  id: string; owner: Owner; intent: Intent; stateHash: string; digest: string;
  preview: Preview; createdAt: number; expiresAt: number;
  state: "prepared" | "approved" | "rejected" | "claimed" | "cancelled";
  approval?: { subject: string; at: number; digest: string };
}
export interface Operation {
  id: string; receiptId: string; owner: Owner; createdAt: number; updatedAt: number;
  state: "dispatching" | "accepted" | "failed" | "needs_reconciliation";
  result?: Record<string, unknown>;
}
const MAX_RECORD_BYTES = 196608;
const RETENTION_MS = 30 * 86400000;
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
  }
  throw new OperationError("invalid_value", "Use finite JSON values; functions, undefined array values and cycles are not accepted.", 400);
}
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const encode = (value: unknown): string => {
  const text = canonical(value);
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new OperationError("record_too_large", "Narrow this change; the durable record exceeds its size limit.", 413);
  return text;
};
export const assertUuid = (id: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new OperationError("invalid_identifier", "Supply a UUID returned by Zenith, or generate a fresh request UUID.", 400);
};
function sameOwner(a: Owner, b: Owner): boolean { return digest(a) === digest(b); }
function unknownRecord(): never { throw new OperationError("not_found", "No permitted receipt or operation matches this selection. Select its original workspace, project and environment.", 404); }

/** Existing journal paths must be private and owned; never follow a symlink. */
export function openPrivateJournal(path: string): OperationJournal {
  if (!isAbsolute(path) || process.platform === "win32") throw new OperationError("storage_unavailable", "Use an absolute journal path on a POSIX control host; Windows ACL support is not enabled.", 503);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const dir = lstatSync(dirname(path));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid!() || (dir.mode & 0o077))
    throw new OperationError("storage_unavailable", "The journal directory must be owned by this process user and have mode 0700.", 503);
  try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid!() || (file.mode & 0o077))
    throw new OperationError("storage_unavailable", "The existing journal must be an owned regular file with mode 0600.", 503);
  return new OperationJournal(new DatabaseSync(path));
}

export class OperationJournal {
  constructor(private readonly sql: DatabaseSync, private readonly clock: () => number = Date.now) {
    sql.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL;");
    const version = Number(sql.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== 0 && version !== 1) throw new OperationError("schema_mismatch", "Upgrade Zenith to the journal's schema version; do not replace the database.", 503);
    if (sql.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new OperationError("storage_unavailable", "Journal integrity check failed. Stop writes and restore a verified backup.", 503);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_receipts (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
        data TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_operations (
        id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE REFERENCES agent_receipts(id),
        idempotency_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_approval_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_operation_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
        subject TEXT NOT NULL, at INTEGER NOT NULL
      );
      PRAGMA user_version=1;
    `);
  }
  close(): void { this.sql.close(); }
  private tx<T>(fn: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.sql.exec("COMMIT"); return result; }
    catch (error) { this.sql.exec("ROLLBACK"); throw error; }
  }
  private rawReceipt(id: string): Receipt {
    const row = this.sql.prepare("SELECT data FROM agent_receipts WHERE id=?").get(id);
    if (!row) unknownRecord();
    return JSON.parse(String(row.data)) as Receipt;
  }
  private writeReceipt(receipt: Receipt): void { this.sql.prepare("UPDATE agent_receipts SET data=? WHERE id=?").run(encode(receipt), receipt.id); }
  private rawOperation(id: string): Operation {
    const row = this.sql.prepare("SELECT data FROM agent_operations WHERE id=?").get(id);
    if (!row) unknownRecord();
    return JSON.parse(String(row.data)) as Operation;
  }
  private writeOperation(op: Operation): void {
    this.sql.prepare("UPDATE agent_operations SET data=?,updated_at=? WHERE id=?").run(encode(op), op.updatedAt, op.id);
  }
  private event(id: string, kind: string, subject: string): void {
    this.sql.prepare("INSERT INTO agent_operation_events(operation_id,kind,subject,at) VALUES(?,?,?,?)").run(id, kind, subject, this.clock());
  }
  private live(receipt: Receipt): void {
    if (receipt.expiresAt <= this.clock()) throw new OperationError("plan_expired", "This review has expired. Prepare a new change with a new request ID.");
  }
  receipt(id: string, owner: Owner): Receipt {
    assertUuid(id); const receipt = this.rawReceipt(id);
    if (!sameOwner(receipt.owner, owner)) unknownRecord();
    return receipt;
  }
  /** Control-channel lookup. HTTP identity/role checks MUST precede disclosure. */
  forReview(id: string): Receipt { assertUuid(id); return this.rawReceipt(id); }
  operation(id: string, owner: Owner): Operation {
    assertUuid(id); const op = this.rawOperation(id);
    if (!sameOwner(op.owner, owner)) unknownRecord();
    return op;
  }
  prepare(owner: Owner, intent: Intent, stateHash: string, preview: Preview, requestId: string, lifetimeMs = 900000): Receipt {
    assertUuid(requestId);
    if (preview.blocked) throw new OperationError("plan_blocked", preview.blocked);
    if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 900000) throw new OperationError("invalid_expiry", "Plan lifetime must be between one second and fifteen minutes.", 400);
    const requestKey = digest({ owner, requestId });
    const requestDigest = digest({ intent, stateHash });
    return this.tx(() => {
      const prior = this.sql.prepare("SELECT id,request_digest FROM agent_receipts WHERE request_key=?").get(requestKey);
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new OperationError("idempotency_conflict", "This preparation ID already names different input or state. Review the current state and use a fresh ID.");
        return this.rawReceipt(String(prior.id));
      }
      if (Number(this.sql.prepare("SELECT count(*) AS n FROM agent_receipts").get()?.n) >= 10000)
        throw new OperationError("journal_capacity", "The review journal reached its bound. An operator must archive completed records before accepting new work.", 503);
      const now = this.clock();
      const payload = { id: randomUUID(), owner, intent, stateHash, preview, createdAt: now, expiresAt: now + lifetimeMs };
      const receipt: Receipt = { ...payload, digest: digest(payload), state: "prepared" };
      this.sql.prepare("INSERT INTO agent_receipts(id,request_key,request_digest,data,expires_at) VALUES(?,?,?,?,?)")
        .run(receipt.id, requestKey, requestDigest, encode(receipt), receipt.expiresAt);
      this.event(receipt.id, "prepared", owner.subject);
      return receipt;
    });
  }
  decide(id: string, expectedDigest: string, subject: string, decision: "approve" | "reject", nonce: string, nonceExpiresAt: number): Receipt {
    assertUuid(id); assertUuid(nonce);
    return this.tx(() => {
      const receipt = this.rawReceipt(id); this.live(receipt);
      if (receipt.digest !== expectedDigest) throw new OperationError("review_mismatch", "The displayed review does not match this receipt. Reload and review it again.");
      if (receipt.state !== "prepared") throw new OperationError("review_settled", "This receipt has already been decided, cancelled, or consumed. Prepare a new change rather than reusing approval.");
      if (nonceExpiresAt <= this.clock() || nonceExpiresAt > this.clock() + 60000) throw new OperationError("approval_expired", "The approval request expired. Review the receipt again.");
      if (this.sql.prepare("SELECT nonce FROM agent_approval_nonces WHERE nonce=?").get(nonce)) throw new OperationError("approval_replayed", "This approval request was already used.");
      this.sql.prepare("DELETE FROM agent_approval_nonces WHERE expires_at<?").run(this.clock());
      this.sql.prepare("INSERT INTO agent_approval_nonces(nonce,expires_at) VALUES(?,?)").run(nonce, nonceExpiresAt);
      receipt.state = decision === "approve" ? "approved" : "rejected";
      receipt.approval = { subject, at: this.clock(), digest: receipt.digest };
      this.writeReceipt(receipt); this.event(id, receipt.state, subject);
      return receipt;
    });
  }
  cancel(id: string, owner: Owner): Receipt {
    return this.tx(() => {
      const receipt = this.receipt(id, owner);
      if (receipt.state === "claimed") throw new OperationError("already_dispatched", "The action was dispatched. Inspect its operation; prepare a separate deployment cancellation or rollback when appropriate.");
      if (receipt.state === "cancelled") return receipt;
      receipt.state = "cancelled"; this.writeReceipt(receipt); this.event(id, "cancelled", owner.subject); return receipt;
    });
  }
  /** Synchronous validation and claim; no await may occur between freshGuard and INSERT. */
  claim(id: string, owner: Owner, key: string, freshGuard: (receipt: Receipt) => void): { operation: Operation; created: boolean } {
    assertUuid(key);
    return this.tx(() => {
      const receipt = this.receipt(id, owner);
      const idem = digest({ subject: owner.subject, workspaceId: owner.workspaceId, key });
      const keyed = this.sql.prepare("SELECT id,receipt_id FROM agent_operations WHERE idempotency_key=?").get(idem);
      if (keyed && keyed.receipt_id !== id) throw new OperationError("idempotency_conflict", "This execution ID already belongs to another receipt. Inspect that operation; do not repurpose its key.");
      const prior = keyed ?? this.sql.prepare("SELECT id FROM agent_operations WHERE receipt_id=?").get(id);
      if (prior) return { operation: this.operation(String(prior.id), owner), created: false };
      this.live(receipt);
      if (receipt.state !== "approved" || receipt.approval?.digest !== receipt.digest)
        throw new OperationError("approval_required", "An independent operator must approve this exact receipt through the control channel. A model-supplied approval flag is not accepted.", 403);
      freshGuard(receipt);
      const now = this.clock();
      const operation: Operation = { id: randomUUID(), receiptId: id, owner, state: "dispatching", createdAt: now, updatedAt: now };
      this.sql.prepare("INSERT INTO agent_operations(id,receipt_id,idempotency_key,data,updated_at) VALUES(?,?,?,?,?)")
        .run(operation.id, id, idem, encode(operation), now);
      receipt.state = "claimed"; this.writeReceipt(receipt); this.event(operation.id, "dispatching", owner.subject);
      return { operation, created: true };
    });
  }
  settle(id: string, state: "accepted" | "failed" | "needs_reconciliation", result: Record<string, unknown>): Operation {
    return this.tx(() => {
      const op = this.rawOperation(id);
      if (op.state !== "dispatching") return op;
      op.state = state; op.updatedAt = this.clock(); op.result = result;
      this.writeOperation(op); this.event(id, state, op.owner.subject); return op;
    });
  }
  /** Call only after claiming Zenith's single-process data directory at boot. */
  recoverInterrupted(): number {
    return this.tx(() => {
      let n = 0;
      for (const row of this.sql.prepare("SELECT data FROM agent_operations").all()) {
        const op = JSON.parse(String(row.data)) as Operation;
        if (op.state !== "dispatching") continue;
        op.state = "needs_reconciliation"; op.updatedAt = this.clock();
        op.result = { summary: "The control process stopped after reserving dispatch. Inspect the action audit and deployment/job records before preparing anything else. This action will not be replayed automatically." };
        this.writeOperation(op); this.event(op.id, op.state, op.owner.subject); n++;
      }
      return n;
    });
  }
  events(id: string, owner: Owner, after = 0): { seq: number; kind: string; at: number }[] {
    this.operation(id, owner);
    if (!Number.isSafeInteger(after) || after < 0) throw new OperationError("invalid_cursor", "Use a nonnegative event sequence.", 400);
    return this.sql.prepare("SELECT seq,kind,at FROM agent_operation_events WHERE operation_id=? AND seq>? ORDER BY seq LIMIT 100").all(id, after)
      .map(r => ({ seq: Number(r.seq), kind: String(r.kind), at: Number(r.at) }));
  }
  /** Retain idempotency records for at least 30 days; never prune dispatch markers. */
  prune(): void {
    const before = this.clock() - RETENTION_MS;
    this.tx(() => {
      for (const row of this.sql.prepare("SELECT data FROM agent_operations WHERE updated_at<?").all(before)) {
        const op = JSON.parse(String(row.data)) as Operation;
        if (!["accepted", "failed"].includes(op.state)) continue;
        this.sql.prepare("DELETE FROM agent_operation_events WHERE operation_id=?").run(op.id);
        this.sql.prepare("DELETE FROM agent_operations WHERE id=?").run(op.id);
      }
      this.sql.prepare("DELETE FROM agent_operation_events WHERE at<? AND operation_id IN (SELECT id FROM agent_receipts WHERE expires_at<?)").run(before, before);
      this.sql.prepare("DELETE FROM agent_receipts WHERE expires_at<? AND id NOT IN (SELECT receipt_id FROM agent_operations)").run(before);
    });
  }
}
