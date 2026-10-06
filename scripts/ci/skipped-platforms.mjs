/** Actual native execution for two OS-gated leaves. Child diagnostics stay private. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const WINDOWS_NAME = 'private login config Windows refuses inherited ACLs that grant other identities access';
export const GO_NAME = 'TestRealSystemctlAndJournalctl';
export const GO_PACKAGE = 'github.com/GODOSTROYER/zenith/go/internal/machine/ops';
export const WINDOWS_EXCLUDED = {
  "private login config stores stdin atomically, uses it for auth, and logout removes it": 1,
  "private login config POSIX config file is 0600 and directory is 0700 (mode check skipped on Windows)": 1,
  "private login config accepts CRLF stdin and can replace an existing private config": 1,
  "private login config refuses forwarding a saved credential to another server": 1,
  "private login config environment auth overrides saved credentials and bypasses malformed config": 1,
  "private login config refuses invalid stdin without outputting it": 5,
  "private login config requires token-stdin and rejects tokens in command arguments": 1,
  "private login config missing auth is a local usage error without a request": 1,
  "private login config malformed config never exposes raw contents even in debug diagnostics": 1,
  "private login config refuses shared POSIX files and symlinked config paths": 1,
  "private login config aborts token stdin with exit 130 before saving": 1
};
const fail = () => { throw new Error('Native skipped-platform acceptance refused.'); };
export function validateNative(meta, kind) {
  if (!['windows', 'systemd'].includes(kind) || meta.arch !== 'x64' || meta.platform !== (kind === 'windows' ? 'win32' : 'linux') || meta.runnerOS !== (kind === 'windows' ? 'Windows' : 'Linux') || meta.hosted !== true || meta.node !== '22.23.3' || !/^[a-f0-9]{40}$/.test(meta.commit ?? '') || meta.commit !== meta.head || meta.dirty !== false || (kind === 'systemd' && (meta.go !== 'go version go1.27.1 linux/amd64' || meta.init !== 'systemd' || meta.journald !== 'active'))) fail();
}
export function validateWindows(report, context) {
  validateNative(context ?? {}, 'windows');
  if (context.childExitCode !== 0) fail();
  if (!report || report.success !== true || !Array.isArray(report.testResults) || report.testResults.length !== 1 || !Array.isArray(report.testResults[0].assertionResults) || report.testResults[0].status !== 'passed' || report.testResults[0].message !== '' || !/[\\/]tests[\\/]cli[\\/]config\.test\.ts$/.test(report.testResults[0].name ?? '')) fail();
  const assertions = report.testResults[0].assertionResults;
  const selected = assertions.filter(a => a.fullName === WINDOWS_NAME);
  if (selected.length !== 1 || selected[0].status !== 'passed' || !Array.isArray(selected[0].failureMessages) || selected[0].failureMessages.length) fail();
  // Vitest retains -t excluded siblings as pending. They are not executed skips.
  const excluded = assertions.filter(a => a.fullName !== WINDOWS_NAME);
  const observed = {};
  for (const a of excluded) observed[a.fullName] = (observed[a.fullName] ?? 0) + 1;
  if (JSON.stringify(Object.entries(observed).sort()) !== JSON.stringify(Object.entries(WINDOWS_EXCLUDED).sort())) fail();
  if (excluded.some(a => !['pending', 'skipped'].includes(a.status) || !a.fullName?.startsWith('private login config ') || !Array.isArray(a.failureMessages) || a.failureMessages.length) || report.numPassedTests !== 1 || report.numFailedTests !== 0 || report.numPendingTests !== excluded.length || report.numTotalTests !== assertions.length || report.numFailedTestSuites !== 0 || report.numTodoTests !== 0 || report.numPendingTestSuites !== 0 || !Number.isInteger(report.numTotalTestSuites) || report.numTotalTestSuites < 1 || report.numPassedTestSuites !== report.numTotalTestSuites || Object.hasOwn(report, 'numRuntimeErrorTestSuites')) fail();
  return { name: WINDOWS_NAME, passed: 1, failed: 0, skipped: 0, excludedSiblingCount: excluded.length };
}
export function validateGo(raw) {
  let events;
  try { events = raw.trim().split(/\r?\n/).map(line => JSON.parse(line)); } catch { fail(); }
  if (!events.length || events.some(e => e.Package !== GO_PACKAGE || !['start', 'run', 'output', 'pass'].includes(e.Action) || (e.Test !== undefined && e.Test !== GO_NAME))) fail();
  const tests = events.filter(e => e.Test === GO_NAME && e.Action !== 'output');
  if (tests.length !== 2 || tests[0].Action !== 'run' || tests[1].Action !== 'pass' || events.filter(e => e.Action === 'start' && !e.Test).length !== 1 || events.filter(e => e.Action === 'pass' && !e.Test).length !== 1 || events.at(-1).Action !== 'pass' || events.at(-1).Test !== undefined) fail();
  return { name: GO_NAME, passed: 1, failed: 0, skipped: 0, excludedSiblingCount: 0 };
}
export function validateProcess(result) {
  if (!result || result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') {
    const error = new Error('Native child process failed.');
    error.processUncertain = !result || Boolean(result.error || result.signal) || !Number.isInteger(result.status);
    // Preserve settlement uncertainty; never expose raw diagnostics in public evidence.
    error.childState = result ? { error: result.error, signal: result.signal, status: result.status } : null;
    throw error;
  }
  return result.stdout;
}
/** Public diagnostics contain fixed labels and counters only, never child/report text. */
export function failureDiagnostics(child, report, reportState = 'missing') {
  const assertions = Array.isArray(report?.testResults) ? report.testResults.flatMap(f => Array.isArray(f?.assertionResults) ? f.assertionResults : []) : [];
  const selected = assertions.filter(a => a?.fullName === WINDOWS_NAME);
  const states = ['passed', 'failed', 'pending', 'skipped', 'todo'];
  const selectedLeafStatus = selected.length === 1 && states.includes(selected[0]?.status) ? selected[0].status : selected.length === 0 ? 'missing' : 'invalid';
  const reporterTimeout = selected.some(a => Array.isArray(a.failureMessages) && a.failureMessages.some(m => typeof m === 'string' && /^(?:Error: )?(?:Test|Hook) timed out in [0-9]+ms(?:[.\n]|$)/.test(m)));
  const childTimeout = child?.error?.code === 'ETIMEDOUT';
  const classification = childTimeout ? 'child_timeout' : child?.error?.code === 'ENOBUFS' ? 'child_output_overflow' : child?.error ? 'child_spawn_error' : child?.signal ? 'child_signal' : reporterTimeout ? 'selected_leaf_timeout' : child && !Number.isInteger(child.status) ? 'child_unsettled' : child?.status !== undefined && child.status !== 0 ? 'child_nonzero_exit' : reportState !== 'parsed' ? 'report_' + (reportState === 'malformed' ? 'malformed' : 'missing') : selectedLeafStatus !== 'passed' ? 'selected_leaf_' + selectedLeafStatus : 'report_admission_refused';
  const count = key => Number.isSafeInteger(report?.[key]) && report[key] >= 0 ? report[key] : null;
  return { classification, childExitCode: Number.isInteger(child?.status) ? child.status : null, timeout: childTimeout || reporterTimeout, selectedLeafStatus, selectedLeafCount: selected.length, passed: count('numPassedTests'), failed: count('numFailedTests'), pending: count('numPendingTests'), todo: count('numTodoTests'), failedSuites: count('numFailedTestSuites') };
}
function capture(command, args, options = {}) {
  const { observe, ...spawnOptions } = options;
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, maxBuffer: 128 * 1024 * 1024, windowsHide: true, ...spawnOptions });
  observe?.(result);
  return validateProcess(result);
}
export function cleanupScratch(scratch, uncertain) {
  if (uncertain) return 'cleanup_unconfirmed';
  if (!scratch) return 'complete';
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
    return fs.existsSync(scratch) ? 'failed' : 'complete';
  } catch { return 'failed'; }
}
export function run(kind, destination) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  let scratch, result, failure, meta, diagnostics, phase = 'provenance', uncertain = false, cleanup = 'pending';
  try {
    const commit = process.env.GITHUB_SHA;
    meta = { arch: process.arch, platform: process.platform, runnerOS: process.env.RUNNER_OS, hosted: process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', node: process.versions.node, commit, head: capture('git', ['rev-parse', 'HEAD'], { cwd: root }).trim(), dirty: capture('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root }).trim() !== '' };
    if (kind === 'systemd') {
      meta.go = capture('go', ['version']).trim();
      meta.init = fs.readFileSync('/proc/1/comm', 'utf8').trim();
      meta.journald = capture('systemctl', ['is-active', 'systemd-journald.service']).trim();
    }
    validateNative(meta, kind);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-skipped-native-'));
    const env = { ...process.env, TMP: scratch, TEMP: scratch, TMPDIR: scratch, ZENITH_DATA: path.join(scratch, 'data') };
    let leaf;
    if (kind === 'windows') {
      const report = path.join(scratch, 'report.json');
      let child, parsed, reportState = 'missing';
      phase = 'windows_execution';
      try {
        capture(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/cli/config.test.ts', '--project=node', '--maxWorkers=1', '--no-file-parallelism', '--testNamePattern=^' + WINDOWS_NAME + '$', '--reporter=json', '--outputFile=' + report], { cwd: root, env, observe: value => { child = value; } });
      } finally {
        if (fs.existsSync(report)) {
          try { parsed = JSON.parse(fs.readFileSync(report, 'utf8')); reportState = 'parsed'; } catch { reportState = 'malformed'; }
        }
        diagnostics = failureDiagnostics(child, parsed, reportState);
      }
      phase = 'windows_admission';
      leaf = validateWindows(parsed, { ...meta, childExitCode: child?.status });
    } else {
      phase = 'systemd_execution';
      leaf = validateGo(capture('go', ['test', './internal/machine/ops', '-run', '^' + GO_NAME + '$', '-json', '-count=1'], { cwd: path.join(root, 'go'), env: { ...env, ZENITH_TEST_SYSTEMD: '1', GOTOOLCHAIN: 'local' } }));
    }
    const sources = ['scripts/ci/skipped-platforms.mjs', '.github/workflows/skipped-platforms.yml', kind === 'windows' ? 'tests/cli/config.test.ts' : 'go/internal/machine/ops/network_test.go'];
    result = { schemaVersion: 1, kind, status: 'passed', sourceCommit: commit, tools: { node: meta.node, ...(meta.go ? { go: meta.go } : {}) }, leaf, sourceHashes: sources.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })), cleanup: 'pending' };
  } catch (error) { failure = true; uncertain = error.processUncertain === true; }
  finally {
    cleanup = cleanupScratch(scratch, uncertain);
    if (cleanup !== 'complete') {
      failure = true;
      if (result) diagnostics = { classification: cleanup === 'failed' ? 'cleanup_failed' : 'cleanup_unconfirmed', childExitCode: 0, timeout: false, selectedLeafStatus: 'passed', selectedLeafCount: 1 };
    }
  }
  const publicReport = failure ? { schemaVersion: 1, kind: ['windows', 'systemd'].includes(kind) ? kind : 'unknown', status: 'failed', sourceCommit: /^[a-f0-9]{40}$/.test(meta?.commit ?? '') ? meta.commit : null, tools: { node: process.versions.node }, diagnostics: diagnostics ?? { classification: phase === 'provenance' ? 'native_provenance_refused' : 'systemd_execution_refused', childExitCode: null, timeout: false }, cleanup } : { ...result, cleanup };
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(publicReport, null, 2) + '\n', { mode: 0o600 });
  if (failure) fail();
  return publicReport;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) fail();
    const result = run(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result));
  } catch { console.error('Native skipped-platform acceptance failed; see sanitized status artifact.'); process.exitCode = 1; }
}
