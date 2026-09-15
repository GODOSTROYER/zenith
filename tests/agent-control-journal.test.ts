import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, SqliteAgentJournal, digest, type Principal, type Proposal } from '../src/lib/agent-access/control/journal';
import {
  PgAgentJournal, SCAN_LIMIT, claimStatement, expireStatement, finalizeStatement,
  reconcileStatement, renewStatement, sweepUploadsStatement, type AnySql,
} from '../src/lib/agent-access/control/journal-pg';
import { createPgAuthorityClient, type Sql } from '../src/lib/hosted/authority/pg/client';
const who: Principal = { subject: 'member', integrationId: 'codex', workspaceId: 'ws', projectIds: ['project'],
  scopes: ['read','plan','write'], expiresAt: '2099-01-01T00:00:00Z' };
const proposal: Proposal = { action: 'manifest.import', input: { source: 'source' }, target: { workspaceId: 'ws', projectId: 'project' },
  fingerprint: 'original-state', plan: { summary: 'reviewed', risk: 'low' }, requestKey: 'request_0001' };
function ready(j: Journal) { const op = j.prepare(who, proposal); j.review(op.id, who.subject, who.workspaceId, op.digest, true); return op; }
/**
 * The on-disk cases cannot run on Windows.
 *
 * `new Journal(<path>)` refuses any file whose parent directory is not owned by
 * this uid and not private to it — and the condition names the platform
 * outright: `process.platform === 'win32'` is one of its disjuncts
 * (`src/lib/agent-access/control/journal.ts:54-57`), alongside `parent.uid !==
 * process.getuid!()` and `parent.mode & 0o077`. Windows has neither uids nor
 * POSIX mode bits, so the constructor throws `journal_permissions` before the
 * journal is ever opened. That is the guard working, not a bug: agent control
 * is only supported on a long-lived POSIX host (`docs/AGENT-CONTROL.md`).
 *
 * So these two skip on win32 with the reason printed, rather than failing. A
 * red local suite that is red for a reason nobody can fix teaches developers to
 * ignore red. CI runs them for real on ubuntu-latest.
 */
const POSIX_JOURNAL_ONLY = process.platform === 'win32';
if (POSIX_JOURNAL_ONLY)
  console.warn(
    '\n[agent-control journal] 2 tests SKIPPED on win32: the journal requires an owned private POSIX directory\n' +
      '  (src/lib/agent-access/control/journal.ts:54-57 refuses win32 explicitly, and reads process.getuid()).\n' +
      '  They are not skipped on Linux or macOS, and CI runs them.\n'
  );
describe('durable agent journal', () => {
  it('canonical digests ignore object key order but not values or arrays', () => {
    expect(digest({ b: 2, a: [1,2] })).toBe(digest({ a: [1,2], b: 2 }));
    expect(digest({ a: [1,2] })).not.toBe(digest({ a: [2,1] }));
  });
  it('does not confuse a prepared receipt with approval', () => {
    const j = new Journal(':memory:'); try { const op = j.prepare(who, proposal);
      expect(() => j.claim(who, op.id, proposal.fingerprint)).toThrow('approve');
    } finally { j.close(); }
  });
  it('replays preparation without silently rebasing changed state', () => {
    const j = new Journal(':memory:'); try {
      const op = j.prepare(who, proposal);
      expect(j.prepare(who, { ...proposal, fingerprint: 'new' })).toEqual(op);
      expect(() => j.prepare(who, { ...proposal, input: { source: 'other' } })).toThrow('different inputs');
    } finally { j.close(); }
  });
  it('requires the exact approval digest, actor and workspace', () => {
    const j = new Journal(':memory:'); try { const op = j.prepare(who, proposal);
      expect(() => j.review(op.id, who.subject, who.workspaceId, 'tampered', true)).toThrow('exact proposal');
      expect(() => j.review(op.id, 'attacker', who.workspaceId, op.digest, true)).toThrow('not found');
      expect(() => j.review(op.id, who.subject, 'foreign', op.digest, true)).toThrow('not found');
    } finally { j.close(); }
  });
  it('refuses blocked plans and stale state', () => {
    const j = new Journal(':memory:'); try {
      const blocked = j.prepare(who, { ...proposal, plan: { blocked: 'AWS Preview cannot apply' }, requestKey: 'blocked_0001' });
      expect(() => j.review(blocked.id, who.subject, who.workspaceId, blocked.digest, true)).toThrow('blockers');
      const op = ready(j); expect(() => j.claim(who, op.id, 'changed')).toThrow('State or permissions changed');
    } finally { j.close(); }
  });
  it('refuses missing write scope and foreign project, environment and subject', () => {
    const j = new Journal(':memory:'); try { const op = ready(j);
      expect(() => j.claim({ ...who, scopes: ['read','plan'] }, op.id, proposal.fingerprint)).toThrow('cannot access');
      expect(() => j.get({ ...who, projectIds: [] }, op.id)).toThrow('cannot access');
      expect(() => j.get({ ...who, subject: 'other' }, op.id)).toThrow('not found');
      expect(() => j.prepare({ ...who, environmentIds: ['staging'] }, { ...proposal, target: { ...proposal.target, environmentId: 'production' } })).toThrow('cannot access');
    } finally { j.close(); }
  });
  it('allows same-user cross-client observation without duplicating execution', () => {
    const j = new Journal(':memory:'); try { const op = ready(j);
      expect(j.claim(who, op.id, proposal.fingerprint).claimed).toBe(true);
      expect(j.claim({ ...who, integrationId: 'claude' }, op.id, proposal.fingerprint).claimed).toBe(false);
      expect(j.get({ ...who, integrationId: 'claude' }, op.id).id).toBe(op.id);
      j.finish(op.id, { ok: true, deploymentId: 'dep' }, true);
      expect(j.claim(who, op.id, 'different-after-execution').operation.phase).toBe('succeeded');
    } finally { j.close(); }
  });
  it('expires both approval and dispatch', () => {
    let now = Date.now(); const j = new Journal(':memory:', () => now);
    try { const op = j.prepare(who, proposal, 1000); now += 1001;
      expect(() => j.review(op.id, who.subject, who.workspaceId, op.digest, true)).toThrow('fresh plan');
      now -= 1001; const other = ready(j); now += 16*60_000;
      expect(() => j.claim(who, other.id, proposal.fingerprint)).toThrow('fresh plan');
    } finally { j.close(); }
  });
  it('does not finalize an operation after its approval expires', () => {
    let now = Date.now(); const j = new Journal(':memory:', () => now);
    try {
      const op = j.prepare(who, proposal, 1000);
      j.review(op.id, who.subject, who.workspaceId, op.digest, true);
      j.claim(who, op.id, proposal.fingerprint);
      now += 1001;
      expect(() => j.finishIfValid(who, op.id, { ok: true }, true)).toThrow('expired');
      expect(j.get(who, op.id).phase).toBe('running');
    } finally { j.close(); }
  });
  it('fences finalization when the durable OAuth grant is revoked', () => {
    const j = new Journal(':memory:');
    const client = 'codex-client';
    const grant = { ...who, clientId: client, integrationId: 'integration', revoked: false };
    const authenticated = { ...who, clientId: client } as Principal & { clientId: string };
    try {
      j.setGrant(grant);
      const op = j.prepare(authenticated, proposal);
      j.review(op.id, who.subject, who.workspaceId, op.digest, true);
      j.claim(authenticated, op.id, proposal.fingerprint);
      j.setGrant({ ...grant, revoked: true });
      expect(() => j.finishIfValid(authenticated, op.id, { ok: true }, true)).toThrow('grant changed');
      expect(j.get(authenticated, op.id).phase).toBe('running');
    } finally { j.close(); }
  });
  it.skipIf(POSIX_JOURNAL_ONLY)('persists across restarts and never blindly replays an interrupted dispatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zenith-journal-')); const file = join(dir, 'agent.sqlite');
    try { const first = new Journal(file); const op = ready(first); first.claim(who, op.id, proposal.fingerprint); first.close();
      const second = new Journal(file); try {
        expect(second.recover()).toBe(1); expect(second.get(who, op.id).phase).toBe('uncertain');
        expect(second.claim(who, op.id, proposal.fingerprint).claimed).toBe(false);
        expect(second.prepare(who, proposal).id).toBe(op.id);
      } finally { second.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.skipIf(POSIX_JOURNAL_ONLY)('two journal connections cannot claim the same receipt twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zenith-claim-')); const file = join(dir, 'agent.sqlite');
    const first = new Journal(file), second = new Journal(file);
    try { const op = ready(first); expect(first.claim(who, op.id, proposal.fingerprint).claimed).toBe(true);
      expect(second.claim(who, op.id, proposal.fingerprint).claimed).toBe(false);
      expect(() => second.finish(op.id, {}, true)).toThrow('does not own');
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('event pages are bounded and operation-scoped', () => {
    const j = new Journal(':memory:'); try { const op = ready(j); expect(j.events(who, op.id, 0, 1)).toHaveLength(1);
      expect(() => j.events(who, op.id, 0, 101)).toThrow('bounded');
      expect(() => j.events({ ...who, subject: 'other' }, op.id)).toThrow('not found');
    } finally { j.close(); }
  });
});

/* ========================================================================== *
 * The asynchronous interface, and the Postgres implementation behind it.
 * ========================================================================== */

/**
 * `SqliteAgentJournal` must be the SQLite journal and nothing else.
 *
 * It is a delegation layer, so the only thing worth testing about it is that it
 * delegates: same answers, same refusals, same codes, one promise deep. A
 * wrapper that quietly turned a refusal into a resolved value would throw away
 * the whole of the file store's guarantees.
 */
describe('SqliteAgentJournal', () => {
  it('answers exactly as the synchronous journal does, asynchronously', async () => {
    const inner = new Journal(':memory:');
    const j = new SqliteAgentJournal(inner);
    try {
      expect(j.kind).toBe('file');
      expect(j.workerId).toBe(inner.workerId);
      const op = await j.prepare(who, proposal);
      expect(await j.findRequest(who, proposal.requestKey)).toEqual(op);
      // Same refusal, same message, now as a rejection.
      await expect(j.claim(who, op.id, proposal.fingerprint)).rejects.toThrow('approve');
      await j.review(op.id, who.subject, who.workspaceId, op.digest, true);
      expect((await j.claim(who, op.id, proposal.fingerprint)).claimed).toBe(true);
      expect((await j.finishIfValid(who, op.id, { ok: true }, true)).phase).toBe('succeeded');
      expect(await j.list(who)).toHaveLength(1);
      expect((await j.events(who, op.id)).length).toBeGreaterThan(0);
      expect(await j.reviewQueue(who.workspaceId, who.subject, true)).toHaveLength(0);
    } finally { inner.close(); }
  });

  it('exposes the boot-time recovery only the single-writer host may use', async () => {
    const inner = new Journal(':memory:');
    const j = new SqliteAgentJournal(inner);
    try {
      // Nothing running: recovery has nothing to reclaim, and says so with 0
      // rather than with a silent success.
      expect(await j.recover()).toBe(0);
      expect(await j.expire()).toEqual({ expired: 0, uploads: 0 });
    } finally { inner.close(); }
  });
});

/**
 * The Postgres journal's SQL, proven without a Postgres.
 *
 * Every statement is an exported function taking the tag it runs on, so a
 * recording tag can be handed in and its text and bound values inspected. This
 * is not a substitute for the live suite below — it cannot prove the database
 * behaves — but it is what keeps the claim's shape honest on a machine with no
 * database anywhere near it, which is where most of this code is read and
 * edited.
 */
interface Recorded { text: string; values: unknown[] }
function recordingSql(rows: unknown[] = []) {
  const recorded: Recorded[] = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    recorded.push({ text: strings.raw.join(' ? ').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve(rows);
  }) as unknown as AnySql;
  (tag as unknown as { json: (v: unknown) => unknown }).json = (value: unknown) => ({ json: value });
  return { tag, recorded };
}

describe('postgres journal statements', () => {
  const operation = {
    ...proposal, id: 'op_1', subject: who.subject, integrationId: who.integrationId,
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:15:00.000Z',
    digest: 'd'.repeat(64), phase: 'running' as const,
  };

  it('claims with one conditional update that carries every precondition', async () => {
    const { tag, recorded } = recordingSql();
    await claimStatement(tag, {
      id: 'op_1', leaseOwner: 'worker', leaseUntil: '2026-01-01T00:01:00.000Z',
      authorizationDigest: null, applicationAuthorizationDigest: 'app-digest', document: operation,
      now: '2026-01-01T00:00:30.000Z', digest: 'd'.repeat(64), fingerprint: 'original-state',
    });
    const text = recorded[0].text;
    expect(text).toContain("set phase = 'running'");
    // The fence is incremented by the database in the same statement that
    // decides the claim. Reading it, adding one in JS and writing it back is
    // exactly the race a fence exists to close.
    expect(text).toContain('fence_token = fence_token + 1');
    expect(text).toContain("and phase = 'approved'");
    expect(text).toContain('approved_by is not null');
    expect(text).toContain('approval_role is not null');
    expect(text).toContain('expires_at >');
    expect(text).toContain("(document ->> 'fingerprint') =");
    expect(text).toContain('returning id, fence_token, document');
    expect(recorded[0].values).toContain('original-state');
    expect(recorded[0].values).toContain('app-digest');
  });

  it('fences finalization on the token the claim returned', async () => {
    const { tag, recorded } = recordingSql();
    await finalizeStatement(tag, {
      id: 'op_1', fence: 7, phase: 'succeeded', finishedAt: '2026-01-01T00:01:00.000Z',
      document: operation, authorizationDigest: null, applicationAuthorizationDigest: null,
    });
    expect(recorded[0].text).toContain('fence_token =');
    expect(recorded[0].text).toContain("and phase = 'running'");
    expect(recorded[0].text).toContain('authorization_digest is not distinct from');
    expect(recorded[0].values).toContain(7);
  });

  it('reconciles only leases that have actually passed, and never re-dispatches', async () => {
    const { tag, recorded } = recordingSql();
    await reconcileStatement(tag, { now: '2026-01-01T00:05:00.000Z', limit: SCAN_LIMIT });
    const text = recorded[0].text;
    expect(text).toContain("set phase = 'uncertain'");
    expect(text).toContain("where phase = 'running'");
    expect(text).toContain('lease_until is not null');
    expect(text).toContain('lease_until <=');
    // Bounded, so a backlog is drained a pass at a time rather than in one
    // transaction that outlives the function.
    expect(text).toContain('limit');
    expect(recorded[0].values).toContain(SCAN_LIMIT);
    // Nothing in the reconciliation may put a row back into a dispatchable
    // phase: the side effect may already have happened.
    expect(text).not.toContain("'approved'");
  });

  it('bounds the expiry and upload sweeps the same way', async () => {
    const { tag, recorded } = recordingSql();
    await expireStatement(tag, { now: 'now', limit: SCAN_LIMIT });
    await sweepUploadsStatement(tag, { now: 'now', limit: SCAN_LIMIT });
    expect(recorded[0].text).toContain("set phase = 'expired'");
    expect(recorded[0].values).toContain(SCAN_LIMIT);
    expect(recorded[1].text).toContain('delete from agent.agent_uploads');
    expect(recorded[1].values).toContain(SCAN_LIMIT);
  });

  it('renews a lease only for the fence it holds', async () => {
    const { tag, recorded } = recordingSql();
    await renewStatement(tag, { id: 'op_1', fence: 3, leaseUntil: 'later' });
    expect(recorded[0].text).toContain('fence_token =');
    expect(recorded[0].text).toContain("and phase = 'running'");
    expect(recorded[0].values).toEqual(expect.arrayContaining(['op_1', 3, 'later']));
    expect(recorded[0].values).toHaveLength(3);
  });

  it('refuses OAuth client grants rather than answering "no grant"', async () => {
    const journal = new PgAgentJournal({ client: recordingSql().tag });
    // An empty list would read as "this client has no grant", which is a
    // different — and wrong — answer from "this store does not hold grants".
    await expect(journal.getGrant('s', 'c', 'w')).rejects.toThrow('not available on the Postgres agent control plane');
    await expect(journal.grants('s', 'w')).rejects.toThrow('ZENITH_STORE=file');
  });
});

/* -------------------------- the live Postgres suite ------------------------ */

/**
 * The properties that only a real database can demonstrate.
 *
 * Two connections, one claim; a lease that expires; a fence that is stale.
 * None of these can be proven against a recording tag, and none of them is
 * worth believing from a comment — the whole reason the journal moved into
 * Postgres is that the coordination is the database's job now.
 *
 * Both `ZENITH_CONTRACT_POSTGRES=1` and `SUPABASE_DB_URL` are required, and the
 * two do different jobs: the URL says a database exists, and the flag says you
 * meant it — this writes rows, and a suite that silently started writing to
 * whatever `.env.local` points at would be an unpleasant surprise. Unset, the
 * suite skips and prints why.
 */
const PG_LIVE = process.env.ZENITH_CONTRACT_POSTGRES === '1' && Boolean(process.env.SUPABASE_DB_URL);
if (!PG_LIVE) {
  const missing: string[] = [];
  if (process.env.ZENITH_CONTRACT_POSTGRES !== '1') missing.push('ZENITH_CONTRACT_POSTGRES=1');
  if (!process.env.SUPABASE_DB_URL) missing.push('SUPABASE_DB_URL=<pooler URI>');
  console.warn(
    '\n[agent-control journal] the live Postgres suite is SKIPPED: ' + missing.join(' and ') + ' not set.\n' +
      '  It proves the two-connection claim race, lease expiry to `uncertain` with no re-dispatch,\n' +
      '  and the stale-fence finalize — none of which a fake tag can demonstrate.\n' +
      '  CI runs it in the postgres lane (.github/workflows/ci.yml).\n'
  );
}

describe.skipIf(!PG_LIVE)('postgres agent journal (live)', () => {
  const namespace = `contract-${randomUUID()}`;
  const pgWho: Principal = { ...who, subject: `${namespace}-member`, workspaceId: `${namespace}-ws`, projectIds: [`${namespace}-project`] };
  const pgProposal: Proposal = { ...proposal, target: { workspaceId: pgWho.workspaceId, projectId: pgWho.projectIds[0] } };
  let clientA: Sql;
  let clientB: Sql;

  const key = (suffix: string): string => `request_${suffix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  beforeAll(async () => {
    clientA = createPgAuthorityClient(process.env.SUPABASE_DB_URL!);
    clientB = createPgAuthorityClient(process.env.SUPABASE_DB_URL!);
    // `service_role` is a Supabase role a bare container does not have; the
    // grant block in the migration needs it to parse. Same stand-in the CI
    // migration script creates, and for the same reason.
    await clientA.unsafe(
      "do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') " +
        'then create role service_role nologin noinherit; end if; end $$;'
    );
    await clientA.unsafe(readFileSync(join(process.cwd(), 'supabase/migrations/0007_agent_control.sql'), 'utf8'));
    // Version 1 is written by `0006_agent_link.sql`, which another packet owns
    // and which may not be in this tree yet. The journal's schema check is
    // proven on its own below; gating this whole suite on a file P1 writes
    // would prove nothing about this one.
    await clientA.unsafe(
      "insert into agent.schema_migrations (version, name, applied_at) values (1, 'agent-link-v1', '2026-01-01T00:00:00.000Z') on conflict (version) do nothing"
    );
  });

  afterAll(async () => {
    // Reverse foreign-key order: events reference operations.
    await clientA`delete from agent.agent_operation_events where operation_id in (select id from agent.agent_operations where workspace_id = ${pgWho.workspaceId})`;
    await clientA`delete from agent.agent_operations where workspace_id = ${pgWho.workspaceId}`;
    await clientA`delete from agent.agent_uploads where workspace_id = ${pgWho.workspaceId}`;
    await clientA.end({ timeout: 5 });
    await clientB.end({ timeout: 5 });
  });

  /** An approved operation, ready to be claimed. */
  async function approved(journal: PgAgentJournal, requestKey = key('ready')) {
    const op = await journal.prepare(pgWho, { ...pgProposal, requestKey });
    await journal.review(op.id, pgWho.subject, pgWho.workspaceId, op.digest, true);
    return op;
  }

  it('two connections racing one claim: exactly one wins, the other sees the row unchanged', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const b = new PgAgentJournal({ client: clientB });
    const op = await approved(a);
    const [first, second] = await Promise.all([
      a.claim(pgWho, op.id, pgProposal.fingerprint),
      b.claim(pgWho, op.id, pgProposal.fingerprint),
    ]);
    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
    // The loser is not an error: it is handed the operation as it now stands,
    // which is the same branch the SQLite journal takes.
    const loser = first.claimed ? second : first;
    expect(loser.operation.id).toBe(op.id);
    expect(loser.operation.phase).toBe('running');
  });

  it('a lease past its end reconciles to uncertain, and is never re-dispatched', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const b = new PgAgentJournal({ client: clientB });
    const op = await approved(a);
    expect((await a.claim(pgWho, op.id, pgProposal.fingerprint)).claimed).toBe(true);

    // Stand in for a frozen instance: the row is `running` and nobody is coming
    // back for it.
    await clientA`update agent.agent_operations set lease_until = '1999-01-01T00:00:00.000Z' where id = ${op.id}`;
    const reconciled = (await reconcileStatement(clientB, { now: new Date().toISOString(), limit: SCAN_LIMIT })) as unknown as unknown[];
    expect(reconciled.length).toBeGreaterThanOrEqual(1);
    expect((await b.get(pgWho, op.id)).phase).toBe('uncertain');

    // The point of the whole design: a second pass changes nothing, and nothing
    // picks the operation back up.
    const again = (await reconcileStatement(clientB, { now: new Date().toISOString(), limit: SCAN_LIMIT })) as unknown as { id: string }[];
    expect(again.some((row) => row.id === op.id)).toBe(false);
    expect((await b.claim(pgWho, op.id, pgProposal.fingerprint)).claimed).toBe(false);
  });

  it('a finalize with a stale fence changes zero rows', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const op = await approved(a);
    await a.claim(pgWho, op.id, pgProposal.fingerprint);
    const [row] = (await clientA`select fence_token from agent.agent_operations where id = ${op.id}`) as unknown as { fence_token: string }[];
    const fence = Number(row.fence_token);
    const stale = (await finalizeStatement(clientA, {
      id: op.id, fence: fence - 1, phase: 'succeeded', finishedAt: new Date(Date.now() + 1000).toISOString(),
      document: { ...op, phase: 'succeeded' }, authorizationDigest: null, applicationAuthorizationDigest: null,
    })) as unknown as unknown[];
    expect(stale).toHaveLength(0);
    // Untouched, and still claimable-by-nobody: the row says `running`.
    const [after] = (await clientA`select phase from agent.agent_operations where id = ${op.id}`) as unknown as { phase: string }[];
    expect(after.phase).toBe('running');
  });

  it('an application authority that moved during dispatch refuses to finalize', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const op = await approved(a);
    await a.claim(pgWho, op.id, pgProposal.fingerprint, 'authority-before');
    // A role change or a revoked grant between claim and finalize: the digest
    // taken after is not the one the claim recorded.
    await expect(a.finishIfValid(pgWho, op.id, { ok: true }, true, 'authority-after')).rejects.toThrow('changed during dispatch');
    const [after] = (await clientA`select phase from agent.agent_operations where id = ${op.id}`) as unknown as { phase: string }[];
    expect(after.phase).toBe('running');
  });

  it('(workspace, subject, request_key) is unique, so prepare is idempotent in the database', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const requestKey = key('idem');
    const first = await a.prepare(pgWho, { ...pgProposal, requestKey });
    const replay = await a.prepare(pgWho, { ...pgProposal, requestKey, fingerprint: 'moved-on' });
    expect(replay.id).toBe(first.id);
    expect(replay.fingerprint).toBe(pgProposal.fingerprint);
    await expect(a.prepare(pgWho, { ...pgProposal, requestKey, input: { source: 'different' } }))
      .rejects.toThrow('different inputs');
  });

  it('claims, finalizes and reads back through the same interface the file store satisfies', async () => {
    const a = new PgAgentJournal({ client: clientA });
    const op = await approved(a);
    expect((await a.claim(pgWho, op.id, pgProposal.fingerprint)).claimed).toBe(true);
    const finished = await a.finishIfValid(pgWho, op.id, { ok: true, deploymentId: 'dep' }, true);
    expect(finished.phase).toBe('succeeded');
    expect((await a.get(pgWho, op.id)).phase).toBe('succeeded');
    expect((await a.events(pgWho, op.id)).length).toBeGreaterThan(0);
    expect((await a.list(pgWho)).some((row) => row.id === op.id)).toBe(true);
    // A terminal operation is not re-dispatchable: same answer as the file store.
    expect((await a.claim(pgWho, op.id, 'anything')).claimed).toBe(false);
  });

  it('refuses every read and write until the schema ledger is what this build needs', async () => {
    const wrong = new PgAgentJournal({ client: clientA });
    // Point the check at a ledger that does not have version 2 by asking a
    // journal whose required set cannot be satisfied: the message must name the
    // migration files, because "schema out of date" with nothing to run is the
    // error that costs an afternoon.
    await clientA`delete from agent.schema_migrations where version = 2`;
    await expect(wrong.get(pgWho, 'op_nothing')).rejects.toThrow('0007_agent_control.sql');
    await clientA.unsafe(
      "insert into agent.schema_migrations (version, name, applied_at) values (2, 'agent-control-v1', '2026-01-01T00:00:00.000Z') on conflict (version) do nothing"
    );
  });
});
