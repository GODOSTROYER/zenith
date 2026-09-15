/**
 * The capability table, row by row.
 *
 * `capabilities.ts` replaced two `throw` statements that had hard-coded the
 * topology they were written for. The replacement is only worth anything if
 * every cell of its decision table is pinned — in particular the two that are
 * *refusals*, because the tempting reading of "agent control now works on
 * Postgres" is that the guards went away, and they did not:
 *
 *  - **serverless + file store is still refused**, because a SQLite journal in
 *    a per-instance `/tmp` is not durable;
 *  - **Postgres without a reachable `agent` schema is still refused**, and
 *    fails closed rather than accepting an operation it cannot make durable.
 *
 * Every case here drives the real module through `process.env`, which is what
 * `env()` and `isPostgres()` read, so nothing about the decision is mocked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { controlCapabilitiesSync, requireControlSync, requireWritesSync, resetCapabilityProbe } from '../src/lib/agent-access/control/capabilities';
import { ControlError } from '../src/lib/agent-access/control/journal';

const KEYS = ['ZENITH_STORE', 'ZENITH_SERVERLESS', 'VERCEL', 'ZENITH_AGENT_CONTROL', 'ZENITH_AGENT_WRITES', 'SUPABASE_DB_URL'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
  resetCapabilityProbe();
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetCapabilityProbe();
});

/** One environment, as the table's leftmost columns describe it. */
interface Row {
  name: string;
  env: Partial<Record<(typeof KEYS)[number], string>>;
  control: boolean;
  writes: boolean;
  journal: 'file' | 'postgres';
  coordination: 'process-gate' | 'database';
  /** A distinctive phrase the refusal must contain, so the operator is told what to set. */
  fix?: string;
}

const POOLER = 'postgres://user:pass@db.example.supabase.co:6543/postgres';

const TABLE: Row[] = [
  {
    name: 'file store, long-lived host, control and writes enabled — exactly today’s semantics',
    env: { ZENITH_STORE: 'file', ZENITH_AGENT_CONTROL: '1', ZENITH_AGENT_WRITES: '1' },
    control: true, writes: true, journal: 'file', coordination: 'process-gate',
  },
  {
    name: 'file store, long-lived host, writes not enabled — control yes, writes no',
    env: { ZENITH_STORE: 'file', ZENITH_AGENT_CONTROL: '1' },
    control: true, writes: false, journal: 'file', coordination: 'process-gate',
    fix: 'ZENITH_AGENT_WRITES=1',
  },
  {
    name: 'file store, control flag unset — refused, as today',
    env: { ZENITH_STORE: 'file' },
    control: false, writes: false, journal: 'file', coordination: 'process-gate',
    fix: 'ZENITH_AGENT_CONTROL=1',
  },
  {
    name: 'file store on a serverless host — still refused: a /tmp journal is not durable',
    env: { ZENITH_STORE: 'file', ZENITH_SERVERLESS: '1', ZENITH_AGENT_CONTROL: '1', ZENITH_AGENT_WRITES: '1' },
    control: false, writes: false, journal: 'file', coordination: 'process-gate',
    fix: 'ZENITH_STORE=postgres',
  },
  {
    name: 'postgres with a journal URL, serverless, control enabled — control and writes',
    env: { ZENITH_STORE: 'postgres', ZENITH_SERVERLESS: '1', ZENITH_AGENT_CONTROL: '1', SUPABASE_DB_URL: POOLER },
    control: true, writes: true, journal: 'postgres', coordination: 'database',
  },
  {
    name: 'postgres with no journal URL — refused, fail closed, migration named',
    env: { ZENITH_STORE: 'postgres', ZENITH_AGENT_CONTROL: '1' },
    control: false, writes: false, journal: 'postgres', coordination: 'database',
    fix: 'SUPABASE_DB_URL',
  },
  {
    name: 'postgres, control flag unset — still opt-in',
    env: { ZENITH_STORE: 'postgres', SUPABASE_DB_URL: POOLER },
    control: false, writes: false, journal: 'postgres', coordination: 'database',
    fix: 'ZENITH_AGENT_CONTROL=1',
  },
];

describe('agent control capabilities', () => {
  for (const row of TABLE)
    it(row.name, () => {
      Object.assign(process.env, row.env);
      const capabilities = controlCapabilitiesSync();
      expect({ control: capabilities.control, writes: capabilities.writes }).toEqual({ control: row.control, writes: row.writes });
      expect(capabilities.journal).toBe(row.journal);
      expect(capabilities.coordination).toBe(row.coordination);
      if (row.fix) {
        expect(capabilities.reason).toBeDefined();
        expect(capabilities.reason).toContain(row.fix);
        expect(capabilities.reason).toContain('Fix:');
      } else {
        expect(capabilities.reason).toBeUndefined();
      }
    });

  it('ZENITH_AGENT_WRITES governs nothing on Postgres — the credential’s scopes do', () => {
    Object.assign(process.env, { ZENITH_STORE: 'postgres', ZENITH_AGENT_CONTROL: '1', SUPABASE_DB_URL: POOLER });
    expect(controlCapabilitiesSync().writes).toBe(true);
    process.env.ZENITH_AGENT_WRITES = '0';
    expect(controlCapabilitiesSync().writes).toBe(true);
  });

  it('the file store never claims distributed coordination', () => {
    Object.assign(process.env, { ZENITH_STORE: 'file', ZENITH_AGENT_CONTROL: '1', ZENITH_AGENT_WRITES: '1' });
    // `withMutationGate` and the pid lock are one process's. Saying so is the
    // point: `zenith_get_capabilities` reports this verbatim.
    expect(controlCapabilitiesSync().coordination).toBe('process-gate');
  });

  it('requireControlSync and requireWritesSync raise the frozen error codes', () => {
    Object.assign(process.env, { ZENITH_STORE: 'file' });
    expect(() => requireControlSync()).toThrow(ControlError);
    try { requireControlSync(); } catch (error) {
      expect((error as ControlError).code).toBe('control_disabled');
      expect((error as ControlError).status).toBe(503);
    }
    process.env.ZENITH_AGENT_CONTROL = '1';
    expect(() => requireControlSync()).not.toThrow();
    try { requireWritesSync(); } catch (error) {
      expect((error as ControlError).code).toBe('writes_disabled');
      expect((error as ControlError).status).toBe(503);
    }
  });

  it('a serverless file-store refusal explains itself rather than naming a flag', () => {
    Object.assign(process.env, { ZENITH_STORE: 'file', VERCEL: '1', ZENITH_AGENT_CONTROL: '1', ZENITH_AGENT_WRITES: '1' });
    const reason = controlCapabilitiesSync().reason ?? '';
    expect(reason).toContain('durable');
    expect(reason).toContain('/tmp');
    // Removing the guard by setting a flag must not be on offer anywhere in it.
    expect(reason).not.toMatch(/set ZENITH_AGENT_CONTROL to bypass|disable this check/i);
  });
  /**
   * The acceptance condition, stated as a test: `runtime.ts` must still refuse
   * these two. The tempting reading of "agent control now works on Postgres" is
   * that the guards were removed, and a future edit that removes them should
   * fail here rather than in production.
   */
  it('runtime.ts still refuses serverless+file, and Postgres without a journal', async () => {
    const runtime = await import('../src/lib/agent-access/control/runtime');

    Object.assign(process.env, { ZENITH_STORE: 'file', ZENITH_SERVERLESS: '1', ZENITH_AGENT_CONTROL: '1', ZENITH_AGENT_WRITES: '1' });
    expect(() => runtime.requireControl()).toThrow(/durable/);
    expect(() => runtime.requireWrites()).toThrow(/durable/);
    await expect(runtime.requireControlAsync()).rejects.toThrow(/durable/);

    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, { ZENITH_STORE: 'postgres', ZENITH_AGENT_CONTROL: '1' });
    expect(() => runtime.requireControl()).toThrow(/SUPABASE_DB_URL/);
    expect(() => runtime.requireWrites()).toThrow(/SUPABASE_DB_URL/);
    await expect(runtime.requireWritesAsync()).rejects.toThrow(/SUPABASE_DB_URL/);
  });

  it('the coordinator refuses the Postgres journal until three files await it', async () => {
    const runtime = await import('../src/lib/agent-access/control/runtime');
    Object.assign(process.env, { ZENITH_STORE: 'postgres', ZENITH_AGENT_CONTROL: '1', SUPABASE_DB_URL: POOLER });
    // Everything the Postgres control plane needs exists; what is missing is
    // that `coordinator.ts`, `browser.ts` and `boundary.ts` still read the
    // journal synchronously. Refusing loudly beats appearing to accept a
    // reviewed operation and writing it where nothing will read it again.
    expect(() => runtime.control()).toThrow(/coordinator/);
    expect(() => runtime.control()).toThrow(/ZENITH_STORE=file/);
  });
});
