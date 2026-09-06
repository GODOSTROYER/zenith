/**
 * Projects: create one blank, from a blueprint, or from a docker-compose file.
 *
 * Blueprint and import both end in the same place — an ordinary working
 * manifest you can edit — so nothing about a project's origin is special-cased
 * later.
 */
import { z } from "zod";
import { defineAction, type ActionContext } from "@/lib/actions/core";
import { getBlueprint, blueprints } from "@/lib/blueprints";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { db, q, save } from "@/lib/db/store";
import {
  ResourceKind,
  emptyManifest,
  id,
  type Manifest,
  type Project,
} from "@/lib/domain/types";
import { importCompose } from "@/lib/importers/compose";
import type { ImportReport } from "@/lib/importers/types";
import { slugify, uniqueName } from "@/lib/importers/types";
import { providerRegistry } from "@/lib/providers/types";
import { buildEnvironment, envPlanDetails, inFlight, liveRevision } from "./env";
import { getEngine } from "./_engine";
import { fmtUsd } from "@/lib/format";
import { clone, commit, planFromDiff, requireConnection, requireProject } from "./_shared";

/**
 * Both create-a-project-from-something actions build their first environment
 * in `execute` only — their `plan` never touches `buildEnvironment`, so a
 * foreign or fabricated connectionId sailed through the preview and was
 * refused one click later, on an enabled confirm button. Plan and execute have
 * to refuse the same input for the same reason, so the plan resolves the id
 * the execute will use. Nothing is kept: this is called for its refusal.
 */
function checkPlannedConnection(ctx: ActionContext, connectionId: string | undefined, creating: boolean): void {
  if (creating && connectionId) requireConnection(ctx, connectionId);
}

/**
 * A new project record, slugged uniquely WITHIN THE WORKSPACE.
 *
 * Uniqueness used to be computed across every project in the store, which made
 * the slug allocator an oracle: create "Acme" in your own empty workspace, get
 * back `acme-2`, and you have learned that a stranger's workspace holds `acme`.
 * One project creation per guess enumerates other tenants' names. Two
 * workspaces may now hold the same slug, which the action layer already reads
 * correctly: `_shared.requireProject` puts the workspace predicate inside the
 * find, so a slug resolves within the caller's own tenant. The HTTP layer does
 * NOT yet — `q.project` matches id-or-slug across the whole store and several
 * /api/projects routes resolve globally before checking tenancy, which answers
 * the second holder of a slug with a 404 on their own project. Scoping those
 * lookups is the companion change to this one.
 *
 * The filter matches on `workspaceId` alone and deliberately does not go
 * through `q.project`, which resolves an id OR a slug across the whole store:
 * reaching for a global match here is the very leak being closed. This only
 * chooses the slug for a project being created — no existing row is re-slugged.
 */
function newProject(ctx: ActionContext, name: string, slug: string | undefined, origin: Project["origin"], manifest: Manifest): Project {
  const taken = db()
    .projects.filter((p) => p.workspaceId === ctx.workspaceId)
    .map((p) => p.slug);
  return {
    id: id(),
    workspaceId: ctx.workspaceId,
    name: name.trim(),
    slug: uniqueName(slugify(slug ?? name, "project"), taken),
    workingManifest: manifest,
    createdAt: new Date().toISOString(),
    origin,
  };
}

/** Existing project in scope, or undefined when we are creating a new one. */
function scopedProject(ctx: ActionContext, projectId?: string): Project | undefined {
  const pid = projectId ?? ctx.projectId;
  return pid ? requireProject(ctx, pid) : undefined;
}

function manifestSummary(m: Manifest): string {
  const bits = [
    m.services.length && `${m.services.length} service${m.services.length === 1 ? "" : "s"}`,
    m.resources.length && `${m.resources.length} resource${m.resources.length === 1 ? "" : "s"}`,
    m.routes.length && `${m.routes.length} route${m.routes.length === 1 ? "" : "s"}`,
    m.bindings.length && `${m.bindings.length} connection${m.bindings.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return bits.length ? bits.join(", ") : "nothing yet";
}

/* ------------------------------ project.create ---------------------------- */

const CreateProject = z.object({
  name: z.string().min(1, "give the project a name"),
  slug: z.string().optional(),
  /** create a first environment straight away (default: yes, a sandbox one) */
  withEnvironment: z.boolean().optional(),
  connectionId: z.string().optional(),
});
type CreateProject = z.infer<typeof CreateProject>;

defineAction<CreateProject>({
  id: "project.create",
  title: "Create project",
  category: "project",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: CreateProject,
  plan(ctx, input) {
    const project = newProject(ctx, input.name, input.slug, { type: "blank" }, emptyManifest());
    const details = [`URL slug: /p/${project.slug}.`, "The system starts empty — add services and resources, or apply a blueprint."];
    if (input.withEnvironment !== false) {
      const { env, connection } = buildEnvironment(project, { connectionId: input.connectionId }, ctx, false);
      details.push(`Also creates the "${env.name}" environment.`, ...envPlanDetails(project, env, connection));
    }
    return {
      summary: `Create the project "${input.name}".`,
      details,
      costDeltaUsd: 0,
      risk: "low",
      warnings: [],
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const project = newProject(ctx, input.name, input.slug, { type: "blank" }, emptyManifest());
    // Resolve the connection BEFORE anything is written. A refused
    // connectionId must leave no half-created project behind — the store is
    // mutated only once every id in the request has been accepted.
    const built =
      input.withEnvironment !== false
        ? buildEnvironment(project, { connectionId: input.connectionId }, ctx)
        : undefined;
    db().projects.push(project);
    if (built) db().environments.push(built.env);
    const environmentId = built?.env.id;
    save();
    return {
      ok: true,
      summary: `Created "${project.name}". Next: add what it runs, then deploy.`,
      data: { projectId: project.id, slug: project.slug, environmentId },
    };
  },
});

/* --------------------------- project.applyBlueprint ------------------------ */

const ApplyBlueprint = z.object({
  projectId: z.string().optional(),
  blueprint: z.string().min(1),
  /** used only when there is no project in scope — creates one */
  name: z.string().optional(),
  connectionId: z.string().optional(),
});
type ApplyBlueprint = z.infer<typeof ApplyBlueprint>;

function resolveBlueprint(blueprintId: string) {
  const bp = getBlueprint(blueprintId);
  if (!bp)
    throw new Error(
      `No blueprint "${blueprintId}". Pick one of: ${blueprints.map((b) => b.id).join(", ")}.`
    );
  return bp;
}

defineAction<ApplyBlueprint>({
  id: "project.applyBlueprint",
  title: "Apply blueprint",
  category: "project",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: ApplyBlueprint,
  plan(ctx, input) {
    const bp = resolveBlueprint(input.blueprint);
    const existing = scopedProject(ctx, input.projectId);
    checkPlannedConnection(ctx, input.connectionId, !existing);
    const slug = existing?.slug ?? slugify(input.name ?? bp.name, "project");
    const next = bp.manifestFactory(slug);
    const before = existing?.workingManifest ?? emptyManifest();
    const warnings: string[] = [];
    if (existing && (before.services.length || before.resources.length))
      warnings.push(`This replaces the working copy of ${existing.name} (${manifestSummary(before)}). Nothing deployed changes until you deploy, but unsaved edits to the working copy are lost.`);

    const plan = planFromDiff(
      before,
      next,
      existing ? `Replace ${existing.name}'s system with the "${bp.name}" blueprint.` : `Create a project from the "${bp.name}" blueprint.`,
      { details: [bp.description, `You get: ${manifestSummary(next)}.`], warnings }
    );
    return { ...plan, risk: warnings.length ? "medium" : plan.risk };
  },
  execute(ctx, input) {
    const bp = resolveBlueprint(input.blueprint);
    const existing = scopedProject(ctx, input.projectId);
    if (existing) {
      const next = bp.manifestFactory(existing.slug);
      existing.origin = { type: "blueprint", blueprint: bp.id };
      commit(existing, next);
      return {
        ok: true,
        summary: `Applied the "${bp.name}" blueprint to ${existing.name}: ${manifestSummary(next)}, ${fmtUsd(monthlyCostUsd(next))}/month estimated. Deploy to apply it.`,
        data: { projectId: existing.id, blueprint: bp.id },
      };
    }
    const project = newProject(ctx, input.name ?? bp.name, undefined, { type: "blueprint", blueprint: bp.id }, emptyManifest());
    project.workingManifest = bp.manifestFactory(project.slug);
    // Connection first, then the writes: a refused id creates nothing at all.
    const { env } = buildEnvironment(project, { connectionId: input.connectionId }, ctx);
    db().projects.push(project);
    db().environments.push(env);
    save();
    return {
      ok: true,
      summary: `Created "${project.name}" from the "${bp.name}" blueprint: ${manifestSummary(project.workingManifest)}, ${fmtUsd(monthlyCostUsd(project.workingManifest))}/month estimated. Nothing is deployed yet.`,
      data: { projectId: project.id, slug: project.slug, environmentId: env.id, blueprint: bp.id },
    };
  },
});

/* --------------------------- project.importCompose ------------------------- */

const ImportCompose = z.object({
  projectId: z.string().optional(),
  composeYaml: z.string().min(1, "paste the contents of a docker-compose.yml"),
  name: z.string().optional(),
  connectionId: z.string().optional(),
});
type ImportCompose = z.infer<typeof ImportCompose>;

function reportDetails(report: ImportReport, m: Manifest): string[] {
  const details = [
    `Imported ${manifestSummary(m)}.`,
    ...report.mapped.map((x) => `${x.source} → ${x.result}${x.confidence === "assumed" ? " (assumed)" : ""}. ${x.note}`),
  ];
  if (report.unmapped.length)
    details.push(
      `${report.unmapped.length} thing(s) were not imported, and each one says why:`,
      ...report.unmapped.map((u) => `${u.source}: ${u.reason} → ${u.suggestion}`)
    );
  return details;
}

defineAction<ImportCompose>({
  id: "project.importCompose",
  title: "Import docker-compose",
  category: "project",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: ImportCompose,
  plan(ctx, input) {
    const { manifest, report } = importCompose(input.composeYaml);
    const existing = scopedProject(ctx, input.projectId);
    checkPlannedConnection(ctx, input.connectionId, !existing);
    const before = existing?.workingManifest ?? emptyManifest();
    const warnings = [...report.warnings];
    if (existing && (before.services.length || before.resources.length))
      warnings.push(`This replaces the working copy of ${existing.name} (${manifestSummary(before)}).`);
    return planFromDiff(
      before,
      manifest,
      existing ? `Import a compose file into ${existing.name}.` : `Create a project from a docker-compose file.`,
      { details: reportDetails(report, manifest), warnings }
    );
  },
  execute(ctx, input) {
    const { manifest, report } = importCompose(input.composeYaml);
    const existing = scopedProject(ctx, input.projectId);
    const origin = { type: "import", source: "compose" } as const;
    const tally = `${report.mapped.length} mapped, ${report.unmapped.length} not imported (each listed with a reason)`;

    if (existing) {
      existing.origin = origin;
      commit(existing, manifest);
      return {
        ok: true,
        summary: `Imported into ${existing.name}: ${manifestSummary(manifest)} — ${tally}. Deploy to apply it.`,
        data: { projectId: existing.id, report },
      };
    }
    const project = newProject(ctx, input.name ?? "Imported app", undefined, origin, clone(manifest));
    // Connection first, then the writes: a refused id creates nothing at all.
    const { env } = buildEnvironment(project, { connectionId: input.connectionId }, ctx);
    db().projects.push(project);
    db().environments.push(env);
    save();
    return {
      ok: true,
      summary: `Created "${project.name}" from docker-compose: ${manifestSummary(manifest)} — ${tally}. Nothing is deployed yet.`,
      data: { projectId: project.id, slug: project.slug, environmentId: env.id, report },
    };
  },
});

/* -------------------------- project.importResources ------------------------ */

/**
 * Adopt resources that already exist in a connected account or endpoint.
 *
 * Two rules make this safe, and both are enforced here rather than trusted to
 * the caller:
 *
 *  1. Everything imported is `referenced`, never `managed`. Orrery shows a
 *     referenced resource on the map and lets services bind to it; it never
 *     provisions, changes or deletes one, and it never bills for it.
 *  2. The submitted list is a SELECTION, not data. Every entry is matched by
 *     `externalRef` against a fresh `discover()` on the server, and the
 *     provider's record is what lands in the manifest. A caller cannot write
 *     an arbitrary external reference into a system by posting one.
 */
const ImportResources = z.object({
  projectId: z.string().optional(),
  connectionId: z.string().min(1, "say which connection to import from"),
  region: z.string().optional(),
  /** DiscoveredResource rows from GET /api/connections/:id/discover */
  resources: z
    .array(z.object({ externalRef: z.string().min(1) }).passthrough())
    .min(1, "pick at least one resource to import"),
});
type ImportResources = z.infer<typeof ImportResources>;

async function resolveImport(ctx: ActionContext, input: ImportResources) {
  const project = requireProject(ctx, input.projectId);
  const conn = q.connection(input.connectionId);
  if (!conn || conn.workspaceId !== ctx.workspaceId)
    throw new Error(
      `Connection "${input.connectionId}" is not in this workspace. Pick one from Settings → Connections.`
    );
  if (!providerRegistry().has(conn.provider)) await getEngine();
  const adapter = providerRegistry().get(conn.provider);
  if (!adapter)
    throw new Error(
      `Provider "${conn.provider}" is not available in this build, so nothing can be imported from ${conn.label}.`
    );
  if (!adapter.discover)
    throw new Error(
      `${adapter.displayName} cannot list what already exists, so there is nothing here to import. Import from a Terraform file instead — the map's import dialog reads one.`
    );

  const found = await adapter.discover(conn, input.region ?? conn.region);
  const byRef = new Map(found.resources.map((r) => [r.externalRef, r]));

  const next = clone(project.workingManifest);
  const taken = [...next.services.map((s) => s.name), ...next.resources.map((r) => r.name)];
  const already = new Set(
    next.resources.map((r) => r.externalRef).filter((x): x is string => !!x)
  );

  const added: { name: string; ref: string; kind: ResourceKind }[] = [];
  const skipped: string[] = [];

  for (const wanted of input.resources) {
    const hit = byRef.get(wanted.externalRef);
    if (!hit) {
      skipped.push(
        `${wanted.externalRef} was not imported: ${adapter.displayName} does not list it any more. Re-open the dialog to see what is there now.`
      );
      continue;
    }
    if (already.has(hit.externalRef)) {
      skipped.push(`${hit.externalRef} was not imported: this project already references it.`);
      continue;
    }
    already.add(hit.externalRef);
    const name = uniqueName(slugify(hit.name, hit.kind.replace("_", "-")), taken);
    taken.push(name);
    next.resources.push({
      id: id(),
      name,
      kind: hit.kind,
      config: {},
      size: "small",
      ownership: "referenced",
      externalRef: hit.externalRef,
    });
    added.push({ name, ref: hit.externalRef, kind: hit.kind });
  }

  return { project, conn, adapter, found, next, added, skipped };
}

const REFERENCED_NOTE =
  "Imported resources are marked referenced: Orrery draws them on the map and lets services bind to them, but never provisions, changes or deletes them — and they add nothing to the cost estimate.";

defineAction<ImportResources>({
  id: "project.importResources",
  title: "Import existing resources",
  category: "project",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: ImportResources,
  async plan(ctx, input) {
    const { project, conn, adapter, found, next, added, skipped } = await resolveImport(ctx, input);
    const warnings: string[] = [];
    if (found.simulated)
      warnings.push(
        `${adapter.displayName} invented this list. It is a simulation of resource discovery, not a reading of a real account — the references it writes carry a "sim://" prefix so they stay recognisable in the manifest and in any export.`
      );

    const plan = planFromDiff(
      project.workingManifest,
      next,
      `Reference ${added.length} existing resource${added.length === 1 ? "" : "s"} from ${conn.label}.`,
      {
        details: [
          ...added.map((a) => `${a.ref} → referenced ${a.kind} "${a.name}".`),
          REFERENCED_NOTE,
          ...skipped,
        ],
        warnings,
      }
    );

    return added.length
      ? plan
      : {
          ...plan,
          blocked: `Nothing here would be imported. ${skipped.join(" ")}`.trim(),
        };
  },
  async execute(ctx, input) {
    const { project, conn, next, added, skipped } = await resolveImport(ctx, input);
    if (!added.length)
      return {
        ok: false,
        summary: "Nothing was imported.",
        error: `None of the selected resources could be imported. ${skipped.join(" ")}`.trim(),
      };
    commit(project, next);
    return {
      ok: true,
      summary: `Referenced ${added.length} existing resource${added.length === 1 ? "" : "s"} from ${conn.label}: ${added
        .map((a) => a.name)
        .join(", ")}. ${REFERENCED_NOTE} They show as pending changes until you deploy, which records them in a revision without provisioning anything.`,
      data: {
        projectId: project.id,
        connectionId: conn.id,
        imported: added,
        skipped,
      },
    };
  },
});

/* ------------------------------ project.delete ---------------------------- */

const DeleteProject = z.object({ projectId: z.string().optional() });
type DeleteProject = z.infer<typeof DeleteProject>;

/**
 * One reading of the deletion, shared by plan and execute: what goes, what
 * stays, and the one condition that refuses. A project whose environments are
 * mid-deploy is not deletable — the engine would keep writing to records that
 * no longer exist.
 */
function projectDelete(ctx: ActionContext, input: DeleteProject) {
  const project = requireProject(ctx, input.projectId);
  const envs = q.environmentsOf(project.id);
  const revisions = q.revisionsOf(project.id);
  const deployments = envs.flatMap((e) => q.deploymentsOf(e.id));
  const findings = db().findings.filter((f) => f.projectId === project.id);
  const runs = db().navigatorRuns.filter((r) => r.projectId === project.id);
  const busy = envs.flatMap((e) => {
    const dep = inFlight(e.id);
    return dep ? [{ env: e, dep }] : [];
  });
  const live = envs.filter((e) => e.deployedRevisionId);

  const blocked = busy.length
    ? `${busy.map((b) => `${b.env.name} is ${b.dep.status}`).join(", ")}. Wait for that deployment to finish, or cancel it on the Deploys page, then delete the project.`
    : undefined;

  const details = [
    `Removes ${project.name} and everything Orrery holds about it: ${envs.length} environment(s), ${revisions.length} revision(s), ${deployments.length} deployment record(s), ${findings.length} security finding(s), ${runs.length} Navigator run(s).`,
    "Nothing in your cloud or in the sandbox is torn down. This deletes Orrery's records, not running infrastructure.",
    `The URL /p/${project.slug} stops working, and the working copy goes with it — export the bundle from Source → Export first if you want the generated files.`,
    "The audit log keeps every row already written, including this deletion. It is append-only.",
  ];

  const warnings = live.length
    ? [
        `${live.map((e) => `${e.name} is running ${liveRevision(e)}`).join("; ")}. Those keep running after the project is gone, and Orrery will have no way to reach them again — tear them down first if you want them stopped.`,
      ]
    : [];

  return { project, envs, revisions, deployments, findings, runs, details, warnings, blocked };
}

defineAction<DeleteProject>({
  id: "project.delete",
  title: "Delete project",
  category: "project",
  risk: "high",
  requiredRole: "admin",
  mutates: true,
  input: DeleteProject,
  plan(ctx, input) {
    const { project, details, warnings, blocked } = projectDelete(ctx, input);
    return {
      summary: `Delete the project "${project.name}".`,
      details,
      costDeltaUsd: 0,
      risk: "high",
      warnings,
      requiresApproval: false,
      blocked,
    };
  },
  execute(ctx, input) {
    const { project, envs, revisions, deployments, blocked } = projectDelete(ctx, input);
    if (blocked) return { ok: false, summary: `"${project.name}" was not deleted.`, error: blocked };
    const envIds = new Set(envs.map((e) => e.id));
    const d = db();
    d.projects = d.projects.filter((p) => p.id !== project.id);
    d.environments = d.environments.filter((e) => !envIds.has(e.id));
    d.revisions = d.revisions.filter((r) => r.projectId !== project.id);
    d.deployments = d.deployments.filter((dep) => !envIds.has(dep.environmentId));
    d.findings = d.findings.filter((f) => f.projectId !== project.id);
    d.navigatorRuns = d.navigatorRuns.filter((r) => r.projectId !== project.id);
    save();
    return {
      ok: true,
      summary: `Deleted "${project.name}" — ${envs.length} environment(s), ${revisions.length} revision(s) and ${deployments.length} deployment record(s) went with it. Nothing running was torn down.`,
      data: {
        projectId: project.id,
        slug: project.slug,
        name: project.name,
        environmentsRemoved: envs.length,
        revisionsRemoved: revisions.length,
      },
    };
  },
});
