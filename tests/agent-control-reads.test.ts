/**
 * The control plane's reads (PLAN3 §3.5), through `runtime.invoke`.
 *
 * Each read is checked for what it shows and, as much, for what it must not:
 * no secret value, no member details beyond a count, no channel target, no
 * other tenant's rows, and nothing written by a read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@/lib/agent-access/control/journal';
import { tempDataDir } from './_support/data-dir';

tempDataDir('zenith-agent-reads-', { fast: true });
const ORIGIN = 'http://localhost:3400';
process.env.ZENITH_AGENT_CONTROL = '1';
process.env.ZENITH_AGENT_WRITES = '1';
process.env.ZENITH_AGENT_ORIGIN = ORIGIN;
process.env.ZENITH_SECRET_KEY = '8'.repeat(64);
delete process.env.ZENITH_STORE;

const { db, resetDb, save, readAudit } = await import('@/lib/db/store');
const { runAction } = await import('@/lib/actions/core');
const { registerAllActions } = await import('@/lib/actions/defs');
const { putSecret } = await import('@/lib/secrets');
const { Journal, SqliteAgentJournal } = await import('@/lib/agent-access/control/journal');
const runtime = await import('@/lib/agent-access/control/runtime');

const journal = new SqliteAgentJournal(new Journal(':memory:'));
(globalThis as { __zenithAgentJournal?: unknown }).__zenithAgentJournal = journal;

const WS = 'ws-reads';
const OTHER = 'ws-reads-other';
const ADA = { id: 'reader-ada', name: 'Ada', email: 'ada@example.test' };
const AT = new Date().toISOString();
const base = { subject: ADA.id, integrationId: 'cred_reads', workspaceId: WS, scopes: ['read', 'plan', 'logs'],
  expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
const whole: Principal = { ...base, projectIds: [], allProjects: true };
let listed: Principal;
let projectId = '';
let otherProject = '';
let environmentId = '';
let serviceId = '';

const invoke = (name: string, args: Record<string, unknown> = {}, who: Principal = whole) =>
  runtime.invoke(name, args, who, { workspaceId: WS }, async () => who, ORIGIN) as Promise<Record<string, unknown>>;
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? (e as Error).name; } return 'resolved'; };
const tgt = (extra: Record<string, string> = {}) => ({ workspaceId: WS, projectId, ...extra });

beforeAll(async () => {
  registerAllActions();
  resetDb();
  const data = db();
  data.workspaces.push({ id: WS, name: 'Reads', slug: 'reads', createdAt: AT }, { id: OTHER, name: 'Elsewhere', slug: 'elsewhere', createdAt: AT });
  data.members.push({ id: ADA.id, workspaceId: WS, name: ADA.name, email: ADA.email, role: 'editor' },
    { id: 'reader-bob', workspaceId: WS, name: 'Bob', email: 'bob-private@example.test', role: 'admin' },
    { id: ADA.id, workspaceId: OTHER, name: ADA.name, email: ADA.email, role: 'viewer' });
  data.connections.push({ id: 'conn-reads', workspaceId: WS, provider: 'sandbox', label: 'Sandbox', region: 'local', status: 'healthy', grantedPermissions: [], createdAt: AT },
    { id: 'conn-unused', workspaceId: WS, provider: 'localstack', label: 'Unused', region: 'us-east-1', status: 'healthy', grantedPermissions: [], createdAt: AT });
  save();
  const actor = { type: 'user' as const, id: ADA.id, name: ADA.name };
  const a = await runAction('project.applyBlueprint', { workspaceId: WS, actor }, { name: 'Read One', blueprint: 'api-worker', connectionId: 'conn-reads' }, { mode: 'execute' });
  ({ projectId, environmentId } = a.result?.data as { projectId: string; environmentId: string });
  const b = await runAction('project.create', { workspaceId: WS, actor }, { name: 'Read Two', withEnvironment: false }, { mode: 'execute' });
  otherProject = (b.result?.data as { projectId: string }).projectId;
  const project = db().projects.find(p => p.id === projectId)!;
  serviceId = project.workingManifest.services[0].id;
  project.workingManifest.services[0].env.push({ key: 'PAYMENT_KEY', secretRef: 'vault:shared/PAYMENT_KEY' });
  putSecret(WS, 'vault:shared/PAYMENT_KEY', 'super-secret-value-1', 'Ada');
  putSecret(WS, 'vault:orphan/UNUSED', 'another-secret-value', 'Ada');
  await runAction('deploy.apply', { workspaceId: WS, projectId, environmentId, actor }, { projectId, environmentId }, { mode: 'execute' });
  (db().settings as { alertChannels?: unknown[] }).alertChannels = [
    { id: 'ch-hook', workspaceId: WS, kind: 'webhook', name: 'Hook', target: 'https://hooks.example.test/', enabled: true, createdBy: actor, createdAt: AT },
    { id: 'ch-mail', workspaceId: WS, kind: 'email', name: 'Mail', target: 'oncall-private@example.test', enabled: true, createdBy: actor, createdAt: AT },
  ];
  save();
  listed = { ...base, projectIds: [projectId] };
}, 60_000);

describe('workspace reads', () => {
  it('lists memberships with a relink command for the others', async () => {
    const { items } = await invoke('zenith_list_workspaces') as { items: { id: string; current: boolean; role: string; relink?: string }[] };
    expect(items).toContainEqual({ id: WS, name: 'Reads', role: 'editor', current: true });
    expect(items).toContainEqual({ id: OTHER, name: 'Elsewhere', role: 'viewer', current: false, relink: `zenith login --workspace ${OTHER}` });
  });

  it('shows the workspace without member details, narrowed for an explicit list', async () => {
    const wide = await invoke('zenith_get_workspace');
    expect(wide).toMatchObject({ id: WS, role: 'editor', scopeMode: 'workspace', projectCount: 2, memberCount: 2 });
    expect((wide.connections as { id: string }[]).map(c => c.id).sort()).toEqual(['conn-reads', 'conn-unused']);
    expect(JSON.stringify(wide)).not.toContain('bob-private');
    const narrow = await invoke('zenith_get_workspace', {}, listed);
    expect(narrow).toMatchObject({ scopeMode: 'projects', projectCount: 1 });
    expect(narrow.memberCount).toBeUndefined();
    expect((narrow.connections as { id: string }[]).map(c => c.id)).toEqual(['conn-reads']);
  });

  it('lists blueprints with an estimated cost', async () => {
    const { items } = await invoke('zenith_list_blueprints') as { items: { id: string; monthlyUsd: number }[] };
    expect(items.length).toBeGreaterThan(1);
    expect(items.every(b => typeof b.monthlyUsd === 'number')).toBe(true);
  });
});

describe('secrets', () => {
  it('lists references and users, never a value', async () => {
    const all = await invoke('zenith_list_secrets');
    expect((all.items as { ref: string }[]).map(s => s.ref).sort()).toEqual(['vault:orphan/UNUSED', 'vault:shared/PAYMENT_KEY']);
    expect(JSON.stringify(all)).not.toMatch(/super-secret|another-secret/);
    const used = (all.items as { ref: string; usedBy: { serviceId: string; key: string }[] }[]).find(s => s.ref === 'vault:shared/PAYMENT_KEY')!;
    expect(used.usedBy).toEqual([expect.objectContaining({ projectId, serviceId, key: 'PAYMENT_KEY' })]);
  });

  it('hides unused references from an explicit-list link', async () => {
    const narrow = await invoke('zenith_list_secrets', {}, listed);
    expect((narrow.items as { ref: string }[]).map(s => s.ref)).toEqual(['vault:shared/PAYMENT_KEY']);
    const scoped = await invoke('zenith_list_secrets', { target: { workspaceId: WS, projectId: otherProject } });
    expect(scoped.items).toEqual([]);
  });
});

describe('project and environment reads', () => {
  it('reads alerts metadata without a channel target', async () => {
    const alerts = await invoke('zenith_get_alerts', { target: tgt() });
    expect(alerts.channels).toEqual([
      { id: 'ch-hook', kind: 'webhook', name: 'Hook', enabled: true, targetOrigin: 'https://hooks.example.test' },
      { id: 'ch-mail', kind: 'email', name: 'Mail', enabled: true, targetOrigin: null },
    ]);
    expect(JSON.stringify(alerts)).not.toContain('oncall-private');
    expect(await code(invoke('zenith_get_alerts', { target: { workspaceId: OTHER } }))).toBe('scope_denied');
  });

  it('reads a redacted audit page for a project, and refuses one outside the grant', async () => {
    const page = await invoke('zenith_get_audit', { target: tgt(), limit: 5 }) as { events: Record<string, unknown>[] };
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every(e => !('input' in e))).toBe(true);
    expect(await code(invoke('zenith_get_audit', { target: { workspaceId: WS, projectId: otherProject } }, listed))).toBe('scope_denied');
  });

  it('investigates without writing an audit row', async () => {
    const before = readAudit({}).length;
    const result = await invoke('zenith_investigate', { target: tgt({ environmentId }) });
    expect(result).toMatchObject({ changedNothing: true, healthIsSimulated: true });
    expect(readAudit({}).length).toBe(before);
  });

  it('reads simulated health and service logs for an environment', async () => {
    const health = await invoke('zenith_get_health', { target: tgt({ environmentId }) });
    expect(health).toMatchObject({ environmentId, simulated: true });
    expect(await code(invoke('zenith_get_health', { target: tgt() }))).toBe('environment_required');
    const logs = await invoke('zenith_get_service_logs', { target: tgt({ environmentId }), serviceId, limit: 5 });
    expect(logs).toMatchObject({ serviceId, simulated: true });
    expect((logs.events as unknown[]).length).toBeLessThanOrEqual(5);
    expect(await code(invoke('zenith_get_service_logs', { target: tgt({ environmentId }), serviceId: 'nope' }))).toBe('not_found');
    expect(await code(invoke('zenith_get_service_logs', { target: tgt({ environmentId }), serviceId }, { ...whole, scopes: ['read'] }))).toBe('capability_unavailable');
  });

  it('discovers only through sandbox and LocalStack, and only for a whole-workspace link', async () => {
    expect(await code(invoke('zenith_discover_resources', { target: { workspaceId: WS }, connectionId: 'conn-reads' }, listed))).toBe('workspace_scope_required');
    const found = await invoke('zenith_discover_resources', { target: { workspaceId: WS }, connectionId: 'conn-reads' });
    expect(found.simulated).toBe(true);
  });
});

describe('hand-offs', () => {
  it('formats a hand-off from grant-checked ids only', async () => {
    const h = await invoke('zenith_get_handoff', { task: 'members' });
    expect(String(h.url).startsWith(ORIGIN)).toBe(true);
    expect(h.agentMayNotDoThis).toBe(true);
    expect(await code(invoke('zenith_get_handoff', { task: 'project.delete', target: { workspaceId: WS, projectId: otherProject } }, listed))).toBe('scope_denied');
    expect(await code(invoke('zenith_get_handoff', { task: 'deploy.approve', target: tgt() }))).toBe('invalid_input');
    expect(await code(invoke('zenith_get_handoff', { task: 'deploy.approve', target: tgt(), deploymentId: 'dep-nowhere' }))).toBe('not_found');
    expect(await code(invoke('zenith_get_handoff', { task: 'operation.review', operationId: 'op_missing' }))).toBe('operation_not_found');
    expect(await code(invoke('zenith_get_handoff', { task: 'workspace.create', name: 'https://evil.test/x?y' }))).toBe('ZodError');
    expect(await code(invoke('zenith_get_handoff', { task: 'secret.value' }))).toBe('ZodError');
  });
});

describe('grant predicates', () => {
  it('leaves no bare projectIds.includes( in the files this packet owns', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/agent-access/control');
    // boundary.ts and browser.ts belong to the link packet, which carries the same test for them.
    for (const file of ['runtime.ts', 'operations.ts', 'reads.ts', 'contracts.ts', 'journal.ts', 'journal-pg.ts', 'advance.ts'])
      expect(fs.readFileSync(path.join(dir, file), 'utf8'), file).not.toMatch(/projectIds\.includes\(|appIds\?\.includes\(/);
  });
});
