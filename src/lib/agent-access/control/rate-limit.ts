/** Durable request throttling for the supported single-host agent-control topology. */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { claimDataDir } from '@/lib/data-lock';
import { env } from '@/lib/env';
import { ControlError, type Principal } from './journal';

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  maxPrincipals?: number;
}

export class DurableRateLimiter {
  private readonly sql: DatabaseSync;
  constructor(file: string, private readonly clock = Date.now) {
    if (file !== ':memory:') {
      if (!isAbsolute(file)) throw new ControlError('rate_limit_configuration', 'Use an absolute durable rate-limit path.', 503);
      const dir = dirname(file);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const parent = lstatSync(dir);
      if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform === 'win32'
        || parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0)
        throw new ControlError('rate_limit_permissions', 'Rate limits require an owned private POSIX directory.', 503);
      if (!existsSync(file)) closeSync(openSync(file, 'wx', 0o600));
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
        throw new ControlError('rate_limit_permissions', 'The rate-limit database must be an owned regular private file.', 503);
      chmodSync(file, 0o600);
    }
    this.sql = new DatabaseSync(file);
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agent_rate_limits (
        workspace TEXT NOT NULL,
        subject TEXT NOT NULL,
        bucket INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 0),
        PRIMARY KEY(workspace, subject, bucket));
      CREATE INDEX IF NOT EXISTS agent_rate_limit_bucket ON agent_rate_limits(bucket);`);
  }

  close(): void { this.sql.close(); }

  check(who: Principal, options: RateLimitOptions = {}): void {
    const limit = options.limit ?? 120;
    const windowMs = options.windowMs ?? 60_000;
    const maxPrincipals = options.maxPrincipals ?? 2_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000
      || !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 60 * 60_000
      || !Number.isSafeInteger(maxPrincipals) || maxPrincipals < 1 || maxPrincipals > 100_000)
      throw new ControlError('rate_limit_configuration', 'Rate-limit bounds are invalid.', 503);

    const bucket = Math.floor(this.clock() / windowMs);
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.sql.prepare('DELETE FROM agent_rate_limits WHERE bucket < ?').run(bucket - 1);
      const existing = this.sql.prepare('SELECT count FROM agent_rate_limits WHERE workspace=? AND subject=? AND bucket=?')
        .get(who.workspaceId, who.subject, bucket) as { count: number } | undefined;
      if (!existing) {
        const active = this.sql.prepare('SELECT count(*) AS n FROM agent_rate_limits WHERE bucket=?').get(bucket) as { n: number };
        if (active.n >= maxPrincipals) throw new ControlError('rate_limited', 'Request limit reached; retry later.', 429);
        this.sql.prepare('INSERT INTO agent_rate_limits(workspace,subject,bucket,count) VALUES(?,?,?,0)')
          .run(who.workspaceId, who.subject, bucket);
      }
      this.sql.prepare('UPDATE agent_rate_limits SET count=count+1 WHERE workspace=? AND subject=? AND bucket=?')
        .run(who.workspaceId, who.subject, bucket);
      const row = this.sql.prepare('SELECT count FROM agent_rate_limits WHERE workspace=? AND subject=? AND bucket=?')
        .get(who.workspaceId, who.subject, bucket) as { count: number };
      if (row.count > limit) throw new ControlError('rate_limited', 'Request limit reached; retry later.', 429);
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
}

type GlobalRateLimiter = typeof globalThis & { __zenithAgentRateLimiter?: DurableRateLimiter };

export function throttle(who: Principal): void {
  const global = globalThis as GlobalRateLimiter;
  if (!global.__zenithAgentRateLimiter) {
    const data = env().ZENITH_DATA;
    claimDataDir(data);
    global.__zenithAgentRateLimiter = new DurableRateLimiter(resolve(data, 'agent-control', 'rate-limits.sqlite'));
  }
  global.__zenithAgentRateLimiter.check(who);
}
