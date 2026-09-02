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
import { q, save } from "@/lib/db/store";
import { diffManifests } from "@/lib/domain/graph";
import { fmtUsd } from "@/lib/format";
import type {
  Environment,
  Manifest,
  Project,
  Resource,
  Service,
} from "@/lib/domain/types";

export const clone = <T>(v: T): T => structuredClone(v);

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (risks: Risk[]): Risk =>
  risks.reduce<Risk>((a, r) => (RISK_ORDER[r] > RISK_ORDER[a] ? r : a), "low");

/* --------------------------------- lookups -------------------------------- */

export function requireProject(ctx: ActionContext, projectId?: string): Project {
  const pid = projectId ?? ctx.projectId;
  if (!pid)
    throw new Error("No project in scope. Open a project first, or pass a projectId with the request.");
  const project = q.project(pid);
  if (!project)
    throw new Error(`Project "${pid}" does not exist. Pick one from the workspace overview.`);
  return project;
}

export function requireEnvironment(ctx: ActionContext, environmentId?: string): Environment {
  const eid = environmentId ?? ctx.environmentId;
  if (eid) {
    const env = q.environment(eid);
    if (!env)
      throw new Error(`Environment "${eid}" does not exist. Pick one from the project's environment switcher.`);
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
