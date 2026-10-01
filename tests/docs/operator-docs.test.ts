/**
 * The operator guides (`docs/platform/operations/**`) make claims about the
 * code. These tests tie the checkable ones to the code, so a change that makes a
 * page wrong fails here instead of misleading an operator:
 *
 *  - every file path the guides name exists, every `npm run` script exists;
 *  - every environment variable the platform modules mention is documented in
 *    DEPLOYING.md, and every variable DEPLOYING.md names exists in the code;
 *  - the policy rule names and counts, the workspace defaults and the autonomy
 *    table match the Rego and the catalog;
 *  - the price-catalog counts and the cost engine's included / excluded lists on
 *    COST.md equal what the engine says now;
 *  - the "in progress" claims still hold (when a module lands, a test here fails
 *    and the docs and this table get updated together);
 *  - the index lists every guide, and no "planned" guide already exists.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { estimateGraphCost, loadDefaultCatalog, type CostNode } from "@/lib/placement";
import { DEFAULT_WORKSPACE_POLICY } from "@/lib/policy/types";
import { REPO_ROOT, extractLinks, read, stripFences, walk } from "./markdown";

const OPS = path.join(REPO_ROOT, "docs", "platform", "operations");
const guide = (name: string): string => read(path.join(OPS, name));
const GUIDES = walk(OPS);
const exists = (rel: string): boolean => fs.existsSync(path.join(REPO_ROOT, rel));
const squash = (text: string): string => text.replace(/\s+/g, " ");

/* -------------------------------- structure ------------------------------- */

describe("the guide set", () => {
  it("README.md links every guide in the folder, and the generated matrix", () => {
    const readme = path.join(OPS, "README.md");
    const linked = new Set(extractLinks(readme, read(readme)).map((l) => l.target.split("#")[0]));
    for (const file of GUIDES) {
      const name = path.basename(file);
      if (name === "README.md") continue;
      expect(linked, `README.md should link ${name}`).toContain(name);
    }
    expect(linked).toContain("../CAPABILITY-MATRIX.md");
  });

  it("every guide says what commit it was written against and has an honesty section", () => {
    for (const file of GUIDES) {
      const text = read(file);
      expect(text, path.basename(file)).toMatch(/Written against branch `ws\/docs`/);
    }
    for (const name of ["DEPLOYING.md", "RECOVERY.md"]) {
      expect(guide(name), name).toMatch(/not verified|Not verified|not rehearsed|Not rehearsed/);
    }
  });

  it("contains no placeholders", () => {
    for (const file of [...GUIDES, path.join(REPO_ROOT, "docs", "platform", "CAPABILITY-MATRIX.md")]) {
      expect(read(file), path.basename(file)).not.toMatch(/\bTODO\b|\bTBD\b|\bFIXME\b|lorem ipsum/i);
    }
  });

  it("'planned' guides do not exist yet: a guide that exists is not planned", () => {
    const readme = guide("README.md");
    const start = readme.indexOf("## Planned guides");
    expect(start).toBeGreaterThan(0);
    const section = readme.slice(start, readme.indexOf("\n## ", start + 5));
    const names = [...section.matchAll(/`([A-Z][A-Z-]*\.md)`/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) expect(fs.existsSync(path.join(OPS, name)), `${name} is listed as planned but exists`).toBe(false);
  });
});

/* ------------------------------ paths & scripts ---------------------------- */

/** Paths a guide names precisely because they do NOT exist; their absence is asserted elsewhere. */
const ABSENT_ON_PURPOSE = new Set(["scripts/acceptance/aws-live.ts", "src/lib/runners"]);

const PATH_PREFIX = /^(?:src|docs|scripts|tests|deploy|policy|workers|docker|supabase|\.github)\//;

describe("paths and commands named in the guides", () => {
  it("every repository path in a code span exists", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of GUIDES) {
      const text = stripFences(read(file));
      for (const m of text.matchAll(/`([^`\n]+)`/g)) {
        for (const raw of m[1].split(/\s+/)) {
          const token = raw.replace(/^["'(]+|["'),.;:]+$/g, "");
          if (!PATH_PREFIX.test(token)) continue;
          if (/[<>*{}$|]|\.\.\./.test(token)) continue;
          if (ABSENT_ON_PURPOSE.has(token)) continue;
          checked++;
          if (!exists(token.replace(/\/$/, ""))) missing.push(`${path.basename(file)}: ${token}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });

  it("every `npm run` script named exists in package.json", () => {
    const pkg = JSON.parse(read(path.join(REPO_ROOT, "package.json"))) as { scripts: Record<string, string> };
    const named = new Set<string>();
    for (const file of GUIDES) for (const m of read(file).matchAll(/npm run ([a-z0-9:_-]+)/g)) named.add(m[1]);
    expect([...named].length).toBeGreaterThanOrEqual(4);
    for (const script of named) expect(pkg.scripts, `npm run ${script}`).toHaveProperty([script]);
  });

  it("every script path in a command exists", () => {
    const missing: string[] = [];
    for (const file of GUIDES) {
      for (const m of read(file).matchAll(/(?:npx tsx|node|bash)\s+((?:scripts|policy|src|workers|docker)\/[A-Za-z0-9_./-]+)/g)) {
        if (!exists(m[1])) missing.push(`${path.basename(file)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

/* ------------------------------ environment ------------------------------- */

/** Names that look like environment variables but are not (and why). */
const NOT_ENVIRONMENT: Record<string, string> = {
  ZENITH_CHAOS: "a manifest env key for sandbox failure injection, not read from the process environment",
  ZENITH_SKUS: "a constant table in placement/capabilities.ts",
  ZENITH_RUNNER_STORE: "named in a stale comment in runners/memory-store.ts; no code reads it",
  ZENITH_IMAGE_DIGEST: "a variable inside the customer-account CodeBuild build (the buildspec), not the control plane's environment",
  ZENITH_SOURCE_DIGEST: "a variable inside the customer-account CodeBuild build (the buildspec), not the control plane's environment",
  ZENITH_DOCKERFILE: "a variable inside the customer-account CodeBuild build (the buildspec), not the control plane's environment",
  ZENITH_REPO_URL: "a variable inside the customer-account CodeBuild build (the buildspec), not the control plane's environment",
  ZENITH_SITE_BUCKET: "a variable inside the customer-account CodeBuild build (the buildspec), not the control plane's environment",
  ZENITH_DISTRIBUTION_ID: "a variable inside the customer-account CodeBuild build (the buildspec), not the control plane's environment",
  ZENITH_SSM_DOCUMENTS: "a constant table of SSM document definitions in machines/transports/aws-ssm-docs.ts",
  ZENITH_SSM_DOCUMENT_SUFFIXES: "a constant list in machines/transports/aws-ssm-docs.ts",
  ZENITH_TEST_KIND: "a test-only gate for the kind-cluster test, named in a comment",
  ZENITH_EXTRA_KINDS: "a constant table of extra Kubernetes kinds in providers/zenith/k8s-port.ts",
};

describe("environment variables", () => {
  const MODULE_ROOTS = [
    "src/lib/controlplane",
    "src/lib/credentials",
    "src/lib/tofu",
    "src/lib/policy",
    "src/lib/workflows",
    "src/lib/placement",
    "src/lib/resources",
    "src/lib/observability",
    "src/lib/incidents",
    "src/lib/reconcile",
    "src/lib/capabilities",
    "src/lib/runners",
    "src/app/api/platform",
    "src/lib/providers/aws/drivers",
    "src/lib/providers/gcp",
    "src/lib/providers/azure",
    "src/lib/providers/oci",
    "src/lib/providers/kubernetes",
    "src/lib/providers/zenith",
    "src/lib/execution",
    "src/lib/machines",
    "src/lib/analysis",
    "src/lib/capabilities",
    "src/lib/drivers",
    "workers/execution",
    "scripts/platform",
  ];
  const TOKEN = /\bZENITH_[A-Z][A-Z0-9_]*[A-Z0-9]\b/g;

  function tokensIn(rel: string): Set<string> {
    const out = new Set<string>();
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) return out;
    const files = fs.statSync(abs).isDirectory() ? [...walk(abs, ".ts"), ...walk(abs, ".tsx"), ...walk(abs, ".mjs"), ...walk(abs, ".cjs")] : [abs];
    for (const f of files) for (const m of read(f).matchAll(TOKEN)) out.add(m[0]);
    return out;
  }

  it("every ZENITH_* name in the platform modules is documented in DEPLOYING.md (or is known not to be a variable)", () => {
    const deploying = guide("DEPLOYING.md");
    const found = new Set<string>();
    for (const root of [...MODULE_ROOTS, "policy/build.mjs", "docker/worker.Dockerfile"]) for (const t of tokensIn(root)) found.add(t);
    expect(found.size).toBeGreaterThan(20);
    const undocumented = [...found].filter((t) => !deploying.includes(t) && !(t in NOT_ENVIRONMENT));
    expect(undocumented).toEqual([]);
    // the allow-list is not allowed to go stale either
    for (const name of Object.keys(NOT_ENVIRONMENT)) expect(found.has(name), `${name} is allow-listed but no longer appears in the code`).toBe(true);
  });

  it("every ZENITH_* name DEPLOYING.md mentions exists in the code", () => {
    const deploying = guide("DEPLOYING.md");
    const named = new Set([...deploying.matchAll(TOKEN)].map((m) => m[0]));
    const codeRoots = ["src", "workers", "scripts", "policy", "docker", "tests", ".github"];
    const known = new Set<string>();
    for (const root of codeRoots) for (const t of tokensIn(root)) known.add(t);
    const ghost = [...named].filter((n) => !known.has(n));
    expect(ghost).toEqual([]);
  });

  it("the documented defaults match the code", () => {
    const deploying = squash(guide("DEPLOYING.md"));
    expect(deploying).toContain("`localhost:7233`");
    expect(deploying).toContain("`zenith-execution`");
    expect(deploying).toContain("| `ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES` | `8` |");
    expect(deploying).toContain("| `ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS` | `40` |");
    expect(deploying).toContain("| `ZENITH_WORKER_SHUTDOWN_GRACE_MS` | `600000` |");
    expect(deploying).toContain("| `ZENITH_WORKER_HEARTBEAT_THROTTLE_MS` | `10000` |");
    expect(deploying).toContain("| `ZENITH_PLATFORM_DB_MAX` | `5` |");
    expect(deploying).toContain("`1.12.5`");
    const config = read(path.join(REPO_ROOT, "workers", "execution", "config.ts"));
    expect(config).toContain('"ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES", 8');
    expect(config).toContain('"ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS", 40');
    expect(config).toContain('"ZENITH_WORKER_SHUTDOWN_GRACE_MS", 600_000');
    expect(config).toContain('"ZENITH_WORKER_HEARTBEAT_THROTTLE_MS", 10_000');
    expect(read(path.join(REPO_ROOT, "src", "lib", "controlplane", "db", "executor.ts"))).toContain("max: opts.max ?? 5");
    expect(read(path.join(REPO_ROOT, "src", "lib", "tofu", "types.ts"))).toContain('TOFU_VERSION = "1.12.5"');
  });
});

/* --------------------------------- policy --------------------------------- */

describe("POLICY.md matches the Rego, the defaults and the catalog", () => {
  const policy = guide("POLICY.md");
  const rules = (file: string): string[] =>
    [...read(path.join(REPO_ROOT, "policy", "rego", file)).matchAll(/^([a-z][a-z_]*) := /gm)].map((m) => m[1]).sort();
  const deny = rules("deny.rego");
  const approval = rules("approval.rego");
  const constraints = rules("constraints.rego");

  it("states the rule counts the Rego has, and names every rule", () => {
    const counts = /(\d+) deny rules, (\d+) approval rules and (\d+) constraint rules/.exec(squash(policy));
    expect(counts, "POLICY.md states the rule counts").not.toBeNull();
    expect([Number(counts![1]), Number(counts![2]), Number(counts![3])]).toEqual([deny.length, approval.length, constraints.length]);
    for (const name of [...deny, ...approval, ...constraints]) expect(policy, `rule ${name}`).toContain(`\`${name}\``);
  });

  it("states the workspace defaults the code has", () => {
    const row = (name: string): string => policy.split("\n").find((l) => l.startsWith(`| \`${name}\``)) ?? "";
    expect(row("costApprovalThresholdUsd")).toContain(`\`${DEFAULT_WORKSPACE_POLICY.costApprovalThresholdUsd}\``);
    expect(row("allowEscapeHatchInProduction")).toContain(`\`${DEFAULT_WORKSPACE_POLICY.allowEscapeHatchInProduction}\``);
    expect(row("twoPersonProduction")).toContain(`\`${DEFAULT_WORKSPACE_POLICY.twoPersonProduction}\``);
    for (const [klass, mode] of Object.entries(DEFAULT_WORKSPACE_POLICY.autoRemediation)) expect(row("autoRemediation")).toContain(`${klass} \`${mode}\``);
    expect(DEFAULT_WORKSPACE_POLICY.deniedCapabilities).toEqual([]);
    expect(DEFAULT_WORKSPACE_POLICY.approvedRegions).toBeUndefined();
    expect(DEFAULT_WORKSPACE_POLICY.budgetUsdMonthly).toBeUndefined();
  });

  it("the autonomy table lists, for levels 3 to 5, exactly the mutating capabilities the catalog assigns", () => {
    for (const level of [3, 4, 5]) {
      const line = policy.split("\n").find((l) => l.startsWith(`| ${level} |`));
      expect(line, `autonomy row ${level}`).toBeDefined();
      const named = new Set([...line!.matchAll(/`([a-z]+\.[A-Za-z.]+)`/g)].map((m) => m[1]));
      const expected = Object.values(CAPABILITIES)
        .filter((c) => c.mutates && c.defaultAutonomy === level)
        .map((c) => c.name);
      expect([...named].sort()).toEqual(expected.sort());
    }
    for (const c of Object.values(CAPABILITIES).filter((c) => c.mutates && c.defaultAutonomy === 6)) expect(policy).toContain(`\`${c.name}\``);
  });

  it("states the broker's autonomy defaults by environment class, and the level a never-configured store reads", () => {
    const autonomy = read(path.join(REPO_ROOT, "src", "lib", "capabilities", "autonomy.ts"));
    const body = /DEFAULT_AUTONOMY_BY_CLASS[^=]*=\s*\{([^}]*)\}/.exec(autonomy);
    expect(body, "DEFAULT_AUTONOMY_BY_CLASS in autonomy.ts").not.toBeNull();
    const levels = Object.fromEntries([...body![1].matchAll(/(\w+):\s*(\d)/g)].map((m) => [m[1], Number(m[2])]));
    expect(Object.keys(levels).sort()).toEqual(["development", "production", "sandbox", "staging"]);
    expect(squash(policy)).toContain(`production ${levels.production}, staging ${levels.staging}, development ${levels.development}, sandbox ${levels.sandbox}`);
    expect(read(path.join(REPO_ROOT, "src", "lib", "controlplane", "db", "repos", "settings.ts"))).toContain("DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 1");
    expect(squash(policy)).toContain("`DEFAULT_AUTONOMY_LEVEL`");
  });

  it("does not claim a level the store would refuse", () => {
    const migration = read(path.join(REPO_ROOT, "src", "lib", "controlplane", "db", "migrations", "0001_core.ts"));
    expect(migration).toContain("autonomy_level between 0 and 5");
  });
});

/* ---------------------------------- cost ---------------------------------- */

describe("COST.md matches the catalog and the engine", () => {
  const cost = guide("COST.md");
  const catalog = loadDefaultCatalog();

  it("names the catalog version", () => {
    expect(cost).toContain(`**\`${catalog.version}\`**`);
  });

  it("its entries-by-provider-and-class table equals the bundled catalog", () => {
    const counts = new Map<string, number>();
    for (const e of catalog.entries) counts.set(`${e.provider}|${e.verification}`, (counts.get(`${e.provider}|${e.verification}`) ?? 0) + 1);
    const start = cost.indexOf("### What the catalog holds today");
    expect(start).toBeGreaterThan(0);
    const section = cost.slice(start, cost.indexOf("\n###", start + 5) === -1 ? undefined : cost.indexOf("\n###", start + 5));
    const documented = new Map<string, number>();
    for (const m of section.matchAll(/^\| (\w+) \| (\w+) \| (\d+) \|$/gm)) {
      if (m[1] === "Provider") continue;
      documented.set(`${m[1]}|${m[2]}`, Number(m[3]));
    }
    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(counts));
  });

  it("lists the engine's included and excluded lines verbatim", () => {
    const node = (address: string, kind: CostNode["kind"], provider: string, region: string, spec: Record<string, unknown> = {}, ownership: CostNode["ownership"] = "managed"): CostNode => ({ address, kind, provider, region, spec, ownership });
    const estimate = estimateGraphCost(
      {
        nodes: [
          node("network/main", "network", "aws", "us-east-1"),
          node("load_balancer/edge", "load_balancer", "aws", "us-east-1"),
          node("service/web", "container_service", "aws", "us-east-1", { size: "small", replicas: 2 }),
          node("resource/db", "postgres", "aws", "us-east-1", { size: "small", storageGb: 20, backupRetentionDays: 7 }),
          node("resource/assets", "object_store", "aws", "us-east-1", { storageGb: 10 }),
          node("fn/x", "function", "aws", "us-east-1"),
          node("resource/m", "mysql", "aws", "us-east-1", { size: "small" }),
          node("k/x", "container_service", "kubernetes", "x"),
          node("ext/bucket", "object_store", "aws", "us-east-1", {}, "referenced"),
        ],
        edges: [
          { from: "load_balancer/edge", to: "service/web", relation: "routes_to" },
          { from: "service/web", to: "resource/db", relation: "connects_to" },
        ],
      },
      { catalog }
    );
    expect(estimate.kind).toBe("estimate");
    expect(estimate.included.length).toBeGreaterThanOrEqual(8);
    expect(estimate.excluded.length).toBeGreaterThanOrEqual(15);
    const lines = new Set(cost.split("\n"));
    for (const line of [...estimate.included, ...estimate.excluded]) expect(lines.has(line), `COST.md should list: ${line}`).toBe(true);
    // the three "also, when present" inclusions are still the engine's words
    const source = read(path.join(REPO_ROOT, "src", "lib", "placement", "cost.ts"));
    for (const phrase of ["Cross-region and cross-cloud transfer between components", "Provisioned IOPS", "High-availability standby capacity"]) {
      expect(source).toContain(phrase);
      expect(cost).toContain(phrase);
    }
  });

  it("describes the evidence classes the catalog code defines", () => {
    for (const cls of ["official_api", "official_page", "third_party_mirror", "derived", "model_knowledge", "internal_assumption"]) expect(cost).toContain(`\`${cls}\``);
    expect(read(path.join(REPO_ROOT, "src", "lib", "placement", "solver.ts"))).toContain("WEAK_EVIDENCE_WARN_SHARE = 0.25");
    expect(cost).toContain("25 %");
  });

  it("is right that only estimates exist: the store refuses anything else, and the product still uses the old table", () => {
    expect(read(path.join(REPO_ROOT, "src", "lib", "controlplane", "db", "repos", "cost.ts"))).toContain('estimate.kind !== "estimate"');
    expect(read(path.join(REPO_ROOT, "src", "app", "(product)", "p", "[slug]", "observe", "cost-card.tsx"))).toContain("@/lib/cost");
  });
});

/* ------------------------- "in progress" claims hold ----------------------- */

/**
 * Each row is a statement the guides make about what has NOT landed. When one
 * fails, the module landed: write its guide, update README.md's lists and the
 * status tables in DEPLOYING.md, then change this table.
 */
describe("the 'in progress' claims still hold", () => {
  const callers = (needle: RegExp, roots: string[]): string[] => {
    const hits: string[] = [];
    for (const root of roots) {
      const abs = path.join(REPO_ROOT, root);
      if (!fs.existsSync(abs)) continue;
      for (const f of [...walk(abs, ".ts"), ...walk(abs, ".tsx")]) if (needle.test(read(f))) hits.push(path.relative(REPO_ROOT, f).replace(/\\/g, "/"));
    }
    return hits;
  };

  it("drivers are merged and nothing in the application registers them", () => {
    const providers = path.join(REPO_ROOT, "src", "lib", "providers");
    const dirs = fs.readdirSync(providers, { withFileTypes: true }).filter((d) => d.isDirectory());
    const indexes = dirs.filter((d) => fs.existsSync(path.join(providers, d.name, "drivers", "index.ts"))).map((d) => d.name);
    // every provider has a provider-level index (AWS's composes its network, compute and data groups)
    expect(indexes).toEqual(["aws", "azure", "gcp", "kubernetes", "oci", "zenith"]);
    expect(fs.readdirSync(path.join(providers, "aws", "drivers"), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "shared").map((d) => d.name).sort()).toEqual(["compute", "data", "network"]);
    // nothing outside the provider modules calls a register function
    const register = /^(?!\s*(?:\*|\/\/)).*\bregister(?:Aws|Gcp|Azure|Oci|Kubernetes|Zenith|ZenithManaged)Drivers\s*\(/m;
    const hits = callers(register, ["src/app", "src/components", "workers", "src/lib/workflows", "src/lib/capabilities", "src/lib/runners", "src/lib/execution", "src/lib/reconcile", "src/lib/machines", "src/lib/controlplane"]);
    expect(hits).toEqual([]);
  });

  it("the broker, REST, the runner plane, the machine plane and MCP v3 have merged; the connections route has not", () => {
    expect(exists("src/lib/capabilities/broker.ts")).toBe(true);
    expect(exists("src/lib/runners/service.ts")).toBe(true);
    for (const route of ["capabilities/propose", "operations/[id]/approve", "environments/[id]/autonomy", "workspace/policy", "runners/register", "machines/register"]) {
      expect(exists(`src/app/api/platform/v1/${route}/route.ts`), route).toBe(true);
    }
    expect(exists("src/lib/machines/service.ts")).toBe(true);
    expect(exists("src/lib/machines/transports/aws-ssm.ts")).toBe(true);
    // only the execution activities call it (machine capabilities run inside a workflow, with a grant)
    expect(callers(/executeMachineOperation|createMachineDrivers/, ["src/app", "src/components", "workers", "src/lib/workflows", "src/lib/capabilities", "src/lib/runners", "src/lib/execution", "src/lib/reconcile"])).toEqual(["src/lib/execution/capability.ts"]);
    expect(exists("src/app/api/platform/v1/connections")).toBe(false);
    expect(exists("src/app/api/agent/v3/mcp/route.ts")).toBe(true);
    expect(exists("docs/platform/MCP.md")).toBe(true);
  });

  it("the broker is joined to the store and the policy engine, and to nothing that executes", () => {
    const platform = read(path.join(REPO_ROOT, "src", "lib", "capabilities", "platform.ts"));
    expect(platform).toContain("platformDb");
    expect(platform).toContain("loadPolicyEngine");
    expect(platform).toContain("ZENITH_PLATFORM_BROKER_MEMORY");
    // nothing starts a workflow: only the workflows module and the worker import the client
    expect(callers(/@\/lib\/workflows\/client/, ["src/app", "src/components", "src/lib/capabilities", "src/lib/runners", "src/lib/reconcile", "workers"])).toEqual([]);
    expect(callers(/startDeploy|startDayTwo|startRemediation/, ["src/app", "src/lib/capabilities", "src/lib/runners"])).toEqual([]);
    // over REST the plan never comes from the body
    expect(read(path.join(REPO_ROOT, "src", "app", "api", "platform", "v1", "capabilities", "propose", "route.ts"))).toContain('via: "rest"');
    expect(read(path.join(REPO_ROOT, "src", "lib", "capabilities", "evaluate.ts"))).toContain("plan_required");
  });

  it("the integration gaps the guides report are still there, and the migration count is what they say", () => {
    // 1. CLOSED: the middleware lets classified bearer and agent-signed platform paths through
    expect(read(path.join(REPO_ROOT, "src", "middleware.ts"))).toContain("isPlatformBearerRequest");
    expect(read(path.join(REPO_ROOT, "src", "middleware.ts"))).toContain("isAgentSignedPath");
    // 2. CLOSED: the policy bundle is traced into serverless builds and copied into the worker image
    expect(read(path.join(REPO_ROOT, "next.config.ts"))).toContain("outputFileTracingIncludes");
    expect(read(path.join(REPO_ROOT, "next.config.ts"))).toContain("policy/dist");
    expect(read(path.join(REPO_ROOT, "docker", "worker.Dockerfile"))).toContain("policy/dist");
    // 3. the migrations the guides count: core, reconcile, machine_requests and approval_rounds (4)
    const index = read(path.join(REPO_ROOT, "src", "lib", "controlplane", "db", "migrations", "index.ts"));
    expect(index).toContain("[migration0001Core, migration0002Reconcile, migration0003MachineRequests, migration0004ApprovalRounds]");
    expect(read(path.join(REPO_ROOT, "src", "lib", "controlplane", "db", "migrations", "0004_approval_rounds.ts"))).toContain("version: 4,");
    expect(squash(guide("DEPLOYING.md"))).toContain("Four migrations exist today");
    expect(guide("DEPLOYING.md")).toContain("src/middleware.ts");
  });

  it("the Go agents have merged and have operator guides of their own (the guides link them rather than describe them)", () => {
    expect(exists("go/cmd/zenith-runner/main.go")).toBe(true);
    expect(exists("go/cmd/zenithd/main.go")).toBe(true);
    expect(exists("docs/platform/RUNNER.md")).toBe(true);
    expect(exists("docs/platform/ZENITHD.md")).toBe(true);
    for (const name of ["DEPLOYING.md", "README.md"]) expect(guide(name), name).toContain("RUNNER.md");
  });

  it("the reconciliation controller is merged but not driven: no wiring, no schedule", () => {
    expect(exists("src/lib/reconcile/index.ts")).toBe(true);
    expect(exists("src/app/api/internal/tick/reconcile/route.ts")).toBe(true);
    expect(callers(/^(?!\s*\*|\s*\/\/).*\bwireReconcilePorts\(/m, ["src/app", "src/components", "workers", "scripts"])).toEqual([]);
    const tick = read(path.join(REPO_ROOT, ".github", "workflows", "tick.yml"));
    expect(/for pass in [^\n]*reconcile/.test(tick)).toBe(false);
    expect(read(path.join(REPO_ROOT, "vercel.json"))).not.toContain("reconcile");
  });

  it("the real activities exist as a library and the worker still registers the stubs", () => {
    expect(exists("src/lib/execution/activities.ts")).toBe(true);
    const worker = read(path.join(REPO_ROOT, "workers", "execution", "worker.ts"));
    expect(worker).toContain("createActivities(");
    expect(worker).not.toContain("createExecutionActivities");
    expect(callers(/createExecutionActivities\s*\(/, ["src/app", "workers", "src/lib/capabilities", "src/lib/runners", "src/lib/workflows"])).toEqual([]);
  });

  it("every activity the worker registers is still a stub", () => {
    const activities = read(path.join(REPO_ROOT, "src", "lib", "workflows", "activities", "index.ts"));
    const body = activities.slice(activities.indexOf("const activities:"), activities.indexOf("return withFailureMapping"));
    const entries = [...body.matchAll(/^\s+(\w+): (.+),$/gm)];
    expect(entries.length).toBeGreaterThanOrEqual(19);
    expect(entries.filter((e) => !e[2].startsWith("stub("))).toEqual([]);
    expect(activities).toContain("notImplemented");
  });

  it("the worker and the workflows open neither the platform store nor the policy engine, and nothing calls the incident engine", () => {
    // `import type` is a contract, not a call: the UI components take control-plane types as props
    const runtimeImport = (module: string): RegExp => new RegExp(`^import\\s+(?!type\\b)[^;]*?from\\s+["']${module}`, "m");
    expect(callers(runtimeImport("@/lib/controlplane/db"), ["workers", "src/lib/workflows", "src/components"])).toEqual([]);
    expect(callers(/loadPolicyEngine/, ["src/components", "workers", "src/lib/workflows"])).toEqual([]);
    expect(callers(runtimeImport("@/lib/incidents"), ["src/app", "workers", "src/lib/workflows", "src/lib/controlplane", "src/lib/capabilities", "src/lib/runners"])).toEqual([]);
  });

  it("no page or route renders the platform UI components", () => {
    expect(callers(/@\/components\/platform/, ["src/app"])).toEqual([]);
  });

  it("nothing calls the reconciler or the job reaper on a timer", () => {
    expect(callers(/reconcileOperations|expireStale|reapExpiredJobs/, ["src/app", "workers", "scripts"])).toEqual([]);
  });

  it("the live-acceptance harness statement in README.md matches the filesystem", () => {
    const present = exists("scripts/acceptance/aws-live.ts");
    expect(squash(guide("README.md")).includes("is not present on this branch")).toBe(!present);
    expect(exists(".github/workflows/live-acceptance.yml")).toBe(true);
  });
});
