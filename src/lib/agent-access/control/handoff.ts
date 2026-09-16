/**
 * Browser hand-offs: tasks a human does on tryzenith.cloud, never the agent.
 *
 * A pure URL map (PLAN3 §3.5). `zenith_get_handoff` resolves slugs and checks
 * every id against the grant before calling this; this module only formats.
 * It never puts a value, a secret or a caller-supplied URL into its output:
 * every path is a literal below, ids are checked against the identifier
 * pattern and percent-encoded, and the result must stay on `origin`.
 *
 * Frozen signature (PLAN3 F0).
 */

export const HANDOFF_TASKS = [
  'workspace.create',
  'workspace.autonomy',
  'account',
  'account.export',
  'account.delete',
  'members',
  'invites',
  'secret.set',
  'secret.rotate',
  'connection.credentials',
  'alerts.channel',
  'environment.policies',
  'environment.delete',
  'project.delete',
  'deploy.approve',
  'operation.review',
  'app.audience',
  'relink',
] as const;

export type HandoffTask = (typeof HANDOFF_TASKS)[number];

/** Grant-checked identifiers the caller already resolved. None is free text except `name`. */
export interface HandoffIds {
  workspaceId?: string;
  projectId?: string;
  /** The project's slug, looked up by the caller (URLs are `/p/<slug>/…`). */
  projectSlug?: string;
  environmentId?: string;
  deploymentId?: string;
  operationId?: string;
  appId?: string;
  /** `workspace.create` only: the suggested name, used in `command`, never in `url`. */
  name?: string;
}

export interface Handoff {
  /** An absolute URL on `origin`. */
  url: string;
  /** What the human does there, in one or two sentences. */
  instructions: string;
  /** A local command the agent may run instead of (or before) opening `url`. */
  command?: string;
}

/** A hand-off that cannot be built from what the caller supplied. */
export class HandoffError extends Error {
  constructor(readonly code: 'handoff_input' | 'handoff_origin', message: string) {
    super(message);
    this.name = 'HandoffError';
  }
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

function id(value: string | undefined, field: keyof HandoffIds, task: HandoffTask): string {
  if (value === undefined) throw new HandoffError('handoff_input', `The ${task} hand-off needs ${field}.`);
  if (!ID.test(value)) throw new HandoffError('handoff_input', `${field} is not a Zenith identifier.`);
  return encodeURIComponent(value);
}

function optionalId(value: string | undefined, field: keyof HandoffIds, task: HandoffTask): string | undefined {
  return value === undefined ? undefined : id(value, field, task);
}

function slug(ids: HandoffIds, task: HandoffTask): string {
  if (ids.projectSlug === undefined) throw new HandoffError('handoff_input', `The ${task} hand-off needs the project.`);
  if (!SLUG.test(ids.projectSlug)) throw new HandoffError('handoff_input', 'projectSlug is not a Zenith project slug.');
  return encodeURIComponent(ids.projectSlug);
}

/**
 * Settings for one project when the caller named one, otherwise the
 * workspace-level `/settings`, which opens the first project's settings (or
 * the standalone workspace sections when there is none).
 */
function settings(ids: HandoffIds, task: HandoffTask, section: string, environment = false): string {
  const env = environment ? optionalId(ids.environmentId, 'environmentId', task) : undefined;
  const query = env ? `?env=${env}` : '';
  return ids.projectSlug === undefined ? `/settings${query}#${section}` : `/p/${slug(ids, task)}/settings${query}#${section}`;
}

/** A workspace name as a shell argument: plain characters only, so the quotes cannot be broken. */
function nameArgument(name: string | undefined): string | undefined {
  const plain = (name ?? '').replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  return plain.length > 0 ? `"${plain}"` : undefined;
}

function route(task: HandoffTask, ids: HandoffIds): Omit<Handoff, 'url'> & { path: string } {
  switch (task) {
    case 'workspace.create': {
      const name = nameArgument(ids.name);
      return {
        path: '/onboarding?step=1',
        command: name ? `zenith login --new-workspace ${name}` : 'zenith login',
        instructions:
          'Run the command: the approval page offers "Create a new workspace", and a person creates it and approves Whole workspace. Or create it at this URL and then run `zenith login`.',
      };
    }
    case 'workspace.autonomy':
      return {
        path: `/p/${slug(ids, task)}/navigator`,
        instructions: 'Change the autonomy level with the dial on the Navigator screen. Only a person sets how much Navigator may do without review.',
      };
    case 'account':
      return { path: '/account#profile', instructions: 'Manage the display name, sign-in methods and sessions on the Account page.' };
    case 'account.export':
      return { path: '/account#data', instructions: 'Download the personal data export from the Account page.' };
    case 'account.delete':
      return { path: '/account#danger', instructions: 'Delete the account from the Danger zone of the Account page. It cannot be undone.' };
    case 'members':
      return { path: '/settings#members', instructions: 'Change a member’s role or remove them under Members. Only an admin can.' };
    case 'invites':
      return { path: '/settings#members', instructions: 'Create or revoke an invite under Members. Zenith sends no mail: share the invite yourself.' };
    case 'secret.set':
      return {
        path: settings(ids, task, 'secrets'),
        instructions: 'Enter the secret value under Secrets. Never paste a value into the agent chat.',
      };
    case 'secret.rotate':
      return {
        path: settings(ids, task, 'secrets'),
        instructions: 'Rotate the secret under Secrets by entering the new value there. Every service that reads the reference picks it up on its next deploy.',
      };
    case 'connection.credentials':
      return {
        path: settings(ids, task, 'connections'),
        instructions: 'Add the provider connection and enter its credentials under Connections. An admin can.',
      };
    case 'alerts.channel':
      return {
        path: settings(ids, task, 'alerts'),
        instructions: 'Create the alert channel, or change its URL or signing secret, under Alerts. A webhook URL is a credential.',
      };
    case 'environment.policies':
      return {
        path: settings(ids, task, 'environments', true),
        instructions: 'Loosen the environment’s approval or deletion policy on its card under Environments. An admin can.',
      };
    case 'environment.delete':
      return {
        path: settings(ids, task, 'environments', true),
        instructions: 'Delete the environment from its card under Environments. Nothing running in the cloud is torn down.',
      };
    case 'project.delete':
      return {
        path: `/p/${slug(ids, task)}/settings#danger`,
        instructions: 'Delete the project from the Danger zone. It asks for the project name to confirm and cannot be undone.',
      };
    case 'deploy.approve':
      return {
        path: `/p/${slug(ids, task)}/deploys?deployment=${id(ids.deploymentId, 'deploymentId', task)}`,
        instructions: 'Review the deployment and choose Approve and apply. An agent never approves a deployment.',
      };
    case 'operation.review': {
      const operation = optionalId(ids.operationId, 'operationId', task);
      return {
        path: operation ? `/integrations?operation=${operation}#${operation}` : '/integrations#proposals',
        instructions: 'Read the exact proposal, then approve or reject it. Approving does not run it: the agent dispatches it afterwards.',
      };
    }
    case 'app.audience':
      return {
        path: `/apps/${id(ids.appId, 'appId', task)}#audience`,
        instructions: 'Grant or revoke access, and send invites, under Audience. An app owner can.',
      };
    case 'relink':
      return {
        path: '/integrations#linked-agents',
        command: 'zenith login',
        instructions: 'Run `zenith login` and choose the access in the browser (Whole workspace to create projects). Revoke an old credential under Linked agents.',
      };
  }
}

export function handoffUrl(origin: string, task: HandoffTask, ids: HandoffIds): Handoff {
  if (!(HANDOFF_TASKS as readonly string[]).includes(task)) throw new HandoffError('handoff_input', 'Unknown hand-off task.');
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    throw new HandoffError('handoff_origin', 'The Zenith origin is not a URL.');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:')
    throw new HandoffError('handoff_origin', 'The Zenith origin must be http or https.');
  const { path, ...rest } = route(task, ids);
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin) throw new HandoffError('handoff_origin', 'A hand-off never leaves the Zenith origin.');
  return { url: url.toString(), ...rest };
}
