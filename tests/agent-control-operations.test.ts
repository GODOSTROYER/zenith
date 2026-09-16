/**
 * The reviewed-operation kinds of PLAN3 §3.2 and §3.3, through the runtime.
 *
 * Every case goes the whole way a linked agent goes: `invoke('zenith_prepare_change')`
 * → the browser review (`reviewOperation`, as a second, human admin) →
 * `invoke('zenith_execute_operation')` → the product store. The journal is an
 * in-memory SQLite journal, because the file journal refuses a non-POSIX
 * directory by design and this suite must run on Windows too.
 *
 * What is pinned here, beyond "it works":
 *  - a workspace-level kind on an explicit-list link is refused with
 *    `workspace_scope_required` and journals nothing;
 *  - every referenced id from another workspace is `not_found`;
 *  - scope comes from the target, never from the input;
 *  - no secret value can be proposed, and a policy cannot be loosened;
 *  - the excluded actions stay excluded even if a row is forged into the journal.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@/lib/agent-access/control/journal';
import { tempDataDir } from './_support/data-dir';

const DATA = tempDataDir('zenith-agent-ops-', { fast: true });
const ORIGIN = 'http://localhost:3400';
process.env.ZENITH_AGENT_CONTROL = '1';
process.env.ZENITH_AGENT_WRITES = '1';
process.env.ZENITH_AGENT_ORIGIN = ORIGIN;
process.env.ZENITH_SECRET_KEY = '7'.repeat(64);
delete process.env.ZENITH_STORE;

const { db, resetDb, save } = await import('@/lib/db/store');
const { runAction } = await import('@/lib/actions/core');
const { registerAllActions } = await import('@/lib/actions/defs');
const { Journal, SqliteAgentJournal } = await import('@/lib/agent-access/control/journal');
const runtime = await import('@/lib/agent-access/control/runtime');
const contracts = await import('@/lib/agent-access/control/contracts');
const operations = await import('@/lib/agent-access/control/operations');
const release = await import('@/lib/hosted/release');
const { runtimeDouble, buildRunnerDouble, usageDouble } = await import('./hosted/release/_doubles');
const artifacts = await import('@/lib/hosted/artifacts');

const journal = new SqliteAgentJournal(new Journal(':memory:'));
(globalThis as { __zenithAgentJournal?: unknown }).__zenithAgentJournal = journal;

const WS = 'ws-ops';
const OTHER = 'ws-foreign';
const ADA = { id: 'user-ada', name: 'Ada', email: 'ada@example.test' };
const BOB = { id: 'user-bob', name: 'Bob', email: 'bob@example.test' };
const AT = new Date().toISOString();

const base = {
  subject: ADA.id, integrationId: 'cred_ops', workspaceId: WS,
  scopes: ['read', 'plan', 'write', 'publish', 'logs'], expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const whole: Principal = { ...base, projectIds: [], allProjects: true };
let listed: Principal;

let projectId = '';
let environmentId = '';
let serviceId = '';
let foreignProject = '';

const invoke = (name: string, args: Record<string, unknown>, who: Principal = whole, selected: Record<string, string> = {}) =>
  runtime.invoke(name, args, who, { workspaceId: WS, ...selected }, async () => who, ORIGIN) as Promise<Record<string, unknown>>;

let keys = 0;
const key = (label: string) => `${label.replace(/[^A-Za-z0-9_-]/g, '_')}_${String(++keys).padStart(4, '0')}`;

/** A proposal, as the agent sends it. */
const prepare = (args: Record<string, unknown>, who: Principal = whole) =>
  invoke('zenith_prepare_change', { requestKey: key(String(args.kind)), ...args }, who);

/** The browser review, by a human admin who is not the agent's subject. */
const approve = async (op: Record<string, unknown>) =>
  runtime.reviewOperation(BOB.id, WS, 'admin', String(op.id), String(op.digest), true);

const execute = (op: { id?: unknown }, who: Principal = whole) =>
  invoke('zenith_execute_operation', { operationId: op.id }, who);

/** Prepare, review and execute; returns the finished operation view. */
async function run(args: Record<string, unknown>, who: Principal = whole) {
  const op = await prepare(args, who);
  expect(op.phase, JSON.stringify(op.plan)).toBe('prepared');
  expect((op.plan as { blocked?: string }).blocked, String((op.plan as { blocked?: string }).blocked)).toBeUndefined();
  await approve(op);
  const done = await execute(op, who);
  return done;
}
const ok = (done: Record<string, unknown>) => {
  expect(done.phase, JSON.stringify(done.result)).toBe('succeeded');
  return (done.result as { data?: Record<string, unknown> }).data ?? {};
};
const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? (error as Error).name; }
  return 'resolved';
};

const tgt = (extra: Record<string, string> = {}) => ({ workspaceId: WS, projectId, ...extra });
const envTgt = () => tgt({ environmentId });
const operationsIn = async (who: Principal) => (await journal.list(who, 100, 0)).length;

const store = new artifacts.FsArtifactStore(path.join(DATA, 'artifacts'));
let restoreDeps: (() => void) | undefined;

beforeAll(async () => {
  registerAllActions();
  resetDb();
  const data = db();
  data.workspaces.push({ id: WS, name: 'Operations', slug: 'operations', createdAt: AT });
  data.workspaces.push({ id: OTHER, name: 'Foreign', slug: 'foreign', createdAt: AT });
  data.members.push({ id: ADA.id, workspaceId: WS, name: ADA.name, email: ADA.email, role: 'admin' });
  data.members.push({ id: BOB.id, workspaceId: WS, name: BOB.name, email: BOB.email, role: 'admin' });
  data.members.push({ id: ADA.id, workspaceId: OTHER, name: ADA.name, email: ADA.email, role: 'viewer' });
  data.members.push({ id: 'user-zed', workspaceId: OTHER, name: 'Zed', email: 'zed@example.test', role: 'admin' });
  for (const [id, ws] of [['conn-ops', WS], ['conn-foreign', OTHER]] as const)
    data.connections.push({ id, workspaceId: ws, provider: 'sandbox', label: `Sandbox ${ws}`, region: 'local', status: 'healthy', grantedPermissions: [], createdAt: AT });
  save();

  const actor = { type: 'user' as const, id: ADA.id, name: ADA.name };
  const created = await runAction('project.applyBlueprint', { workspaceId: WS, actor }, { name: 'Ops App', blueprint: 'api-worker', connectionId: 'conn-ops' }, { mode: 'execute' });
  const out = created.result?.data as { projectId: string; environmentId: string };
  projectId = out.projectId; environmentId = out.environmentId;
  serviceId = db().projects.find(p => p.id === projectId)!.workingManifest.services[0].id;
  listed = { ...base, projectIds: [projectId] };

  const zed = { type: 'user' as const, id: 'user-zed', name: 'Zed' };
  const foreign = await runAction('project.create', { workspaceId: OTHER, actor: zed }, { name: 'Theirs', connectionId: 'conn-foreign' }, { mode: 'execute' });
  foreignProject = (foreign.result?.data as { projectId: string }).projectId;

  const runtimeFake = (await runtimeDouble({ store })).runtime;
  const build = (await buildRunnerDouble({})).runner;
  const usage = usageDouble();
  const grant = (appId: string, subject: string) => ({ id: `grant-${appId}`, appId, subject, email: `${subject}@example.test`,
    role: 'owner' as const, state: 'active' as const, grantedBy: subject, createdAt: AT, updatedAt: AT });
  restoreDeps = release.setReleaseDepsForTests({
    runtime: () => runtimeFake, buildRunner: () => build, artifactStore: () => store,
    recordUsage: usage.recordUsage as never, buildsPaused: async () => usage.buildsPaused(), appSchemaVersion: () => Promise.resolve(1),
    requireAppRole: async (appId, subject) => {
      if (subject !== ADA.id) throw new Error(`${subject} holds no owner grant`);
      return grant(appId, subject);
    },
    activeGrant: async (appId, subject) => (subject === ADA.id ? grant(appId, subject) : null),
  });
}, 60_000);

afterAll(async () => {
  restoreDeps?.();
  await release.resetReleaseDeps();
  await Promise.resolve(release.stopHostedJobRunner()).catch(() => undefined);
  journal.close();
  // `tempDataDir` removes DATA at exit; Windows still holds its handles here.
});

describe('the contract', () => {
  it('lists every new kind, edit and tool', () => {
    for (const kind of ['project.create', 'project.createFromCompose', 'project.createFromBlueprint', 'workspace.rename', 'connection.create',
      'connection.check', 'connection.disconnect', 'alerts.testChannel', 'alerts.deleteChannel', 'alerts.updateChannel', 'project.applyBlueprint',
      'project.importResources', 'environment.create', 'alerts.createRule', 'alerts.updateRule', 'alerts.deleteRule', 'alerts.acknowledge',
      'finding.dismiss', 'finding.reopen', 'finding.resolve', 'app.suspend', 'app.resume', 'environment.clone', 'environment.update',
      'environment.setBudget', 'environment.setConnection', 'environment.tightenPolicies', 'deployment.cancel', 'ops.restart'])
      expect(contracts.PREPARATION_KINDS).toContain(kind);
    expect(contracts.EDIT_KINDS.slice(-4)).toEqual(['env.set', 'secret.adopt', 'secret.remove', 'service.scale']);
    const prepareTool = contracts.controlTools.find(t => t.name === 'zenith_prepare_change')!;
    const schema = prepareTool.inputSchema as { properties: { kind: { enum: string[] }; target: { required: string[] } } };
    expect(schema.properties.kind.enum).toEqual([...contracts.PREPARATION_KINDS]);
    expect(schema.properties.target.required).toEqual(['workspaceId']);
  });

  it('keeps the excluded actions out of the allow-list and out of the schema', () => {
    for (const action of operations.EXCLUDED_ACTIONS) {
      expect(operations.OPERATION_ACTIONS).not.toContain(action);
      expect(Object.values(contracts.EDIT_ACTIONS)).not.toContain(action);
    }
    for (const kind of ['deploy.approve', 'project.delete', 'environment.delete', 'workspace.setAutonomy', 'alerts.createChannel', 'secret.rotate'])
      expect(contracts.preparationSchema.safeParse({ kind, target: { workspaceId: WS }, requestKey: 'request_0001' }).success).toBe(false);
  });

  it('cannot express loosening a policy', () => {
    const t = { workspaceId: WS, projectId: 'p', environmentId: 'e' };
    const parse = (extra: Record<string, unknown>) => contracts.preparationSchema.safeParse({ kind: 'environment.tightenPolicies', target: t, requestKey: 'request_0001', ...extra }).success;
    expect(parse({ approvalRequired: false })).toBe(false);
    expect(parse({ allowStatefulDeletion: true })).toBe(false);
    expect(parse({})).toBe(false);
    expect(parse({ approvalRequired: true })).toBe(true);
    expect(parse({ allowStatefulDeletion: false })).toBe(true);
  });

  it('takes an environment-level kind only with an environment, and a workspace-level kind only without a project', () => {
    const parse = (kind: string, target: Record<string, string>, extra: Record<string, unknown> = {}) =>
      contracts.preparationSchema.safeParse({ kind, target, requestKey: 'request_0001', ...extra }).success;
    expect(parse('ops.restart', { workspaceId: WS, projectId: 'p' }, { serviceId: 's' })).toBe(false);
    expect(parse('ops.restart', { workspaceId: WS, projectId: 'p', environmentId: 'e' }, { serviceId: 's' })).toBe(true);
    expect(parse('project.create', { workspaceId: WS, projectId: 'p' }, { name: 'x' })).toBe(false);
    expect(parse('project.create', { workspaceId: WS }, { name: 'x' })).toBe(true);
    // Scope fields are not inputs.
    expect(parse('environment.create', { workspaceId: WS, projectId: 'p' }, { name: 'x', class: 'sandbox', projectId: 'other' })).toBe(false);
  });

  it('flags secret-looking env values and leaves ordinary ones alone', () => {
    expect(operations.secretLikeReason('API_TOKEN', 'x')).toBeDefined();
    expect(operations.secretLikeReason('DATABASE_URL', 'postgres://db/app')).toBeDefined();
    expect(operations.secretLikeReason('UPSTREAM', 'postgres://user:hunter2@db/app')).toBeDefined();
    expect(operations.secretLikeReason('HEADER', 'Bearer abc.def')).toBeDefined();
    expect(operations.secretLikeReason('SEED', 'q8Zr2LkP0vXw9sTn4yBm7cJd')).toBeDefined();
    expect(operations.secretLikeReason('LOG_LEVEL', 'debug')).toBeUndefined();
    expect(operations.secretLikeReason('GREETING', 'hello hello hello hello hello')).toBeUndefined();
    expect(operations.secretLikeReason('NODE_ENV', 'production')).toBeUndefined();
  });
});

describe('scope', () => {
  it('refuses a workspace-level kind on an explicit-list link, before anything is journalled', async () => {
    const before = await operationsIn(listed);
    for (const args of [
      { kind: 'project.create', target: { workspaceId: WS }, name: 'Nope' },
      { kind: 'workspace.rename', target: { workspaceId: WS }, name: 'Nope' },
      { kind: 'connection.create', target: { workspaceId: WS }, provider: 'sandbox' },
    ]) expect(await code(prepare(args, listed))).toBe('workspace_scope_required');
    expect(await operationsIn(listed)).toBe(before);
    expect(await operationsIn(whole)).toBe(before);
    expect(await code(invoke('zenith_get_alerts', { target: { workspaceId: WS } }, listed))).toBe('workspace_scope_required');
  });

  it('refuses a workspace-level kind when the profile pins a project, even under a whole-workspace link', async () => {
    const op = invoke('zenith_prepare_change', { kind: 'workspace.rename', target: { workspaceId: WS }, name: 'Pinned', requestKey: key('pinned') }, whole, { projectId });
    expect(await code(op)).toBe('workspace_scope_required');
  });

  it('refuses another workspace, and a project of another workspace, under a whole-workspace link', async () => {
    expect(await code(prepare({ kind: 'workspace.rename', target: { workspaceId: OTHER }, name: 'Stolen' }))).toBe('scope_denied');
    expect(await code(prepare({ kind: 'environment.create', target: { workspaceId: WS, projectId: foreignProject }, name: 'x', class: 'sandbox' }))).toBe('not_found');
  });

  it('answers not_found for every referenced id that belongs to another workspace', async () => {
    const zed = { type: 'user' as const, id: 'user-zed', name: 'Zed' };
    const foreignEnv = db().environments.find(e => e.projectId === foreignProject)!;
    db().findings.push({ id: 'finding-foreign', projectId: foreignProject, severity: 'low', title: 'Theirs', detail: 'x', status: 'open', createdAt: AT } as never);
    const rule = await runAction('alerts.createRule', { workspaceId: OTHER, projectId: foreignProject, environmentId: foreignEnv.id, actor: zed }, { kind: 'deploy_failed' }, { mode: 'execute' });
    const ruleId = (rule.result?.data as { ruleId: string }).ruleId;
    db().alertEvents.push({ id: 'event-foreign', ruleId, projectId: foreignProject, environmentId: foreignEnv.id, firedAt: AT, summary: 'x', severity: 'low', detail: 'x', simulated: true } as never);
    const deploymentId = 'deployment-foreign';
    db().deployments.push({ id: deploymentId, projectId: foreignProject, environmentId: foreignEnv.id, status: 'awaiting_approval', steps: [], createdAt: AT } as never);
    save();

    const cases: Record<string, unknown>[] = [
      { kind: 'connection.check', target: { workspaceId: WS }, connectionId: 'conn-foreign' },
      { kind: 'connection.disconnect', target: { workspaceId: WS }, connectionId: 'conn-foreign' },
      { kind: 'project.create', target: { workspaceId: WS }, name: 'Uses theirs', connectionId: 'conn-foreign' },
      { kind: 'environment.create', target: tgt(), name: 'theirs', class: 'sandbox', connectionId: 'conn-foreign' },
      { kind: 'environment.setConnection', target: envTgt(), connectionId: 'conn-foreign' },
      { kind: 'project.importResources', target: tgt(), connectionId: 'conn-foreign', resources: [{ externalRef: 'x' }] },
      { kind: 'finding.dismiss', target: tgt(), findingId: 'finding-foreign', reason: 'mine now' },
      { kind: 'alerts.deleteRule', target: tgt(), ruleId },
      { kind: 'alerts.updateRule', target: tgt(), ruleId, enabled: false },
      { kind: 'alerts.acknowledge', target: tgt(), eventId: 'event-foreign' },
      { kind: 'deployment.cancel', target: envTgt(), deploymentId },
      { kind: 'alerts.deleteChannel', target: { workspaceId: WS }, channelId: 'channel-nowhere' },
    ];
    const before = await operationsIn(whole);
    for (const args of cases) expect(await code(prepare(args)), String(args.kind)).toBe('not_found');
    expect(await operationsIn(whole)).toBe(before);
  });
});

describe('secret values', () => {
  const edit = (edit: string, parameters: Record<string, unknown>) => prepare({ kind: 'system.edit', target: tgt(), edit, parameters });

  it('refuses secretValue on every edit, and secret-looking env.set', async () => {
    expect(await code(edit('secret.adopt', { serviceId, key: 'STRIPE_KEY', secretValue: 'sk_live_123' }))).toBe('secret_value_refused');
    expect(await code(edit('service.update', { serviceId, secretValue: 'x' }))).toBe('secret_value_refused');
    for (const [k, value] of [['API_TOKEN', 'abc'], ['UPSTREAM', 'https://u:p@example.com/'], ['SEED', 'q8Zr2LkP0vXw9sTn4yBm7cJd'], ['OPENAI', 'sk-proj-abcdefghijklmnopqrstuv']])
      expect(await code(edit('env.set', { serviceId, key: k, value })), k).toBe('secret_value_refused');
  });

  it('takes exactly one of secretRef and moveExistingValue', async () => {
    expect(await code(edit('secret.adopt', { serviceId, key: 'A_KEY' }))).toBe('edit_input');
    expect(await code(edit('secret.adopt', { serviceId, key: 'A_KEY', secretRef: 'vault:x', moveExistingValue: true }))).toBe('edit_input');
  });

  it('never advertises secretValue as an edit field', async () => {
    const fields = await invoke('zenith_get_edit_fields', {}) as { edits: { kind: string; fields: { name: string }[] }[] };
    expect(fields.edits.map(e => e.kind)).toEqual([...contracts.EDIT_KINDS]);
    for (const e of fields.edits) expect(e.fields.map(f => f.name)).not.toContain('secretValue');
    expect(fields.edits.find(e => e.kind === 'secret.adopt')!.fields.map(f => f.name)).toEqual(expect.arrayContaining(['serviceId', 'key', 'secretRef', 'moveExistingValue']));
  });

  it('runs the four value-less edits', async () => {
    ok(await run({ kind: 'system.edit', target: tgt(), edit: 'env.set', parameters: { serviceId, key: 'LOG_LEVEL', value: 'debug' } }));
    const service = () => db().projects.find(p => p.id === projectId)!.workingManifest.services.find(s => s.id === serviceId)!;
    expect(service().env.find(e => e.key === 'LOG_LEVEL')?.value).toBe('debug');
    ok(await run({ kind: 'system.edit', target: tgt(), edit: 'secret.adopt', parameters: { serviceId, key: 'LOG_LEVEL', moveExistingValue: true } }));
    const ref = service().env.find(e => e.key === 'LOG_LEVEL')?.secretRef;
    expect(ref).toMatch(/^vault:/);
    expect(service().env.find(e => e.key === 'LOG_LEVEL')?.value).toBeUndefined();
    const secrets = await invoke('zenith_list_secrets', { target: tgt() }) as { items: { ref: string; usedBy: unknown[] }[] };
    expect(secrets.items.find(s => s.ref === ref)?.usedBy).toHaveLength(1);
    expect(JSON.stringify(secrets)).not.toContain('debug');
    ok(await run({ kind: 'system.edit', target: tgt(), edit: 'secret.remove', parameters: { serviceId, key: 'LOG_LEVEL' } }));
    expect(service().env.find(e => e.key === 'LOG_LEVEL')).toBeUndefined();
    ok(await run({ kind: 'system.edit', target: tgt(), edit: 'service.scale', parameters: { serviceId, replicas: 3 } }));
    expect(service().replicas).toBe(3);
  });
});

describe('workspace-level operations', () => {
  it('creates one project for two identical requests, reports it, and can edit it straight away', async () => {
    const requestKey = key('create_once');
    const args = { kind: 'project.create', target: { workspaceId: WS }, name: 'Agent Made', requestKey };
    const first = await invoke('zenith_prepare_change', args);
    const again = await invoke('zenith_prepare_change', args);
    expect(again.id).toBe(first.id);
    expect((first.plan as { level?: string }).level).toBe('ws');
    await approve(first);
    const count = db().projects.filter(p => p.workspaceId === WS).length;
    const done = await execute(first);
    const replay = await execute(first);
    expect(replay.id).toBe(done.id);
    const data = ok(done);
    expect(db().projects.filter(p => p.workspaceId === WS)).toHaveLength(count + 1);

    const read = await invoke('zenith_get_operation', { operationId: first.id }) as { evidence: { projectId: string; slug: string; environmentId: string } };
    expect(read.evidence.projectId).toBe(data.projectId);
    expect(read.evidence.slug).toBe('agent-made');
    expect(read.evidence.environmentId).toBe(data.environmentId);

    const created = { workspaceId: WS, projectId: read.evidence.projectId };
    const edit = await prepare({ kind: 'system.edit', target: created, edit: 'service.add', parameters: { name: 'web', kind: 'web', image: 'nginx:1.27', port: 80 } });
    expect(edit.phase).toBe('prepared');
    // The explicit-list link cannot reach it.
    expect(await code(prepare({ kind: 'system.edit', target: created, edit: 'service.add', parameters: { name: 'web' } }, listed))).toBe('scope_denied');
  });

  it('refuses a project the quota does not allow', async () => {
    const saved = process.env.ZENITH_AGENT_MAX_PROJECTS;
    process.env.ZENITH_AGENT_MAX_PROJECTS = '1';
    try { expect(await code(prepare({ kind: 'project.create', target: { workspaceId: WS }, name: 'Too many' }))).toBe('project_quota'); }
    finally { if (saved === undefined) delete process.env.ZENITH_AGENT_MAX_PROJECTS; else process.env.ZENITH_AGENT_MAX_PROJECTS = saved; }
  });

  it('creates projects from compose and from a blueprint', async () => {
    const compose = ok(await run({ kind: 'project.createFromCompose', target: { workspaceId: WS }, name: 'Composed',
      composeYaml: 'services:\n  web:\n    image: nginx:1.27\n    ports: ["80:80"]\n' }));
    expect(db().projects.find(p => p.id === compose.projectId)?.workspaceId).toBe(WS);
    const blueprint = ok(await run({ kind: 'project.createFromBlueprint', target: { workspaceId: WS }, blueprint: 'api-worker', name: 'From Blueprint' }));
    expect(db().projects.find(p => p.id === blueprint.projectId)?.name).toBe('From Blueprint');
    const list = await invoke('zenith_list_blueprints', {}) as { items: { id: string }[] };
    expect(list.items.map(b => b.id)).toContain('api-worker');
  });

  it('renames the workspace, and creates, checks and disconnects a connection', async () => {
    ok(await run({ kind: 'workspace.rename', target: { workspaceId: WS }, name: 'Operations Renamed' }));
    expect(db().workspaces.find(w => w.id === WS)?.name).toBe('Operations Renamed');

    const created = await run({ kind: 'connection.create', target: { workspaceId: WS }, provider: 'sandbox', label: 'Second sandbox' });
    const connectionId = String(ok(created).connectionId);
    expect(db().connections.find(c => c.id === connectionId)?.workspaceId).toBe(WS);
    const evidence = (await invoke('zenith_get_operation', { operationId: created.id }) as { evidence: { connectionId: string } }).evidence;
    expect(evidence.connectionId).toBe(connectionId);
    ok(await run({ kind: 'connection.check', target: { workspaceId: WS }, connectionId }));
    ok(await run({ kind: 'connection.disconnect', target: { workspaceId: WS }, connectionId }));
    expect(db().connections.some(c => c.id === connectionId)).toBe(false);
  });

  it('updates and deletes an alert channel, and prepares a test send', async () => {
    const settings = db().settings as { alertChannels?: unknown[] };
    settings.alertChannels = [...(settings.alertChannels ?? []), { id: 'channel-ops', workspaceId: WS, kind: 'email', name: 'Ops mail',
      target: 'ops@example.test', enabled: true, createdBy: { type: 'user', id: ADA.id, name: ADA.name }, createdAt: AT }];
    save();
    const test = await prepare({ kind: 'alerts.testChannel', target: { workspaceId: WS }, channelId: 'channel-ops' });
    expect(test.phase).toBe('prepared');
    ok(await run({ kind: 'alerts.updateChannel', target: { workspaceId: WS }, channelId: 'channel-ops', name: 'Ops inbox', enabled: false }));
    const alerts = await invoke('zenith_get_alerts', { target: { workspaceId: WS } }) as { channels: { id: string; name: string; targetOrigin: unknown }[] };
    expect(alerts.channels.find(c => c.id === 'channel-ops')).toMatchObject({ name: 'Ops inbox', targetOrigin: null });
    expect(JSON.stringify(alerts)).not.toContain('ops@example.test');
    // A channel's target and secret are not proposable at all.
    expect(await code(prepare({ kind: 'alerts.updateChannel', target: { workspaceId: WS }, channelId: 'channel-ops', secret: 'y' }))).toBe('ZodError');
    ok(await run({ kind: 'alerts.deleteChannel', target: { workspaceId: WS }, channelId: 'channel-ops' }));
  });
});

describe('project-level operations', () => {
  it('applies a blueprint against the manifest hash it read', async () => {
    expect(await code(prepare({ kind: 'project.applyBlueprint', target: tgt(), blueprint: 'api-worker', expectedHash: '00000000' }))).toBe('stale_manifest');
    const manifest = await invoke('zenith_get_manifest', { projectId }, whole, { projectId }) as { workingManifestHash: string };
    ok(await run({ kind: 'project.applyBlueprint', target: tgt(), blueprint: 'api-worker', expectedHash: manifest.workingManifestHash }));
    serviceId = db().projects.find(p => p.id === projectId)!.workingManifest.services[0].id;
  });

  it('discovers and imports existing resources through the sandbox', async () => {
    const found = await invoke('zenith_discover_resources', { target: { workspaceId: WS }, connectionId: 'conn-ops' }) as { resources: { externalRef: string }[]; simulated: boolean };
    expect(found.resources.length).toBeGreaterThan(0);
    expect(await code(invoke('zenith_discover_resources', { target: { workspaceId: WS }, connectionId: 'conn-foreign' }))).toBe('not_found');
    const data = ok(await run({ kind: 'project.importResources', target: tgt(), connectionId: 'conn-ops', resources: [{ externalRef: found.resources[0].externalRef }] }));
    expect(data.projectId).toBe(projectId);
  });

  it('creates an environment in the target project only', async () => {
    const data = ok(await run({ kind: 'environment.create', target: tgt(), name: 'staging', class: 'staging', budgetUsdMonthly: 25 }));
    const env = db().environments.find(e => e.id === data.environmentId)!;
    expect(env.projectId).toBe(projectId);
    expect(env.class).toBe('staging');
  });

  it('creates, updates and deletes an alert rule, and acknowledges an alert', async () => {
    const rule = ok(await run({ kind: 'alerts.createRule', target: envTgt(), alertKind: 'deploy_failed' }));
    const ruleId = String(rule.ruleId);
    expect(db().alertRules.find(r => r.id === ruleId)).toMatchObject({ projectId, environmentId });
    ok(await run({ kind: 'alerts.updateRule', target: tgt(), ruleId, enabled: false }));
    expect(db().alertRules.find(r => r.id === ruleId)?.enabled).toBe(false);
    db().alertEvents.push({ id: 'event-ops', ruleId, projectId, environmentId, firedAt: AT, summary: 'Deploy failed', severity: 'high', detail: 'x', simulated: true } as never);
    save();
    ok(await run({ kind: 'alerts.acknowledge', target: tgt(), eventId: 'event-ops', note: 'on it' }));
    expect(db().alertEvents.find(e => e.id === 'event-ops')?.acknowledgedAt).toBeDefined();
    const alerts = await invoke('zenith_get_alerts', { target: tgt() }) as { rules: { id: string }[]; events: { id: string; acknowledged: boolean }[] };
    expect(alerts.rules.map(r => r.id)).toContain(ruleId);
    expect(alerts.events.find(e => e.id === 'event-ops')?.acknowledged).toBe(true);
    ok(await run({ kind: 'alerts.deleteRule', target: tgt(), ruleId }));
    expect(db().alertRules.some(r => r.id === ruleId)).toBe(false);
  });

  it('dismisses, reopens and resolves a finding', async () => {
    db().findings.push({ id: 'finding-ops', projectId, severity: 'medium', title: 'Open port', detail: 'x', status: 'open', createdAt: AT } as never);
    save();
    ok(await run({ kind: 'finding.dismiss', target: tgt(), findingId: 'finding-ops', reason: 'accepted risk' }));
    expect(db().findings.find(f => f.id === 'finding-ops')?.status).toBe('dismissed');
    ok(await run({ kind: 'finding.reopen', target: tgt(), findingId: 'finding-ops' }));
    expect(db().findings.find(f => f.id === 'finding-ops')?.status).toBe('open');
    ok(await run({ kind: 'finding.resolve', target: tgt(), findingId: 'finding-ops', applyFix: false }));
    expect(db().findings.find(f => f.id === 'finding-ops')?.status).not.toBe('open');
  });

  it('suspends and resumes an app the link reaches, and refuses one it does not', async () => {
    const actor = { type: 'user' as const, id: ADA.id, name: ADA.name };
    const created = await runAction('app.create', { workspaceId: WS, actor }, { name: 'Agent App', slug: 'agent-ops-app' }, { mode: 'execute' });
    expect(created.result?.ok, created.result?.error).toBe(true);
    const appId = (created.result?.data as { app: { id: string } }).app.id;
    expect(await code(prepare({ kind: 'app.suspend', target: tgt(), appId }, listed))).toBe('app_scope_denied');
    const apps = await invoke('zenith_list_apps', {}) as { items: { id: string; role: string }[] };
    expect(apps.items).toContainEqual(expect.objectContaining({ id: appId, role: 'owner' }));
    const suspended = ok(await run({ kind: 'app.suspend', target: tgt(), appId, reason: 'maintenance' }));
    expect(suspended.jobId).toBeDefined();
    const resume = await prepare({ kind: 'app.resume', target: tgt(), appId });
    expect(resume.phase).toBe('prepared');
  });
});

describe('environment-level operations', () => {
  it('clones, renames, budgets, re-points and tightens an environment', async () => {
    const clone = ok(await run({ kind: 'environment.clone', target: envTgt(), name: 'preview' }));
    const cloneTarget = tgt({ environmentId: String(clone.environmentId) });
    ok(await run({ kind: 'environment.update', target: cloneTarget, name: 'preview-two' }));
    expect(db().environments.find(e => e.id === clone.environmentId)?.name).toBe('preview-two');
    ok(await run({ kind: 'environment.setBudget', target: cloneTarget, budgetUsdMonthly: 40 }));
    expect(db().environments.find(e => e.id === clone.environmentId)?.policies.budgetUsdMonthly).toBe(40);
    db().connections.push({ id: 'conn-ops-2', workspaceId: WS, provider: 'sandbox', label: 'Sandbox two', region: 'local', status: 'healthy', grantedPermissions: [], createdAt: AT });
    save();
    ok(await run({ kind: 'environment.setConnection', target: cloneTarget, connectionId: 'conn-ops-2' }));
    expect(db().environments.find(e => e.id === clone.environmentId)?.connectionId).toBe('conn-ops-2');
    ok(await run({ kind: 'environment.tightenPolicies', target: cloneTarget, approvalRequired: true, allowStatefulDeletion: false }));
    expect(db().environments.find(e => e.id === clone.environmentId)?.policies).toMatchObject({ approvalRequired: true, allowStatefulDeletion: false });
  });

  it('cancels a deployment of the target environment, and restarts a service', async () => {
    const env = db().environments.find(e => e.id === environmentId)!;
    env.policies.approvalRequired = true;
    save();
    const actor = { type: 'user' as const, id: BOB.id, name: BOB.name };
    const deploy = await runAction('deploy.apply', { workspaceId: WS, projectId, environmentId, actor }, { projectId, environmentId }, { mode: 'execute' });
    const deploymentId = String((deploy.result?.data as { deploymentId: string }).deploymentId);
    expect(db().deployments.find(d => d.id === deploymentId)?.status).toBe('awaiting_approval');
    const op = await prepare({ kind: 'deployment.cancel', target: envTgt(), deploymentId });
    // An approval-gated environment needs an admin reviewer, whatever the action's own role.
    expect((op.plan as { approvalRole: string }).approvalRole).toBe('admin');
    await approve(op);
    ok(await execute(op));
    expect(db().deployments.find(d => d.id === deploymentId)?.status).toBe('cancelled');

    const restart = await run({ kind: 'ops.restart', target: envTgt(), serviceId });
    expect(['succeeded', 'failed']).toContain(restart.phase);
    expect((restart.result as { summary: string }).summary).toMatch(/restart|not running/i);
  });
});

describe('the allow-list at dispatch', () => {
  it('refuses a forged journal row for an excluded action, even when approved', async () => {
    for (const action of ['project.delete', 'deploy.approve', 'system.rotateSecret']) {
      const forged = await journal.prepare(whole, { action, input: { projectId }, target: tgt(), fingerprint: 'x', plan: {}, requestKey: key(`forged_${action}`) });
      await journal.review(forged.id, whole.subject, WS, forged.digest, true, BOB.id, 'admin');
      expect(await code(execute(forged)), action).toBe('capability_unavailable');
    }
    expect(db().projects.some(p => p.id === projectId)).toBe(true);
  });

  it('refuses a forged row whose action does not match its kind', async () => {
    const forged = await journal.prepare(whole, { action: 'env.updatePolicies', input: { environmentId, approvalRequired: false }, target: envTgt(),
      fingerprint: 'x', plan: { kind: 'environment.setBudget' }, requestKey: key('forged_kind') });
    await journal.review(forged.id, whole.subject, WS, forged.digest, true, BOB.id, 'admin');
    expect(await code(execute(forged))).toBe('capability_unavailable');
  });
});

describe('capabilities', () => {
  it('reports the preparation kinds and the scope mode', async () => {
    const wide = await invoke('zenith_get_capabilities', {}) as { preparationKinds: string[]; scopeMode: string; tools: { name: string }[] };
    expect(wide.preparationKinds).toEqual([...contracts.PREPARATION_KINDS]);
    expect(wide.scopeMode).toBe('workspace');
    expect((await invoke('zenith_get_capabilities', {}, listed) as { scopeMode: string }).scopeMode).toBe('projects');
  });

  it('lists the new tools by scope', () => {
    const names = (who: Principal) => runtime.catalog(who).map(t => t.name);
    for (const tool of ['zenith_list_workspaces', 'zenith_get_workspace', 'zenith_list_blueprints', 'zenith_list_secrets', 'zenith_get_alerts',
      'zenith_get_audit', 'zenith_investigate', 'zenith_get_health', 'zenith_discover_resources', 'zenith_list_apps', 'zenith_get_handoff'])
      expect(names({ ...whole, scopes: ['read'] })).toContain(tool);
    expect(names({ ...whole, scopes: ['read'] })).not.toContain('zenith_get_service_logs');
    expect(names({ ...whole, scopes: ['read', 'logs'] })).toContain('zenith_get_service_logs');
    expect(names({ ...whole, scopes: ['read'] })).not.toContain('zenith_prepare_change');
  });
});
