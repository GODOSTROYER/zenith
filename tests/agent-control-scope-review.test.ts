/**
 * Regressions for the agent-control security review (2026-09):
 *
 *  - M1: an explicit-list link cannot point a variable at another project's
 *    secret reference (secret.adopt, manifest.replace), and a plan it can see
 *    never names another project's readers of a shared reference;
 *  - L2: an environment-narrowed link cannot change a record of another
 *    environment, or a project-wide one, through a project-only target;
 *  - L3: the project quota is checked again when an approved create executes.
 *
 * Same harness as agent-control-operations: prepare → human review → execute.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@/lib/agent-access/control/journal';
import { tempDataDir } from './_support/data-dir';

tempDataDir('zenith-agent-scope-', { fast: true });
const ORIGIN = 'http://localhost:3400';
process.env.ZENITH_AGENT_CONTROL = '1';
process.env.ZENITH_AGENT_WRITES = '1';
process.env.ZENITH_AGENT_ORIGIN = ORIGIN;
process.env.ZENITH_SECRET_KEY = '9'.repeat(64);
delete process.env.ZENITH_STORE;

const { db, resetDb, save } = await import('@/lib/db/store');
const { runAction } = await import('@/lib/actions/core');
const { registerAllActions } = await import('@/lib/actions/defs');
const { contentHash } = await import('@/lib/domain/types');
const { putSecret, vaultRef } = await import('@/lib/secrets');
const { Journal, SqliteAgentJournal } = await import('@/lib/agent-access/control/journal');
const runtime = await import('@/lib/agent-access/control/runtime');

const journal = new SqliteAgentJournal(new Journal(':memory:'));
(globalThis as { __zenithAgentJournal?: unknown }).__zenithAgentJournal = journal;

const WS = 'ws-scope';
const ADA = { id: 'scope-ada', name: 'Ada', email: 'ada@example.test' };
const BOB = { id: 'scope-bob', name: 'Bob', email: 'bob@example.test' };
const AT = new Date().toISOString();
const base = { subject: ADA.id, integrationId: 'cred_scope', workspaceId: WS,
  scopes: ['read', 'plan', 'write'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
const whole: Principal = { ...base, projectIds: [], allProjects: true };
let listed: Principal;

let projectA = '', projectB = '', envA = '', envA2 = '', serviceA = '', serviceB = '';
let refB = '';
const SECRET_B = 'project-b-credential-value';

const invoke = (name: string, args: Record<string, unknown>, who: Principal) =>
  runtime.invoke(name, args, who, { workspaceId: WS }, async () => who, ORIGIN) as Promise<Record<string, unknown>>;
let keys = 0;
const prepare = (args: Record<string, unknown>, who: Principal) =>
  invoke('zenith_prepare_change', { requestKey: `scope_${String(++keys).padStart(4, '0')}`, ...args }, who);
const approve = (op: Record<string, unknown>) => runtime.reviewOperation(BOB.id, WS, 'admin', String(op.id), String(op.digest), true);
const execute = (op: { id?: unknown }, who: Principal) => invoke('zenith_execute_operation', { operationId: op.id }, who);
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? (e as Error).name; } return 'resolved'; };
const adopt = (who: Principal, secretRef: string, key = 'DB_URL') =>
  prepare({ kind: 'system.edit', target: { workspaceId: WS, projectId: projectA }, edit: 'secret.adopt', parameters: { serviceId: serviceA, key, secretRef } }, who);
const operationsIn = async (who: Principal) => (await journal.list(who, 100, 0)).length;
const project = (id: string) => db().projects.find(p => p.id === id)!;

beforeAll(async () => {
  registerAllActions();
  resetDb();
  const data = db();
  data.workspaces.push({ id: WS, name: 'Scope', slug: 'scope', createdAt: AT });
  data.members.push({ id: ADA.id, workspaceId: WS, name: ADA.name, email: ADA.email, role: 'admin' },
    { id: BOB.id, workspaceId: WS, name: BOB.name, email: BOB.email, role: 'admin' });
  data.connections.push({ id: 'conn-scope', workspaceId: WS, provider: 'sandbox', label: 'Sandbox', region: 'local', status: 'healthy', grantedPermissions: [], createdAt: AT });
  save();
  const actor = { type: 'user' as const, id: ADA.id, name: ADA.name };
  const a = await runAction('project.applyBlueprint', { workspaceId: WS, actor }, { name: 'Alpha', blueprint: 'api-worker', connectionId: 'conn-scope' }, { mode: 'execute' });
  ({ projectId: projectA, environmentId: envA } = a.result?.data as { projectId: string; environmentId: string });
  const b = await runAction('project.applyBlueprint', { workspaceId: WS, actor }, { name: 'Bravo Secret Keeper', blueprint: 'api-worker', connectionId: 'conn-scope' }, { mode: 'execute' });
  projectB = (b.result?.data as { projectId: string }).projectId;
  const env2 = await runAction('env.create', { workspaceId: WS, projectId: projectA, actor }, { projectId: projectA, name: 'second', class: 'staging' }, { mode: 'execute' });
  envA2 = (env2.result?.data as { environmentId: string }).environmentId;

  serviceA = project(projectA).workingManifest.services[0].id;
  const svcB = project(projectB).workingManifest.services[0];
  serviceB = svcB.id;
  refB = vaultRef(projectB, serviceB, 'DB_URL');
  svcB.env.push({ key: 'DB_URL', secretRef: refB }, { key: 'LEGACY', secretRef: 'vault:LEGACY_B' },
    { key: 'SHARED', secretRef: 'vault:SHARED_AB' }, { key: 'EXTERNAL', secretRef: 'aws:bravo/db' });
  project(projectA).workingManifest.services[0].env.push({ key: 'SHARED', secretRef: 'vault:SHARED_AB' });
  putSecret(WS, refB, SECRET_B, 'Bob');
  putSecret(WS, 'vault:LEGACY_B', SECRET_B, 'Bob');
  putSecret(WS, 'vault:SHARED_AB', 'shared-value', 'Bob');
  save();
  listed = { ...base, projectIds: [projectA] };
}, 60_000);

afterAll(() => journal.close());

describe('M1: secret references outside the grant', () => {
  it("refuses another project's reference, a legacy one only it reads, and its external one, before planning", async () => {
    const before = await operationsIn(listed);
    for (const ref of [refB, 'vault:LEGACY_B', 'aws:bravo/db', vaultRef(projectB, 'svc-made-up', 'NEW')])
      expect(await code(adopt(listed, ref)), ref).toBe('scope_denied');
    expect(await operationsIn(listed)).toBe(before);
  });

  it('refuses the same reference inside a whole-manifest replacement', async () => {
    const manifest = structuredClone(project(projectA).workingManifest);
    manifest.services[0].env.push({ key: 'STOLEN', secretRef: refB });
    const args = { kind: 'manifest.replace', target: { workspaceId: WS, projectId: projectA }, manifest, expectedHash: contentHash(project(projectA).workingManifest) };
    expect(await code(prepare(args, listed))).toBe('scope_denied');
    // The same manifest without the foreign reference plans.
    manifest.services[0].env = manifest.services[0].env.filter(e => e.key !== 'STOLEN');
    expect((await prepare(args, listed)).phase).toBe('prepared');
  });

  it("allows the target's own references, external ones nobody else reads, and anything under a whole-workspace link", async () => {
    for (const ref of [vaultRef(projectA, serviceA, 'NEW_KEY'), 'aws:alpha/own'])
      expect((await adopt(listed, ref, 'OWN')).phase, ref).toBe('prepared');
    expect((await adopt(whole, refB, 'WIDE')).phase).toBe('prepared');
  });

  it("counts, and never names, another project's readers of a shared reference", async () => {
    const narrow = await adopt(listed, 'vault:SHARED_AB', 'ALSO_SHARED');
    expect(narrow.phase).toBe('prepared');
    const text = JSON.stringify(narrow.plan);
    expect(text).not.toContain('Bravo');
    expect(text).toContain('1 variable in projects this link cannot see');
    expect(text).not.toContain(SECRET_B);
    const wide = await adopt(whole, 'vault:SHARED_AB', 'ALSO_SHARED_WIDE');
    expect(JSON.stringify(wide.plan)).toContain('Bravo Secret Keeper');
  });

  it('refuses a forged approved row at execute, before it is claimed', async () => {
    const forged = await journal.prepare(listed, { action: 'system.setSecret', input: { projectId: projectA, serviceId: serviceA, key: 'FORGED', secretRef: refB },
      target: { workspaceId: WS, projectId: projectA }, fingerprint: 'x', plan: { kind: 'system.edit' }, requestKey: 'scope_forged_1' });
    await journal.review(forged.id, listed.subject, WS, forged.digest, true, BOB.id, 'admin');
    expect(await code(execute(forged, listed))).toBe('scope_denied');
    expect((await journal.get(listed, forged.id)).phase).toBe('approved');
    expect(project(projectA).workingManifest.services[0].env.some(e => e.key === 'FORGED')).toBe(false);
  });
});

describe('L2: environment narrowing on project-only targets', () => {
  let narrowed: Principal;
  let ruleOther = '', ruleMine = '';
  beforeAll(async () => {
    narrowed = { ...listed, environmentIds: [envA] };
    const actor = { type: 'user' as const, id: ADA.id, name: ADA.name };
    const rule = async (environmentId: string) => ((await runAction('alerts.createRule', { workspaceId: WS, projectId: projectA, environmentId, actor },
      { projectId: projectA, environmentId, kind: 'deploy_failed' }, { mode: 'execute' })).result?.data as { ruleId: string }).ruleId;
    ruleOther = await rule(envA2);
    ruleMine = await rule(envA);
    db().findings.push({ id: 'finding-wide', projectId: projectA, severity: 'low', title: 'Project-wide', detail: 'x', status: 'open', createdAt: AT } as never,
      { id: 'finding-mine', projectId: projectA, environmentId: envA, severity: 'low', title: 'Mine', detail: 'x', status: 'open', createdAt: AT } as never,
      { id: 'finding-other', projectId: projectA, environmentId: envA2, severity: 'low', title: 'Other', detail: 'x', status: 'open', createdAt: AT } as never);
    save();
  });
  const target = () => ({ workspaceId: WS, projectId: projectA });

  it("refuses another environment's rule and finding, and a project-wide finding", async () => {
    expect(await code(prepare({ kind: 'alerts.deleteRule', target: target(), ruleId: ruleOther }, narrowed))).toBe('not_found');
    expect(await code(prepare({ kind: 'alerts.updateRule', target: target(), ruleId: ruleOther, enabled: false }, narrowed))).toBe('not_found');
    expect(await code(prepare({ kind: 'finding.dismiss', target: target(), findingId: 'finding-other', reason: 'x' }, narrowed))).toBe('not_found');
    expect(await code(prepare({ kind: 'finding.dismiss', target: target(), findingId: 'finding-wide', reason: 'x' }, narrowed))).toBe('not_found');
  });

  it('still allows the granted environment, and everything without a narrowing', async () => {
    expect((await prepare({ kind: 'alerts.deleteRule', target: target(), ruleId: ruleMine }, narrowed)).phase).toBe('prepared');
    expect((await prepare({ kind: 'finding.dismiss', target: target(), findingId: 'finding-mine', reason: 'x' }, narrowed)).phase).toBe('prepared');
    expect((await prepare({ kind: 'alerts.deleteRule', target: target(), ruleId: ruleOther }, listed)).phase).toBe('prepared');
    expect((await prepare({ kind: 'finding.dismiss', target: target(), findingId: 'finding-wide', reason: 'x' }, listed)).phase).toBe('prepared');
  });
});

describe('L3: project quota at execute', () => {
  it('refuses an approved create once the workspace reached the quota, leaving it approved', async () => {
    const saved = process.env.ZENITH_AGENT_MAX_PROJECTS;
    try {
      delete process.env.ZENITH_AGENT_MAX_PROJECTS;
      const op = await prepare({ kind: 'project.create', target: { workspaceId: WS }, name: 'Over Quota' }, whole);
      expect(op.phase).toBe('prepared');
      await approve(op);
      const count = db().projects.filter(p => p.workspaceId === WS).length;
      process.env.ZENITH_AGENT_MAX_PROJECTS = String(count);
      expect(await code(execute(op, whole))).toBe('project_quota');
      expect(db().projects.filter(p => p.workspaceId === WS)).toHaveLength(count);
      expect((await journal.get(whole, String(op.id))).phase).toBe('approved');
      // With room again, the same approval dispatches and its own project does not fail it.
      process.env.ZENITH_AGENT_MAX_PROJECTS = String(count + 1);
      expect((await execute(op, whole)).phase).toBe('succeeded');
      expect(db().projects.filter(p => p.workspaceId === WS)).toHaveLength(count + 1);
    } finally {
      if (saved === undefined) delete process.env.ZENITH_AGENT_MAX_PROJECTS; else process.env.ZENITH_AGENT_MAX_PROJECTS = saved;
    }
  });
});
