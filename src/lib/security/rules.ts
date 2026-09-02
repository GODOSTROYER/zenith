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
import type {
  Environment,
  Project,
  SecurityFinding,
} from "@/lib/domain/types";

const SECRETISH = /key|secret|token|password|passwd|credential/i;
/** Values that are obviously not real secrets — placeholders and references. */
const PLACEHOLDER = /^(|true|false|\d+|localhost|change_?me|todo|none|null|\$\{.*\}|\/.*)$/i;

function hash32(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const stableId = (rule: string, target: string) => `sf_${rule}_${hash32(`${rule}:${target}`)}`;

/**
 * Analyze a project's working manifest against its environments.
 * Pure apart from the timestamp: pass the same inputs, get the same ids.
 */
export function analyze(project: Project, environments: Environment[]): SecurityFinding[] {
  const m = project.workingManifest;
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
        detail: `${e.key} looks like a credential but its value lives in the manifest, which means it is in every revision, every export and every audit snapshot of this project.`,
        targetId: s.id,
        fix: {
          actionId: "system.setSecret",
          input: {
            serviceId: s.id,
            key: e.key,
            secretRef: `${s.name}/${e.key.toLowerCase()}`,
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

  /* 5 — the smallest database size under production load. */
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
      environments.map((e) => [e.id, e.name, e.class, e.policies.budgetUsdMonthly]),
    ])
  );
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

  const reconciled = fresh.map((f) => {
    const prior = existing.get(f.id);
    return prior
      ? { ...f, status: prior.status === "dismissed" ? "dismissed" : f.status, createdAt: prior.createdAt }
      : f;
  });

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
