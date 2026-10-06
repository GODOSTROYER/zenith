import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { validateNative, validateWindows, validateGo, validateProcess, windowsFixtureFailureMessage, windowsPrerequisiteFailureMessage, failureDiagnostics, cleanupScratch, WINDOWS_NAME, WINDOWS_EXCLUDED, GO_NAME, GO_PACKAGE } from '../../scripts/ci/skipped-platforms.mjs';
const sha = 'a'.repeat(40);
const native = (kind: string) => ({ arch: 'x64', platform: kind === 'windows' ? 'win32' : 'linux', runnerOS: kind === 'windows' ? 'Windows' : 'Linux', hosted: true, node: '22.23.3', commit: sha, head: sha, dirty: false, go: 'go version go1.27.1 linux/amd64', init: 'systemd', journald: 'active' });
const windows = () => {
  const assertionResults: { fullName: string; status: string; failureMessages: string[] }[] = [{ fullName: WINDOWS_NAME, status: 'passed', failureMessages: [] }, ...Object.entries(WINDOWS_EXCLUDED).flatMap(([fullName, count]) => Array.from({ length: count as number }, () => ({ fullName, status: 'pending', failureMessages: [] })))];
  return { success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: assertionResults.length - 1, numTotalTests: assertionResults.length, numTotalTestSuites: 2, numPassedTestSuites: 2, numFailedTestSuites: 0, numPendingTestSuites: 0, numTodoTests: 0, testResults: [{ name: 'C:\\checkout\\tests\\cli\\config.test.ts', status: 'passed', message: '', assertionResults }] };
};
const go = (action = 'pass', name = GO_NAME) => [{ Action: 'start', Package: GO_PACKAGE }, { Action: 'run', Package: GO_PACKAGE, Test: name }, { Action: 'output', Package: GO_PACKAGE, Test: name, Output: 'private journal contents' }, { Action: action, Package: GO_PACKAGE, Test: name }, { Action: 'pass', Package: GO_PACKAGE }].map(e => JSON.stringify(e)).join('\n');
describe('native skipped platform admission', () => {
  it.each(['windows', 'systemd'])('accepts exact native source and tools for %s', kind => { expect(() => validateNative(native(kind), kind)).not.toThrow(); });
  it.each([
    { arch: 'arm64' }, { platform: 'darwin' }, { runnerOS: 'macOS' }, { hosted: false }, { node: '22.23.2' }, { commit: 'unknown' }, { head: 'b'.repeat(40) }, { dirty: true },
  ])('refuses unavailable or mismatched native provenance %j', change => { expect(() => validateNative({ ...native('windows'), ...change }, 'windows')).toThrow(); });
  it.each([{ go: 'go version go1.27.0 linux/amd64' }, { init: 'bash' }, { journald: 'inactive' }])('refuses missing actual Linux system tools %j', change => { expect(() => validateNative({ ...native('systemd'), ...change }, 'systemd')).toThrow(); });
  it('accepts only the exact ACL pass and explicitly accounts for excluded siblings', () => { const result = validateWindows(windows(), { ...native('windows'), childExitCode: 0 }); expect(result).toMatchObject({ passed: 1, failed: 0, skipped: 0, excludedSiblingCount: 15 }); expect(JSON.stringify(result)).not.toContain('checkout'); });
  it.each(['pending', 'skipped', 'failed'])('refuses ACL %s even with aggregate success', status => { const report = windows(); report.testResults[0].assertionResults[0].status = status; expect(() => validateWindows(report, { ...native('windows'), childExitCode: 0 })).toThrow(); });
  it('refuses a renamed ACL leaf, extra executed sibling and injected unknown sibling', () => {
    for (const change of ['rename', 'executed', 'unknown']) { const report = windows(); if (change === 'rename') report.testResults[0].assertionResults[0].fullName += ' sibling'; if (change === 'executed') report.testResults[0].assertionResults[1].status = 'passed'; if (change === 'unknown') report.testResults[0].assertionResults[1].fullName = 'private login config unknown'; expect(() => validateWindows(report, { ...native('windows'), childExitCode: 0 })).toThrow(); }
  });
  it.each([null, {}, { success: true, testResults: [] }])('refuses missing/malformed Windows reports %j', report => { expect(() => validateWindows(report, { ...native('windows'), childExitCode: 0 })).toThrow(); });
  it('accepts actual Vitest4 reporter shape without an invented runtime-error field only in successful native child context', () => {
    const report = windows();
    expect(Object.hasOwn(report, 'numRuntimeErrorTestSuites')).toBe(false);
    expect(() => validateWindows(report, { ...native('windows'), childExitCode: 0 })).not.toThrow();
    for (const context of [undefined, { ...native('windows'), childExitCode: 1 }, { ...native('windows'), childExitCode: null }, { ...native('windows'), platform: 'darwin', childExitCode: 0 }]) expect(() => validateWindows(report, context)).toThrow();
  });
  it('refuses unsupported runtime-error fields, missing actual counters, todos and suite messages', () => {
    for (const report of [{ ...windows(), numRuntimeErrorTestSuites: 0 }, { ...windows(), numRuntimeErrorTestSuites: 1 }, { ...windows(), numFailedTestSuites: undefined }, { ...windows(), numTodoTests: 1 }, { ...windows(), numPendingTestSuites: 1 }]) expect(() => validateWindows(report, { ...native('windows'), childExitCode: 0 })).toThrow();
    const report = windows(); report.testResults[0].message = 'private error'; expect(() => validateWindows(report, { ...native('windows'), childExitCode: 0 })).toThrow();
  });
  it('refuses hidden runtime failure, target diagnostic failure and forged counts', () => {
    for (const change of ['runtime', 'diagnostics', 'counts', 'process']) { const report = windows(); if (change === 'runtime') report.numFailedTestSuites = 1; if (change === 'diagnostics') (report.testResults[0].assertionResults[0].failureMessages as string[]).push('private error'); if (change === 'counts') report.numPassedTests = 0; if (change === 'process') report.success = false; expect(() => validateWindows(report, { ...native('windows'), childExitCode: 0 })).toThrow(); }
  });
  it.each([{ status: 1, stdout: 'forged pass' }, { status: null, stdout: '' }, { status: 0, signal: 'SIGTERM', stdout: '' }, { status: 0, error: new Error('private child error'), stdout: '' }, { status: 0 }])('refuses raw failed/incomplete child process %j', result => { expect(() => validateProcess(result)).toThrow(); });
  it.each([{ status: null, stdout: '' }, { status: 0, signal: 'SIGKILL', stdout: '' }, { status: 0, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), stdout: '' }, { status: 0, error: Object.assign(new Error('overflow'), { code: 'ENOBUFS' }), stdout: '' }, { status: null, error: Object.assign(new Error('spawn'), { code: 'ENOENT' }), stdout: '' }])('retains real scratch and report on uncertain child settlement %j', child => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-native-cleanup-test-'));
    const report = path.join(scratch, 'report.json'); fs.writeFileSync(report, 'private evidence');
    try {
      let uncertain = false;
      try { validateProcess(child); } catch (error) { uncertain = (error as { processUncertain: boolean }).processUncertain; }
      expect(cleanupScratch(scratch, uncertain)).toBe('cleanup_unconfirmed');
      expect(fs.readFileSync(report, 'utf8')).toBe('private evidence');
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  it('removes real scratch only for a settled nonzero child exit', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-native-cleanup-test-'));
    fs.writeFileSync(path.join(scratch, 'report.json'), 'private evidence');
    let uncertain = true; try { validateProcess({ status: 1, stdout: '' }); } catch (error) { uncertain = (error as { processUncertain: boolean }).processUncertain; }
    expect(uncertain).toBe(false); expect(cleanupScratch(scratch, uncertain)).toBe('complete'); expect(fs.existsSync(scratch)).toBe(false);
  });
  it('classifies an actual timed-out child without exposing its output or errors', () => {
    const child = spawnSync(process.execPath, ['-e', "process.stdout.write('private credential');setTimeout(()=>{},10000)"], { encoding: 'utf8', timeout: 50 });
    expect(() => validateProcess(child)).toThrow();
    const diagnostic = failureDiagnostics(child, undefined);
    expect(diagnostic).toMatchObject({ classification: 'child_timeout', timeout: true, selectedLeafStatus: 'missing' });
    expect(JSON.stringify(diagnostic)).not.toContain('private credential');
    expect(JSON.stringify(diagnostic)).not.toContain('ETIMEDOUT');
  });
  it('distinguishes a reporter-proven leaf timeout from an ordinary failed leaf without relaxing admission', () => {
    const report = windows(); report.success = false; report.numPassedTests = 0; report.numFailedTests = 1;
    report.testResults[0].assertionResults[0].status = 'failed';
    (report.testResults[0].assertionResults[0].failureMessages as string[]).push('Error: Test timed out in 20000ms.\nprivate credential and home path');
    expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ classification: 'selected_leaf_timeout', childExitCode: 1, timeout: true, selectedLeafStatus: 'failed', selectedLeafCount: 1, passed: 0, failed: 1, pending: 15 });
    expect(() => validateWindows(report, { ...native('windows'), childExitCode: 1 })).toThrow();
    expect(JSON.stringify(failureDiagnostics({ status: 1 }, report, 'parsed'))).not.toContain('private credential');
    report.testResults[0].assertionResults[0].failureMessages = ['private error mentions Test timed out in 20000ms.'];
    expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ classification: 'child_nonzero_exit', timeout: false });
  });
  it.each([
    [{ status: 0 }, undefined, 'missing', 'report_missing'],
    [{ status: 0 }, undefined, 'malformed', 'report_malformed'],
    [{ status: null }, undefined, 'missing', 'child_unsettled'],
    [{ status: null, signal: 'SIGTERM' }, undefined, 'missing', 'child_signal'],
    [{ status: null, error: { code: 'ENOBUFS', message: 'private output' } }, undefined, 'missing', 'child_output_overflow'],
    [{ status: null, error: { code: 'ENOENT', path: 'private home' } }, undefined, 'missing', 'child_spawn_error'],
  ])('publishes fixed classification without private child fields %j', (child, report, state, classification) => {
    const diagnostic = failureDiagnostics(child, report, state); expect(diagnostic.classification).toBe(classification);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|SIGTERM|ENOENT|ENOBUFS/);
  });
  it('refuses fabricated diagnostic counter/status data rather than copying it into public output', () => {
    const report = windows(); report.testResults[0].assertionResults[0].status = 'private home'; report.numFailedTests = -1;
    const diagnostic = failureDiagnostics({ status: 0 }, report, 'parsed');
    expect(diagnostic).toMatchObject({ classification: 'selected_leaf_invalid', selectedLeafStatus: 'invalid', failed: null });
    expect(JSON.stringify(diagnostic)).not.toContain('private home');
    expect(() => validateWindows(report, { ...native('windows'), childExitCode: 0 })).toThrow();
  });
  it.each(['setup', 'verification'])('publishes only a fixed fixture %s failure kind and test line', phase => {
    const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
    report.testResults[0].assertionResults[0].failureMessages = [`Error: Windows inherited ACL fixture ${phase} failed.\n at C:\\private-home\\tests\\cli\\config.test.ts:77:5\nprivate credential`];
    const diagnostic = failureDiagnostics({ status: 1 }, report, 'parsed');
    expect(diagnostic).toMatchObject({ failureKind: 'fixture_' + phase, failureAtTestLine: 77, selectedLeafStatus: 'failed' });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-home|private credential|config.test.ts/);
    expect(() => validateWindows(report, { ...native('windows'), childExitCode: 1 })).toThrow();
  });
  it('extracts a bounded test line for actual assertion failure and ignores unrelated/private paths', () => {
    const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
    report.testResults[0].assertionResults[0].failureMessages = ['AssertionError: private credential\n at /private/home/tests/cli/config.test.ts:80:3'];
    expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ failureKind: 'assertion', failureAtTestLine: 80 });
    for (const message of ['Error: private-home:99:5', 'Error: private credential\n at /private/home/tests/cli/config.test.ts:99999:3']) {
      report.testResults[0].assertionResults[0].failureMessages = [message];
      expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ failureKind: 'other_test_failure', failureAtTestLine: null });
    }
    report.testResults[0].assertionResults[0].status = 'passed';
    expect(failureDiagnostics({ status: 0 }, report, 'parsed')).toMatchObject({ failureKind: null, failureAtTestLine: null });
  });
  it('projects the actual fixture callback timeout and nonzero exit separately without private child output', async () => {
    for (const [script, timeout, expected] of [
      ["process.stdout.write('private credential');setTimeout(()=>{},10000)", 50, { fixtureChildOutcome: 'timeout', fixtureChildExitCode: null }],
      ["process.stderr.write('private credential');process.exit(7)", 3000, { fixtureChildOutcome: 'nonzero_exit', fixtureChildExitCode: 7 }],
    ] as const) {
      const message = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script], { timeout, maxBuffer: 4096 }, error => error ? resolve(windowsFixtureFailureMessage('verification', error)) : reject(new Error('Expected failed fixture child.'))));
      const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
      report.testResults[0].assertionResults[0].failureMessages = ['Error: ' + message + '\n at C:\\private-home\\tests\\cli\\config.test.ts:25:5'];
      const diagnostic = failureDiagnostics({ status: 1 }, report, 'parsed');
      expect(diagnostic).toMatchObject({ failureKind: 'fixture_verification', failureAtTestLine: 25, timeout: false, ...expected });
      expect(JSON.stringify(diagnostic) + message).not.toMatch(/private credential|private-home|SIGTERM|Command failed/);
      expect(() => validateWindows(report, { ...native('windows'), childExitCode: 1 })).toThrow();
    }
  });
  it('keeps overflow, spawn, foreign signal and unknown fixture outcomes fixed and value-free', () => {
    for (const [error, outcome, exit] of [
      [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }, 'output_overflow', 'none'],
      [{ code: 'ENOENT', message: 'private executable' }, 'spawn_error', 'none'],
      [{ code: null, killed: false, signal: 'SIGTERM' }, 'signal', 'none'],
      [{ code: 0, killed: true, signal: null }, 'unclassified', 'none'],
      [{ code: 'private credential', signal: null }, 'unclassified', 'none'],
      [{ code: 4294967296, signal: null }, 'unclassified', 'none'],
      [{ code: 41, killed: false, signal: null }, 'nonzero_exit', '41'],
      [{ code: 42, killed: false, signal: null }, 'nonzero_exit', '42'],
    ] as const) {
      const message = windowsFixtureFailureMessage('setup', error);
      expect(message).toBe(`Windows inherited ACL fixture setup failed. [child=${outcome};exit=${exit}]`);
      const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
      report.testResults[0].assertionResults[0].failureMessages = ['Error: ' + message];
      expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ failureKind: 'fixture_setup', fixtureChildOutcome: outcome, fixtureChildExitCode: exit === 'none' ? null : Number(exit) });
      expect(message).not.toMatch(/private|SIGTERM|ENOENT|MAXBUFFER/);
    }
    expect(() => windowsFixtureFailureMessage('private phase', { code: 1 })).toThrow('Native skipped-platform acceptance refused.');
  });
  it('rejects malformed or unbound fixture metadata without changing failed-report admission', () => {
    for (const message of [
      'Error: Windows inherited ACL fixture verification failed.',
      'Error: Windows inherited ACL fixture verification failed. [child=private credential;exit=none]',
      'Error: Windows inherited ACL fixture verification failed. [child=timeout;exit=1]',
      'Error: Windows inherited ACL fixture verification failed. [child=nonzero_exit;exit=none]',
      'Error: Windows inherited ACL fixture verification failed. [child=nonzero_exit;exit=0]',
      'Error: Windows inherited ACL fixture verification failed. [child=nonzero_exit;exit=4294967296]',
      'Error: Windows inherited ACL fixture verification failed. [child=timeout;exit=none] private suffix',
      'Error: unrelated\nError: Windows inherited ACL fixture verification failed. [child=timeout;exit=none]',
    ]) {
      const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
      report.testResults[0].assertionResults[0].failureMessages = [message];
      expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ fixtureChildOutcome: null, fixtureChildExitCode: null });
      expect(() => validateWindows(report, { ...native('windows'), childExitCode: 1 })).toThrow();
    }
    const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
    report.testResults[0].assertionResults[0].failureMessages = ['Error: ' + windowsFixtureFailureMessage('setup', { code: 1 }), 'Error: ' + windowsFixtureFailureMessage('verification', { code: null, killed: true, signal: 'SIGTERM' })];
    expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ fixtureChildOutcome: null, fixtureChildExitCode: null });
  });
  it('projects only fixed prerequisite child, deadline and close outcomes without admitting the failed leaf', () => {
    for (const [reason, error, outcome, exit] of [
      ['child', { code: null, killed: true, signal: 'SIGTERM' }, 'timeout', null],
      ['child', { code: 51, killed: false, signal: null }, 'nonzero_exit', 51],
      ['child', { code: 52, killed: false, signal: null }, 'nonzero_exit', 52],
      ['child', { code: 53, killed: false, signal: null }, 'nonzero_exit', 53],
      ['child', { code: 54, killed: false, signal: null }, 'nonzero_exit', 54],
      ['child', { code: 'ENOENT', message: 'private executable' }, 'spawn_error', null],
      ['child', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }, 'output_overflow', null],
      ['child', { code: 'private credential', signal: null }, 'unclassified', null],
      ['deadline', { message: 'private exception' }, 'deadline', null],
      ['close', { message: 'private exception' }, 'close_refused', null],
    ] as const) {
      const message = windowsPrerequisiteFailureMessage(reason, error);
      expect(message).toBe(`Windows ACL fixture prerequisite failed. [child=${outcome};exit=${exit === null ? 'none' : exit}]`);
      const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
      report.testResults[0].assertionResults[0].failureMessages = ['Error: ' + message + '\n at C:\\private-home\\tests\\cli\\config.test.ts:44:5'];
      const diagnostic = failureDiagnostics({ status: 1 }, report, 'parsed');
      expect(diagnostic).toMatchObject({ failureKind: 'fixture_prerequisite', fixtureChildOutcome: outcome, fixtureChildExitCode: exit, failureAtTestLine: 44, timeout: false });
      expect(JSON.stringify(diagnostic) + message).not.toMatch(/private executable|private credential|private exception|private-home|SIGTERM|ENOENT|MAXBUFFER/);
      expect(() => validateWindows(report, { ...native('windows'), childExitCode: 1 })).toThrow();
    }
    expect(() => Reflect.apply(windowsPrerequisiteFailureMessage, undefined, ['private reason'])).toThrow('Native skipped-platform acceptance refused.');
  });
  it('does not copy malformed, contradictory or misplaced prerequisite metadata into public fields', () => {
    for (const message of [
      'Error: Windows ACL fixture prerequisite failed. [child=deadline;exit=51]',
      'Error: Windows ACL fixture prerequisite failed. [child=close_refused;exit=1]',
      'Error: Windows ACL fixture prerequisite failed. [child=nonzero_exit;exit=0]',
      'Error: Windows ACL fixture prerequisite failed. [child=nonzero_exit;exit=4294967296]',
      'Error: Windows ACL fixture prerequisite failed. [child=private credential;exit=none]',
      'Error: Windows ACL fixture prerequisite failed. [child=timeout;exit=none] private suffix',
      'Error: Windows inherited ACL fixture verification failed. [child=deadline;exit=none]',
      'Error: unrelated\nError: Windows ACL fixture prerequisite failed. [child=close_refused;exit=none]',
    ]) {
      const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
      report.testResults[0].assertionResults[0].failureMessages = [message];
      expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ fixtureChildOutcome: null, fixtureChildExitCode: null });
      expect(() => validateWindows(report, { ...native('windows'), childExitCode: 1 })).toThrow();
    }
  });
  it('retains one bounded prerequisite failure alongside its exact unsettled-cleanup marker only', () => {
    const prerequisite = 'Error: ' + windowsPrerequisiteFailureMessage('deadline') + '\n at C:\\private-home\\tests\\cli\\config.test.ts:44:5';
    const cleanup = 'Error: Windows ACL fixture prerequisite cleanup unconfirmed.\n at C:\\private-home\\tests\\cli\\config.test.ts:17:5';
    for (const messages of [[prerequisite, cleanup], [cleanup, prerequisite]]) {
      const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
      report.testResults[0].assertionResults[0].failureMessages = messages;
      expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ failureKind: 'fixture_prerequisite', fixtureChildOutcome: 'deadline', fixtureChildExitCode: null, failureAtTestLine: 44 });
      expect(JSON.stringify(failureDiagnostics({ status: 1 }, report, 'parsed'))).not.toMatch(/private-home|config.test.ts/);
      expect(() => validateWindows(report, { ...native('windows'), childExitCode: 1 })).toThrow();
    }
    for (const messages of [[prerequisite, prerequisite], [prerequisite, cleanup, cleanup], [prerequisite, 'Error: private credential'], [cleanup]]) {
      const report = windows(); report.testResults[0].assertionResults[0].status = 'failed';
      report.testResults[0].assertionResults[0].failureMessages = messages;
      expect(failureDiagnostics({ status: 1 }, report, 'parsed')).toMatchObject({ fixtureChildOutcome: null, fixtureChildExitCode: null });
      expect(() => validateWindows(report, { ...native('windows'), childExitCode: 1 })).toThrow();
    }
  });
  it('accepts actual Go exact leaf without exposing journal text', () => { const result = validateGo(go()); expect(result).toEqual({ name: GO_NAME, passed: 1, failed: 0, skipped: 0, excludedSiblingCount: 0 }); expect(JSON.stringify(result)).not.toContain('private journal'); });
  it.each(['skip', 'fail', 'pause'])('refuses Go %s', action => { expect(() => validateGo(go(action))).toThrow(); });
  it('refuses renamed, duplicated, missing and malformed Go leaves', () => { for (const raw of [go('pass', 'Other'), go() + '\n' + go(), '', '{', JSON.stringify({ Action: 'pass', Package: GO_PACKAGE }), go().replace(GO_PACKAGE, 'other/package')]) expect(() => validateGo(raw)).toThrow(); });
});
