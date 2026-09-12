/** Durable integration intent journal. It does not replace Zenith's application store. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export class ControlError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export interface Principal {
  subject: string; integrationId: string; workspaceId: string;
  projectIds: string[]; environmentIds?: string[]; appIds?: string[]; scopes: string[]; expiresAt: string; oauthIssuer?: string;
}
export interface Target { workspaceId: string; projectId: string; environmentId?: string }
export interface Proposal {
  action: string; input: Record<string, unknown>; target: Target; fingerprint: string;
  plan: Record<string, unknown>; requestKey: string; clientInputDigest?: string; source?: { repository: string; commit: string; pullRequest?: number };
}
export type Phase = 'prepared' | 'approved' | 'rejected' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'expired';
export interface Operation extends Proposal {
  id: string; subject: string; integrationId: string; createdAt: string; expiresAt: string;
  digest: string; phase: Phase; approvedBy?: string; approvalRole?: 'editor' | 'admin'; approvedAt?: string; result?: unknown;
  workerId?: string; executedByIntegration?: string; finishedAt?: string;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function checkTarget(who: Principal, target: Target, scope: string, now = Date.now()): void {
  if (Date.parse(who.expiresAt) <= now || !Number.isFinite(Date.parse(who.expiresAt))) throw new ControlError('credential_expired', 'Re-authenticate before continuing.', 401);
  if (!who.scopes.includes(scope) || target.workspaceId !== who.workspaceId || !who.projectIds.includes(target.projectId)
    || target.environmentId && who.environmentIds && !who.environmentIds.includes(target.environmentId))
    throw new ControlError('scope_denied', 'This integration cannot access this operation or target.', 403);
}

type JsonRow = { document: string };
/** Synchronization is a SQLite transaction, never an in-memory replay cache. */
export class Journal {
  readonly workerId = randomUUID();
  private readonly sql: DatabaseSync;
  constructor(file: string, private readonly clock = Date.now) {
    if (file !== ':memory:') {
      if (!isAbsolute(file)) throw new ControlError('journal_configuration', 'Use an absolute durable journal path.', 503);
      const dir = dirname(file);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const parent = lstatSync(dir);
      if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform === 'win32'
        || parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0)
        throw new ControlError('journal_permissions', 'The journal requires an owned private POSIX directory.', 503);
      if (!existsSync(file)) closeSync(openSync(file, 'wx', 0o600));
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0)
        throw new ControlError('journal_permissions', 'The journal must be an owned regular private file.', 503);
      chmodSync(file, 0o600);
    }
    this.sql = new DatabaseSync(file);
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agent_operations (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, subject TEXT NOT NULL, request_key TEXT NOT NULL,
        intent_hash TEXT NOT NULL, phase TEXT NOT NULL, created_at TEXT NOT NULL, document TEXT NOT NULL,
        UNIQUE(workspace, subject, request_key));
      CREATE INDEX IF NOT EXISTS agent_ops_scope ON agent_operations(workspace, subject, created_at);
      CREATE TABLE IF NOT EXISTS agent_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
        at TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_events_op ON agent_events(operation_id, seq);
      CREATE TABLE IF NOT EXISTS agent_grants (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, client_id TEXT NOT NULL, workspace TEXT NOT NULL,
        document TEXT NOT NULL, UNIQUE(subject, client_id, workspace));
      CREATE TABLE IF NOT EXISTS agent_uploads (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, workspace TEXT NOT NULL, project TEXT NOT NULL,
        app TEXT NOT NULL, sha256 TEXT NOT NULL, expires_at INTEGER NOT NULL, bytes BLOB NOT NULL);
      PRAGMA user_version=1;`);
  }
  close(): void { this.sql.close(); }
  private transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.sql.exec('COMMIT'); return result; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  private row(id: string): Operation {
    const row = this.sql.prepare('SELECT document FROM agent_operations WHERE id=?').get(id) as JsonRow | undefined;
    if (!row) throw new ControlError('operation_not_found', 'Operation not found in this scope.', 404);
    return JSON.parse(row.document) as Operation;
  }
  private write(op: Operation, kind: string): Operation {
    this.sql.prepare('UPDATE agent_operations SET phase=?, document=? WHERE id=?').run(op.phase, JSON.stringify(op), op.id);
    const at = new Date(this.clock()).toISOString();
    this.sql.prepare('INSERT INTO agent_events(operation_id,kind,at,document) VALUES (?,?,?,?)')
      .run(op.id, kind, at, JSON.stringify({ operationId: op.id, phase: op.phase, digest: op.digest, integrationId: op.integrationId }));
    return op;
  }
  prepare(who: Principal, proposal: Proposal, ttlMs = 15 * 60_000): Operation {
    checkTarget(who, proposal.target, 'plan', this.clock());
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(proposal.requestKey)) throw new ControlError('invalid_request_key', 'Use a stable 8–100 character request key.', 400);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 15 * 60_000) throw new ControlError('invalid_ttl', 'Plan lifetime must be at most fifteen minutes.', 400);
    if (Buffer.byteLength(JSON.stringify(proposal)) > 512_000) throw new ControlError('proposal_too_large', 'Narrow the proposal.', 413);
    // Exclude derived state from idempotency: a retry must return the original reviewed plan, not rebase it.
    const intentHash = digest({ action: proposal.action, input: proposal.input, target: proposal.target, source: proposal.source });
    return this.transaction(() => {
      const existing = this.sql.prepare('SELECT document,intent_hash FROM agent_operations WHERE workspace=? AND subject=? AND request_key=?')
        .get(who.workspaceId, who.subject, proposal.requestKey) as (JsonRow & { intent_hash: string }) | undefined;
      if (existing) {
        if (existing.intent_hash !== intentHash) throw new ControlError('idempotency_conflict', 'This request key belongs to different inputs.');
        return JSON.parse(existing.document) as Operation;
      }
      this.expirePending();
      const count = this.sql.prepare("SELECT count(*) AS n FROM agent_operations WHERE workspace=? AND subject=? AND phase IN ('prepared','approved','running')")
        .get(who.workspaceId, who.subject) as { n: number };
      if (count.n >= 100) throw new ControlError('operation_quota', 'Reject or finish existing operations before preparing more.', 429);
      const createdAt = new Date(this.clock()).toISOString();
      const expiresAt = new Date(Math.min(this.clock() + ttlMs, Date.parse(who.expiresAt))).toISOString();
      const op: Operation = { ...structuredClone(proposal), id: `op_${randomUUID()}`, subject: who.subject, integrationId: who.integrationId,
        createdAt, expiresAt, phase: 'prepared', digest: digest({ ...proposal, subject: who.subject, integrationId: who.integrationId, expiresAt }) };
      this.sql.prepare('INSERT INTO agent_operations VALUES(?,?,?,?,?,?,?,?)')
        .run(op.id, who.workspaceId, who.subject, proposal.requestKey, intentHash, op.phase, createdAt, JSON.stringify(op));
      return this.write(op, 'prepared');
    });
  }
  findRequest(who: Principal, requestKey: string): Operation | undefined {
    const row = this.sql.prepare('SELECT id FROM agent_operations WHERE workspace=? AND subject=? AND request_key=?').get(who.workspaceId, who.subject, requestKey) as {id:string}|undefined;
    return row ? this.get(who, row.id) : undefined;
  }
  get(who: Principal, id: string): Operation {
    const op = this.row(id);
    checkTarget(who, op.target, 'read', this.clock());
    if (op.subject !== who.subject) throw new ControlError('operation_not_found', 'Operation not found in this scope.', 404);
    return op;
  }
  /** Browser-only caller resolves a fresh live user, scope and role before using this method. */
  review(id: string, subject: string, workspace: string, expectedDigest: string, approve: boolean, approver = subject, role: 'editor' | 'admin' = 'editor'): Operation {
    return this.transaction(() => {
      const op = this.row(id);
      if (op.subject !== subject || op.target.workspaceId !== workspace) throw new ControlError('operation_not_found', 'Operation not found.', 404);
      if (op.digest !== expectedDigest) throw new ControlError('review_changed', 'Reload and review the exact proposal.');
      if (op.phase !== 'prepared') throw new ControlError('invalid_phase', 'This proposal is no longer awaiting review.');
      if (Date.parse(op.expiresAt) <= this.clock()) throw new ControlError('plan_expired', 'Prepare a fresh plan.');
      if (approve && op.plan.blocked) throw new ControlError('plan_blocked', 'Resolve blockers and prepare a new plan.');
      op.phase = approve ? 'approved' : 'rejected'; op.approvedBy = approver; op.approvalRole = role; op.approvedAt = new Date(this.clock()).toISOString();
      return this.write(op, op.phase);
    });
  }
  /** Called under the application's mutation gate after fresh authorization and fingerprint validation. */
  claim(who: Principal, id: string, fingerprint: string): { operation: Operation; claimed: boolean } {
    return this.transaction(() => {
      const op = this.get(who, id);
      checkTarget(who, op.target, op.action.startsWith('app.') ? 'publish' : 'write', this.clock());
      if (['running','succeeded','failed','uncertain'].includes(op.phase)) return { operation: op, claimed: false };
      if (op.phase !== 'approved' || !op.approvedBy || !op.approvalRole) throw new ControlError('approval_required', 'Review and approve this exact proposal in Zenith.');
      if (Date.parse(op.expiresAt) <= this.clock()) throw new ControlError('plan_expired', 'Prepare a fresh plan.');
      if (op.fingerprint !== fingerprint) throw new ControlError('stale_plan', 'State or permissions changed. Prepare and review a new plan.');
      op.phase = 'running'; op.workerId = this.workerId; op.executedByIntegration = who.integrationId;
      return { operation: this.write(op, 'claimed'), claimed: true };
    });
  }
  finish(id: string, result: unknown, success: boolean): Operation {
    return this.transaction(() => {
      const op = this.row(id);
      if (op.phase !== 'running' || op.workerId !== this.workerId) throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
      op.phase = success ? 'succeeded' : 'failed'; op.result = structuredClone(result); op.finishedAt = new Date(this.clock()).toISOString();
      return this.write(op, op.phase);
    });
  }
  uncertain(id: string): Operation {
    return this.transaction(() => {
      const op = this.row(id);
      if (op.phase === 'running' && op.workerId === this.workerId) { op.phase = 'uncertain'; return this.write(op, 'uncertain'); }
      return op;
    });
  }
  /** Operator/runtime boot only: single application writer required. Never replay an uncertain dispatch. */
  recover(): number {
    return this.transaction(() => {
      const rows = this.sql.prepare("SELECT document FROM agent_operations WHERE phase='running'").all() as JsonRow[];
      let recovered = 0;
      for (const row of rows) { const op = JSON.parse(row.document) as Operation;
        if (op.workerId !== this.workerId) { op.phase = 'uncertain'; this.write(op, 'interrupted'); recovered++; } }
      return recovered;
    });
  }
  list(who: Principal, limit = 50, offset = 0): Operation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000)
      throw new ControlError('invalid_page', 'Use a bounded page.', 400);
    // Filter before pagination so no out-of-scope row changes the visible page count.
    return (this.sql.prepare('SELECT document FROM agent_operations WHERE workspace=? AND subject=? ORDER BY created_at DESC LIMIT 10000')
      .all(who.workspaceId, who.subject) as JsonRow[]).map(r => JSON.parse(r.document) as Operation)
      .filter(op => { try { checkTarget(who, op.target, 'read', this.clock()); return true; } catch { return false; } }).slice(offset, offset + limit);
  }
  events(who: Principal, id: string, after = 0, limit = 50): unknown[] {
    this.get(who, id);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ControlError('invalid_page', 'Use a bounded event page.', 400);
    return this.sql.prepare('SELECT seq,kind,at,document FROM agent_events WHERE operation_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit)
      .map(row => ({ sequence: row.seq, kind: row.kind, at: row.at, data: JSON.parse(String(row.document)) as unknown }));
  }
  /** Trusted browser service only. Never expose this lookup without separate authorization. */
  forReview(id: string, workspace: string): Operation {
    const op = this.row(id);
    if (op.target.workspaceId !== workspace) throw new ControlError('operation_not_found', 'Operation not found.', 404);
    return op;
  }
  reviewQueue(workspace: string, subject: string, admin: boolean): Operation[] {
    return (this.sql.prepare("SELECT document FROM agent_operations WHERE workspace=? AND phase IN ('prepared','approved') ORDER BY created_at DESC LIMIT 100")
      .all(workspace) as JsonRow[]).map(r => JSON.parse(r.document) as Operation).filter(op => admin || op.subject === subject);
  }
  private expirePending(): void {
    const rows = this.sql.prepare("SELECT document FROM agent_operations WHERE phase IN ('prepared','approved')").all() as JsonRow[];
    for (const row of rows) { const op = JSON.parse(row.document) as Operation;
      if (Date.parse(op.expiresAt) <= this.clock()) { op.phase = 'expired'; this.write(op, 'expired'); } }
    this.sql.prepare('DELETE FROM agent_uploads WHERE expires_at <= ?').run(this.clock());
  }
  grants(subject: string, workspace: string): (Principal & { clientId: string; revoked?: boolean })[] {
    return (this.sql.prepare('SELECT document FROM agent_grants WHERE subject=? AND workspace=? LIMIT 100').all(subject, workspace) as JsonRow[]).map(r => JSON.parse(r.document));
  }
  putUpload(who: Principal, target: Target, appId: string, bytes: Buffer): { uploadId: string; sha256: string; bytes: number; expiresAt: string } {
    checkTarget(who, target, 'publish', this.clock());
    if (!who.appIds?.includes(appId)) throw new ControlError('scope_denied', 'Select an explicitly authorized app.', 403);
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new ControlError('source_too_large', 'Source archive exceeds its upload limit.', 413);
    return this.transaction(() => {
      this.expirePending();
      const usage = this.sql.prepare('SELECT count(*) AS n, coalesce(sum(length(bytes)),0) AS size FROM agent_uploads WHERE workspace=?').get(who.workspaceId) as { n: number; size: number };
      if (usage.n >= 20 || usage.size + bytes.length > 100 * 1024 * 1024) throw new ControlError('upload_quota', 'Wait for pending uploads to expire before uploading more.', 429);
      const id = `upload_${randomUUID()}`, sha256 = createHash('sha256').update(bytes).digest('hex');
      const expires = Math.min(this.clock() + 3600000, Date.parse(who.expiresAt));
      this.sql.prepare('INSERT INTO agent_uploads VALUES(?,?,?,?,?,?,?,?)').run(id, who.subject, who.workspaceId, target.projectId, appId, sha256, expires, bytes);
      return { uploadId: id, sha256, bytes: bytes.length, expiresAt: new Date(expires).toISOString() };
    });
  }
  upload(who: Principal, target: Target, appId: string, id: string, expectedHash: string): Buffer {
    checkTarget(who, target, 'publish', this.clock());
    const row = this.sql.prepare('SELECT * FROM agent_uploads WHERE id=? AND subject=? AND workspace=? AND project=? AND app=?')
      .get(id, who.subject, who.workspaceId, target.projectId, appId) as { sha256: string; expires_at: number; bytes: Uint8Array } | undefined;
    if (!who.appIds?.includes(appId) || !row || row.expires_at <= this.clock() || row.sha256 !== expectedHash)
      throw new ControlError('upload_unavailable', 'Upload missing, expired, out of scope or changed. Upload and prepare again.', 404);
    const bytes = Buffer.from(row.bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new ControlError('upload_corrupt', 'Stored source integrity check failed.', 503);
    return bytes;
  }
  setGrant(grant: Principal & { clientId: string; revoked?: boolean }): void {
    this.sql.prepare('INSERT INTO agent_grants VALUES(?,?,?,?,?) ON CONFLICT(subject,client_id,workspace) DO UPDATE SET id=excluded.id,document=excluded.document')
      .run(grant.integrationId, grant.subject, grant.clientId, grant.workspaceId, JSON.stringify(grant));
  }
  getGrant(subject: string, clientId: string, workspace: string): (Principal & { clientId: string; revoked?: boolean }) | undefined {
    const row = this.sql.prepare('SELECT document FROM agent_grants WHERE subject=? AND client_id=? AND workspace=?').get(subject, clientId, workspace) as JsonRow | undefined;
    return row ? JSON.parse(row.document) : undefined;
  }
}
