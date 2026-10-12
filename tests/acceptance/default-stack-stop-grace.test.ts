import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupStopDiagnostic, containerStopGraceSeconds, writeCleanupStopDiagnosticFile } from '../../scripts/acceptance/default-stack/runtime.mjs';

const installationId = '0123456789abcdef01234567';
const state = {
  installationId,
  applicationInstallationId: 'fedcba9876543210fedcba98',
  applicationProjectName: 'zenith-app-0123456789abcdef01234567',
  projectId: `zenith-local-${installationId}`,
};

describe('default-stack owned container stop grace', () => {
  it('creates exclusive mode-0600 records and refuses existing symlink or hardlink targets', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-stop-diagnostic-'));
    const nonce = '00000000-0000-4000-8000-000000000001';
    const file = (suffix: string) => `cleanup-stop-${suffix}.private.json`;
    const content = { schemaVersion: 1, container: { phase: 'observed', exitCode: 137 } };
    try {
      const created = path.join(directory, file(nonce));
      expect(writeCleanupStopDiagnosticFile(directory, file(nonce), content)).toBe(true);
      expect(fs.statSync(created).mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(created).nlink).toBe(1);
      expect(JSON.parse(fs.readFileSync(created, 'utf8'))).toEqual(content);

      const sentinel = path.join(directory, 'sentinel');
      fs.writeFileSync(sentinel, 'unchanged');
      const existingName = file('00000000-0000-4000-8000-000000000004');
      const existingPath = path.join(directory, existingName);
      fs.writeFileSync(existingPath, 'preexisting');
      expect(writeCleanupStopDiagnosticFile(directory, existingName, content)).toBe(false);
      expect(fs.readFileSync(existingPath, 'utf8')).toBe('preexisting');
      const symlinkName = file('00000000-0000-4000-8000-000000000002');
      fs.symlinkSync(sentinel, path.join(directory, symlinkName));
      expect(writeCleanupStopDiagnosticFile(directory, symlinkName, content)).toBe(false);
      const hardlinkName = file('00000000-0000-4000-8000-000000000003');
      fs.linkSync(sentinel, path.join(directory, hardlinkName));
      expect(writeCleanupStopDiagnosticFile(directory, hardlinkName, content)).toBe(false);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('records only bounded private stop observations and normalizes configured signals', () => {
    const resource = { id: '0123456789abcdef0123456789abcdef' };
    const current = { Name: '/supabase_kong_example', State: { Running: true }, Config: { StopSignal: 'SIGTERM' } };
    const stopped = { State: { Running: false, ExitCode: 137, OOMKilled: false } };
    expect(cleanupStopDiagnostic({ resource, current, stopped, graceSeconds: 60, elapsedMs: 60123,
      phase: 'observed', stopResolved: true })).toEqual({
      id: resource.id, name: current.Name, graceSeconds: 60, signal: 'SIGTERM', elapsedMs: 60123,
      phase: 'observed', stopResolved: true, wasRunning: true, postStopInspectionAvailable: true,
      runningAfter: false, exitCode: 137, oomKilled: false,
    });
    expect(cleanupStopDiagnostic({ resource, current: { Config: { StopSignal: 'untrusted-value' } },
      graceSeconds: 660, elapsedMs: 1, phase: 'stop', stopResolved: false })).toMatchObject({
      signal: 'other', postStopInspectionAvailable: false, runningAfter: null, exitCode: null, oomKilled: null,
    });
    expect(cleanupStopDiagnostic({ resource, current: {}, graceSeconds: 60, elapsedMs: 1,
      phase: 'stop', stopResolved: false }).signal).toBe('SIGTERM');
  });

  it('uses the short grace only for exact Supabase infrastructure names with the project owner label', () => {
    for (const service of ['auth', 'db', 'kong', 'pooler', 'rest']) {
      expect(containerStopGraceSeconds({
        Name: `/supabase_${service}_${state.projectId}`,
        Config: { Labels: { 'com.supabase.cli.project': state.projectId } },
      }, state)).toBe(60);
    }
    expect(containerStopGraceSeconds({
      Name: `/supabase_kong_${state.projectId}`,
      Config: { Labels: { 'com.supabase.cli.project': 'zenith-local-ffffffffffffffffffffffff' } },
    }, state)).toBe(660);
    expect(containerStopGraceSeconds({
      Name: `/supabase_custom_${state.projectId}`,
      Config: { Labels: { 'com.supabase.cli.project': state.projectId } },
    }, state)).toBe(660);
  });

  it('uses the short grace for exact installation-owned infrastructure service labels only', () => {
    for (const service of ['temporal', 'supabase-edge']) {
      expect(containerStopGraceSeconds({
        Config: { Labels: {
          'io.zenith.installation': state.applicationInstallationId,
          'com.docker.compose.project': state.applicationProjectName,
          'com.docker.compose.service': service,
        } },
      }, state)).toBe(60);
    }
    expect(containerStopGraceSeconds({
      Config: { Labels: {
        'io.zenith.installation': 'ffffffffffffffffffffffff',
        'com.docker.compose.project': state.applicationProjectName,
        'com.docker.compose.service': 'temporal',
      } },
    }, state)).toBe(660);
    expect(containerStopGraceSeconds({
      Config: { Labels: {
        'io.zenith.installation': state.applicationInstallationId,
        'com.docker.compose.project': 'wrong-project',
        'com.docker.compose.service': 'temporal',
      } },
    }, state)).toBe(660);
    expect(containerStopGraceSeconds({
      Config: { Labels: {
        'io.zenith.installation': state.applicationInstallationId,
        'com.docker.compose.service': 'temporal',
      } },
    }, state)).toBe(660);
    expect(containerStopGraceSeconds({
      Config: { Labels: {
        'io.zenith.installation': state.applicationInstallationId,
        'com.docker.compose.service': 'temporal',
      } },
    }, { ...state, applicationProjectName: undefined })).toBe(660);
    expect(containerStopGraceSeconds({
      Config: { Labels: {
        'io.zenith.installation': state.applicationInstallationId,
        'com.docker.compose.project': state.applicationProjectName,
        'com.docker.compose.service': 'api',
      } },
    }, state)).toBe(660);
    expect(containerStopGraceSeconds({
      Config: { Labels: {
        'io.zenith.installation': installationId,
        'com.docker.compose.project': state.applicationProjectName,
        'com.docker.compose.service': 'temporal',
      } },
    }, state)).toBe(660);
  });

  it('never shortens execution worker, peer worker, or unknown-role grace', () => {
    for (const service of ['execution-worker', 'execution-worker-peer']) {
      expect(containerStopGraceSeconds({
        Config: { Labels: {
          'io.zenith.installation': state.applicationInstallationId,
          'com.docker.compose.project': state.applicationProjectName,
          'com.docker.compose.service': service,
        } },
      }, state)).toBe(660);
    }
    expect(containerStopGraceSeconds({
      Name: '/unrecognized-owned-container',
      Config: { Labels: { 'io.zenith.installation': installationId } },
    }, state)).toBe(660);
    expect(containerStopGraceSeconds({}, state)).toBe(660);
  });
});
