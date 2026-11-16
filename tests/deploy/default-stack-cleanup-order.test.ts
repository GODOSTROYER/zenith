import { describe, expect, it } from 'vitest';
import { cleanupPlan, installationLabel, projectLabel } from '../../scripts/acceptance/default-stack/config.mjs';

const installationId = 'a'.repeat(24);
const applicationInstallationId = 'b'.repeat(24);
const state = { installationId, applicationInstallationId, projectId: `zenith-local-${installationId}` };
const installationLabels = { [installationLabel]: installationId };

describe('default stack cleanup container ordering', () => {
  it('places the exact owned Supabase database after client containers so connections can drain first', () => {
    const resources = [
      { kind: 'container', id: 'z-client', labels: { [installationLabel]: applicationInstallationId }, item: { Name: '/supabase_rest_client' } },
      { kind: 'container', id: '000-database', labels: installationLabels, item: { Name: `/supabase_db_${state.projectId}` } },
      { kind: 'container', id: 'a-client', labels: installationLabels, item: { Name: '/supabase_pooler_client' } },
      { kind: 'container', id: 'm-unknown', labels: installationLabels, item: { Name: '/unrecognized_service' } },
    ];
    const expected = [
      { kind: 'container', id: 'a-client' },
      { kind: 'container', id: 'm-unknown' },
      { kind: 'container', id: 'z-client' },
      { kind: 'container', id: '000-database' },
    ];
    expect(cleanupPlan(resources, state)).toEqual(expected);
    expect(cleanupPlan([...resources].reverse(), state)).toEqual(expected);
  });

  it('skips foreign containers and still refuses conflicting ownership labels', () => {
    const foreign = { kind: 'container', id: 'foreign', labels: { [installationLabel]: 'c'.repeat(24) }, item: { Name: `/supabase_db_${state.projectId}` } };
    expect(cleanupPlan([foreign], state)).toEqual([]);

    const conflict = { kind: 'container', id: 'conflict', labels: { [installationLabel]: 'c'.repeat(24), [projectLabel]: state.projectId }, item: { Name: '/client' } };
    expect(() => cleanupPlan([conflict], state)).toThrow('resource-identity');
  });
});
