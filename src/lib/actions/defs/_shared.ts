/**
 * Helpers shared by the action definitions.
 *
 * Two rules live here so every action gets them for free:
 *  - lookups fail with a message that names the fix;
 *  - manifest edits are previewed with a real changeset (diff + pricing), and
 *    every preview says out loud that it only touches the working copy.
 */
import type { ActionContext, ActionPlan, Risk } from "@/lib/actions/core";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { db, q, save } from "@/lib/db/store";
import { diffManifests } from "@/lib/domain/graph";
import { fmtUsd } from "@/lib/format";
import type {
  CloudConnection,
  Deployment,
  Environment,
  Manifest,
  Project,
  Resource,
  Revision,
  Service,
} from "@/lib/domain/types";

export const clone = <T>(v: T): T => structuredClone(v);

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (risks: Risk[]): Risk =>
  risks.reduce<Risk>((a, r) => (RISK_ORDER[r] > RISK_ORDER[a] ? r : a), "low");

/* --------------------------------- lookups -------------------------------- */

/**
 * TENANCY — the rule every lookup below enforces.
 *
 * An object id is a bearer token. `runAction` checks the caller's role in
 * `ctx.workspaceId` and nothing else, so a lookup that reads the whole store
 * lets an admin of workspace A plan or execute against workspace B just by
 * passing one of B's ids — deployments and deletions included. Authorization
 * is only as narrow as the resolution that feeds it.
 *
 * So: every resolver here constrains to `ctx.workspaceId`, transitively where
 * the object carries no workspace of its own (Environment → Project →
 * workspace; likewise Revision and Deployment).
 *
 * And a foreign id gets the SAME message as an absent one. "You don't have
 * access to that" confirms the object exists, which makes the id space
 * enumerable across tenants — a slow read of someone else's estate. Not-found
 * says nothing, so both cases share one message factory below.
 *
 * Note the lookups resolve *within* the workspace rather than resolving
 * globally and then checking. `q.project` matches on id OR slug, and two
 * workspaces may both have a project slugged "atlas": a global resolve would
 * return the stranger's row and then refuse it, hiding your own project behind
 * their slug. Scoping the search fixes the leak without inventing that bug.
 */

/** The tenant every lookup is scoped to. No workspace = resolve nothing. */
function scopeOf(ctx: ActionContext): string {
  if (!ctx.workspaceId)
    throw new Error(
      "No workspace in scope, so nothing can be looked up safely. Pass workspaceId in the action context — the UI and the API both take it from the current workspace."
    );
  return ctx.workspaceId;
}

/**
 * Does this workspace own that project? Matches on id ONLY — unlike
 * `q.project` and store's `inWorkspace`, which also accept a slug. Every
 * stored `projectId` is an id, and a slug that happens to shadow one must
 * never be what decides tenancy.
 */
const ownsProject = (workspaceId: string, projectId: string): boolean =>
  db().projects.some((p) => p.id === projectId && p.workspaceId === workspaceId);

/* Absent and foreign resolve to the same sentence. Each one names its fix. */
const noProject = (ref: string) =>
  new Error(`Project "${ref}" does not exist. Pick one from the workspace overview.`);
const noEnvironment = (ref: string) =>
  new Error(
    `Environment "${ref}" does not exist. Pick one from the project's environment switcher.`
  );
const noRevision = (ref: string) =>
  new Error(`Revision "${ref}" does not exist. Pick one from the project's history.`);
const noDeployment = (ref: string) =>
  new Error(
    `Deployment "${ref}" does not exist. Pick one from the environment's deployment history.`
  );
const noConnection = (ref: string) =>
  new Error(
    `Cloud connection "${ref}" does not exist. Pick one in Settings → Connections, or connect an account there.`
  );

export function requireProject(ctx: ActionContext, projectId?: string): Project {
  const ws = scopeOf(ctx);
  const pid = projectId ?? ctx.projectId;
  if (!pid)
    throw new Error("No project in scope. Open a project first, or pass a projectId with the request.");
  const project = db().projects.find(
    (p) => (p.id === pid || p.slug === pid) && p.workspaceId === ws
  );
  if (!project) throw noProject(pid);
  return project;
}

export function requireEnvironment(ctx: ActionContext, environmentId?: string): Environment {
  const ws = scopeOf(ctx);
  const eid = environmentId ?? ctx.environmentId;
  if (eid) {
    const env = q.environment(eid);
    // An Environment carries no workspaceId; its project is what decides.
    if (!env || !ownsProject(ws, env.projectId)) throw noEnvironment(eid);
    return env;
  }
  const project = requireProject(ctx);
  const envs = q.environmentsOf(project.id);
  if (envs.length === 1) return envs[0];
  if (envs.length === 0)
    throw new Error(`Project "${project.name}" has no environments yet. Create one with env.create.`);
  throw new Error(
    `This project has ${envs.length} environments (${envs.map((e) => e.name).join(", ")}). Say which one — pass environmentId.`
  );
}

/** A revision, scoped through the project that owns it. */
export function requireRevision(ctx: ActionContext, revisionId: string): Revision {
  const ws = scopeOf(ctx);
  const rev = q.revision(revisionId);
  if (!rev || !ownsProject(ws, rev.projectId)) throw noRevision(revisionId);
  return rev;
}

/** A deployment, scoped through the project that owns it. */
export function requireDeployment(ctx: ActionContext, deploymentId: string): Deployment {
  const ws = scopeOf(ctx);
  const dep = q.deployment(deploymentId);
  if (!dep || !ownsProject(ws, dep.projectId)) throw noDeployment(deploymentId);
  return dep;
}

/** A cloud connection. This one carries its own workspaceId — no hop needed. */
export function requireConnection(ctx: ActionContext, connectionId: string): CloudConnection {
  const ws = scopeOf(ctx);
  const conn = q.connection(connectionId);
  if (!conn || conn.workspaceId !== ws) throw noConnection(connectionId);
  return conn;
}

/*
 * The helpers below take a Manifest, not an id, and a Manifest only ever
 * reaches them from a Project or Revision that the resolvers above already
 * scoped. There is no store lookup to constrain, so a service or node id is
 * meaningful inside that one system and nowhere else. They stay as they are.
 */

export function requireService(m: Manifest, serviceId: string): Service {
  const s = m.services.find((x) => x.id === serviceId || x.name === serviceId);
  if (!s)
    throw new Error(
      `No service "${serviceId}" in this system. Use one of: ${m.services.map((x) => x.name).join(", ") || "(none — add one with system.addService)"}.`
    );
  return s;
}

export function requireResource(m: Manifest, resourceId: string): Resource {
  const r = m.resources.find((x) => x.id === resourceId || x.name === resourceId);
  if (!r)
    throw new Error(
      `No resource "${resourceId}" in this system. Use one of: ${m.resources.map((x) => x.name).join(", ") || "(none — add one with system.addResource)"}.`
    );
  return r;
}

/** Resolve a node id from an id OR a name — the Navigator speaks in names. */
export function resolveNodeId(m: Manifest, ref: string): string {
  const hit =
    m.services.find((s) => s.id === ref || s.name === ref) ??
    m.resources.find((r) => r.id === ref || r.name === ref) ??
    m.routes.find((r) => r.id === ref || r.host === ref);
  if (!hit)
    throw new Error(
      `"${ref}" is not a node in this system. Known nodes: ${[
        ...m.services.map((s) => s.name),
        ...m.resources.map((r) => r.name),
        ...m.routes.map((r) => r.host),
      ].join(", ") || "(none)"}.`
    );
  return hit.id;
}

/* ------------------------------ manifest edits ----------------------------- */

export const WORKING_COPY_NOTE =
  "Applies to the working copy. Nothing changes in a running environment until you deploy.";

/** Build an ActionPlan from a real changeset between two manifests. */
export function planFromDiff(
  before: Manifest,
  after: Manifest,
  summary: string,
  extra: { details?: string[]; warnings?: string[] } = {}
): ActionPlan {
  const cs = diffManifests(before, after);
  return {
    summary,
    details: [
      ...(extra.details ?? []),
      ...cs.items.map((i) => i.explanation),
      `Projected monthly total after this change: ${fmtUsd(cs.projectedMonthlyUsd)} (estimate).`,
      WORKING_COPY_NOTE,
    ],
    costDeltaUsd: cs.totalCostDeltaUsd,
    risk: maxRisk(cs.items.map((i) => i.risk)),
    warnings: [...(extra.warnings ?? []), ...cs.warnings],
    requiresApproval: false,
  };
}

/** Persist a new working manifest. runAction also saves; this keeps direct callers safe. */
export function commit(project: Project, next: Manifest): void {
  project.workingManifest = next;
  save();
}

/** One-line human summary of a manifest edit, for ActionResult.summary. */
export function editSummary(before: Manifest, after: Manifest, what: string): string {
  const cs = diffManifests(before, after);
  const delta = cs.totalCostDeltaUsd;
  const money = delta === 0 ? "no cost change" : `${fmtUsd(delta, { sign: true })}/mo`;
  return `${what} — ${money}, projected ${fmtUsd(monthlyCostUsd(after))}/mo (estimate). Deploy to apply it.`;
}
