/**
 * The reviewed-operation table: which prepared `kind` runs which action, at
 * which target level, with which arguments (PLAN3 §3.2).
 *
 * Three rules hold for every row, and the runtime relies on them:
 *
 *  1. **Scope comes from the target, never from the input.** `args` builds the
 *     action input from the parsed preparation and the *resolved* project and
 *     environment. No row copies a `projectId` or `environmentId` out of what
 *     the caller sent.
 *  2. **Every referenced object belongs to the target.** `owns` resolves each
 *     id the input names (connection, channel, rule, alert, finding,
 *     deployment) inside the target's workspace, project and environment, and
 *     answers `not_found` otherwise, with the same sentence for "absent" and
 *     "someone else's".
 *  3. **The fingerprint covers what the reviewer saw.** `state` is the
 *     per-kind state digested into the operation's fingerprint, on top of the
 *     workspace, member, manifest and environment the runtime always digests.
 *
 * Nothing here executes. The runtime plans, fingerprints, journals and
 * dispatches; this file only answers questions about one kind.
 */
import { db, q } from '@/lib/db/store';
import { channelsOf, findChannel } from '@/lib/alerts';
import { slugify } from '@/lib/importers/types';
import type { Environment, Project } from '@/lib/domain/types';
import { redact } from '../security';
import { ControlError, digest, type Principal } from './journal';
import type { EditKind, Preparation, PreparationKind } from './contracts';

export type OperationLevel = 'ws' | 'proj' | 'env';

/** The target, resolved and tenancy-checked by the runtime. */
export interface ResolvedTarget {
  workspaceId: string;
  project?: Project;
  environment?: Environment;
}

type Of<K extends PreparationKind> = Extract<Preparation, { kind: K }>;
/** A built action input, as `owns` and `state` read it. */
export type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

export interface OperationSpec<K extends PreparationKind = PreparationKind> {
  /** The registered action this kind dispatches. */
  action: string;
  level: OperationLevel;
  /** The credential scope execute needs. */
  scope: 'write' | 'publish';
  /** The action input. `projectId` / `environmentId` come from `r` only. */
  args(input: Of<K>, r: ResolvedTarget, who: Principal): Record<string, unknown>;
  /**
   * Refuse, with `not_found`, any referenced object outside the target. Takes
   * the built action input, so the runtime can run it again before dispatch.
   */
  owns?(args: Args, r: ResolvedTarget): void;
  /** Per-kind state for the fingerprint, from the action input. JSON-safe and secret-free. */
  state?(args: Args, r: ResolvedTarget): unknown;
  /** Result `data` fields `zenith_get_operation` may surface as evidence. */
  evidence?: readonly string[];
}

/* ---------------------------------- owns ---------------------------------- */

const notFound = (what: string): ControlError =>
  new ControlError('not_found', `No ${what} with that id is in this target. Read it again from Zenith and use an id from there.`, 404);

function ownConnection(r: ResolvedTarget, connectionId: string | undefined): void {
  if (connectionId === undefined) return;
  const conn = q.connection(connectionId);
  if (!conn || conn.workspaceId !== r.workspaceId) throw notFound('connection');
}
function ownChannel(r: ResolvedTarget, channelId: string): void {
  const channel = findChannel(channelId);
  if (!channel || channel.workspaceId !== r.workspaceId) throw notFound('alert channel');
}
function ownChannels(r: ResolvedTarget, channelIds: readonly string[] | undefined): void {
  if (!channelIds?.length) return;
  const mine = new Set(channelsOf(r.workspaceId).map(c => c.id));
  if (channelIds.some(id => !mine.has(id))) throw notFound('alert channel');
}
/** Project-owned records: same project, and the same environment when the target names one. */
function ownInProject(r: ResolvedTarget, row: { projectId: string; environmentId?: string } | undefined, what: string): void {
  if (!row || !r.project || row.projectId !== r.project.id
    || (r.environment && row.environmentId !== undefined && row.environmentId !== r.environment.id)) throw notFound(what);
}

/* ---------------------------------- state --------------------------------- */

/** A connection as the fingerprint sees it. `CloudConnection` holds no credential. */
const connectionState = (id: string | undefined) => {
  const c = id ? q.connection(id) : undefined;
  return c ? { id: c.id, provider: c.provider, label: c.label, region: c.region, status: c.status, workspaceId: c.workspaceId } : null;
};
/** Channel metadata only: never the target, never a secret reference. */
const channelState = (id: string) => {
  const c = findChannel(id);
  return c ? { id: c.id, kind: c.kind, name: c.name, enabled: c.enabled, workspaceId: c.workspaceId } : null;
};
const slugTaken = (workspaceId: string, wanted: string): boolean => {
  const slug = slugify(wanted, 'project');
  return db().projects.some(p => p.workspaceId === workspaceId && p.slug === slug);
};

/* ---------------------------------- table --------------------------------- */

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new ControlError('environment_required', `Choose ${what} explicitly.`, 400);
  return value;
};
const pid = (r: ResolvedTarget) => need(r.project, 'a project').id;
const eid = (r: ResolvedTarget) => need(r.environment, 'an environment').id;

const PROJECT_EVIDENCE = ['projectId', 'slug', 'environmentId'] as const;

type Table = { [K in PreparationKind]?: OperationSpec<K> };

export const OPERATIONS: Table = {
  /* workspace level */
  'project.create': {
    action: 'project.create', level: 'ws', scope: 'write',
    args: i => ({ name: i.name, slug: i.slug, withEnvironment: i.withEnvironment, connectionId: i.connectionId }),
    owns: (a, r) => ownConnection(r, str(a.connectionId)),
    state: (a, r) => ({ slugTaken: slugTaken(r.workspaceId, str(a.slug) ?? str(a.name) ?? ''), connection: connectionState(str(a.connectionId)) }),
    evidence: PROJECT_EVIDENCE,
  },
  'project.createFromCompose': {
    action: 'project.importCompose', level: 'ws', scope: 'write',
    args: i => ({ name: i.name, composeYaml: i.composeYaml, connectionId: i.connectionId }),
    owns: (a, r) => ownConnection(r, str(a.connectionId)),
    state: (a, r) => ({ slugTaken: slugTaken(r.workspaceId, str(a.name) ?? ''), connection: connectionState(str(a.connectionId)) }),
    evidence: PROJECT_EVIDENCE,
  },
  'project.createFromBlueprint': {
    action: 'project.applyBlueprint', level: 'ws', scope: 'write',
    args: i => ({ blueprint: i.blueprint, name: i.name, connectionId: i.connectionId }),
    owns: (a, r) => ownConnection(r, str(a.connectionId)),
    state: (a, r) => ({ slugTaken: slugTaken(r.workspaceId, str(a.name) ?? str(a.blueprint) ?? ''), connection: connectionState(str(a.connectionId)) }),
    evidence: [...PROJECT_EVIDENCE, 'blueprint'],
  },
  'workspace.rename': {
    action: 'workspace.rename', level: 'ws', scope: 'write',
    args: i => ({ name: i.name }),
    evidence: ['workspaceId', 'name'],
  },
  'connection.create': {
    action: 'connection.create', level: 'ws', scope: 'write',
    args: i => ({ provider: i.provider, label: i.label, region: i.region }),
    state: (_a, r) => ({ connections: db().connections.filter(c => c.workspaceId === r.workspaceId).map(c => c.id).sort() }),
    evidence: ['connectionId', 'status'],
  },
  'connection.check': {
    action: 'connection.check', level: 'ws', scope: 'write',
    args: i => ({ connectionId: i.connectionId }),
    owns: (a, r) => ownConnection(r, str(a.connectionId)),
    state: a => connectionState(str(a.connectionId)),
    evidence: ['connectionId', 'status'],
  },
  'connection.disconnect': {
    action: 'connection.disconnect', level: 'ws', scope: 'write',
    args: i => ({ connectionId: i.connectionId }),
    owns: (a, r) => ownConnection(r, str(a.connectionId)),
    state: a => ({ connection: connectionState(str(a.connectionId)), users: db().environments.filter(e => e.connectionId === str(a.connectionId)).map(e => e.id).sort() }),
    evidence: ['connectionId'],
  },
  'alerts.testChannel': {
    action: 'alerts.testChannel', level: 'ws', scope: 'write',
    args: i => ({ channelId: i.channelId }),
    owns: (a, r) => ownChannel(r, str(a.channelId) ?? ''),
    state: a => channelState(str(a.channelId) ?? ''),
    evidence: ['channelId'],
  },
  'alerts.deleteChannel': {
    action: 'alerts.deleteChannel', level: 'ws', scope: 'write',
    args: i => ({ channelId: i.channelId }),
    owns: (a, r) => ownChannel(r, str(a.channelId) ?? ''),
    state: a => channelState(str(a.channelId) ?? ''),
    evidence: ['channelId'],
  },
  'alerts.updateChannel': {
    action: 'alerts.updateChannel', level: 'ws', scope: 'write',
    args: i => ({ channelId: i.channelId, name: i.name, enabled: i.enabled }),
    owns: (a, r) => ownChannel(r, str(a.channelId) ?? ''),
    state: a => channelState(str(a.channelId) ?? ''),
    evidence: ['channelId', 'enabled'],
  },

  /* project level */
  'project.applyBlueprint': {
    action: 'project.applyBlueprint', level: 'proj', scope: 'write',
    args: (i, r) => ({ projectId: pid(r), blueprint: i.blueprint, connectionId: i.connectionId }),
    owns: (a, r) => ownConnection(r, str(a.connectionId)),
    evidence: ['projectId', 'blueprint'],
  },
  'project.importResources': {
    action: 'project.importResources', level: 'proj', scope: 'write',
    args: (i, r) => ({ projectId: pid(r), connectionId: i.connectionId, region: i.region, resources: i.resources.map(x => ({ externalRef: x.externalRef })) }),
    owns: (a, r) => ownConnection(r, str(a.connectionId)),
    state: a => connectionState(str(a.connectionId)),
    evidence: ['projectId', 'connectionId'],
  },
  'environment.create': {
    action: 'env.create', level: 'proj', scope: 'write',
    args: (i, r) => ({ projectId: pid(r), name: i.name, class: i.class, connectionId: i.connectionId, region: i.region,
      approvalRequired: i.approvalRequired, budgetUsdMonthly: i.budgetUsdMonthly }),
    owns: (a, r) => ownConnection(r, str(a.connectionId)),
    state: (a, r) => ({ connection: connectionState(str(a.connectionId)), environments: q.environmentsOf(pid(r)).map(e => e.name).sort() }),
    evidence: ['environmentId', 'name'],
  },
  'alerts.createRule': {
    action: 'alerts.createRule', level: 'proj', scope: 'write',
    args: (i, r) => ({ projectId: pid(r), environmentId: r.environment?.id, kind: i.alertKind, threshold: i.threshold, enabled: i.enabled, channelIds: i.channelIds }),
    owns: (a, r) => ownChannels(r, strs(a.channelIds)),
    state: (a, r) => ({ rules: db().alertRules.filter(x => x.projectId === pid(r)).map(x => x.id).sort(), channels: (strs(a.channelIds) ?? []).map(channelState) }),
    evidence: ['ruleId', 'environmentId'],
  },
  'alerts.updateRule': {
    action: 'alerts.updateRule', level: 'proj', scope: 'write',
    args: i => ({ ruleId: i.ruleId, threshold: i.threshold, enabled: i.enabled, channelIds: i.channelIds }),
    owns: (a, r) => { ownInProject(r, db().alertRules.find(x => x.id === a.ruleId), 'alert rule'); ownChannels(r, strs(a.channelIds)); },
    state: a => db().alertRules.find(x => x.id === a.ruleId) ?? null,
    evidence: ['ruleId', 'enabled'],
  },
  'alerts.deleteRule': {
    action: 'alerts.deleteRule', level: 'proj', scope: 'write',
    args: i => ({ ruleId: i.ruleId }),
    owns: (a, r) => ownInProject(r, db().alertRules.find(x => x.id === a.ruleId), 'alert rule'),
    state: a => db().alertRules.find(x => x.id === a.ruleId) ?? null,
    evidence: ['ruleId'],
  },
  'alerts.acknowledge': {
    action: 'alerts.acknowledge', level: 'proj', scope: 'write',
    args: i => ({ eventId: i.eventId, note: i.note }),
    owns: (a, r) => ownInProject(r, db().alertEvents.find(x => x.id === a.eventId), 'alert'),
    state: a => { const e = db().alertEvents.find(x => x.id === a.eventId); return e ? { id: e.id, resolvedAt: e.resolvedAt, acknowledgedAt: e.acknowledgedAt } : null; },
    evidence: ['eventId'],
  },
  'finding.dismiss': {
    action: 'security.dismissFinding', level: 'proj', scope: 'write',
    args: i => ({ findingId: i.findingId, reason: i.reason }),
    owns: (a, r) => ownInProject(r, db().findings.find(x => x.id === str(a.findingId)), 'finding'),
    state: a => findingState(str(a.findingId) ?? ''),
    evidence: ['findingId', 'status'],
  },
  'finding.reopen': {
    action: 'security.reopenFinding', level: 'proj', scope: 'write',
    args: i => ({ findingId: i.findingId }),
    owns: (a, r) => ownInProject(r, db().findings.find(x => x.id === str(a.findingId)), 'finding'),
    state: a => findingState(str(a.findingId) ?? ''),
    evidence: ['findingId', 'status'],
  },
  'finding.resolve': {
    action: 'security.resolveFinding', level: 'proj', scope: 'write',
    args: i => ({ findingId: i.findingId, applyFix: i.applyFix }),
    owns: (a, r) => ownInProject(r, db().findings.find(x => x.id === str(a.findingId)), 'finding'),
    state: a => findingState(str(a.findingId) ?? ''),
    evidence: ['findingId', 'status'],
  },
  // App ownership (grant + owner role) is the runtime's `ownedApp`, as for publish.
  'app.suspend': {
    action: 'app.suspend', level: 'proj', scope: 'publish',
    args: (i, _r, who) => ({ appId: i.appId, reason: i.reason, jobId: stableJobId(who, i.requestKey) }),
  },
  'app.resume': {
    action: 'app.resume', level: 'proj', scope: 'publish',
    args: (i, _r, who) => ({ appId: i.appId, reason: i.reason, jobId: stableJobId(who, i.requestKey) }),
  },

  /* environment level */
  'environment.clone': {
    action: 'env.clone', level: 'env', scope: 'write',
    args: (i, r) => ({ environmentId: eid(r), name: i.name }),
    state: (_a, r) => ({ environments: q.environmentsOf(pid(r)).map(e => e.name).sort() }),
    evidence: ['environmentId', 'name'],
  },
  'environment.update': {
    action: 'env.update', level: 'env', scope: 'write',
    args: (i, r) => ({ environmentId: eid(r), name: i.name, region: i.region }),
    state: (_a, r) => ({ environments: q.environmentsOf(pid(r)).map(e => e.name).sort() }),
    evidence: ['environmentId', 'name', 'region'],
  },
  'environment.setBudget': {
    action: 'env.setBudget', level: 'env', scope: 'write',
    args: (i, r) => ({ environmentId: eid(r), budgetUsdMonthly: i.budgetUsdMonthly }),
    evidence: ['environmentId', 'budgetUsdMonthly'],
  },
  'environment.setConnection': {
    action: 'env.setConnection', level: 'env', scope: 'write',
    args: (i, r) => ({ environmentId: eid(r), connectionId: i.connectionId }),
    owns: (a, r) => ownConnection(r, str(a.connectionId)),
    state: a => connectionState(str(a.connectionId)),
    evidence: ['environmentId', 'connectionId'],
  },
  'environment.tightenPolicies': {
    action: 'env.updatePolicies', level: 'env', scope: 'write',
    // Only the two literal values the schema admits can reach the action.
    args: (i, r) => ({ environmentId: eid(r), approvalRequired: i.approvalRequired, allowStatefulDeletion: i.allowStatefulDeletion }),
    evidence: ['environmentId'],
  },
  'deployment.cancel': {
    action: 'deploy.cancel', level: 'env', scope: 'write',
    args: i => ({ deploymentId: i.deploymentId }),
    owns: (a, r) => {
      const d = q.deployment(str(a.deploymentId) ?? '');
      if (!d || !r.project || !r.environment || d.projectId !== r.project.id || d.environmentId !== r.environment.id) throw notFound('deployment');
    },
    state: a => { const d = q.deployment(str(a.deploymentId) ?? ''); return d ? { id: d.id, status: d.status } : null; },
  },
  'ops.restart': {
    action: 'ops.restartService', level: 'env', scope: 'write',
    args: (i, r) => ({ projectId: pid(r), environmentId: eid(r), serviceId: i.serviceId }),
    evidence: ['serviceId', 'environmentId', 'simulated'],
  },
};

function findingState(id: string) {
  const f = db().findings.find(x => x.id === id);
  return f ? { id: f.id, status: f.status, severity: f.severity, fix: f.fix?.actionId ?? null } : null;
}

/** The spec for a kind, or undefined for the kinds the runtime handles itself. */
export const operationSpec = (kind: PreparationKind): OperationSpec | undefined =>
  OPERATIONS[kind] as OperationSpec | undefined;

/** Every action id the table dispatches. Part of the runtime's allow-list. */
export const OPERATION_ACTIONS: readonly string[] = [...new Set(Object.values(OPERATIONS).map(s => s!.action))];

/**
 * Actions that stay out of the allow-list no matter what. A person does these
 * in the browser (`zenith_get_handoff`); the agent never approves, deletes,
 * loosens a gate, or carries a secret value.
 */
export const EXCLUDED_ACTIONS = ['deploy.approve', 'project.delete', 'env.delete', 'workspace.setAutonomy',
  'alerts.createChannel', 'system.rotateSecret', 'ops.investigate'] as const;

/** Refuse a workspace-level kind for an explicit-list credential, before anything is persisted. */
export function requireWorkspaceScope(who: Principal): void {
  if (who.allProjects !== true)
    throw new ControlError('workspace_scope_required',
      'This change is workspace-level and this link covers only selected projects. Fix: re-link with Whole workspace — run `zenith login` and choose Whole workspace in the browser — or call zenith_get_handoff with task "relink".', 403);
}

/** `ZENITH_AGENT_MAX_PROJECTS`, default 50: the most projects an agent may bring a workspace to. */
export function maxAgentProjects(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ZENITH_AGENT_MAX_PROJECTS ?? 50);
  return Number.isSafeInteger(n) && n > 0 ? n : 50;
}
export function requireProjectQuota(workspaceId: string, env?: Record<string, string | undefined>): void {
  const max = maxAgentProjects(env);
  if (db().projects.filter(p => p.workspaceId === workspaceId).length >= max)
    throw new ControlError('project_quota', `This workspace already has ${max} or more projects, the most an agent may create. Delete one in the browser, or create it there yourself.`, 429);
}

/** A client-derived job id that is stable per request key, so a retried hosted admission is recognisable. */
export function stableJobId(who: Principal, requestKey: string): string {
  const h = digest({ workspace: who.workspaceId, subject: who.subject, requestKey });
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}

/* ---------------------------- env.set secret guard ------------------------- */

/** Keys that name a credential. `_URL$` because connection strings carry passwords. */
export const SECRET_LIKE_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|DSN|_URL$|AUTH)/i;

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...value].length;
  let bits = 0;
  for (const c of counts.values()) { const p = c / n; bits -= p * Math.log2(p); }
  return bits;
}

/**
 * Why this plain environment variable looks like a secret, or undefined.
 *
 * Best effort by design (PLAN3 §5): the real guard is the human review, which
 * shows the value in full. What this stops is the obvious case — a model
 * pasting a token into a manifest that is exported, diffed and audited.
 */
export function secretLikeReason(key: string, value: string): string | undefined {
  if (SECRET_LIKE_KEY.test(key)) return `the name "${key}" reads like a credential`;
  if (redact(value) !== value) return 'the value contains a token-shaped string';
  if (/:\/\/[^\s/@:]+:[^\s/@]+@/.test(value)) return 'the value is a URL with a password in it';
  if (value.length >= 24 && entropy(value) >= 3.5) return 'the value is long and random-looking';
  return undefined;
}

const SECRET_REFUSAL_FIX = 'Fix: a person sets secret values in the browser — call zenith_get_handoff with task "secret.set". To point a variable at a value already stored, use the secret.adopt edit with a secretRef.';

/** Parameter-level refusals for curated edits, before the action's schema sees them. */
export function refuseEditParameters(edit: EditKind, parameters: Record<string, unknown>): void {
  if ('secretValue' in parameters)
    throw new ControlError('secret_value_refused', `A secret value cannot be sent through an agent. ${SECRET_REFUSAL_FIX}`, 400);
  if (edit === 'env.set' && typeof parameters.value === 'string' && typeof parameters.key === 'string') {
    const reason = secretLikeReason(parameters.key, parameters.value);
    if (reason) throw new ControlError('secret_value_refused', `Refused: ${reason}. ${SECRET_REFUSAL_FIX}`, 400);
  }
  if (edit === 'secret.adopt' && (parameters.secretRef === undefined) === (parameters.moveExistingValue !== true))
    throw new ControlError('edit_input', 'secret.adopt takes exactly one of secretRef (an existing reference) or moveExistingValue: true.', 400);
}
