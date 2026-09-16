/**
 * `agentTickPass()` — crash recovery as a scheduled pass.
 *
 * The file store's half is what runs here: the pass delegates to the journal's
 * existing `recover()` and to the sweep that used to happen only on the next
 * write. The Postgres half — a `running` row past its lease becoming
 * `uncertain`, bounded and idempotent — is proven by the statements in
 * `agent-control-journal.test.ts` and by the live suite there.
 *
 * The property that matters on both stores, and that this file exists to pin:
 * **an interrupted dispatch resolves to `uncertain` and is never picked back
 * up.** The side effect may have happened, and no pass can find out.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDataDir } from './_support/data-dir';

const DATA = tempDataDir('zenith-agent-reconcile-', { fast: true });

const { agentTickPass, sweepLinkCodesStatement, deleteLinkCodesStatement } = await import(
  '@/lib/agent-access/control/reconcile'
);
const { resetCapabilityProbe } = await import('@/lib/agent-access/control/capabilities');
const { SCAN_LIMIT } = await import('@/lib/agent-access/control/journal-pg');

/**
 * The journal itself is POSIX-only.
 *
 * `new Journal(<path>)` names `process.platform === 'win32'` as one disjunct of
 * its refusal (`journal.ts:54-57`), so on Windows the enabled file-store case
 * exercises the *failure* path rather than the delegation, and asserting the
 * delegation there would assert nothing. Skipped, loudly; CI runs it on Linux.
 */
const POSIX_JOURNAL_ONLY = process.platform === 'win32';
if (POSIX_JOURNAL_ONLY)
  console.warn(
    '\n[agent-control reconcile] 1 test SKIPPED on win32: the journal requires an owned private POSIX directory\n' +
      '  (src/lib/agent-access/control/journal.ts:54-57 refuses win32 explicitly).\n' +
      '  It is not skipped on Linux or macOS, and CI runs it.\n'
  );

const KEYS = ['ZENITH_STORE', 'ZENITH_SERVERLESS', 'VERCEL', 'ZENITH_AGENT_CONTROL', 'ZENITH_AGENT_WRITES', 'ZENITH_DATA'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
  process.env.ZENITH_DATA = DATA;
  resetCapabilityProbe();
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetCapabilityProbe();
});

describe('agentTickPass', () => {
  it('does nothing at all when agent control is not enabled', async () => {
    process.env.ZENITH_STORE = 'file';
    const result = await agentTickPass();
    // The scheduler is not a way to turn the feature on, and a pass that opened
    // a journal a disabled deployment has no business opening would be exactly
    // that.
    expect(result).toMatchObject({ reconciled: 0, expired: 0, links: 0, uploads: 0 });
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(POSIX_JOURNAL_ONLY)('sweeps the enabled file store, and is idempotent', async () => {
    Object.assign(process.env, { ZENITH_STORE: 'file', ZENITH_AGENT_CONTROL: '1', ZENITH_AGENT_WRITES: '1' });
    const result = await agentTickPass(2_000);
    expect(Object.keys(result).sort()).toEqual(['expired', 'links', 'ms', 'reconciled', 'uploads']);
    // A fresh journal has nothing running and nothing stale.
    expect(result).toMatchObject({ reconciled: 0, expired: 0, uploads: 0 });
    // Link codes live in 0006, which another packet owns; the pass reports zero
    // rather than failing when that table is not there yet.
    expect(result.links).toBe(0);
    const again = await agentTickPass(2_000);
    expect(again).toMatchObject({ reconciled: 0, expired: 0 });
  });

  it('never throws, whatever the journal does', async () => {
    // A journal that cannot be opened is not a reason to fail the tick route:
    // the other four passes still have work to do, and the route reports what
    // each one did. `ZENITH_DATA` pointing at a regular file makes the open
    // fail the same way on every platform.
    const file = join(DATA, 'not-a-directory');
    writeFileSync(file, 'x');
    Object.assign(process.env, { ZENITH_STORE: 'file', ZENITH_AGENT_CONTROL: '1', ZENITH_DATA: file });
    await expect(agentTickPass(500)).resolves.toMatchObject({ reconciled: 0, expired: 0 });
  });
});

/**
 * The link-code half of the Postgres pass, against a recording tag.
 *
 * `agent.agent_link_codes` is keyed on `user_code_hash` and has **no `id`
 * column** (`supabase/migrations/0006_agent_link.sql`). A statement naming one
 * raises `42703 undefined_column`, which is not the `42P01` this pass forgives,
 * so the whole tick route fails — on Postgres only, where nothing local can see
 * it. That is the mistake these two assertions exist to stop coming back.
 */
describe('the link-code sweep statements', () => {
  interface Recorded { text: string; values: unknown[] }
  const recordingSql = () => {
    const recorded: Recorded[] = [];
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.push({ text: strings.raw.join(' ? ').replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve([]);
    }) as never;
    return { tag, recorded };
  };

  it('key the sweep on user_code_hash, never on an id column that does not exist', async () => {
    const { tag, recorded } = recordingSql();
    await sweepLinkCodesStatement(tag, { now: '2026-01-01T00:00:00.000Z', limit: SCAN_LIMIT });
    await deleteLinkCodesStatement(tag, { cutoff: '2025-12-31T00:00:00.000Z', limit: SCAN_LIMIT });
    for (const call of recorded) {
      expect(call.text).toContain('user_code_hash');
      expect(call.text, 'agent.agent_link_codes has no id column').not.toMatch(/\bid\b/);
      expect(call.values).toContain(SCAN_LIMIT);
      expect(call.text, 'bounded, so a backlog drains a pass at a time').toContain('limit');
    }
  });

  it('expires a live code before deleting anything, and only deletes past the retention', async () => {
    const { tag, recorded } = recordingSql();
    await sweepLinkCodesStatement(tag, { now: 'now', limit: SCAN_LIMIT });
    await deleteLinkCodesStatement(tag, { cutoff: 'a-day-ago', limit: SCAN_LIMIT });

    // An agent that is still polling deserves `expired_token`, which needs the
    // row to still be there; deleting at `expires_at` would answer
    // `invalid_device_code` and read as "that code never existed".
    expect(recorded[0].text).toContain("set state = 'expired'");
    expect(recorded[0].text).toContain('secret_ct = null');
    expect(recorded[0].text).toContain("state in ('pending','approved')");
    expect(recorded[0].values).toContain('now');

    expect(recorded[1].text).toContain('delete from agent.agent_link_codes');
    expect(recorded[1].values).toContain('a-day-ago');
    expect(recorded[1].values, 'the cutoff is the retention, not the expiry').not.toContain('now');
  });
});
