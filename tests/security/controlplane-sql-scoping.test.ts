/**
 * Static audit: every repository function that touches a tenant table scopes it
 * by `workspace_id` IN SQL (WS-SEC; architecture invariant 2, ground rule 6).
 *
 * `tests/controlplane/tenancy.test.ts` is the dynamic sweep: it runs every
 * function as workspace B against workspace A's rows. This is its independent
 * cross-check, from the other side: it reads the SOURCE of every repository
 * (`src/lib/controlplane/db/repos/*.ts`) and requires that any exported function
 * whose body mentions a tenant table also mentions `workspace_id`. A function
 * that forgets the predicate cannot hide behind a sweep that does not know it
 * exists, and a function that is deliberately unscoped must be named here with
 * the reason — so the set of cross-tenant-capable queries is a reviewed list,
 * not an accident.
 *
 * Limits (honest): this is a text check. It proves the predicate is PRESENT in
 * the function, not that it is correct (that is the sweep's job) and it cannot
 * see SQL built in another module. Tenant tables are discovered from the
 * migrations: every table that has a `workspace_id` column.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(process.cwd(), "src", "lib", "controlplane", "db");
const REPOS = path.join(ROOT, "repos");

/** Tables that carry a `workspace_id` column, read from the migrations. */
function tenantTables(): string[] {
  const tables = new Set<string>();
  for (const file of readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d{4}_.*\.ts$/.test(f))) {
    const text = readFileSync(path.join(ROOT, "migrations", file), "utf8");
    for (const m of text.matchAll(/create table(?: if not exists)? platform\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      if (/\bworkspace_id\b/i.test(m[2])) tables.add(m[1]);
    }
  }
  return [...tables].sort();
}

interface Fn {
  file: string;
  name: string;
  body: string;
}

function functionsOf(file: string): Fn[] {
  const text = readFileSync(path.join(REPOS, file), "utf8");
  const starts = [...text.matchAll(/^export (?:async )?function (\w+)/gm)];
  return starts.map((m, i) => ({ file, name: m[1], body: text.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : text.length) }));
}

/**
 * Functions that touch a tenant table WITHOUT a workspace predicate on purpose,
 * each with the reason. Mirrors EXEMPT in tests/controlplane/tenancy.test.ts —
 * a new entry here needs a security review, not just a reason.
 */
const UNSCOPED: Record<string, string> = {
  "leases.acquire": "keyed by a globally unique scope string; a workspace-tagged scope refuses a foreign workspace",
  "leases.renew": "keyed by scope + holder + fence",
  "leases.release": "keyed by scope + holder + fence",
  "leases.current": "keyed by scope",
  "leases.assertFence": "keyed by scope + fence",
  "nonces.remember": "keyed by agent id (globally unique); never read by tenants",
  "nonces.prune": "system maintenance",
  "idempotency.prune": "system maintenance",
  "operations.markUncertainExpired": "system reconciler; every returned record carries its workspace",
  "operations.expireOverdue": "system reconciler",
  "jobs.expireStale": "system reaper",
  "runners.consumeRegistrationToken": "keyed by the token hash; the workspace comes FROM the token",
  "runners.registerRunner": "the workspace comes from the registration token, never from the caller",
  "machines.registerMachine": "the workspace comes from the registration token, never from the caller",
  "runners.findRunnerForAuth": "the one documented unscoped lookup: a signed request names only the agent id",
  "machines.findMachineForAuth": "the one documented unscoped lookup: a signed request names only the machine id",
  "operations.getForSystem": "execution worker only: a workflow carries just the operation id; every later call uses the workspace of the returned row (callers pinned below)",
};

describe("control-store repositories: workspace scoping is present in every function that touches a tenant table", () => {
  const tables = tenantTables();
  const files = readdirSync(REPOS).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  const fns = files.flatMap(functionsOf);
  const touches = (fn: Fn) => tables.filter((t) => new RegExp(`platform\\.${t}\\b`).test(fn.body));
  const key = (fn: Fn) => `${fn.file.replace(/\.ts$/, "").replace(/-(\w)/g, (_m, c: string) => c.toUpperCase())}.${fn.name}`;

  it("finds the tenant tables and the repository functions this audit is about (so it cannot pass by reading nothing)", () => {
    expect(tables.length).toBeGreaterThanOrEqual(20);
    expect(tables).toEqual(expect.arrayContaining(["operations", "approvals", "capability_grants", "events", "runners", "resources", "provider_connections", "incidents"]));
    expect(fns.length).toBeGreaterThan(80);
    expect(fns.filter((f) => touches(f).length > 0).length).toBeGreaterThan(50);
  });

  it("every function touching a tenant table names workspace_id, or is on the reviewed exemption list", () => {
    const offenders: string[] = [];
    for (const fn of fns) {
      const hit = touches(fn);
      if (hit.length === 0) continue;
      // the SQL column, not the TypeScript parameter: `workspaceId` in a signature proves nothing about the query
      if (/\bworkspace_id\b/.test(fn.body)) continue;
      if (key(fn) in UNSCOPED) continue;
      offenders.push(`${key(fn)} touches ${hit.join(", ")} but never mentions workspace_id`);
    }
    expect(offenders, "SECURITY INVARIANT (tenancy in SQL): scope these queries by workspace_id or add a reviewed entry to UNSCOPED with its reason").toEqual([]);
  });

  it("operations.getForSystem is called only by the execution worker's platform ports (never from a tenant-facing path)", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && readFileSync(p, "utf8").includes("getForSystem")) callers.push(path.relative(process.cwd(), p).split(path.sep).join("/"));
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(callers.filter((f) => !f.startsWith("src/lib/controlplane/")).sort()).toEqual(["src/lib/execution/platform.ts"]);
  });

  it("every UNSCOPED entry still exists (a stale exemption would hide a future function of the same name)", () => {
    const names = new Set(fns.map(key));
    for (const entry of Object.keys(UNSCOPED)) expect(names.has(entry), `${entry} no longer exists; remove its exemption`).toBe(true);
  });

  it("SQL that carries a tenant id takes it as a bound parameter, never by string concatenation", () => {
    const risky: string[] = [];
    for (const fn of fns) {
      // a template literal handed to .query() that interpolates something other than the known constants
      for (const m of fn.body.matchAll(/\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)) {
        for (const interp of m[1].matchAll(/\$\{([^}]*)\}/g)) {
          const expr = interp[1].trim();
          // allowed: column lists, ordering fragments built from constants, parameter indexes ($${n})
          if (/^(?:[A-Z][A-Z0-9_]*|where\.join\(.*\)|params\.length|n|\w+Columns?|columns|set\.join\(.*\)|order\w*)$/.test(expr)) continue;
          if (/^\w*[Cc]olumns?\b/.test(expr) || /^\w+\.join\(/.test(expr) || /length/.test(expr)) continue;
          risky.push(`${key(fn)}: \${${expr}}`);
        }
      }
    }
    expect(risky, "interpolating anything but a constant column list into SQL text is an injection risk: use $n parameters").toEqual([]);
  });
});
