/** Durable integration intent journal. It does not replace Zenith's application store. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { grantsProject } from '../security';

export class ControlError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export interface Principal {
  subject: string; integrationId: string; workspaceId: string;
  projectIds: string[]; environmentIds?: string[]; appIds?: string[]; scopes: string[]; expiresAt: string; oauthIssuer?: string;
  /** Digest of the live resource grant when the principal came from OAuth. */
  grantDigest?: string;
  /** Whole-workspace grant (see `Credential.allProjects`). Only `grantsProject` reads it. */
  allProjects?: true;
}
/** `projectId` absent = a workspace-level target, which needs `allProjects`. */
export interface Target { workspaceId: string; projectId?: string; environmentId?: string }
export interface Proposal {
  action: string; input: Record<string, unknown>; target: Target; fingerprint: string;
  plan: Record<string, unknown>; requestKey: string; clientInputDigest?: string; source?: { repository: string; commit: string; pullRequest?: number };
}
export type Phase = 'prepared' | 'approved' | 'rejected' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'expired';
export interface Operation extends Proposal {
  id: string; subject: string; integrationId: string; createdAt: string; expiresAt: string;
  digest: string; phase: Phase; approvedBy?: string; approvalRole?: 'editor' | 'admin'; approvedAt?: string; result?: unknown;
  workerId?: string; executedByIntegration?: string; finishedAt?: string;
  /** Grant snapshot held by the worker claim; checked again at finalization. */
  authorizationDigest?: string;
  /** Application membership/role snapshot held by the worker claim. */
  applicationAuthorizationDigest?: string;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
/**
 * The grant check for one target. A workspace-level target (no `projectId`)
 * passes only for a whole-workspace principal, and never with an
 * `environmentId`. Existence and tenancy of the project stay in the caller's
 * `resolveTarget` (`project.workspaceId === target.workspaceId`), so
 * `allProjects` never reaches another workspace's project.
 */
export function checkTarget(who: Principal, target: Target, scope: string, now = Date.now()): void {
  if (Date.parse(who.expiresAt) <= now || !Number.isFinite(Date.parse(who.expiresAt))) throw new ControlError('credential_expired', 'Re-authenticate before continuing.', 401);
  const projectOk = target.projectId === undefined
    ? who.allProjects === true && target.environmentId === undefined
    : grantsProject(who, target.projectId);
  if (!who.scopes.includes(scope) || target.workspaceId !== who.workspaceId || !projectOk
    || target.environmentId && who.environmentIds && !who.environmentIds.includes(target.environmentId))
    throw new ControlError('scope_denied', 'This integration cannot access this operation or target.', 403);
}

/** The project of a project-level target; a workspace-level target is refused (uploads, for one). */
export function projectOf(target: Target): string {
  if (target.projectId === undefined) throw new ControlError('scope_denied', 'This operation needs a project target.', 403);
  return target.projectId;
}

/** A durable OAuth client grant, as both stores hand it back. */
export type Grant = Principal & { clientId: string; revoked?: boolean };
/** What `putUpload` returns on either store. */
export interface UploadReceipt { uploadId: string; sha256: string; bytes: number; expiresAt: string }
/** One journal event, as `events()` projects it. */
export interface JournalEvent { sequence: number; kind: string; at: string; data: unknown }

/**
 * The journal surface, with every method asynchronous.
 *
 * Extracted from `Journal` below so a second implementation can exist that
 * cannot answer synchronously: `journal-pg.ts` talks to Supabase over
 * `postgres.js`, and no amount of care makes a network round trip a return
 * value. The SQLite implementation keeps its synchronous class (nothing about
 * its behaviour changes) and `SqliteAgentJournal` presents it through this
 * interface as already-resolved promises.
 *
 * **Frozen contract (WORK-GRAPH-2 F5).** The method set and their argument
 * shapes are the ones `Journal` already had; only the return types moved into
 * promises.
 */
export interface AgentJournal {
  /** Which store is behind this journal. Reported by `zenith_get_capabilities`. */
  readonly kind: 'file' | 'postgres';
  /** Identity of the process/instance holding a claim. */
  readonly workerId: string;
  prepare(who: Principal, proposal: Proposal, ttlMs?: number): Promise<Operation>;
  findRequest(who: Principal, requestKey: string): Promise<Operation | undefined>;
  get(who: Principal, id: string): Promise<Operation>;
  review(id: string, subject: string, workspace: string, expectedDigest: string, approve: boolean,
    approver?: string, role?: 'editor' | 'admin'): Promise<Operation>;
  claim(who: Principal, id: string, fingerprint: string, applicationAuthorizationDigest?: string): Promise<{ operation: Operation; claimed: boolean }>;
  finishIfValid(who: Principal, id: string, result: unknown, success: boolean, applicationAuthorizationDigest?: string): Promise<Operation>;
  finish(id: string, result: unknown, success: boolean): Promise<Operation>;
  uncertain(id: string): Promise<Operation>;
  list(who: Principal, limit?: number, offset?: number): Promise<Operation[]>;
  events(who: Principal, id: string, after?: number, limit?: number): Promise<JournalEvent[]>;
  forReview(id: string, workspace: string): Promise<Operation>;
  reviewQueue(workspace: string, subject: string, admin: boolean): Promise<Operation[]>;
  putUpload(who: Principal, target: Target, appId: string, bytes: Buffer): Promise<UploadReceipt>;
  upload(who: Principal, target: Target, appId: string, id: string, expectedHash: string): Promise<Buffer>;
  grants(subject: string, workspace: string): Promise<Grant[]>;
  getGrant(subject: string, clientId: string, workspace: string): Promise<Grant | undefined>;
  setGrant(grant: Grant): Promise<void>;
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
  private authorizationDigest(who: Principal): string | undefined {
    const clientId = (who as Principal & { clientId?: string }).clientId;
    if (!clientId) return who.grantDigest;
    const row = this.sql.prepare('SELECT document FROM agent_grants WHERE subject=? AND client_id=? AND workspace=?')
      .get(who.subject, clientId, who.workspaceId) as JsonRow | undefined;
    return row ? digest(JSON.parse(row.document)) : undefined;
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
  claim(who: Principal, id: string, fingerprint: string, applicationAuthorizationDigest?: string): { operation: Operation; claimed: boolean } {
    return this.transaction(() => {
      const op = this.get(who, id);
      checkTarget(who, op.target, op.action.startsWith('app.') ? 'publish' : 'write', this.clock());
      if (['running','succeeded','failed','uncertain'].includes(op.phase)) return { operation: op, claimed: false };
      if (op.phase !== 'approved' || !op.approvedBy || !op.approvalRole) throw new ControlError('approval_required', 'Review and approve this exact proposal in Zenith.');
      if (Date.parse(op.expiresAt) <= this.clock()) throw new ControlError('plan_expired', 'Prepare a fresh plan.');
      if (op.fingerprint !== fingerprint) throw new ControlError('stale_plan', 'State or permissions changed. Prepare and review a new plan.');
      op.phase = 'running'; op.workerId = this.workerId; op.executedByIntegration = who.integrationId;
      op.authorizationDigest = this.authorizationDigest(who);
      op.applicationAuthorizationDigest = applicationAuthorizationDigest;
      return { operation: this.write(op, 'claimed'), claimed: true };
    });
  }
  /**
   * Atomically fence finalization against the durable grant and operation
   * expiry. Application-side authorization is checked by the coordinator just
   * before this call; this transaction closes the race for the journal-owned
   * grant/revocation state and makes expiry linearizable with finish.
   */
  finishIfValid(who: Principal, id: string, result: unknown, success: boolean, applicationAuthorizationDigest?: string): Operation {
    return this.transaction(() => {
      const op = this.row(id);
      if (op.phase !== 'running' || op.workerId !== this.workerId)
        throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
      if (op.subject !== who.subject || op.target.workspaceId !== who.workspaceId || op.executedByIntegration !== who.integrationId)
        throw new ControlError('authorization_changed', 'The authorized integration changed during dispatch.', 403);
      if (Date.parse(op.expiresAt) <= this.clock())
        throw new ControlError('plan_expired', 'The approved operation expired before it could be finalized.', 409);
      checkTarget(who, op.target, op.action.startsWith('app.') ? 'publish' : 'write', this.clock());
      if (op.authorizationDigest !== this.authorizationDigest(who))
        throw new ControlError('authorization_changed', 'The integration grant changed during dispatch.', 403);
      if (op.applicationAuthorizationDigest !== applicationAuthorizationDigest)
        throw new ControlError('authorization_changed', 'Application membership or role changed during dispatch.', 403);
      op.phase = success ? 'succeeded' : 'failed'; op.result = structuredClone(result); op.finishedAt = new Date(this.clock()).toISOString();
      return this.write(op, op.phase);
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
  private expirePending(): { expired: number; uploads: number } {
    const rows = this.sql.prepare("SELECT document FROM agent_operations WHERE phase IN ('prepared','approved')").all() as JsonRow[];
    let expired = 0;
    for (const row of rows) { const op = JSON.parse(row.document) as Operation;
      if (Date.parse(op.expiresAt) <= this.clock()) { op.phase = 'expired'; this.write(op, 'expired'); expired++; } }
    const uploads = this.sql.prepare('DELETE FROM agent_uploads WHERE expires_at <= ?').run(this.clock());
    return { expired, uploads: Number(uploads.changes ?? 0) };
  }
  /**
   * The same sweep `prepare()` and `putUpload()` already run, on its own.
   *
   * `agentTickPass()` (reconcile.ts) calls this so the single-host file store
   * expires stale proposals and uploads on the scheduler's pass as well as on
   * the next write, which is the only thing that used to trigger it. Counting
   * is the only thing added; what is expired and when is unchanged.
   */
  expire(): { expired: number; uploads: number } {
    return this.transaction(() => this.expirePending());
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
      this.sql.prepare('INSERT INTO agent_uploads VALUES(?,?,?,?,?,?,?,?)').run(id, who.subject, who.workspaceId, projectOf(target), appId, sha256, expires, bytes);
      return { uploadId: id, sha256, bytes: bytes.length, expiresAt: new Date(expires).toISOString() };
    });
  }
  upload(who: Principal, target: Target, appId: string, id: string, expectedHash: string): Buffer {
    checkTarget(who, target, 'publish', this.clock());
    const row = this.sql.prepare('SELECT * FROM agent_uploads WHERE id=? AND subject=? AND workspace=? AND project=? AND app=?')
      .get(id, who.subject, who.workspaceId, projectOf(target), appId) as { sha256: string; expires_at: number; bytes: Uint8Array } | undefined;
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

/**
 * `Journal` as an `AgentJournal`: the same object, one promise deep.
 *
 * Nothing is reordered, retried or batched here. Every method delegates
 * straight through, so the single-host file store keeps the behaviour its
 * tests already pin — a `BEGIN IMMEDIATE` transaction per call, the same
 * refusals, the same codes — and the only difference a caller can observe is
 * that it has to `await`.
 *
 * It exists so that one call site can hold either store. `Coordinator` still
 * takes the synchronous class today (see runtime.ts's note on the wiring this
 * round could not finish); everything written against `AgentJournal` —
 * `agentTickPass()`, the reconciliation pass, and the Postgres implementation's
 * own tests — works against both.
 */
export class SqliteAgentJournal implements AgentJournal {
  readonly kind = 'file' as const;
  constructor(readonly inner: Journal) {}
  get workerId(): string { return this.inner.workerId; }
  close(): void { this.inner.close(); }
  /** Boot-time recovery, single-writer only. Never reachable on Postgres. */
  async recover(): Promise<number> { return this.inner.recover(); }
  async expire(): Promise<{ expired: number; uploads: number }> { return this.inner.expire(); }
  async prepare(who: Principal, proposal: Proposal, ttlMs?: number): Promise<Operation> {
    return ttlMs === undefined ? this.inner.prepare(who, proposal) : this.inner.prepare(who, proposal, ttlMs);
  }
  async findRequest(who: Principal, requestKey: string): Promise<Operation | undefined> { return this.inner.findRequest(who, requestKey); }
  async get(who: Principal, id: string): Promise<Operation> { return this.inner.get(who, id); }
  async review(id: string, subject: string, workspace: string, expectedDigest: string, approve: boolean,
    approver?: string, role: 'editor' | 'admin' = 'editor'): Promise<Operation> {
    return this.inner.review(id, subject, workspace, expectedDigest, approve, approver ?? subject, role);
  }
  async claim(who: Principal, id: string, fingerprint: string, applicationAuthorizationDigest?: string): Promise<{ operation: Operation; claimed: boolean }> {
    return this.inner.claim(who, id, fingerprint, applicationAuthorizationDigest);
  }
  async finishIfValid(who: Principal, id: string, result: unknown, success: boolean, applicationAuthorizationDigest?: string): Promise<Operation> {
    return this.inner.finishIfValid(who, id, result, success, applicationAuthorizationDigest);
  }
  async finish(id: string, result: unknown, success: boolean): Promise<Operation> { return this.inner.finish(id, result, success); }
  async uncertain(id: string): Promise<Operation> { return this.inner.uncertain(id); }
  async list(who: Principal, limit?: number, offset?: number): Promise<Operation[]> { return this.inner.list(who, limit, offset); }
  async events(who: Principal, id: string, after?: number, limit?: number): Promise<JournalEvent[]> {
    return this.inner.events(who, id, after, limit) as JournalEvent[];
  }
  async forReview(id: string, workspace: string): Promise<Operation> { return this.inner.forReview(id, workspace); }
  async reviewQueue(workspace: string, subject: string, admin: boolean): Promise<Operation[]> { return this.inner.reviewQueue(workspace, subject, admin); }
  async putUpload(who: Principal, target: Target, appId: string, bytes: Buffer): Promise<UploadReceipt> { return this.inner.putUpload(who, target, appId, bytes); }
  async upload(who: Principal, target: Target, appId: string, id: string, expectedHash: string): Promise<Buffer> { return this.inner.upload(who, target, appId, id, expectedHash); }
  async grants(subject: string, workspace: string): Promise<Grant[]> { return this.inner.grants(subject, workspace); }
  async getGrant(subject: string, clientId: string, workspace: string): Promise<Grant | undefined> { return this.inner.getGrant(subject, clientId, workspace); }
  async setGrant(grant: Grant): Promise<void> { this.inner.setGrant(grant); }
}
