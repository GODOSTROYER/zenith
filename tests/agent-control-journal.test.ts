import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, digest, type Principal, type Proposal } from '../src/lib/agent-access/control/journal';
const who: Principal = { subject: 'member', integrationId: 'codex', workspaceId: 'ws', projectIds: ['project'],
  scopes: ['read','plan','write'], expiresAt: '2099-01-01T00:00:00Z' };
const proposal: Proposal = { action: 'manifest.import', input: { source: 'source' }, target: { workspaceId: 'ws', projectId: 'project' },
  fingerprint: 'original-state', plan: { summary: 'reviewed', risk: 'low' }, requestKey: 'request_0001' };
function ready(j: Journal) { const op = j.prepare(who, proposal); j.review(op.id, who.subject, who.workspaceId, op.digest, true); return op; }
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
  it('persists across restarts and never blindly replays an interrupted dispatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zenith-journal-')); const file = join(dir, 'agent.sqlite');
    try { const first = new Journal(file); const op = ready(first); first.claim(who, op.id, proposal.fingerprint); first.close();
      const second = new Journal(file); try {
        expect(second.recover()).toBe(1); expect(second.get(who, op.id).phase).toBe('uncertain');
        expect(second.claim(who, op.id, proposal.fingerprint).claimed).toBe(false);
        expect(second.prepare(who, proposal).id).toBe(op.id);
      } finally { second.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('two journal connections cannot claim the same receipt twice', () => {
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
