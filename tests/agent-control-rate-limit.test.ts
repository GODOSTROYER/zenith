import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableRateLimiter, PgRateLimiter, rateLimitKey } from '../src/lib/agent-access/control/rate-limit';
import { ControlError, type Principal } from '../src/lib/agent-access/control/journal';
import type { AnySql } from '../src/lib/agent-access/control/journal-pg';

const who: Principal = {
  subject: 'member', integrationId: 'codex', workspaceId: 'ws', projectIds: ['project'],
  scopes: ['read'], expiresAt: '2099-01-01T00:00:00Z',
};

/**
 * The on-disk case cannot run on Windows.
 *
 * `new DurableRateLimiter(<path>)` refuses any file whose parent directory is
 * not owned by this uid and not private to it — and the condition names the
 * platform outright: `process.platform === 'win32'` is one of its disjuncts
 * (`src/lib/agent-access/control/rate-limit.ts:22-25`), alongside `parent.uid
 * !== process.getuid!()` and `parent.mode & 0o077`. Windows has neither uids
 * nor POSIX mode bits, so the constructor throws `rate_limit_permissions`
 * before the file is opened. That is the guard working, not a bug: agent
 * control is only supported on a long-lived POSIX host
 * (`docs/AGENT-CONTROL.md`).
 *
 * The `:memory:` cases below are unaffected and still run everywhere.
 */
const POSIX_LIMITER_ONLY = process.platform === 'win32';
if (POSIX_LIMITER_ONLY)
  console.warn(
    '\n[agent-control rate limit] 1 test SKIPPED on win32: rate limits require an owned private POSIX directory\n' +
      '  (src/lib/agent-access/control/rate-limit.ts:22-25 refuses win32 explicitly, and reads process.getuid()).\n' +
      '  It is not skipped on Linux or macOS, and CI runs it.\n'
  );

describe('durable agent request throttling', () => {
  it('allows the configured budget and rejects the next request', () => {
    const limiter = new DurableRateLimiter(':memory:');
    try {
      limiter.check(who, { limit: 2 });
      limiter.check(who, { limit: 2 });
      expect(() => limiter.check(who, { limit: 2 })).toThrow('retry later');
    } finally { limiter.close(); }
  });

  it.skipIf(POSIX_LIMITER_ONLY)('persists the accepted budget across process restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zenith-rate-limit-'));
    const file = join(dir, 'limits.sqlite');
    const now = 1_700_000_000_000;
    try {
      const first = new DurableRateLimiter(file, () => now);
      first.check(who, { limit: 2 });
      first.close();
      const second = new DurableRateLimiter(file, () => now);
      try {
        second.check(who, { limit: 2 });
        expect(() => second.check(who, { limit: 2 })).toThrow('retry later');
      } finally { second.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('isolates principals and resets on the next fixed window', () => {
    let now = 1_700_000_000_000;
    const limiter = new DurableRateLimiter(':memory:', () => now);
    try {
      limiter.check(who, { limit: 1, windowMs: 1_000 });
      expect(() => limiter.check(who, { limit: 1, windowMs: 1_000 })).toThrow('retry later');
      expect(() => limiter.check({ ...who, subject: 'other' }, { limit: 1, windowMs: 1_000 })).not.toThrow();
      now += 1_000;
      expect(() => limiter.check(who, { limit: 1, windowMs: 1_000 })).not.toThrow();
    } finally { limiter.close(); }
  });

  it('bounds the number of active principals in a window', () => {
    const limiter = new DurableRateLimiter(':memory:');
    try {
      limiter.check(who, { maxPrincipals: 1 });
      expect(() => limiter.check({ ...who, subject: 'other' }, { maxPrincipals: 1 })).toThrow('retry later');
    } finally { limiter.close(); }
  });
});

/**
 * The Postgres limiter, behind the same `check()`.
 *
 * The thing that changes on a host with a hundred instances is not the
 * algorithm — it is where the count lives. A hundred process-local limiters is
 * a limit of 12,000 requests a minute wearing the label of 120, so the count
 * has to be the database's. These cases pin the statements and the refusal;
 * the live behaviour is the postgres lane's to prove.
 */
describe('postgres rate limiter', () => {
  interface Recorded { text: string; values: unknown[] }
  function recordingSql(rows: unknown[]) {
    const recorded: Recorded[] = [];
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.push({ text: strings.raw.join(' ? ').replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve(rows.shift() ?? []);
    }) as unknown as AnySql;
    return { tag, recorded };
  }

  it('counts in one statement, so two instances cannot both miss the limit', async () => {
    const { tag, recorded } = recordingSql([[], [{ count: 3 }]]);
    await new PgRateLimiter(tag, () => 1_700_000_000_000).check(who);
    // The window before last is swept on every check, exactly as the file
    // limiter does.
    expect(recorded[0].text).toContain('delete from agent.agent_rate_limits where bucket <');
    // Read-modify-write over two statements is the race; an upsert that
    // increments and returns is not.
    expect(recorded[1].text).toContain('insert into agent.agent_rate_limits');
    expect(recorded[1].text).toContain('on conflict (scope, key, bucket) do update set count = agent.agent_rate_limits.count + 1');
    expect(recorded[1].text).toContain('returning count');
    expect(recorded[1].values).toContain('v2');
    expect(recorded[1].values).toContain(Math.floor(1_700_000_000_000 / 60_000));
  });

  it('refuses over the limit with the frozen code and status', async () => {
    const { tag } = recordingSql([[], [{ count: 121 }]]);
    const limiter = new PgRateLimiter(tag);
    await expect(limiter.check(who)).rejects.toThrow('retry later');
    try {
      const again = recordingSql([[], [{ count: 121 }]]);
      await new PgRateLimiter(again.tag).check(who);
    } catch (error) {
      expect((error as ControlError).code).toBe('rate_limited');
      expect((error as ControlError).status).toBe(429);
    }
  });

  it('refuses bounds it cannot honour rather than silently widening them', async () => {
    const { tag } = recordingSql([[], [{ count: 1 }]]);
    await expect(new PgRateLimiter(tag).check(who, { limit: 0 })).rejects.toThrow('bounds are invalid');
    const other = recordingSql([[], [{ count: 1 }]]);
    await expect(new PgRateLimiter(other.tag).check(who, { windowMs: 10 })).rejects.toThrow('bounds are invalid');
  });

  it('keys a principal by a fixed-width hash, never by a raw identifier', () => {
    const key = rateLimitKey(who);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // The column is shared with the link endpoints' salted client address; a
    // table holding raw addresses beside raw subject ids is one nobody wants to
    // have to reason about.
    expect(key).not.toContain(who.subject);
    expect(rateLimitKey({ ...who, workspaceId: 'other' })).not.toBe(key);
    expect(rateLimitKey(who)).toBe(key);
  });
});
