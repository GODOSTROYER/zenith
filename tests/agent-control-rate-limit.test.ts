import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableRateLimiter } from '../src/lib/agent-access/control/rate-limit';
import type { Principal } from '../src/lib/agent-access/control/journal';

const who: Principal = {
  subject: 'member', integrationId: 'codex', workspaceId: 'ws', projectIds: ['project'],
  scopes: ['read'], expiresAt: '2099-01-01T00:00:00Z',
};

describe('durable agent request throttling', () => {
  it('allows the configured budget and rejects the next request', () => {
    const limiter = new DurableRateLimiter(':memory:');
    try {
      limiter.check(who, { limit: 2 });
      limiter.check(who, { limit: 2 });
      expect(() => limiter.check(who, { limit: 2 })).toThrow('retry later');
    } finally { limiter.close(); }
  });

  it('persists the accepted budget across process restarts', () => {
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
