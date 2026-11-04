import { describe, expect, it } from 'vitest';
import { startLeanCliServices } from '../../scripts/acceptance/default-stack/start-cli-services.mjs';

const projectId = '0123456789abcdef01234567';
const database = `supabase_db_zenith-local-${projectId}`;
const services = [database, `supabase_auth_zenith-local-${projectId}`, `supabase_rest_zenith-local-${projectId}`];

describe('lean Supabase restart ordering', () => {
  it('starts dependents only after PostgreSQL transitions from starting to healthy', async () => {
    let clock = 0;
    const calls: string[][] = [];
    const states = ['starting', 'starting', 'healthy'];
    const docker = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, Status: 'running', Health: { Status: states.shift() } });
      return '';
    };
    await startLeanCliServices({ projectId: `zenith-local-${projectId}`, serviceNames: services, docker,
      now: () => clock, pause: async ms => { clock += ms; } });
    expect(calls).toEqual([
      ['start', database], ['inspect', '--format', '{{json .State}}', database], ['inspect', '--format', '{{json .State}}', database], ['inspect', '--format', '{{json .State}}', database],
      ['start', ...services.slice(1)],
    ]);
  });

  it.each([
    { name: 'unhealthy', state: { Running: true, Status: 'running', Health: { Status: 'unhealthy' } }, reason: 'supabase-db-unhealthy' },
    { name: 'exited', state: { Running: false, Status: 'exited' }, reason: 'supabase-db-exited' },
    { name: 'unknown health', state: { Running: true, Status: 'running' }, reason: 'supabase-db-health-unknown' },
  ])('fails closed on $name without starting dependent services', async ({ state, reason }) => {
    const calls: string[][] = [];
    const docker = async (args: string[]) => { calls.push(args); return args[0] === 'inspect' ? JSON.stringify(state) : ''; };
    await expect(startLeanCliServices({ projectId: `zenith-local-${projectId}`, serviceNames: services, docker }))
      .rejects.toThrow(reason);
    expect(calls).toEqual([['start', database], ['inspect', '--format', '{{json .State}}', database]]);
  });

  it('refuses an indefinitely starting database at the fixed health deadline', async () => {
    let clock = 0;
    const calls: string[][] = [];
    const docker = async (args: string[]) => {
      calls.push(args);
      return args[0] === 'inspect' ? JSON.stringify({ Running: true, Status: 'running', Health: { Status: 'starting' } }) : '';
    };
    await expect(startLeanCliServices({ projectId: `zenith-local-${projectId}`, serviceNames: services, docker,
      now: () => clock, pause: async ms => { clock += ms; } })).rejects.toThrow('supabase-db-health-timeout');
    expect(clock).toBe(180_000);
    expect(calls[0]).toEqual(['start', database]);
    expect(calls.every(args => args[0] !== 'start' || args[1] === database)).toBe(true);
  });

  it('rejects a healthy inspection that returns after the fixed health deadline', async () => {
    let clock = 0;
    const calls: string[][] = [];
    const docker = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'inspect') {
        clock = 180_001;
        return JSON.stringify({ Running: true, Status: 'running', Health: { Status: 'healthy' } });
      }
      return '';
    };
    await expect(startLeanCliServices({ projectId: `zenith-local-${projectId}`, serviceNames: services, docker,
      now: () => clock, pause: async () => undefined })).rejects.toThrow('supabase-db-health-timeout');
    expect(calls).toEqual([['start', database], ['inspect', '--format', '{{json .State}}', database]]);
  });

});
