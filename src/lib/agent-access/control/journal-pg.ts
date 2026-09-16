/**
 * The reviewed-operation journal on Supabase Postgres.
 *
 * The SQLite journal next door is correct for the host it was written for: one
 * process, one file, one writer, and a `BEGIN IMMEDIATE` around anything that
 * matters. None of that survives Vercel, where an instance is created for a
 * request and frozen after it and a hundred copies of this code can be holding
 * the same operation id at the same moment. So the coordination moves into the
 * database:
 *
 *  - **The claim is one conditional `UPDATE … RETURNING`.** Not a read, a
 *    decision and a write — one statement, whose `WHERE` carries every
 *    precondition (`phase = 'approved'`, an approver, an unexpired plan, the
 *    exact reviewed digest and the fingerprint recomputed this request). Two
 *    instances racing it produce exactly one row.
 *  - **`fence_token` is the fence.** It is incremented by the claim and named
 *    by every later write, so a frozen instance that thaws and tries to
 *    finalize an operation someone else reclaimed changes zero rows and lands
 *    in the uncertain path, which is the honest answer.
 *  - **`lease_until` is what a crash leaves behind.** `agentTickPass()`
 *    (reconcile.ts) turns a `running` row past its lease into `uncertain`. It
 *    is never re-dispatched: the side effect may have happened and nothing here
 *    can know.
 *
 * ## Why direct Postgres and not PostgREST
 *
 * The product store speaks PostgREST, and PostgREST runs every request as its
 * own implicit transaction. `prepare()` needs read-idempotency-row → count →
 * insert → insert as one unit, and the claim needs `fence_token = fence_token
 * + 1` as an expression assignment, which PostgREST cannot write at all — the
 * fence would have to be read, incremented in JS and written back, which is
 * precisely the race a fence exists to close.
 *
 * So this uses `pgAuthorityClient()` — the **same** `globalThis` singleton the
 * hosted control authority already holds, with `max: 1`. The connection budget
 * against the pooler is therefore unchanged by this file existing.
 *
 * ## No cross-authority transaction is implied, anywhere
 *
 * The journal commits here; the product state commits over PostgREST. They are
 * two commits in two authorities and nothing makes them one. What binds them is
 * the *order* — intent first, effect second, outcome last — and the fact that
 * the only states a reader can observe are `running` (intent recorded, effect
 * unknown), `succeeded`/`failed` (effect observed and authority still valid),
 * and `uncertain` (everything else). See ADR D-8a.
 */
import { createHash, randomUUID } from 'node:crypto';
import { pgAuthorityClient, type Sql, type TransactionSql } from '@/lib/hosted/authority/pg/client';
import { transactPg } from '@/lib/hosted/authority/pg/tx';
import { readNumber } from '@/lib/hosted/authority/pg/rows';
import {
  ControlError, checkTarget, digest, projectOf,
  type AgentJournal, type Grant, type JournalEvent, type Operation, type Principal,
  type Proposal, type Target, type UploadReceipt,
} from './journal';

/** Either the pooled client or an open transaction's tag. Statements take both. */
export type AnySql = Sql | TransactionSql;

/**
 * A value bound as `jsonb`.
 *
 * postgres.js needs to be told, or a plain object is inferred as a record type
 * the column will not accept. One helper so no call site forgets and no call
 * site repeats the cast the driver's own typings require.
 */
const asJson = (sql: AnySql, value: unknown): ReturnType<Sql['json']> => sql.json(value as never);

/**
 * How long a claim holds an operation before the reconciliation pass may call
 * it uncertain.
 *
 * Deliberately longer than any route's `maxDuration` (60 s), so a request that
 * is still running never has its row reclaimed under it; short enough that a
 * frozen instance's row resolves within one five-minute tick.
 */
export const LEASE_MS = 60_000;

/** Every bounded scan and sweep in this file. One number, so none of them drifts. */
export const SCAN_LIMIT = 200;

/** The migration ledger rows this build requires before it reads or writes anything. */
export const REQUIRED_MIGRATIONS: readonly { version: number; name: string }[] = [
  { version: 1, name: 'agent-link-v1' },
  { version: 2, name: 'agent-control-v1' },
];

/** ISO-8601 UTC, fixed width — the only timestamp format these columns hold. */
const iso = (ms: number): string => new Date(ms).toISOString();

/** A row of `agent.agent_operations`, as far as this file reads one. */
interface OperationRow { document: Operation; fence_token?: unknown; phase?: unknown; expires_at?: unknown }

/**
 * The refusal when the `agent` schema has not been brought up to this build.
 *
 * It names the files. "Schema out of date" with nothing to run is the error
 * that costs an afternoon.
 */
function schemaBehind(found: { version: number; name: string }[], missing: { version: number; name: string }): ControlError {
  const recorded = found.length
    ? `The ledger records ${found.map((m) => `${m.version} ("${m.name}")`).join(', ')}.`
    : 'The ledger has no rows, so the schema has never been applied.';
  return new ControlError(
    'journal_schema',
    `The agent control database is missing schema version ${missing.version} ("${missing.name}"). ${recorded} ` +
      'Fix: apply supabase/migrations/0006_agent_link.sql and supabase/migrations/0007_agent_control.sql in the Supabase SQL editor ' +
      '(or with psql against SUPABASE_DB_URL) and start again. Both are idempotent, so re-applying them is safe. ' +
      'Nothing was read or written in the meantime.',
    503
  );
}

/* ------------------------------- statements -------------------------------- */
/*
 * Each statement is its own exported function taking the tag it runs on. That
 * is not decoration: it is what lets the builders be exercised against a
 * recording tag in a unit test, so the file-store run of the suite still proves
 * the SQL is shaped the way this file's comments claim, on a machine with no
 * Postgres anywhere near it.
 */

/** The migration ledger, oldest first. */
export const selectMigrations = (sql: AnySql) =>
  sql`select version, name from agent.schema_migrations order by version`;

/**
 * The claim. One statement, and the whole of the single-use property.
 *
 * Zero rows is not an error to guess at — the caller reads the row once and
 * maps it to the same codes the SQLite journal raises.
 */
export const claimStatement = (
  sql: AnySql,
  p: { id: string; leaseOwner: string; leaseUntil: string; authorizationDigest: string | null;
       applicationAuthorizationDigest: string | null; document: Operation; now: string; digest: string; fingerprint: string }
) => sql`
  update agent.agent_operations
     set phase        = 'running',
         fence_token  = fence_token + 1,
         lease_owner  = ${p.leaseOwner},
         lease_until  = ${p.leaseUntil},
         attempts     = attempts + 1,
         authorization_digest             = ${p.authorizationDigest},
         application_authorization_digest = ${p.applicationAuthorizationDigest},
         document     = ${asJson(sql, p.document)}
   where id            = ${p.id}
     and phase         = 'approved'
     and approved_by  is not null
     and approval_role is not null
     and expires_at    > ${p.now}
     and digest        = ${p.digest}
     and (document ->> 'fingerprint') = ${p.fingerprint}
  returning id, fence_token, document`;

/** Finalization, fenced. A stale fence changes zero rows and never a phase. */
export const finalizeStatement = (
  sql: AnySql,
  p: { id: string; fence: number; phase: 'succeeded' | 'failed'; finishedAt: string; document: Operation;
       authorizationDigest: string | null; applicationAuthorizationDigest: string | null }
) => sql`
  update agent.agent_operations
     set phase = ${p.phase}, finished_at = ${p.finishedAt}, document = ${asJson(sql, p.document)},
         lease_owner = null, lease_until = null
   where id = ${p.id} and fence_token = ${p.fence} and phase = 'running'
     and expires_at > ${p.finishedAt}
     and authorization_digest is not distinct from ${p.authorizationDigest}
     and application_authorization_digest is not distinct from ${p.applicationAuthorizationDigest}
  returning id, document`;

/**
 * Lease renewal for a dispatch that outlives the lease.
 *
 * Never called inside a serverless request: there, one request is one attempt,
 * and if the function is killed the lease expires and reconciliation resolves
 * it. This exists for the long-lived Postgres host.
 */
export const renewStatement = (sql: AnySql, p: { id: string; fence: number; leaseUntil: string }) => sql`
  update agent.agent_operations set lease_until = ${p.leaseUntil}
   where id = ${p.id} and fence_token = ${p.fence} and phase = 'running'
  returning id`;

/** The uncertainty write. Fenced, so only the holder of the claim may take it. */
export const uncertainStatement = (sql: AnySql, p: { id: string; fence: number }) => sql`
  update agent.agent_operations
     set phase = 'uncertain', lease_owner = null, lease_until = null,
         document = jsonb_set(document, '{phase}', '"uncertain"')
   where id = ${p.id} and fence_token = ${p.fence} and phase = 'running'
  returning id, document`;

/**
 * Reconciliation: a `running` row whose lease has passed becomes `uncertain`.
 *
 * Bounded and idempotent — a pass that runs twice reconciles nothing the first
 * one did, because the second pass finds no `running` rows past their lease.
 * **Nothing here re-dispatches.** The side effect may have happened.
 */
export const reconcileStatement = (sql: AnySql, p: { now: string; limit: number }) => sql`
  update agent.agent_operations
     set phase = 'uncertain', lease_owner = null, lease_until = null,
         document = jsonb_set(document, '{phase}', '"uncertain"')
   where id in (
     select id from agent.agent_operations
      where phase = 'running' and lease_until is not null and lease_until <= ${p.now}
      order by lease_until limit ${p.limit})
  returning id`;

/** Proposals nobody reviewed in time. Bounded, idempotent. */
export const expireStatement = (sql: AnySql, p: { now: string; limit: number }) => sql`
  update agent.agent_operations
     set phase = 'expired', document = jsonb_set(document, '{phase}', '"expired"')
   where id in (
     select id from agent.agent_operations
      where phase in ('prepared','approved') and expires_at <= ${p.now}
      order by expires_at limit ${p.limit})
  returning id`;

/** Uploaded source past its hour. Bounded, idempotent. */
export const sweepUploadsStatement = (sql: AnySql, p: { now: string; limit: number }) => sql`
  delete from agent.agent_uploads
   where id in (
     select id from agent.agent_uploads where expires_at <= ${p.now} order by expires_at limit ${p.limit})
  returning id`;

/* --------------------------------- journal --------------------------------- */

/** The Postgres implementation of `AgentJournal`. */
export class PgAgentJournal implements AgentJournal {
  readonly kind = 'postgres' as const;
  /** This instance's identity. One per process, exactly as the SQLite journal's is. */
  readonly workerId = randomUUID();
  private readonly client: Sql;
  private readonly clock: () => number;
  private checked: Promise<void> | undefined;
  /**
   * The fence this process holds for an operation it claimed.
   *
   * Remembered in memory on purpose: a finalize from an instance that did not
   * make the claim has no fence to present, changes zero rows, and the
   * operation resolves as `uncertain`. That is the required behaviour, not a
   * limitation — the second instance genuinely does not know what the first
   * one's dispatch did.
   */
  private readonly fences = new Map<string, number>();

  constructor(opts: { client?: Sql; clock?: () => number } = {}) {
    this.client = opts.client ?? pgAuthorityClient();
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * The schema check: started once, awaited by every read and every write.
   *
   * A rejection is kept and re-thrown to every later caller rather than
   * retried. A hundred instances re-checking a schema that is still missing is
   * load the project does not need, and the answer cannot change without
   * somebody applying the file. Modelled on `createPostgresAuthority()`.
   */
  ready(): Promise<void> {
    if (!this.checked)
      this.checked = (async () => {
        const rows = (await selectMigrations(this.client)) as unknown as { version: unknown; name: unknown }[];
        const found = rows.map((r) => ({ version: Number(r.version), name: String(r.name) }));
        const missing = REQUIRED_MIGRATIONS.find(
          (required) => !found.some((f) => f.version === required.version && f.name === required.name)
        );
        if (missing) throw schemaBehind(found, missing);
      })();
    return this.checked;
  }

  private async sql<T>(fn: (sql: AnySql) => Promise<T>): Promise<T> {
    await this.ready();
    return fn(this.client);
  }
  private async tx<T>(fn: (sql: TransactionSql) => Promise<T>): Promise<T> {
    await this.ready();
    return transactPg(this.client, fn);
  }

  private async row(sql: AnySql, id: string): Promise<Operation> {
    const rows = (await sql`select document from agent.agent_operations where id = ${id}`) as unknown as OperationRow[];
    if (!rows.length) throw new ControlError('operation_not_found', 'Operation not found in this scope.', 404);
    return rows[0].document;
  }

  /** The operation record plus the row's fence, for the guarded paths. */
  private async rowWithFence(sql: AnySql, id: string): Promise<{ op: Operation; fence: number } | undefined> {
    const rows = (await sql`select document, fence_token from agent.agent_operations where id = ${id}`) as unknown as OperationRow[];
    if (!rows.length) return undefined;
    return { op: rows[0].document, fence: readNumber(rows[0] as unknown as Record<string, unknown>, 'fence_token') };
  }

  private async event(sql: AnySql, op: Operation, kind: string): Promise<void> {
    await sql`insert into agent.agent_operation_events (operation_id, kind, at, document) values (
      ${op.id}, ${kind}, ${iso(this.clock())},
      ${asJson(sql, { operationId: op.id, phase: op.phase, digest: op.digest, integrationId: op.integrationId })})`;
  }

  /** Write the document and its denormalised phase, then record the event. */
  private async write(sql: AnySql, op: Operation, kind: string): Promise<Operation> {
    await sql`update agent.agent_operations
                 set phase = ${op.phase}, document = ${asJson(sql, op)},
                     approved_by = ${op.approvedBy ?? null}, approval_role = ${op.approvalRole ?? null},
                     approved_at = ${op.approvedAt ?? null}, finished_at = ${op.finishedAt ?? null}
               where id = ${op.id}`;
    await this.event(sql, op, kind);
    return op;
  }

  /* ------------------------------- prepare -------------------------------- */

  async prepare(who: Principal, proposal: Proposal, ttlMs = 15 * 60_000): Promise<Operation> {
    checkTarget(who, proposal.target, 'plan', this.clock());
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(proposal.requestKey))
      throw new ControlError('invalid_request_key', 'Use a stable 8–100 character request key.', 400);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 15 * 60_000)
      throw new ControlError('invalid_ttl', 'Plan lifetime must be at most fifteen minutes.', 400);
    if (Buffer.byteLength(JSON.stringify(proposal)) > 512_000)
      throw new ControlError('proposal_too_large', 'Narrow the proposal.', 413);
    // Derived state is excluded from idempotency for the same reason it is on
    // the file store: a retry must return the original reviewed plan, not
    // rebase it onto state that moved.
    const intentHash = digest({ action: proposal.action, input: proposal.input, target: proposal.target, source: proposal.source });
    return this.tx(async (sql) => {
      const existing = (await sql`
        select document, intent_hash from agent.agent_operations
         where workspace_id = ${who.workspaceId} and subject = ${who.subject} and request_key = ${proposal.requestKey}`) as unknown as
        { document: Operation; intent_hash: string }[];
      if (existing.length) {
        if (existing[0].intent_hash !== intentHash)
          throw new ControlError('idempotency_conflict', 'This request key belongs to different inputs.');
        return existing[0].document;
      }
      const now = iso(this.clock());
      await expireStatement(sql, { now, limit: SCAN_LIMIT });
      await sweepUploadsStatement(sql, { now, limit: SCAN_LIMIT });
      const counted = (await sql`
        select count(*)::int as n from agent.agent_operations
         where workspace_id = ${who.workspaceId} and subject = ${who.subject}
           and phase in ('prepared','approved','running')`) as unknown as { n: number }[];
      if (readNumber(counted[0] as unknown as Record<string, unknown>, 'n') >= 100)
        throw new ControlError('operation_quota', 'Reject or finish existing operations before preparing more.', 429);
      const expiresAt = iso(Math.min(this.clock() + ttlMs, Date.parse(who.expiresAt)));
      const op: Operation = {
        ...structuredClone(proposal), id: `op_${randomUUID()}`, subject: who.subject, integrationId: who.integrationId,
        createdAt: now, expiresAt, phase: 'prepared',
        digest: digest({ ...proposal, subject: who.subject, integrationId: who.integrationId, expiresAt }),
      };
      await sql`insert into agent.agent_operations (
          id, workspace_id, subject, integration_id, request_key, intent_hash, digest, phase,
          action, project_id, environment_id, document, created_at, expires_at)
        values (${op.id}, ${who.workspaceId}, ${who.subject}, ${who.integrationId}, ${proposal.requestKey},
          ${intentHash}, ${op.digest}, ${op.phase}, ${op.action}, ${proposal.target.projectId ?? null},
          ${proposal.target.environmentId ?? null}, ${asJson(sql, op)}, ${now}, ${expiresAt})`;
      await this.event(sql, op, 'prepared');
      return op;
    });
  }

  async findRequest(who: Principal, requestKey: string): Promise<Operation | undefined> {
    return this.sql(async (sql) => {
      const rows = (await sql`
        select document from agent.agent_operations
         where workspace_id = ${who.workspaceId} and subject = ${who.subject} and request_key = ${requestKey}`) as unknown as OperationRow[];
      if (!rows.length) return undefined;
      return this.scoped(who, rows[0].document);
    });
  }

  private scoped(who: Principal, op: Operation): Operation {
    checkTarget(who, op.target, 'read', this.clock());
    if (op.subject !== who.subject) throw new ControlError('operation_not_found', 'Operation not found in this scope.', 404);
    return op;
  }

  async get(who: Principal, id: string): Promise<Operation> {
    return this.sql(async (sql) => this.scoped(who, await this.row(sql, id)));
  }

  /* -------------------------------- review -------------------------------- */

  /** Browser-only caller resolves a fresh live user, scope and role before using this. */
  async review(id: string, subject: string, workspace: string, expectedDigest: string, approve: boolean,
    approver = subject, role: 'editor' | 'admin' = 'editor'): Promise<Operation> {
    return this.tx(async (sql) => {
      const locked = (await sql`select document from agent.agent_operations where id = ${id} for update`) as unknown as OperationRow[];
      if (!locked.length) throw new ControlError('operation_not_found', 'Operation not found.', 404);
      const op = locked[0].document;
      if (op.subject !== subject || op.target.workspaceId !== workspace)
        throw new ControlError('operation_not_found', 'Operation not found.', 404);
      if (op.digest !== expectedDigest) throw new ControlError('review_changed', 'Reload and review the exact proposal.');
      if (op.phase !== 'prepared') throw new ControlError('invalid_phase', 'This proposal is no longer awaiting review.');
      if (Date.parse(op.expiresAt) <= this.clock()) throw new ControlError('plan_expired', 'Prepare a fresh plan.');
      if (approve && op.plan.blocked) throw new ControlError('plan_blocked', 'Resolve blockers and prepare a new plan.');
      op.phase = approve ? 'approved' : 'rejected';
      op.approvedBy = approver; op.approvalRole = role; op.approvedAt = iso(this.clock());
      return this.write(sql, op, op.phase);
    });
  }

  /* --------------------------------- claim -------------------------------- */

  async claim(who: Principal, id: string, fingerprint: string, applicationAuthorizationDigest?: string): Promise<{ operation: Operation; claimed: boolean }> {
    await this.ready();
    const sql = this.client;
    const current = this.scoped(who, await this.row(sql, id));
    checkTarget(who, current.target, current.action.startsWith('app.') ? 'publish' : 'write', this.clock());
    // Already terminal, or already dispatched by somebody: the same branch the
    // SQLite journal takes, with the same answer — the row, unchanged.
    if (['running', 'succeeded', 'failed', 'uncertain'].includes(current.phase)) return { operation: current, claimed: false };

    const now = this.clock();
    const claimed: Operation = {
      ...current, phase: 'running', workerId: this.workerId, executedByIntegration: who.integrationId,
      authorizationDigest: who.grantDigest, applicationAuthorizationDigest,
    };
    const rows = (await claimStatement(sql, {
      id, leaseOwner: this.workerId, leaseUntil: iso(now + LEASE_MS),
      authorizationDigest: who.grantDigest ?? null,
      applicationAuthorizationDigest: applicationAuthorizationDigest ?? null,
      document: claimed, now: iso(now), digest: current.digest, fingerprint,
    })) as unknown as OperationRow[];

    if (!rows.length) {
      // Zero rows is never guessed at. Read the row once and say which
      // precondition failed, with the codes the file store already raises.
      const after = await this.row(sql, id);
      if (['running', 'succeeded', 'failed', 'uncertain'].includes(after.phase)) return { operation: after, claimed: false };
      if (after.phase !== 'approved' || !after.approvedBy || !after.approvalRole)
        throw new ControlError('approval_required', 'Review and approve this exact proposal in Zenith.');
      if (Date.parse(after.expiresAt) <= this.clock()) throw new ControlError('plan_expired', 'Prepare a fresh plan.');
      if (after.fingerprint !== fingerprint)
        throw new ControlError('stale_plan', 'State or permissions changed. Prepare and review a new plan.');
      throw new ControlError('approval_required', 'Review and approve this exact proposal in Zenith.');
    }

    const fence = readNumber(rows[0] as unknown as Record<string, unknown>, 'fence_token');
    this.remember(id, fence);
    const operation = rows[0].document;
    await this.event(sql, operation, 'claimed');
    return { operation, claimed: true };
  }

  /** Bounded so a long-lived host cannot grow this map without limit. */
  private remember(id: string, fence: number): void {
    if (this.fences.size >= 1000) this.fences.delete(this.fences.keys().next().value as string);
    this.fences.set(id, fence);
  }

  /** Extend this instance's lease. Long-lived hosts only; a serverless request is one attempt. */
  async renew(id: string, ms = LEASE_MS): Promise<boolean> {
    const fence = this.fences.get(id);
    if (fence === undefined) return false;
    const rows = (await this.sql((sql) => renewStatement(sql, { id, fence, leaseUntil: iso(this.clock() + ms) }))) as unknown as { id: string }[];
    return rows.length > 0;
  }

  /* ------------------------------- finalize ------------------------------- */

  async finishIfValid(who: Principal, id: string, result: unknown, success: boolean, applicationAuthorizationDigest?: string): Promise<Operation> {
    await this.ready();
    const sql = this.client;
    const fence = this.fences.get(id);
    if (fence === undefined)
      throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
    const op = await this.row(sql, id);
    if (op.subject !== who.subject || op.target.workspaceId !== who.workspaceId || op.executedByIntegration !== who.integrationId)
      throw new ControlError('authorization_changed', 'The authorized integration changed during dispatch.', 403);
    checkTarget(who, op.target, op.action.startsWith('app.') ? 'publish' : 'write', this.clock());
    const finishedAt = iso(this.clock());
    const finished: Operation = { ...op, phase: success ? 'succeeded' : 'failed', result: structuredClone(result), finishedAt };
    const rows = (await finalizeStatement(sql, {
      id, fence, phase: finished.phase as 'succeeded' | 'failed', finishedAt, document: finished,
      authorizationDigest: who.grantDigest ?? null,
      applicationAuthorizationDigest: applicationAuthorizationDigest ?? null,
    })) as unknown as OperationRow[];
    if (!rows.length) {
      // The guards are in the WHERE, so zero rows means one of them moved. Read
      // once and name it; every one of these paths ends as `uncertain` upstream.
      const after = await this.row(sql, id);
      if (after.phase !== 'running') throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
      if (Date.parse(after.expiresAt) <= this.clock())
        throw new ControlError('plan_expired', 'The approved operation expired before it could be finalized.', 409);
      throw new ControlError('authorization_changed', 'The integration grant, membership or role changed during dispatch.', 403);
    }
    this.fences.delete(id);
    await this.event(sql, finished, finished.phase);
    return rows[0].document;
  }

  async finish(id: string, result: unknown, success: boolean): Promise<Operation> {
    await this.ready();
    const sql = this.client;
    const fence = this.fences.get(id);
    if (fence === undefined) throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
    const op = await this.row(sql, id);
    const finishedAt = iso(this.clock());
    const finished: Operation = { ...op, phase: success ? 'succeeded' : 'failed', result: structuredClone(result), finishedAt };
    const rows = (await finalizeStatement(sql, {
      id, fence, phase: finished.phase as 'succeeded' | 'failed', finishedAt, document: finished,
      authorizationDigest: op.authorizationDigest ?? null,
      applicationAuthorizationDigest: op.applicationAuthorizationDigest ?? null,
    })) as unknown as OperationRow[];
    if (!rows.length) throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
    this.fences.delete(id);
    await this.event(sql, finished, finished.phase);
    return rows[0].document;
  }

  async uncertain(id: string): Promise<Operation> {
    await this.ready();
    const sql = this.client;
    const fence = this.fences.get(id);
    if (fence === undefined) return this.row(sql, id);
    const rows = (await uncertainStatement(sql, { id, fence })) as unknown as OperationRow[];
    this.fences.delete(id);
    if (!rows.length) return this.row(sql, id);
    await this.event(sql, rows[0].document, 'uncertain');
    return rows[0].document;
  }

  /* --------------------------------- reads -------------------------------- */

  async list(who: Principal, limit = 50, offset = 0): Promise<Operation[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000)
      throw new ControlError('invalid_page', 'Use a bounded page.', 400);
    return this.sql(async (sql) => {
      // Filter before paginating, so no out-of-scope row changes the page count.
      const rows = (await sql`
        select document from agent.agent_operations
         where workspace_id = ${who.workspaceId} and subject = ${who.subject}
         order by created_at desc limit 10000`) as unknown as OperationRow[];
      return rows.map((r) => r.document)
        .filter((op) => { try { checkTarget(who, op.target, 'read', this.clock()); return true; } catch { return false; } })
        .slice(offset, offset + limit);
    });
  }

  async events(who: Principal, id: string, after = 0, limit = 50): Promise<JournalEvent[]> {
    await this.get(who, id);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ControlError('invalid_page', 'Use a bounded event page.', 400);
    return this.sql(async (sql) => {
      const rows = (await sql`
        select seq, kind, at, document from agent.agent_operation_events
         where operation_id = ${id} and seq > ${after} order by seq limit ${limit}`) as unknown as
        { seq: unknown; kind: string; at: string; document: unknown }[];
      return rows.map((row) => ({
        sequence: readNumber(row as unknown as Record<string, unknown>, 'seq'),
        kind: row.kind, at: row.at, data: row.document,
      }));
    });
  }

  /** Trusted browser service only. Never expose this lookup without separate authorization. */
  async forReview(id: string, workspace: string): Promise<Operation> {
    return this.sql(async (sql) => {
      const op = await this.row(sql, id);
      if (op.target.workspaceId !== workspace) throw new ControlError('operation_not_found', 'Operation not found.', 404);
      return op;
    });
  }

  async reviewQueue(workspace: string, subject: string, admin: boolean): Promise<Operation[]> {
    return this.sql(async (sql) => {
      const rows = (await sql`
        select document from agent.agent_operations
         where workspace_id = ${workspace} and phase in ('prepared','approved')
         order by created_at desc limit 100`) as unknown as OperationRow[];
      return rows.map((r) => r.document).filter((op) => admin || op.subject === subject);
    });
  }

  /* -------------------------------- uploads ------------------------------- */

  async putUpload(who: Principal, target: Target, appId: string, bytes: Buffer): Promise<UploadReceipt> {
    checkTarget(who, target, 'publish', this.clock());
    if (!who.appIds?.includes(appId)) throw new ControlError('scope_denied', 'Select an explicitly authorized app.', 403);
    if (!bytes.length || bytes.length > 20 * 1024 * 1024)
      throw new ControlError('source_too_large', 'Source archive exceeds its upload limit.', 413);
    return this.tx(async (sql) => {
      const now = iso(this.clock());
      await sweepUploadsStatement(sql, { now, limit: SCAN_LIMIT });
      const usage = (await sql`
        select count(*)::int as n, coalesce(sum(octet_length(bytes)), 0)::bigint as size
          from agent.agent_uploads where workspace_id = ${who.workspaceId}`) as unknown as Record<string, unknown>[];
      const n = readNumber(usage[0], 'n'), size = readNumber(usage[0], 'size');
      if (n >= 20 || size + bytes.length > 100 * 1024 * 1024)
        throw new ControlError('upload_quota', 'Wait for pending uploads to expire before uploading more.', 429);
      const id = `upload_${randomUUID()}`;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const expires = iso(Math.min(this.clock() + 3600000, Date.parse(who.expiresAt)));
      await sql`insert into agent.agent_uploads (id, subject, workspace_id, project_id, app_id, sha256, expires_at, bytes)
        values (${id}, ${who.subject}, ${who.workspaceId}, ${projectOf(target)}, ${appId}, ${sha256}, ${expires}, ${bytes})`;
      return { uploadId: id, sha256, bytes: bytes.length, expiresAt: expires };
    });
  }

  async upload(who: Principal, target: Target, appId: string, id: string, expectedHash: string): Promise<Buffer> {
    checkTarget(who, target, 'publish', this.clock());
    return this.sql(async (sql) => {
      const rows = (await sql`
        select sha256, expires_at, bytes from agent.agent_uploads
         where id = ${id} and subject = ${who.subject} and workspace_id = ${who.workspaceId}
           and project_id = ${projectOf(target)} and app_id = ${appId}`) as unknown as
        { sha256: string; expires_at: string; bytes: Uint8Array }[];
      const row = rows[0];
      if (!who.appIds?.includes(appId) || !row || Date.parse(row.expires_at) <= this.clock() || row.sha256 !== expectedHash)
        throw new ControlError('upload_unavailable', 'Upload missing, expired, out of scope or changed. Upload and prepare again.', 404);
      const bytes = Buffer.from(row.bytes);
      if (createHash('sha256').update(bytes).digest('hex') !== expectedHash)
        throw new ControlError('upload_corrupt', 'Stored source integrity check failed.', 503);
      return bytes;
    });
  }

  /* --------------------------------- grants -------------------------------- */
  /*
   * OAuth client grants are not ported to Postgres in this round (CONTROL-PLANE
   * §11 O-2). `bindGrant()` is only reachable when `oauthConfig()` is
   * configured, and a Postgres install that also configures an external
   * authorization server is a phase-2 decision with its own migration. The
   * refusal is explicit rather than an empty list, because an empty list would
   * read as "this client has no grant" — which is a different, and wrong,
   * answer.
   */
  private unavailable(): never {
    throw new ControlError(
      'oauth_unavailable',
      'External OAuth client grants are not available on the Postgres agent control plane in this release. ' +
        'Fix: link the agent from the browser (Integrations → Linked agents), which issues a za_ credential, ' +
        'or run agent control on the single-host file store (ZENITH_STORE=file) if an external authorization server is required.',
      503
    );
  }
  async grants(_subject: string, _workspace: string): Promise<Grant[]> { this.unavailable(); }
  async getGrant(_subject: string, _clientId: string, _workspace: string): Promise<Grant | undefined> { this.unavailable(); }
  async setGrant(_grant: Grant): Promise<void> { this.unavailable(); }
}

type PgJournalGlobal = typeof globalThis & { __zenithAgentPgJournal?: PgAgentJournal };

/** The process-wide Postgres journal, created on first use. */
export function pgAgentJournal(): PgAgentJournal {
  const g = globalThis as PgJournalGlobal;
  return (g.__zenithAgentPgJournal ??= new PgAgentJournal());
}

/** Forget the singleton. Tests and scripts; a server exits. */
export function resetPgAgentJournal(): void {
  delete (globalThis as PgJournalGlobal).__zenithAgentPgJournal;
}
