import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateNative, validateWindows, validateGo, validateProcess, cleanupScratch, WINDOWS_NAME, WINDOWS_EXCLUDED, GO_NAME, GO_PACKAGE } from '../../scripts/ci/skipped-platforms.mjs';
const sha = 'a'.repeat(40);
const native = (kind: string) => ({ arch: 'x64', platform: kind === 'windows' ? 'win32' : 'linux', runnerOS: kind === 'windows' ? 'Windows' : 'Linux', hosted: true, node: '22.23.3', commit: sha, head: sha, dirty: false, go: 'go version go1.27.1 linux/amd64', init: 'systemd', journald: 'active' });
const windows = () => {
  const assertionResults = [{ fullName: WINDOWS_NAME, status: 'passed', failureMessages: [] }, ...Object.entries(WINDOWS_EXCLUDED).flatMap(([fullName, count]) => Array.from({ length: count as number }, () => ({ fullName, status: 'pending', failureMessages: [] })))];
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
  it('accepts actual Go exact leaf without exposing journal text', () => { const result = validateGo(go()); expect(result).toEqual({ name: GO_NAME, passed: 1, failed: 0, skipped: 0, excludedSiblingCount: 0 }); expect(JSON.stringify(result)).not.toContain('private journal'); });
  it.each(['skip', 'fail', 'pause'])('refuses Go %s', action => { expect(() => validateGo(go(action))).toThrow(); });
  it('refuses renamed, duplicated, missing and malformed Go leaves', () => { for (const raw of [go('pass', 'Other'), go() + '\n' + go(), '', '{', JSON.stringify({ Action: 'pass', Package: GO_PACKAGE }), go().replace(GO_PACKAGE, 'other/package')]) expect(() => validateGo(raw)).toThrow(); });
});
