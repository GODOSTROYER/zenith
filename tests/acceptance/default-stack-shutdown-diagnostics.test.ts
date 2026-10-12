import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: runtimeMocks.spawn };
});

import { captureShutdownLifecycle, cleanup, run } from '../../scripts/acceptance/default-stack/runtime.mjs';

const install = '0123456789abcdef01234567';
const project = `zenith-local-${install}`;
const state = { installationId: install, projectId: project, directory: '', source: {} };
const dbId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
type DockerOptions = { timeout?: number; maxOutputBytes?: number; captureStderr?: boolean; id?: string };
function ownedDb(overrides: Record<string, unknown> = {}) {
  return {
    Id: dbId,
    Name: `/supabase_db_${project}`,
    Config: {
      Labels: { 'com.supabase.cli.project': project, 'io.zenith.installation': install },
      Env: ['PRIVATE_ENV_CANARY=never-project-this'], Cmd: ['postgres'],
    },
    HostConfig: { Binds: ['/private/secret:/secret'], NetworkMode: 'private-network-canary' },
    NetworkSettings: { Networks: { private: { NetworkID: 'network-canary' } } },
    State: { Running: true, Status: 'running', Pid: 71 },
    ...overrides,
  };
}
function fakeChild(stdoutText: string, stderrText = '', closeCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('close', 143));
    return true;
  });
  Promise.resolve().then(() => {
    child.stdout.write(stdoutText);
    child.stderr.write(stderrText);
    if (!child.kill.mock.calls.length) child.emit('close', closeCode);
  });
  return child;
}
function stalledChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.kill = vi.fn(() => true);
  return child;
}
function cleanupResponse(args: string[], removed: boolean, stopAttempted: boolean, failStop: boolean): { stdout: string; stderr?: string; code?: number } {
  if (args[0] === 'container' && args[1] === 'ls') {
    const projectFilter = args.find((arg) => arg.startsWith('label=com.supabase.cli.project='));
    return { stdout: !removed && projectFilter === `label=com.supabase.cli.project=${project}` ? dbId : '' };
  }
  if (['volume', 'network', 'image'].includes(args[0]) && args[1] === 'ls') return { stdout: '' };
  if (args[0] === 'container' && args[1] === 'inspect') {
    const item = removed ? [] : [ownedDb({ State: stopAttempted && !failStop ? { Running: false, Status: 'exited', ExitCode: 137 } : { Running: true, Status: 'running', Pid: 71 } })];
    return { stdout: JSON.stringify(item) };
  }
  if (args[0] === 'stop') return { stdout: '', code: failStop ? 1 : 0 };
  if (args[0] === 'rm') return { stdout: '' };
  return { stdout: '' };
}

function cleanupDocker(respond: (args: string[]) => { stdout: string; stderr?: string; code?: number }) {
  const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
  runtimeMocks.spawn.mockImplementation((_command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ args, options });
    const result = respond(args);
    return fakeChild(result.stdout, result.stderr ?? '', result.code ?? 0);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('default-stack shutdown lifecycle capture', () => {
  it('captures exact owned DB and Kong targets with fixed argv and bounded private command options', async () => {
    const calls: Array<{ args: string[]; options: DockerOptions }> = [];
    const dockerCommand = vi.fn(async (args: string[], options: DockerOptions = {}) => {
      calls.push({ args, options });
      if (args[0] === 'top') return { stdout: '71 1 postgres S postgres', stderr: 'top-stderr-canary' };
      return { stdout: '2026-10-12T00:00:00Z shutdown log', stderr: 'logs-stderr-canary' };
    });
    for (const service of ['db', 'kong']) {
      const current = ownedDb({ Name: `/supabase_${service}_${project}` });
      const record = await captureShutdownLifecycle({ state, resource: { kind: 'container', id: dbId }, current, phase: 'pre-stop', dockerCommand });
      expect(record).toMatchObject({ service, phase: 'pre-stop', inspectStatus: 'available', processTable: { status: 'ok' }, logs: { status: 'ok' } });
    }
    expect(calls.map(({ args }) => args)).toEqual([
      ['top', dbId, '-eo', 'pid,ppid,user,stat,comm'], ['logs', '--timestamps', '--tail', '100', dbId],
      ['top', dbId, '-eo', 'pid,ppid,user,stat,comm'], ['logs', '--timestamps', '--tail', '100', dbId],
    ]);
    for (const { options } of calls) expect(options).toMatchObject({ timeout: 3000, maxOutputBytes: 128 * 1024, captureStderr: true });
  });

  it('refuses lookalike names, foreign project labels, and non-container resources without invoking Docker', async () => {
    const dockerCommand = vi.fn();
    const variants = [
      { resource: { kind: 'container', id: dbId }, current: ownedDb({ Name: `/supabase_db_${project}-extra` }) },
      { resource: { kind: 'container', id: dbId }, current: ownedDb({ Name: `/supabase_auth_${project}` }) },
      { resource: { kind: 'container', id: dbId }, current: ownedDb({ Id: 'f'.repeat(64) }) },
      { resource: { kind: 'container', id: 'short-id' }, current: ownedDb({ Id: 'short-id' }) },
      { resource: { kind: 'container', id: dbId }, current: ownedDb({ Config: { Labels: { 'com.supabase.cli.project': 'zenith-local-ffffffffffffffffffffffff', 'io.zenith.installation': install } } }) },
      { resource: { kind: 'volume', id: dbId }, current: ownedDb() },
      { resource: { kind: 'container', id: dbId }, current: ownedDb({ Config: { Labels: { 'com.supabase.cli.project': 'zenith-local-ffffffffffffffffffffffff', 'io.zenith.installation': 'ffffffffffffffffffffffff' } } }) },
    ];
    for (const item of variants) expect(await captureShutdownLifecycle({ state, ...item, phase: 'pre-stop', dockerCommand })).toBeNull();
    expect(dockerCommand).not.toHaveBeenCalled();
  });

  it('refreshes a missing post-stop inspect and projects no environment, mount, or network fields', async () => {
    const inspected = ownedDb({ State: { Running: false, Status: 'exited', ExitCode: 137 } });
    const dockerCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === 'container' ? JSON.stringify([inspected]) : 'bounded diagnostic output', stderr: '',
    }));
    const record = await captureShutdownLifecycle({ state, resource: { kind: 'container', id: dbId }, current: ownedDb(), phase: 'post-stop', dockerCommand });
    expect(record).toMatchObject({ inspectStatus: 'captured', inspect: { state: { exitCode: 137, running: false } } });
    expect(dockerCommand.mock.calls[0]?.[0]).toEqual(['container', 'inspect', dbId]);
    const serialized = JSON.stringify(record?.inspect);
    for (const privateValue of ['Env', 'Binds', 'NetworkSettings', 'PRIVATE_ENV_CANARY', 'private-network-canary', 'network-canary']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('turns command and malformed-inspect failures into fixed status codes', async () => {
    const failCommands = vi.fn(async (args: string[]) => {
      if (args[0] === 'container') return { stdout: '{malformed', stderr: '' };
      throw new Error('private docker diagnostics must not escape');
    });
    const record = await captureShutdownLifecycle({ state, resource: { kind: 'container', id: dbId }, current: ownedDb(), phase: 'post-stop', dockerCommand: failCommands });
    expect(record).toMatchObject({ inspectStatus: 'parse-failed', processTable: { status: 'failed', code: 'capture-top-failed' }, logs: { status: 'failed', code: 'capture-logs-failed' } });
    expect(JSON.stringify(record)).not.toContain('private docker diagnostics');
  });

  it('keeps run stdout-only by default and enforces combined output cap when stderr capture is enabled', async () => {
    runtimeMocks.spawn.mockImplementation(() => fakeChild('  stdout-canary  ', 'stderr-canary'));
    await expect(run('docker', ['version'])).resolves.toBe('stdout-canary');
    runtimeMocks.spawn.mockImplementation(() => fakeChild('1234567890', 'abcdefghij'));
    await expect(run('docker', ['logs'], { captureStderr: true, maxOutputBytes: 16, id: 'shutdown-logs' }))
      .rejects.toThrow('default-stack:diagnostic-output-limit');
  });

  it('preserves the exact stop argv, grace, and forced-stop count when capture commands fail', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-shutdown-observation-'));
    fs.chmodSync(directory, 0o700);
    const liveState = { ...state, directory };
    let removed = false;
    let stopAttempted = false;
    const calls = cleanupDocker((args) => {
      if (args[0] === 'container' && args[1] === 'ls') {
        const projectFilter = args.find((arg) => arg.startsWith('label=com.supabase.cli.project='));
        return { stdout: !removed && projectFilter === `label=com.supabase.cli.project=${project}` ? dbId : '' };
      }
      if (['volume', 'network', 'image'].includes(args[0]) && args[1] === 'ls') return { stdout: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        const item = removed ? [] : [ownedDb({ State: stopAttempted ? { Running: false, Status: 'exited', ExitCode: 137 } : { Running: true, Status: 'running', Pid: 71 } })];
        return { stdout: JSON.stringify(item) };
      }
      if (args[0] === 'top' || args[0] === 'logs') return { stdout: '', stderr: 'diagnostic-capture-failed', code: 1 };
      if (args[0] === 'stop') { stopAttempted = true; return { stdout: '' }; }
      if (args[0] === 'rm') { removed = true; return { stdout: '' }; }
      return { stdout: '' };
    });
    vi.stubEnv('ZENITH_ACCEPTANCE_DEFAULT_STACK', '1');
    try {
      await cleanup(liveState);
      const stop = calls.find((call) => call.args[0] === 'stop');
      expect(stop?.args).toEqual(['stop', '--time', '60', dbId]);
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'cleanup.receipt.json'), 'utf8'));
      expect(receipt).toMatchObject({ ownedResourcesRemaining: 0, forcedStops: 1 });
      const diagnostic = fs.readdirSync(directory).find((name) => name.startsWith('cleanup-stop-'))!;
      const observation = JSON.parse(fs.readFileSync(path.join(directory, diagnostic), 'utf8')).container;
      expect(observation.lifecycle.preStop.processTable).toMatchObject({ status: 'failed', code: 'capture-top-failed' });
      expect(observation.lifecycle.preStop.logs).toMatchObject({ status: 'failed', code: 'capture-logs-failed' });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('retains the original stop failure when lifecycle capture also fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-shutdown-stop-error-'));
    fs.chmodSync(directory, 0o700);
    const liveState = { ...state, directory };
    let removed = false;
    let stopAttempted = false;
    cleanupDocker((args) => {
      if (args[0] === 'container' && args[1] === 'ls') {
        const projectFilter = args.find((arg) => arg.startsWith('label=com.supabase.cli.project='));
        return { stdout: !removed && projectFilter === `label=com.supabase.cli.project=${project}` ? dbId : '' };
      }
      if (['volume', 'network', 'image'].includes(args[0]) && args[1] === 'ls') return { stdout: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        const item = removed ? [] : [ownedDb({ State: { Running: true, Status: 'running', Pid: 71 } })];
        return { stdout: JSON.stringify(item) };
      }
      if (args[0] === 'top' || args[0] === 'logs') return { stdout: '', stderr: 'capture failure', code: 1 };
      if (args[0] === 'stop') { stopAttempted = true; return { stdout: '', code: 1 }; }
      if (args[0] === 'rm') { removed = true; return { stdout: '' }; }
      return { stdout: '' };
    });
    vi.stubEnv('ZENITH_ACCEPTANCE_DEFAULT_STACK', '1');
    try {
      await expect(cleanup(liveState)).rejects.toThrow('default-stack:command-failed');
      expect(stopAttempted).toBe(true);
      expect(fs.existsSync(path.join(directory, 'cleanup.receipt.json'))).toBe(false);
      const diagnostic = fs.readdirSync(directory).find((name) => name.startsWith('cleanup-stop-'))!;
      const observation = JSON.parse(fs.readFileSync(path.join(directory, diagnostic), 'utf8')).container;
      expect(observation.phase).toBe('stop');
      expect(observation.stopResolved).toBe(false);
      expect(observation.lifecycle.postStop.processTable).toMatchObject({ status: 'failed', code: 'capture-top-failed' });
      expect(observation.lifecycle.postStop.logs).toMatchObject({ status: 'failed', code: 'capture-logs-failed' });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects invalid diagnostic byte limits before spawning and accepts bounded safe integers', async () => {
    for (const maxOutputBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1024', 16 * 1024 * 1024 + 1]) {
      await expect(run('docker', ['logs'], { captureStderr: true, maxOutputBytes }))
        .rejects.toThrow('default-stack:diagnostic-output-limit-invalid');
    }
    expect(runtimeMocks.spawn).not.toHaveBeenCalled();
    runtimeMocks.spawn.mockImplementation(() => fakeChild('ok', ''));
    for (const maxOutputBytes of [2, 128, 16 * 1024 * 1024]) {
      await expect(run('docker', ['logs'], { captureStderr: true, maxOutputBytes })).resolves.toEqual({ stdout: 'ok', stderr: '' });
    }
    expect(runtimeMocks.spawn).toHaveBeenCalledTimes(3);
  });

  it('sends TERM then KILL to the same diagnostic child and treats an observed close as a fixed capture failure', async () => {
    vi.useFakeTimers();
    const child = stalledChild();
    const signals: string[] = [];
    child.kill.mockImplementation((signal: string) => {
      signals.push(signal);
      if (signal === 'SIGKILL') setTimeout(() => child.emit('close', 137), 20);
      return true;
    });
    runtimeMocks.spawn.mockImplementationOnce(() => child).mockImplementation(() => fakeChild('logs', ''));
    const pending = captureShutdownLifecycle({
      state, resource: { kind: 'container', id: dbId }, current: ownedDb(), phase: 'pre-stop',
      dockerCommand: (args: string[], options: DockerOptions = {}) => run('docker', args, options),
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(249);
    expect(signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(21);
    const record = await pending;
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(record?.processTable).toMatchObject({ status: 'failed', code: 'capture-top-failed' });
    expect(record?.logs).toMatchObject({ status: 'ok', stdout: 'logs' });
  });

  it('refuses uncertain child custody until the actual close event settles the retained child', async () => {
    vi.useFakeTimers();
    const child = stalledChild();
    const spawn = vi.fn(() => child);
    runtimeMocks.spawn.mockImplementation(spawn);
    const pending = run('docker', ['top', dbId], { timeout: 3000, maxOutputBytes: 1024, captureStderr: true, id: 'shutdown-top' });
    const pendingFailure = expect(pending).rejects.toThrow('default-stack:shutdown-custody-uncertain');
    await vi.advanceTimersByTimeAsync(4250);
    await pendingFailure;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(run('docker', ['version'], { maxOutputBytes: 128, captureStderr: true }))
      .rejects.toThrow('default-stack:shutdown-custody-uncertain');
    expect(spawn).toHaveBeenCalledOnce();
    child.emit('close', 137);
    await Promise.resolve();
    runtimeMocks.spawn.mockImplementation(() => fakeChild('settled', ''));
    await expect(run('docker', ['version'], { maxOutputBytes: 128, captureStderr: true }))
      .resolves.toEqual({ stdout: 'settled', stderr: '' });
  });

  it('retains diagnostic child custody after spawn error without pid until actual close', async () => {
    vi.useFakeTimers();
    const child = stalledChild();
    const spawn = vi.fn(() => child);
    runtimeMocks.spawn.mockImplementation(spawn);
    let settled = false;
    const pending = run('docker', ['top', dbId], {
      timeout: 3000, maxOutputBytes: 1024, captureStderr: true, id: 'shutdown-top',
    }).then((value) => { settled = true; return value; }, (error: unknown) => { settled = true; throw error; });

    expect(child).not.toHaveProperty('pid');
    child.emit('error', new Error('synthetic spawn failure'));
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(run('docker', ['version'], { maxOutputBytes: 128, captureStderr: true }))
      .rejects.toThrow('default-stack:shutdown-custody-uncertain');
    expect(spawn).toHaveBeenCalledOnce();

    child.emit('close', 1);
    await expect(pending).rejects.toThrow('default-stack:shutdown-top');
    runtimeMocks.spawn.mockImplementation(() => fakeChild('after-close', ''));
    await expect(run('docker', ['version'], { maxOutputBytes: 128, captureStderr: true }))
      .resolves.toEqual({ stdout: 'after-close', stderr: '' });
  });

  it('stops cleanup before stop or remove when a pre-stop diagnostic child never closes', async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-shutdown-pre-fatal-'));
    fs.chmodSync(directory, 0o700);
    const liveState = { ...state, directory };
    const calls: string[][] = [];
    const child = stalledChild();
    runtimeMocks.spawn.mockImplementation((_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'top') return child;
      return fakeChild(cleanupResponse(args, false, false, false).stdout, '', cleanupResponse(args, false, false, false).code ?? 0);
    });
    vi.stubEnv('ZENITH_ACCEPTANCE_DEFAULT_STACK', '1');
    try {
      const pending = cleanup(liveState).catch((error: unknown) => error);
      for (let i = 0; i < 200 && !calls.some((args) => args[0] === 'top'); i++) await Promise.resolve();
      expect(calls.some((args) => args[0] === 'top')).toBe(true);
      await vi.advanceTimersByTimeAsync(4250);
      const failure = await pending;
      expect(failure).toMatchObject({ message: 'default-stack:shutdown-custody-uncertain' });
      expect(calls.some((args) => args[0] === 'stop' || args[0] === 'rm')).toBe(false);
      expect(calls.at(-1)?.[0]).toBe('top');
      child.emit('close', 137);
      await Promise.resolve();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('retains the original stop failure as cause when post-stop custody becomes uncertain', async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-shutdown-post-fatal-'));
    fs.chmodSync(directory, 0o700);
    const liveState = { ...state, directory };
    const calls: string[][] = [];
    const child = stalledChild();
    let topCount = 0;
    let stopAttempted = false;
    let removed = false;
    runtimeMocks.spawn.mockImplementation((_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'top' && ++topCount === 2) return child;
      if (args[0] === 'stop') { stopAttempted = true; return fakeChild('', '', 1); }
      if (args[0] === 'rm') removed = true;
      const response = cleanupResponse(args, removed, stopAttempted, true);
      return fakeChild(response.stdout, response.stderr ?? '', response.code ?? 0);
    });
    vi.stubEnv('ZENITH_ACCEPTANCE_DEFAULT_STACK', '1');
    try {
      const pending = cleanup(liveState).catch((error: unknown) => error);
      for (let i = 0; i < 300 && !child.kill.mock.calls.length; i++) await Promise.resolve();
      expect(stopAttempted).toBe(true);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4250);
      const failure = await pending;
      expect(failure).toMatchObject({ message: 'default-stack:shutdown-custody-uncertain' });
      expect((failure as Error & { cause?: Error }).cause?.message).toBe('default-stack:command-failed');
      expect(calls.some((args) => args[0] === 'rm')).toBe(false);
      child.emit('close', 137);
      await Promise.resolve();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
