import { describe, expect, it } from 'vitest';
import { containerStopGraceSeconds } from '../../scripts/acceptance/default-stack/runtime.mjs';

const installationId = '0123456789abcdef01234567';
const state = {
  installationId,
  applicationInstallationId: 'fedcba9876543210fedcba98',
  applicationProjectName: 'zenith-app-0123456789abcdef01234567',
  projectId: `zenith-local-${installationId}`,
};

describe('default-stack owned container stop grace', () => {
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
