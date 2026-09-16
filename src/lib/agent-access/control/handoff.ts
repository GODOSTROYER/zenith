/**
 * Browser hand-offs: tasks a human does on tryzenith.cloud, never the agent.
 *
 * A pure URL map (PLAN3 §3.5). `zenith_get_handoff` resolves slugs and checks
 * every id against the grant before calling this; this module only formats.
 * It never puts a value, a secret or a caller-supplied URL into its output.
 *
 * Frozen signature (PLAN3 F0). The body is a stub until P3 implements the map.
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

export function handoffUrl(origin: string, task: HandoffTask, ids: HandoffIds): Handoff {
  void task;
  void ids;
  // Stub: P3 replaces this with the per-task map and its route-existence test.
  return {
    url: new URL('/settings', origin).toString(),
    instructions: 'Open this page in the browser and complete the task there. The agent cannot do it for you.',
  };
}
