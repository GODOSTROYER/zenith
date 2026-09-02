/**
 * Deterministic security rule engine.
 *
 * Same manifest in, same findings out — ids are content-hashed so a finding
 * survives recomputation, which is what lets "dismissed" stick. Every finding
 * says what is wrong and, where the fix is automatable, carries the action
 * that fixes it.
 *
 * Workstream A.
 */
import { db, q, save } from "@/lib/db/store";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import {
  hash32,
  type Environment,
  type Manifest,
  type Project,
  type SecurityFinding,
} from "@/lib/domain/types";

const SECRETISH = /key|secret|token|password|passwd|credential/i;
/** Values that are obviously not real secrets — placeholders and references. */
const PLACEHOLDER = /^(|true|false|\d+|localhost|change_?me|todo|none|null|\$\{.*\}|\/.*)$/i;

const stableId = (rule: string, target: string) => `sf_${rule}_${hash32(`${rule}:${target}`)}`;

/**
 * Analyze a manifest against a project's environments.
 * Pure apart from the timestamp: pass the same inputs, get the same ids.
 *
 * `manifest` defaults to the working copy. Pass a deployed revision's manifest
 * to ask the other question — what is true of what is actually running.
 */
export function analyze(
  project: Project,
  environments: Environment[],
  manifest?: Manifest
): SecurityFinding[] {
  const m = manifest ?? project.workingManifest;
  const createdAt = new Date().toISOString();
  const out: SecurityFinding[] = [];
  const prod = environments.filter((e) => e.class === "production");
  const primaryProd = prod[0];

  const add = (f: Omit<SecurityFinding, "projectId" | "status" | "createdAt">) =>
    out.push({ ...f, projectId: project.id, status: "open", createdAt });

  /* 1 — a public route that does not encrypt traffic. */
  for (const route of m.routes) {
    if (route.tls) continue;
    add({
      id: stableId("route_no_tls", route.id),
      severity: "high",
      title: `${route.host} serves traffic without TLS`,
      detail: `Requests to ${route.host} travel as plaintext, so anything on the path can read or alter them — including credentials and session cookies.`,
      targetId: route.id,
      fix: {
        actionId: "system.updateRoute",
        input: { routeId: route.id, tls: true },
        label: "Turn TLS on",
      },
    });
  }

  /* 2 — a single replica behind a production route is a single point of failure. */
  if (primaryProd) {
    for (const s of m.services) {
      if (s.kind !== "web" || s.ownership !== "managed") continue;
      if (s.replicas >= 2) continue;
      add({
        id: stableId("single_replica_prod", s.id),
        environmentId: primaryProd.id,
        severity: "medium",
        title: `${s.name} runs a single replica in ${primaryProd.name}`,
        detail: `With ${s.replicas} replica${s.replicas === 1 ? "" : "s"}, every deploy and every crash is downtime for ${s.name}. Two replicas let traffic shift without a gap.`,
        targetId: s.id,
        fix: {
          actionId: "ops.scaleService",
          input: { environmentId: primaryProd.id, serviceId: s.id, replicas: 2 },
          label: "Scale to 2 replicas",
        },
      });
    }
  }

  /* 3 — a secret-looking value sitting in the manifest as plaintext. */
  for (const s of m.services) {
    for (const e of s.env) {
      if (e.value === undefined || e.secretRef) continue;
      if (!SECRETISH.test(e.key)) continue;
      if (PLACEHOLDER.test(e.value.trim())) continue;
      add({
        id: stableId("plaintext_secret", `${s.id}:${e.key}`),
        severity: "high",
        title: `${s.name}.${e.key} is stored in plain text`,
        detail:
          `${e.key} looks like a credential but its value lives in the manifest, which means it is in every revision, every export and every audit snapshot of this project. ` +
          `The fix moves the value into Orrery's secret store — encrypted, out of the manifest — and leaves the reference vault:${e.key} behind, in one action. ` +
          `Revisions already written keep the old plaintext, so rotate the credential at its source if it may have been seen.`,
        targetId: s.id,
        // `moveExistingValue` is what makes this real: the action reads the
        // value currently in the working copy, stores it, and swaps in the
        // reference — writing the store first, so a failure leaves the
        // plaintext exactly where it is. When the store is unconfigured the
        // plan comes back blocked, naming ORRERY_SECRET_KEY and how to make
        // one; nothing is destroyed on any path.
        //
        // The rule engine deliberately does NOT ask whether the store is
        // configured: `analyze` is pure and its output is cached by content
        // hash, so an env-dependent answer here would go stale. The plan is
        // computed on click and is always current.
        fix: {
          actionId: "system.setSecret",
          input: {
            serviceId: s.id,
            key: e.key,
            moveExistingValue: true,
          },
          label: "Move to the secret store",
        },
      });
    }
  }

  /* 4 — production with no spending ceiling. */
  for (const env of prod) {
    if (env.policies.budgetUsdMonthly) continue;
    const suggested = Math.max(25, Math.ceil((monthlyCostUsd(m) * 1.25) / 5) * 5);
    add({
      id: stableId("no_budget_prod", env.id),
      environmentId: env.id,
      severity: "low",
      title: `${env.name} has no monthly budget`,
      detail: `Nothing caps spend in ${env.name}, so a scale-up or a runaway job shows up on the bill instead of in a warning. Current estimate is $${monthlyCostUsd(m).toFixed(2)}/mo.`,
      fix: {
        actionId: "env.setBudget",
        input: { environmentId: env.id, budgetUsdMonthly: suggested },
        label: `Set a $${suggested}/mo budget`,
      },
    });
  }

  /* 5b — a secret-looking value in a resource's config block. */
  for (const r of m.resources) {
    for (const [k, v] of Object.entries(r.config)) {
      if (typeof v !== "string" || !SECRETISH.test(k) || PLACEHOLDER.test(v.trim())) continue;
      add({
        id: stableId("plaintext_config_secret", `${r.id}:${k}`),
        severity: "high",
        title: `${r.name}.config.${k} is stored in plain text`,
        detail: `${k} looks like a credential but its value sits in ${r.name}'s config, which means it is in every revision, every export and every audit snapshot of this project. Resource config is not redacted anywhere.`,
        targetId: r.id,
      });
    }
  }

  /* 6 — production that applies without a human in the loop. */
  for (const env of prod) {
    if (env.policies.approvalRequired) continue;
    add({
      id: stableId("prod_no_approval", env.id),
      environmentId: env.id,
      severity: "high",
      title: `${env.name} deploys to production with no approval step`,
      detail: `Any editor — or the Navigator at bounded autonomy or above — can change ${env.name} the moment a plan exists. Nothing pauses for a second pair of eyes, and a rollback is a second deploy, not an undo.`,
      fix: {
        actionId: "env.updatePolicies",
        input: { environmentId: env.id, approvalRequired: true },
        label: "Require approval",
      },
    });
  }

  /* 7 — production allowed to destroy stateful resources. */
  for (const env of prod) {
    if (!env.policies.allowStatefulDeletion) continue;
    add({
      id: stableId("prod_stateful_deletion", env.id),
      environmentId: env.id,
      severity: "high",
      title: `${env.name} allows deleting databases, caches and queues`,
      detail: `With allowStatefulDeletion on, a plan that removes a stateful resource from ${env.name} will run. Deleting one destroys its data, and rollback restores the system definition, not the data.`,
      fix: {
        actionId: "env.updatePolicies",
        input: { environmentId: env.id, allowStatefulDeletion: false },
        label: "Block stateful deletion",
      },
    });
  }

  /* 8 — the smallest database size under production load. */
  if (primaryProd) {
    for (const r of m.resources) {
      if (r.kind !== "postgres" || r.ownership !== "managed" || r.size !== "nano") continue;
      add({
        id: stableId("nano_db_prod", r.id),
        environmentId: primaryProd.id,
        severity: "low",
        title: `${r.name} is nano-sized in ${primaryProd.name}`,
        detail: `A nano database has 0.25 vCPU and 256 MB. Under production traffic it becomes the bottleneck long before the services do, and resizing later means a restart.`,
        targetId: r.id,
        fix: {
          actionId: "system.updateResource",
          input: { resourceId: r.id, size: "small" },
          label: "Resize to small",
        },
      });
    }
  }

  return out;
}

type G = typeof globalThis & { __orreryFindingsHash?: Map<string, string> };

/** Everything `analyze` actually reads. Same hash in ⇒ same findings out. */
function inputHash(project: Project, environments: Environment[]): string {
  return hash32(
    JSON.stringify([
      project.workingManifest,
      environments.map((e) => [
        e.id,
        e.name,
        e.class,
        e.policies.budgetUsdMonthly,
        e.policies.approvalRequired,
        e.policies.allowStatefulDeletion,
        // A deploy is what turns "fixed, pending deploy" into "resolved", so a
        // new deployed revision must invalidate this cache too.
        e.deployedRevisionId,
      ]),
    ])
  );
}

/**
 * Findings that are true of what is actually RUNNING, across every environment
 * with a deployed revision. This is the evidence that closes a pending fix:
 * the fix is only real once it is absent from everything that is live.
 */
function liveFindingIds(
  project: Project,
  environments: Environment[]
): { ids: Set<string>; revisionId?: string } {
  const ids = new Set<string>();
  let best: { number: number; id: string } | undefined;
  let deployedAny = false;
  for (const env of environments) {
    const rev = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
    if (!rev) continue;
    deployedAny = true;
    for (const f of analyze(project, environments, rev.manifest)) ids.add(f.id);
    if (!best || rev.number > best.number) best = { number: rev.number, id: rev.id };
  }
  return { ids, revisionId: deployedAny ? best?.id : undefined };
}

/**
 * Recompute findings for a project and reconcile them into the store.
 * Dismissals are keyed by the stable id, so a dismissed finding stays
 * dismissed across recomputation; anything no longer detected disappears.
 * Recomputation is skipped entirely when nothing it reads has changed.
 */
export function syncFindings(projectId: string): SecurityFinding[] {
  const project = q.project(projectId);
  if (!project) return [];
  const mine = (f: SecurityFinding) => f.projectId === project.id;

  // The project screen polls every 5s per open tab; only recompute when the
  // manifest or the environments that findings depend on actually changed.
  const environments = q.environmentsOf(project.id);
  const hash = inputHash(project, environments);
  const seen = ((globalThis as G).__orreryFindingsHash ??= new Map());
  if (seen.get(project.id) === hash) return db().findings.filter(mine);

  const fresh = analyze(project, environments);
  const stored = db().findings.filter(mine);
  const existing = new Map(stored.map((f) => [f.id, f]));
  const freshIds = new Set(fresh.map((f) => f.id));

  const reconciled: SecurityFinding[] = fresh.map((f) => {
    const prior = existing.get(f.id);
    if (!prior) return f;
    // Still detected in the working copy. A dismissal sticks; a "fixed" one
    // clearly is not fixed any more, so it goes back to open rather than
    // reporting closed while the rule fires.
    return {
      ...f,
      status: prior.status === "dismissed" ? "dismissed" : "open",
      createdAt: prior.createdAt,
      ...(prior.status === "dismissed"
        ? {
            resolvedAt: prior.resolvedAt,
            resolvedBy: prior.resolvedBy,
            resolvedReason: prior.resolvedReason,
          }
        : {}),
    };
  });

  // Findings the working copy no longer triggers but the environment might.
  // These survive reconciliation — dropping them is how "fixed" used to mean
  // "gone from the report" while production was still exposed.
  const pending = stored.filter(
    (f) =>
      !freshIds.has(f.id) &&
      (f.status === "fixed_pending_deploy" ||
        (f.status === "resolved" && f.fixedInRevisionId))
  );
  if (pending.some((f) => f.status === "fixed_pending_deploy")) {
    const live = liveFindingIds(project, environments);
    for (const f of pending) {
      if (f.status !== "fixed_pending_deploy") continue;
      if (!live.revisionId || live.ids.has(f.id)) continue; // still live, or nothing deployed
      f.status = "resolved";
      f.fixedInRevisionId = live.revisionId;
    }
  }
  reconciled.push(...pending);

  seen.set(project.id, hash);
  // A recompute that changes nothing must not touch the disk.
  if (JSON.stringify(stored) === JSON.stringify(reconciled)) return stored;

  db().findings = [...db().findings.filter((f) => !mine(f)), ...reconciled];
  save();
  return reconciled;
}

/** Convenience for the Observe/Security screens. */
export const openFindings = (projectId: string): SecurityFinding[] =>
  db().findings.filter((f) => f.projectId === projectId && f.status === "open");
