/**
 * What a person reads before approving one agent proposal.
 *
 * `operationView` never returns the stored action input (it is digested, not
 * shown to the agent again). The browser review screen still has to show the
 * exact request — which project a `project.create` makes, which key and value
 * an `env.set` writes — so this projects the input into labelled lines, with
 * every id resolved to a name inside the reviewer's own workspace.
 *
 * Only the signed-in review screen calls this. Nothing credential-shaped is
 * ever projected: a secret value, a channel URL or a signing secret has no
 * field here, and the caller still runs the whole response through `redact()`.
 */
import type { Database } from '@/lib/db/types';
import type { AlertChannel, Project } from '@/lib/domain/types';
import { parseVaultRef } from '@/lib/secrets/refs';
import type { Operation } from './journal';

/** `text`, not `value`: `redact()` blanks every key named `value`, and this line is meant to be read. */
export interface ReviewField { label: string; text: string; mono?: boolean }
export interface ReviewDisplay {
  /** The proposal kind as the agent named it (`project.create`, `system.edit`, …). */
  kind: string;
  /** What the change does, in a few words. */
  title: string;
  level: 'workspace' | 'project' | 'environment';
  workspace: { id: string; name: string };
  project?: { id: string; name: string; slug: string };
  environment?: { id: string; name: string };
  /** The request, one labelled line per parameter. */
  fields: ReviewField[];
  /** A project the dispatched operation created, once it has succeeded. */
  created?: { projectId: string; name: string; slug: string; environmentId?: string; href: string };
}

type Input = Record<string, unknown>;

/** Titles by action id; a few depend on whether the target names a project. */
const TITLES: Record<string, string | ((projectLevel: boolean) => string)> = {
  'project.create': 'Create a project',
  'project.importCompose': (p) => (p ? 'Import a Compose file into this project' : 'Create a project from a Compose file'),
  'project.applyBlueprint': (p) => (p ? 'Apply a blueprint to this project' : 'Create a project from a blueprint'),
  'project.importResources': 'Import existing cloud resources',
  'project.updateManifest': 'Replace the whole manifest',
  'workspace.rename': 'Rename the workspace',
  'connection.create': 'Add a provider connection',
  'connection.check': 'Check a provider connection',
  'connection.disconnect': 'Disconnect a provider connection',
  'alerts.createRule': 'Create an alert rule',
  'alerts.updateRule': 'Change an alert rule',
  'alerts.deleteRule': 'Delete an alert rule',
  'alerts.acknowledge': 'Acknowledge an alert',
  'alerts.testChannel': 'Send a test message to an alert channel',
  'alerts.deleteChannel': 'Delete an alert channel',
  'alerts.updateChannel': 'Rename or switch an alert channel',
  'security.dismissFinding': 'Dismiss a security finding',
  'security.reopenFinding': 'Reopen a security finding',
  'security.resolveFinding': 'Resolve a security finding',
  'app.create': 'Create a hosted app',
  'app.publish': 'Publish a hosted app release',
  'app.rollback': 'Roll back a hosted app',
  'app.suspend': 'Suspend a hosted app',
  'app.resume': 'Resume a hosted app',
  'env.create': 'Create an environment',
  'env.clone': 'Clone this environment',
  'env.update': 'Rename or move this environment',
  'env.setBudget': 'Set the monthly budget',
  'env.setConnection': 'Move this environment to another connection',
  'env.updatePolicies': 'Tighten this environment’s policies',
  'deploy.apply': 'Deploy the working copy',
  'deploy.rollback': 'Roll back to an earlier revision',
  'deploy.promote': 'Promote a revision from another environment',
  'deploy.cancel': 'Cancel a deployment',
  'ops.restartService': 'Restart a service',
  'ops.scaleService': 'Scale a service',
  'system.setEnvVar': 'Set an environment variable',
  'system.setSecret': 'Use a stored secret',
  'system.removeSecret': 'Remove a secret',
};

/** Never shown: scope comes from the target, and the rest is plumbing or a credential. */
const HIDDEN = new Set(['projectId', 'workspaceId', 'environmentId', 'jobId', 'idempotencyKey', 'requestKey',
  'secretValue', 'secret', 'target', 'url', 'webhookUrl', 'token', 'password', 'uploadId', 'sha256']);

const LABELS: Record<string, string> = {
  name: 'Name', slug: 'URL slug', withEnvironment: 'Also create an environment', connectionId: 'Connection',
  blueprint: 'Blueprint', region: 'Region', resources: 'Resources', class: 'Class', approvalRequired: 'Approval required',
  allowStatefulDeletion: 'Allow deleting stateful resources', budgetUsdMonthly: 'Monthly budget (USD)',
  deploymentId: 'Deployment', serviceId: 'Service', findingId: 'Finding', reason: 'Reason', applyFix: 'Apply the suggested fix',
  eventId: 'Alert', note: 'Note', ruleId: 'Rule', kind: 'Alert kind', threshold: 'Threshold', enabled: 'Enabled',
  channelIds: 'Channels', channelId: 'Channel', provider: 'Provider', label: 'Label', key: 'Key', value: 'Value',
  secretRef: 'Secret reference', moveExistingValue: 'Move the current value into the secret store', replicas: 'Replicas',
  size: 'Size', appId: 'App', releaseId: 'Release', revisionId: 'Revision', toRevisionId: 'Revision',
  sourceEnvironmentId: 'From environment', message: 'Message', composeYaml: 'Compose file', manifest: 'Manifest',
  expectedHash: 'Based on manifest', policies: 'Policies',
};

const MAX_VALUE = 500;
const clip = (text: string) => (text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}… (${text.length} characters)` : text);
const humanize = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const named = (name: string | undefined, id: string) => (name ? `${name} (${id})` : id);

function channels(data: Database, workspaceId: string): AlertChannel[] {
  const list = (data.settings as { alertChannels?: AlertChannel[] }).alertChannels;
  return Array.isArray(list) ? list.filter((c) => c.workspaceId === workspaceId) : [];
}

function describeValue(key: string, value: unknown, ctx: { data: Database; workspaceId: string; project?: Project }): ReviewField | undefined {
  const { data, workspaceId, project } = ctx;
  const label = LABELS[key] ?? humanize(key);
  if (value === undefined || value === null) return key === 'value' ? { label, text: '(removed)' } : undefined;
  const text = (v: string, mono = true): ReviewField => ({ label, text: clip(v), mono });
  if (typeof value === 'boolean') return { label, text: value ? 'yes' : 'no' };
  if (typeof value === 'number') return { label, text: String(value) };
  if (typeof value === 'string') {
    const projects = new Set(data.projects.filter((p) => p.workspaceId === workspaceId).map((p) => p.id));
    switch (key) {
      case 'serviceId':
        return text(named(project?.workingManifest.services.find((s) => s.id === value)?.name, value));
      case 'connectionId': {
        const c = data.connections.find((x) => x.id === value && x.workspaceId === workspaceId);
        return text(named(c ? `${c.label} · ${c.provider}` : undefined, value));
      }
      case 'channelId':
        return text(named(channels(data, workspaceId).find((c) => c.id === value)?.name, value));
      case 'ruleId': {
        const r = data.alertRules.find((x) => x.id === value && projects.has(x.projectId));
        return text(named(r?.kind, value));
      }
      case 'eventId':
        return text(named(data.alertEvents.find((x) => x.id === value && projects.has(x.projectId))?.summary, value));
      case 'findingId':
        return text(named(data.findings.find((x) => x.id === value && projects.has(x.projectId))?.title, value));
      case 'deploymentId':
        return text(named(data.deployments.find((x) => x.id === value && projects.has(x.projectId))?.changeSummary, value));
      case 'sourceEnvironmentId':
        return text(named(data.environments.find((x) => x.id === value && projects.has(x.projectId))?.name, value));
      case 'revisionId':
      case 'toRevisionId': {
        const r = data.revisions.find((x) => x.id === value && projects.has(x.projectId));
        return text(named(r ? `r${r.number}` : undefined, value));
      }
      case 'composeYaml':
        return { label, text: `${value.split('\n').length} lines, ${value.length} characters` };
      case 'secretRef': {
        // Whose value this is: a reference of Zenith's names its project, or none at all.
        const parts = parseVaultRef(value);
        if (!parts) return text(value);
        if (parts.projectId === undefined) return text(`${value} · names no project: any project that uses it reads the same value`);
        const owner = data.projects.find((p) => p.id === parts.projectId && p.workspaceId === workspaceId);
        if (!owner) return text(`${value} · project not found in this workspace`);
        return text(`${value} · ${owner.id === project?.id ? 'this project' : 'another project'}: ${owner.name}`);
      }
      case 'value':
      case 'key':
        return text(value);
      default:
        return text(value, /Id$|^(slug|blueprint|region|provider|expectedHash)$/.test(key));
    }
  }
  if (key === 'manifest' && typeof value === 'object') {
    const m = value as { services?: unknown[]; resources?: unknown[]; routes?: unknown[] };
    return { label, text: `${m.services?.length ?? 0} services, ${m.resources?.length ?? 0} resources, ${m.routes?.length ?? 0} routes` };
  }
  if (key === 'resources' && Array.isArray(value))
    return text(value.map((r) => (r && typeof r === 'object' ? String((r as { externalRef?: unknown }).externalRef ?? '') : String(r))).join(', '));
  if (key === 'channelIds' && Array.isArray(value)) {
    const known = channels(data, workspaceId);
    return text(value.map((id) => named(known.find((c) => c.id === id)?.name, String(id))).join(', ') || '(none)');
  }
  return text(JSON.stringify(value));
}

function createdProject(op: Operation, data: Database, workspaceId: string): ReviewDisplay['created'] {
  if (op.phase !== 'succeeded' || op.target.projectId !== undefined) return undefined;
  const result = (op.result as { data?: { projectId?: unknown; environmentId?: unknown } } | undefined)?.data;
  if (typeof result?.projectId !== 'string') return undefined;
  const project = data.projects.find((p) => p.id === result.projectId && p.workspaceId === workspaceId);
  if (!project) return undefined;
  return {
    projectId: project.id, name: project.name, slug: project.slug,
    ...(typeof result.environmentId === 'string' ? { environmentId: result.environmentId } : {}),
    href: `/p/${encodeURIComponent(project.slug)}`,
  };
}

export function reviewDisplay(op: Operation, data: Database): ReviewDisplay {
  const { workspaceId, projectId, environmentId } = op.target;
  const ws = data.workspaces.find((w) => w.id === workspaceId);
  const project = projectId === undefined ? undefined : data.projects.find((p) => p.id === projectId && p.workspaceId === workspaceId);
  const environment = environmentId === undefined || !project ? undefined
    : data.environments.find((e) => e.id === environmentId && e.projectId === project.id);
  const title = TITLES[op.action];
  const input = (op.input ?? {}) as Input;
  const fields = Object.entries(input)
    .filter(([key]) => !HIDDEN.has(key) && !/password|secret(?!Ref)|token|credential|api.?key|webhook/i.test(key))
    .map(([key, value]) => describeValue(key, value, { data, workspaceId, project }))
    .filter((f): f is ReviewField => f !== undefined);
  const created = createdProject(op, data, workspaceId);
  return {
    kind: typeof op.plan.kind === 'string' ? op.plan.kind : op.action,
    title: typeof title === 'function' ? title(projectId !== undefined) : title ?? humanize(op.action.replace(/^[a-z]+\./, '')),
    level: projectId === undefined ? 'workspace' : environmentId === undefined ? 'project' : 'environment',
    workspace: { id: workspaceId, name: ws?.name ?? workspaceId },
    ...(projectId !== undefined ? { project: { id: projectId, name: project?.name ?? projectId, slug: project?.slug ?? '' } } : {}),
    ...(environmentId !== undefined ? { environment: { id: environmentId, name: environment?.name ?? environmentId } } : {}),
    fields,
    ...(created ? { created } : {}),
  };
}
