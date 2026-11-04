/**
 * Three journal defects, on both stores.
 *
 *  1. **Postgres finalize did not check the lease.** `finalizeStatement` fenced
 *     on the fence token, the phase, plan expiry and both authority digests, but
 *     not on `lease_until`. A frozen instance that thawed after its lease ran
 *     out — when reconciliation may already be about to call the row
 *     `uncertain` — could still finalize it as `succeeded`. Now a finalize past
 *     the lease changes zero rows, and the coordinator's ordinary path (any
 *     refusal → `uncertain`) resolves it.
 *  2. **`uncertain` operations never reached the review queue.** The screen has a
 *     branch that explains them, but the queue only selected `prepared` and
 *     `approved`, so nobody was ever shown one. They are returned now — and are
 *     read-only: nothing can approve, reject, claim or un-approve one.
 *  3. **An approval could not be withdrawn.** `unapprove` moves `approved` back to
 *     `prepared` (clearing who approved, in what role and when) only while the
 *     operation has not been claimed, so a reviewer who changes their mind
 *     before dispatch has somewhere to go that is not "wait for it to expire".
 *
 * The file store runs for real (an in-memory SQLite journal). The Postgres
 * journal is exercised two ways here — the statements' text, and a scripted
 * client that answers by query so the journal's own branching is covered — and
 * against a real database in tests/agent-control/pg-contract.test.ts, which the
 * `postgres` CI lane runs.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Journal, SqliteAgentJournal, type Operation, type Principal, type Proposal,
} from '../src/lib/agent-access/control/journal';
import {
  PgAgentJournal, REQUIRED_MIGRATIONS, finalizeStatement, unapproveStatement, type AnySql,
} from '../src/lib/agent-access/control/journal-pg';
import { createPgAuthorityClient, type Sql } from '../src/lib/hosted/authority/pg/client';

const who: Principal = { subject: 'member', integrationId: 'codex', workspaceId: 'ws', projectIds: ['project'],
  scopes: ['read', 'plan', 'write'], expiresAt: '2099-01-01T00:00:00Z' };
const proposal: Proposal = { action: 'manifest.import', input: { source: 'source' }, target: { workspaceId: 'ws', projectId: 'project' },
  fingerprint: 'original-state', plan: { summary: 'reviewed', risk: 'low' }, requestKey: 'request_0001' };

function approved(j: Journal, requestKey = 'request_0001'): Operation {
  const op = j.prepare(who, { ...proposal, requestKey });
  return j.review(op.id, who.subject, who.workspaceId, op.digest, true, 'admin-ada', 'admin');
}

/* ------------------------------ file store ------------------------------- */

describe('file journal: uncertain operations reach the review queue', () => {
  it('lists an uncertain operation to its requester and to an admin, and not to a stranger', () => {
    const j = new Journal(':memory:');
    try {
      const op = approved(j);
      j.claim(who, op.id, proposal.fingerprint);
      expect(j.uncertain(op.id).phase).toBe('uncertain');

      const asAdmin = j.reviewQueue('ws', 'somebody-else', true);
      expect(asAdmin.map((o) => [o.id, o.phase])).toEqual([[op.id, 'uncertain']]);
      expect(j.reviewQueue('ws', who.subject, false).map((o) => o.id)).toEqual([op.id]);
      // Not another requester's, and not another workspace's.
      expect(j.reviewQueue('ws', 'somebody-else', false)).toEqual([]);
      expect(j.reviewQueue('other-workspace', who.subject, true)).toEqual([]);
    } finally { j.close(); }
  });

  it('still lists prepared and approved, and still leaves out settled operations', () => {
    const j = new Journal(':memory:');
    try {
      const prepared = j.prepare(who, { ...proposal, requestKey: 'request_prepared' });
      const ready = approved(j, 'request_approved');
      const done = approved(j, 'request_done');
      j.claim(who, done.id, proposal.fingerprint);
      j.finish(done.id, { ok: true }, true);
      const rejected = j.prepare(who, { ...proposal, requestKey: 'request_rejected' });
      j.review(rejected.id, who.subject, who.workspaceId, rejected.digest, false);

      const queue = j.reviewQueue('ws', who.subject, true);
      expect(queue.map((o) => o.id).sort()).toEqual([prepared.id, ready.id].sort());
    } finally { j.close(); }
  });

  it('cannot be approved, rejected, claimed or un-approved once it is uncertain', () => {
    const j = new Journal(':memory:');
    try {
      const op = approved(j);
      j.claim(who, op.id, proposal.fingerprint);
      j.uncertain(op.id);

      expect(() => j.review(op.id, who.subject, who.workspaceId, op.digest, true)).toThrow('no longer awaiting review');
      expect(() => j.review(op.id, who.subject, who.workspaceId, op.digest, false)).toThrow('no longer awaiting review');
      expect(() => j.unapprove(op.id, op.digest, 'admin-ada', 'ws')).toThrow('claimed');
      // Claiming reports "somebody else has it" rather than dispatching again.
      const again = j.claim(who, op.id, proposal.fingerprint);
      expect(again.claimed).toBe(false);
      expect(again.operation.phase).toBe('uncertain');
      expect(j.get(who, op.id).phase).toBe('uncertain');
    } finally { j.close(); }
  });
});

describe('file journal: unapprove', () => {
  it('returns an approved operation to prepared and clears who approved it', () => {
    const j = new Journal(':memory:');
    try {
      const op = approved(j);
      expect(j.get(who, op.id)).toMatchObject({ phase: 'approved', approvedBy: 'admin-ada', approvalRole: 'admin' });

      const back = j.unapprove(op.id, op.digest, 'admin-bob', 'ws');
      expect(back.phase).toBe('prepared');
      expect(back.approvedBy).toBeUndefined();
      expect(back.approvalRole).toBeUndefined();
      expect(back.approvedAt).toBeUndefined();
      // The proposal itself is untouched: same digest, same plan, same expiry.
      expect(back.digest).toBe(op.digest);
      expect(back.plan).toEqual(op.plan);
      expect(back.expiresAt).toBe(op.expiresAt);
      expect(j.get(who, op.id)).toEqual(back);
    } finally { j.close(); }
  });

  it('records who withdrew the approval in the event log', () => {
    const j = new Journal(':memory:');
    try {
      const op = approved(j);
      j.unapprove(op.id, op.digest, 'admin-bob', 'ws');
      const events = j.events(who, op.id) as { kind: string; data: { by?: string; phase: string } }[];
      const last = events[events.length - 1];
      expect(last.kind).toBe('unapproved');
      expect(last.data).toMatchObject({ phase: 'prepared', by: 'admin-bob' });
    } finally { j.close(); }
  });

  it('cannot be claimed afterwards, but can be approved again for the same exact proposal', () => {
    const j = new Journal(':memory:');
    try {
      const op = approved(j);
      j.unapprove(op.id, op.digest, 'admin-bob', 'ws');
      expect(() => j.claim(who, op.id, proposal.fingerprint)).toThrow('approve');
      expect(j.get(who, op.id).phase).toBe('prepared');

      const reapproved = j.review(op.id, who.subject, who.workspaceId, op.digest, true, 'admin-bob', 'admin');
      expect(reapproved.approvedBy).toBe('admin-bob');
      expect(j.claim(who, op.id, proposal.fingerprint).claimed).toBe(true);
    } finally { j.close(); }
  });

  it('may be followed by a rejection instead', () => {
    const j = new Journal(':memory:');
    try {
      const op = approved(j);
      j.unapprove(op.id, op.digest, 'admin-bob', 'ws');
      expect(j.review(op.id, who.subject, who.workspaceId, op.digest, false).phase).toBe('rejected');
    } finally { j.close(); }
  });

  it('refuses once the operation has been claimed, and leaves it running', () => {
    const j = new Journal(':memory:');
    try {
      const op = approved(j);
      expect(j.claim(who, op.id, proposal.fingerprint).claimed).toBe(true);
      expect(() => j.unapprove(op.id, op.digest, 'admin-bob', 'ws')).toThrow('claimed');
      expect(j.get(who, op.id)).toMatchObject({ phase: 'running', approvedBy: 'admin-ada' });
    } finally { j.close(); }
  });

  it('refuses when there is no approval to withdraw', () => {
    const j = new Journal(':memory:');
    try {
      const prepared = j.prepare(who, proposal);
      expect(() => j.unapprove(prepared.id, prepared.digest, 'admin-bob', 'ws')).toThrow('no approval to withdraw');

      const rejected = j.prepare(who, { ...proposal, requestKey: 'request_rejected' });
      j.review(rejected.id, who.subject, who.workspaceId, rejected.digest, false);
      expect(() => j.unapprove(rejected.id, rejected.digest, 'admin-bob', 'ws')).toThrow('no approval to withdraw');
    } finally { j.close(); }
  });

  it('requires the exact digest that was approved', () => {
    const j = new Journal(':memory:');
    try {
      const op = approved(j);
      expect(() => j.unapprove(op.id, 'tampered', 'admin-bob', 'ws')).toThrow('exact proposal');
      expect(j.get(who, op.id).phase).toBe('approved');
    } finally { j.close(); }
  });

  it('is scoped to the workspace: another workspace sees nothing to withdraw', () => {
    const j = new Journal(':memory:');
    try {
      const op = approved(j);
      expect(() => j.unapprove(op.id, op.digest, 'admin-mallory', 'foreign')).toThrow('not found');
      expect(() => j.unapprove('op_missing', op.digest, 'admin-bob', 'ws')).toThrow('not found');
      expect(j.get(who, op.id).phase).toBe('approved');
    } finally { j.close(); }
  });

  it('refuses an approval that has already expired, which could never be claimed anyway', () => {
    let now = Date.now();
    const j = new Journal(':memory:', () => now);
    try {
      const op = j.prepare(who, proposal, 1000);
      j.review(op.id, who.subject, who.workspaceId, op.digest, true, 'admin-ada', 'admin');
      now += 1001;
      expect(() => j.unapprove(op.id, op.digest, 'admin-bob', 'ws')).toThrow('fresh plan');
    } finally { j.close(); }
  });

  it('is available through the asynchronous interface the coordinator and the routes hold', async () => {
    const inner = new Journal(':memory:');
    const j = new SqliteAgentJournal(inner);
    try {
      const op = approved(inner);
      const back = await j.unapprove(op.id, op.digest, 'admin-bob', 'ws');
      expect(back.phase).toBe('prepared');
      await expect(j.unapprove(op.id, op.digest, 'admin-bob', 'ws')).rejects.toThrow('no approval to withdraw');
    } finally { inner.close(); }
  });
});

/* ------------------------- postgres: statement text ------------------------ */

interface Recorded { text: string; values: unknown[] }
const flat = (strings: TemplateStringsArray) => strings.raw.join(' ? ').replace(/\s+/g, ' ').trim();

function recordingSql(rows: unknown[] = []) {
  const recorded: Recorded[] = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    recorded.push({ text: flat(strings), values });
    return Promise.resolve(rows);
  }) as unknown as AnySql;
  (tag as unknown as { json: (v: unknown) => unknown }).json = (value: unknown) => ({ json: value });
  return { tag, recorded };
}

const running: Operation = {
  ...proposal, id: 'op_1', subject: who.subject, integrationId: who.integrationId,
  createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:15:00.000Z',
  digest: 'd'.repeat(64), phase: 'running', executedByIntegration: who.integrationId,
};

describe('postgres journal statements', () => {
  it('finalizes only while the lease still holds', async () => {
    const { tag, recorded } = recordingSql();
    await finalizeStatement(tag, {
      id: 'op_1', fence: 7, phase: 'succeeded', finishedAt: '2026-01-01T00:01:00.000Z', document: running,
      authorizationDigest: null, applicationAuthorizationDigest: null,
    });
    const text = recorded[0].text;
    // Compared against the finalize time itself: text timestamps in a fixed-width
    // ISO format, so the comparison is chronological, as it is for `expires_at`.
    expect(text).toContain('lease_until >');
    expect(text).toContain('fence_token =');
    expect(text).toContain("phase = 'running'");
    // The finalize time is bound for `expires_at` and for `lease_until`, and the
    // lease is compared with the same instant, not with a later `now()`.
    expect(recorded[0].values.filter((v) => v === '2026-01-01T00:01:00.000Z').length).toBeGreaterThanOrEqual(3);
  });

  it('withdraws an approval with one conditional update that carries every precondition', async () => {
    const { tag, recorded } = recordingSql();
    await unapproveStatement(tag, { id: 'op_1', workspaceId: 'ws', digest: 'd'.repeat(64), now: '2026-01-01T00:01:00.000Z' });
    const text = recorded[0].text;
    expect(text).toContain("set phase = 'prepared'");
    expect(text).toContain('approved_by = null');
    expect(text).toContain('approval_role = null');
    expect(text).toContain('approved_at = null');
    // The stored Operation loses the same fields, in the same statement.
    expect(text).toContain("document - 'approvedBy' - 'approvalRole' - 'approvedAt'");
    expect(text).toContain("jsonb_set(");
    // Every precondition is in the WHERE, so a claim that got there first —
    // which leaves the row `running` — changes zero rows here.
    expect(text).toContain("phase = 'approved'");
    expect(text).toContain('workspace_id =');
    expect(text).toContain('digest =');
    expect(text).toContain('expires_at >');
    expect(recorded[0].values).toEqual(expect.arrayContaining(['op_1', 'ws', 'd'.repeat(64)]));
  });
});

/* ------------------- postgres: the journal, on a scripted client ----------- */

/**
 * A client that answers by statement text, so `PgAgentJournal`'s own branching
 * can be exercised without a database. It proves the journal reads the
 * database's answer correctly; it cannot prove what the database answers — the
 * live suite does that.
 */
type Script = (text: string, values: unknown[]) => unknown[] | undefined;
function scripted(script: Script) {
  const seen: Recorded[] = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = flat(strings);
    seen.push({ text, values });
    if (text.startsWith('select version, name from agent.schema_migrations'))
      return Promise.resolve(REQUIRED_MIGRATIONS.map((m) => ({ ...m })));
    if (text.startsWith('insert into agent.agent_operation_events')) return Promise.resolve([]);
    const answer = script(text, values);
    if (!answer) throw new Error(`unscripted statement: ${text}`);
    return Promise.resolve(answer);
  }) as unknown as Sql;
  (tag as unknown as { json: (v: unknown) => unknown }).json = (value: unknown) => ({ json: value });
  // `transactPg` opens a real transaction through `begin`; run the callback on the same tag.
  (tag as unknown as { begin: (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown> }).begin = (fn) => fn(tag);
  return { client: tag, seen };
}

const isOperationRead = (text: string) => text.startsWith('select document from agent.agent_operations where id =');

/**
 * A journal whose operation is approved until it is claimed and `running` after,
 * as the database would have it. `finalize` and `diagnosis` answer the two
 * statements a finalize can issue.
 */
function claimable(
  doc: Operation,
  answers: { finalize: unknown[]; lease?: { lease_until: string } },
  nowIso: string
) {
  let claimed = false;
  const { client, seen } = scripted((text) => {
    if (isOperationRead(text))
      return [{ document: claimed ? doc : { ...doc, phase: 'approved', approvedBy: 'admin-ada', approvalRole: 'admin' } }];
    if (text.startsWith("update agent.agent_operations set phase = 'running'")) {
      claimed = true;
      return [{ id: 'op_1', fence_token: '3', document: doc }];
    }
    if (text.includes('set phase = ? , finished_at')) return answers.finalize;
    if (text.startsWith('select document, lease_until from agent.agent_operations'))
      return [{ document: doc, ...answers.lease }];
    return undefined;
  });
  return { journal: new PgAgentJournal({ client, clock: () => Date.parse(nowIso) }), seen };
}

describe('PgAgentJournal.finishIfValid past the lease', () => {
  it('refuses to finalize once the lease has lapsed, and says so', async () => {
    // The finalize matched nothing (the lease is past), and the diagnosis read
    // finds the lease over and the plan still good.
    const { journal, seen } = claimable(
      running,
      { finalize: [], lease: { lease_until: '2026-01-01T00:00:59.000Z' } },
      '2026-01-01T00:02:00.000Z'
    );
    expect((await journal.claim(who, 'op_1', proposal.fingerprint)).claimed).toBe(true);

    await expect(journal.finishIfValid(who, 'op_1', { ok: true }, true)).rejects.toMatchObject({ code: 'lease_expired' });
    // It says what happens next, rather than leaving the caller to guess.
    await expect(journal.finishIfValid(who, 'op_1', { ok: true }, true)).rejects.toThrow('uncertain');
    // Nothing recorded success.
    const wroteSuccess = seen.some(
      (s) => s.text.startsWith('insert into agent.agent_operation_events') && JSON.stringify(s.values).includes('succeeded')
    );
    expect(wroteSuccess).toBe(false);
  });

  it('reports an expired plan as the plan, not the lease, when both have passed', async () => {
    const past = { ...running, expiresAt: '2026-01-01T00:00:30.000Z' };
    const { journal } = claimable(
      past,
      { finalize: [], lease: { lease_until: '2026-01-01T00:00:59.000Z' } },
      '2026-01-01T00:02:00.000Z'
    );
    await journal.claim(who, 'op_1', proposal.fingerprint);
    await expect(journal.finishIfValid(who, 'op_1', { ok: true }, true)).rejects.toMatchObject({ code: 'plan_expired' });
  });

  it('still reports a moved authority as authority when the lease is fine', async () => {
    const { journal } = claimable(
      running,
      { finalize: [], lease: { lease_until: '2026-01-01T00:05:00.000Z' } },
      '2026-01-01T00:00:10.000Z'
    );
    await journal.claim(who, 'op_1', proposal.fingerprint);
    await expect(journal.finishIfValid(who, 'op_1', { ok: true }, true)).rejects.toMatchObject({ code: 'authorization_changed' });
  });

  it('finalizes normally while the lease holds', async () => {
    const { journal } = claimable(
      running,
      { finalize: [{ id: 'op_1', document: { ...running, phase: 'succeeded' } }] },
      '2026-01-01T00:00:10.000Z'
    );
    await journal.claim(who, 'op_1', proposal.fingerprint);
    expect((await journal.finishIfValid(who, 'op_1', { ok: true }, true)).phase).toBe('succeeded');
  });
});

describe('PgAgentJournal.reviewQueue and unapprove', () => {
  it('asks for uncertain operations as well as prepared and approved ones', async () => {
    const { client, seen } = scripted((text) => {
      if (text.startsWith('select document from agent.agent_operations where workspace_id =')) return [];
      return undefined;
    });
    await new PgAgentJournal({ client }).reviewQueue('ws', 'member', true);
    const query = seen.find((s) => s.text.includes('order by created_at desc limit 100'))!;
    expect(query.text).toContain("phase in ('prepared','approved','uncertain')");
    expect(query.values).toContain('ws');
  });

  it('returns uncertain operations to an admin and only the requester\'s own to anyone else', async () => {
    const uncertain = { ...running, id: 'op_u', phase: 'uncertain' as const };
    const foreign = { ...uncertain, id: 'op_f', subject: 'somebody-else' };
    const { client } = scripted((text) => {
      if (text.startsWith('select document from agent.agent_operations where workspace_id ='))
        return [{ document: uncertain }, { document: foreign }];
      return undefined;
    });
    const journal = new PgAgentJournal({ client });
    expect((await journal.reviewQueue('ws', 'member', true)).map((o) => o.id)).toEqual(['op_u', 'op_f']);
    expect((await journal.reviewQueue('ws', 'member', false)).map((o) => o.id)).toEqual(['op_u']);
  });

  it('unapproves through the one conditional update, then records the event', async () => {
    const approvedOp = { ...running, phase: 'approved' as const, approvedBy: 'admin-ada', approvalRole: 'admin' as const, approvedAt: 'x' };
    const prepared: Operation = { ...approvedOp, phase: 'prepared' };
    delete prepared.approvedBy; delete prepared.approvalRole; delete prepared.approvedAt;
    const { client, seen } = scripted((text) => {
      if (text.startsWith("update agent.agent_operations set phase = 'prepared'")) return [{ id: 'op_1', document: prepared }];
      return undefined;
    });
    const back = await new PgAgentJournal({ client, clock: () => Date.parse('2026-01-01T00:00:10.000Z') })
      .unapprove('op_1', approvedOp.digest, 'admin-bob', 'ws');
    expect(back.phase).toBe('prepared');
    expect(back.approvedBy).toBeUndefined();
    const event = seen.find((s) => s.text.startsWith('insert into agent.agent_operation_events'))!;
    expect(JSON.stringify(event.values)).toContain('unapproved');
    expect(JSON.stringify(event.values)).toContain('admin-bob');
  });

  it('names what stopped an unapprove when the update changed nothing', async () => {
    const base: Operation = { ...running, phase: 'approved', approvedBy: 'admin-ada', approvalRole: 'admin' };
    const make = (row: Partial<Operation> | undefined) => scripted((text) => {
      if (text.startsWith("update agent.agent_operations set phase = 'prepared'")) return [];
      if (text.startsWith('select document from agent.agent_operations where id =')) return row ? [{ document: { ...base, ...row } }] : [];
      return undefined;
    }).client;
    const clock = () => Date.parse('2026-01-01T00:00:10.000Z');
    const pg = (row: Partial<Operation> | undefined) => new PgAgentJournal({ client: make(row), clock });

    await expect(pg(undefined).unapprove('op_1', base.digest, 'b', 'ws')).rejects.toMatchObject({ code: 'operation_not_found', status: 404 });
    await expect(pg({ target: { workspaceId: 'foreign', projectId: 'project' } }).unapprove('op_1', base.digest, 'b', 'ws'))
      .rejects.toMatchObject({ code: 'operation_not_found', status: 404 });
    await expect(pg({}).unapprove('op_1', 'not-the-digest', 'b', 'ws')).rejects.toMatchObject({ code: 'review_changed' });
    await expect(pg({ phase: 'running' }).unapprove('op_1', base.digest, 'b', 'ws')).rejects.toThrow('claimed');
    await expect(pg({ phase: 'uncertain' }).unapprove('op_1', base.digest, 'b', 'ws')).rejects.toThrow('claimed');
    await expect(pg({ phase: 'prepared' }).unapprove('op_1', base.digest, 'b', 'ws')).rejects.toThrow('no approval to withdraw');
    await expect(pg({ expiresAt: '2026-01-01T00:00:05.000Z' }).unapprove('op_1', base.digest, 'b', 'ws'))
      .rejects.toMatchObject({ code: 'plan_expired' });
  });
});

/* -------------------------- postgres: the real thing ---------------------- */

/**
 * The properties only a database can demonstrate: that the lease really is in
 * the finalize's WHERE, and that an approval being withdrawn races a claim on
 * the row lock with exactly one winner. Gated like the rest of the live suites
 * (ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL); skipped, loudly, otherwise.
 * The migrations are applied by the same statements the other live suite uses.
 */
const PG_LIVE = process.env.ZENITH_CONTRACT_POSTGRES === '1' && Boolean(process.env.SUPABASE_DB_URL);
if (!PG_LIVE)
  console.warn(
    '\n[agent-control journal fixes] the live Postgres suite is SKIPPED: ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL are not both set.\n' +
      '  It is what proves the lease is enforced by the database and that un-approve races a claim safely.\n'
  );

describe.skipIf(!PG_LIVE)('postgres agent journal: lease, un-approve and the queue (live)', () => {
  const namespace = `fixes-${randomUUID()}`;
  const pgWho: Principal = { ...who, subject: `${namespace}-member`, workspaceId: `${namespace}-ws`, projectIds: [`${namespace}-project`] };
  const pgProposal: Proposal = { ...proposal, target: { workspaceId: pgWho.workspaceId, projectId: pgWho.projectIds[0] } };
  let clientA: Sql;
  let clientB: Sql;
  const key = (suffix: string): string => `request_${suffix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  beforeAll(async () => {
    clientA = createPgAuthorityClient(process.env.SUPABASE_DB_URL!);
    clientB = createPgAuthorityClient(process.env.SUPABASE_DB_URL!);
    // The `postgres` CI lane applies every committed migration first. Apply
    // 0007 here only when the schema is not already there (a bare local
    // database), so two live files starting together do not run DDL at once.
    const ledger = (await clientA`select to_regclass('agent.schema_migrations') as t`) as unknown as { t: string | null }[];
    const applied = ledger[0].t
      ? ((await clientA`select version from agent.schema_migrations where version in (1, 2)`) as unknown as unknown[]).length
      : 0;
    if (applied < 2) {
      await clientA.unsafe(
        "do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') " +
          'then create role service_role nologin noinherit; end if; end $$;'
      );
      await clientA.unsafe(readFileSync(join(process.cwd(), 'supabase/migrations/0007_agent_control.sql'), 'utf8'));
      await clientA.unsafe(
        "insert into agent.schema_migrations (version, name, applied_at) values (1, 'agent-link-v1', '2026-01-01T00:00:00.000Z') on conflict (version) do nothing"
      );
    }
  });

  afterAll(async () => {
    await clientA`delete from agent.agent_operation_events where operation_id in (select id from agent.agent_operations where workspace_id = ${pgWho.workspaceId})`;
    await clientA`delete from agent.agent_operations where workspace_id = ${pgWho.workspaceId}`;
    await clientA.end({ timeout: 5 });
    await clientB.end({ timeout: 5 });
  });

  async function approvedOp(journal: PgAgentJournal, requestKey = key('ready')) {
    const op = await journal.prepare(pgWho, { ...pgProposal, requestKey });
    await journal.review(op.id, pgWho.subject, pgWho.workspaceId, op.digest, true, 'admin-ada', 'admin');
    return op;
  }
  const columns = async (id: string) =>
    (await clientA`select phase, approved_by, approval_role, approved_at, lease_until, document from agent.agent_operations where id = ${id}`)[0];

  it('refuses a finalize after the lease lapsed, and the row is resolved as uncertain, never as a success', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const op = await approvedOp(a);
    expect((await a.claim(pgWho, op.id, pgProposal.fingerprint)).claimed).toBe(true);

    // The instance froze past its lease and thawed.
    await clientA`update agent.agent_operations set lease_until = '1999-01-01T00:00:00.000Z' where id = ${op.id}`;
    await expect(a.finishIfValid(pgWho, op.id, { ok: true }, true)).rejects.toMatchObject({ code: 'lease_expired' });
    expect((await columns(op.id)).phase).toBe('running');

    // What the coordinator does with any refusal.
    expect((await a.uncertain(op.id)).phase).toBe('uncertain');
    expect((await columns(op.id)).phase).toBe('uncertain');
    expect((await a.claim(pgWho, op.id, pgProposal.fingerprint)).claimed).toBe(false);
  });

  it('still finalizes while the lease holds', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const op = await approvedOp(a);
    await a.claim(pgWho, op.id, pgProposal.fingerprint);
    expect((await a.finishIfValid(pgWho, op.id, { ok: true }, true)).phase).toBe('succeeded');
    expect((await columns(op.id)).phase).toBe('succeeded');
  });

  it('withdraws an approval: phase, columns and document all go back, and it cannot be claimed', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const op = await approvedOp(a);
    expect(await columns(op.id)).toMatchObject({ phase: 'approved', approved_by: 'admin-ada', approval_role: 'admin' });

    const back = await a.unapprove(op.id, op.digest, 'admin-bob', pgWho.workspaceId);
    expect(back.phase).toBe('prepared');
    expect(back.approvedBy).toBeUndefined();
    const row = await columns(op.id);
    expect(row).toMatchObject({ phase: 'prepared', approved_by: null, approval_role: null, approved_at: null });
    const doc = row.document as Operation;
    expect(doc.phase).toBe('prepared');
    expect(doc).not.toHaveProperty('approvedBy');
    expect(doc).not.toHaveProperty('approvalRole');
    expect(doc).not.toHaveProperty('approvedAt');
    expect(doc.digest).toBe(op.digest);

    await expect(a.claim(pgWho, op.id, pgProposal.fingerprint)).rejects.toThrow('approve');
    const events = await a.events(pgWho, op.id);
    expect(events[events.length - 1]).toMatchObject({ kind: 'unapproved', data: { phase: 'prepared', by: 'admin-bob' } });

    // The same exact proposal can be approved again, and then dispatched.
    await a.review(op.id, pgWho.subject, pgWho.workspaceId, op.digest, true, 'admin-bob', 'admin');
    expect((await a.claim(pgWho, op.id, pgProposal.fingerprint)).claimed).toBe(true);
  });

  it('refuses to withdraw a claimed, foreign, changed or unapproved operation, and changes nothing', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const op = await approvedOp(a);
    await expect(a.unapprove(op.id, 'f'.repeat(64), 'admin-bob', pgWho.workspaceId)).rejects.toMatchObject({ code: 'review_changed' });
    await expect(a.unapprove(op.id, op.digest, 'admin-mallory', 'another-workspace')).rejects.toMatchObject({ code: 'operation_not_found', status: 404 });
    await expect(a.unapprove('op_missing', op.digest, 'admin-bob', pgWho.workspaceId)).rejects.toMatchObject({ code: 'operation_not_found' });
    expect((await columns(op.id)).phase).toBe('approved');

    await a.claim(pgWho, op.id, pgProposal.fingerprint);
    await expect(a.unapprove(op.id, op.digest, 'admin-bob', pgWho.workspaceId)).rejects.toThrow('claimed');
    expect((await columns(op.id)).phase).toBe('running');

    const prepared = await a.prepare(pgWho, { ...pgProposal, requestKey: key('prepared') });
    await expect(a.unapprove(prepared.id, prepared.digest, 'admin-bob', pgWho.workspaceId)).rejects.toThrow('no approval to withdraw');
  });

  it('an un-approve racing a claim on two connections has exactly one winner, whichever gets the row first', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const b = new PgAgentJournal({ client: clientB });
    for (let i = 0; i < 12; i++) {
      const op = await approvedOp(a, key('race' + i));
      const [withdrawn, claimed] = await Promise.allSettled([
        a.unapprove(op.id, op.digest, 'admin-bob', pgWho.workspaceId),
        b.claim(pgWho, op.id, pgProposal.fingerprint),
      ]);
      const phase = (await columns(op.id)).phase;
      if (withdrawn.status === 'fulfilled') {
        // Withdrawn first: the claim must have been refused, and the row is prepared.
        expect(claimed.status).toBe('rejected');
        expect(phase).toBe('prepared');
      } else {
        // Claimed first: the row is running and the withdrawal was refused.
        expect(claimed.status).toBe('fulfilled');
        expect((claimed as PromiseFulfilledResult<{ claimed: boolean }>).value.claimed).toBe(true);
        expect(phase).toBe('running');
      }
      // Never both, never neither. Which side wins is the database's to decide.
    }
  });

  it('lists an uncertain operation in the review queue, read-only', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const op = await approvedOp(a);
    await a.claim(pgWho, op.id, pgProposal.fingerprint);
    await a.uncertain(op.id);

    const asAdmin = await a.reviewQueue(pgWho.workspaceId, 'somebody-else', true);
    expect(asAdmin.find((o) => o.id === op.id)?.phase).toBe('uncertain');
    expect((await a.reviewQueue(pgWho.workspaceId, pgWho.subject, false)).some((o) => o.id === op.id)).toBe(true);
    expect((await a.reviewQueue(pgWho.workspaceId, 'somebody-else', false)).some((o) => o.id === op.id)).toBe(false);
    expect((await a.reviewQueue('another-workspace', pgWho.subject, true)).some((o) => o.id === op.id)).toBe(false);

    // And nothing can act on it.
    await expect(a.review(op.id, pgWho.subject, pgWho.workspaceId, op.digest, true)).rejects.toThrow('no longer awaiting review');
    await expect(a.unapprove(op.id, op.digest, 'admin-bob', pgWho.workspaceId)).rejects.toThrow('claimed');
    expect((await a.claim(pgWho, op.id, pgProposal.fingerprint)).claimed).toBe(false);
    expect((await columns(op.id)).phase).toBe('uncertain');
  });
});

