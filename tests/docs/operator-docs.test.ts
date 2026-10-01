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
 *  - composition, worker startup, scheduled passes, UI and provider limits
 *    match the current code, so removing wiring fails a documented claim;
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

  it("every guide names this sync snapshot and the deployment/recovery limits", () => {
    for (const file of GUIDES) {
      const text = read(file);
      expect(text, path.basename(file)).toContain("Written against branch `ws/docs-sync`");
      expect(text, path.basename(file)).toContain("`e3ea61a`");
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
  ZENITH_FIXED_PYTHON: "a fixed heredoc delimiter in machines/transports/azure-scripts.ts, never an environment variable",
};

describe("environment variables", () => {
  const MODULE_ROOTS = [
    "src/lib/controlplane",
    "src/lib/platform",
    "src/lib/bridge",
    "src/lib/sdk",
    "src/cli",
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

  it("is right that only estimates exist: the store refuses bills, and legacy cost screens keep the old table", () => {
    expect(read(path.join(REPO_ROOT, "src", "lib", "controlplane", "db", "repos", "cost.ts"))).toContain('estimate.kind !== "estimate"');
    expect(read(path.join(REPO_ROOT, "src", "app", "(product)", "p", "[slug]", "observe", "cost-card.tsx"))).toContain("@/lib/cost");
  });
});

/* ------------------------- current wiring claims -------------------------- */

/** Current guide claims pin the actual composition calls, plus honest remaining limits. */
describe("operator claims match current wiring", () => {
  const source = (rel: string): string => read(path.join(REPO_ROOT, rel));
  const deploying = squash(guide("DEPLOYING.md"));
  const callers = (needle: RegExp, roots: string[]): string[] => {
    const hits: string[] = [];
    for (const root of roots) {
      const abs = path.join(REPO_ROOT, root);
      if (!fs.existsSync(abs)) continue;
      for (const f of [...walk(abs, ".ts"), ...walk(abs, ".tsx")]) if (needle.test(read(f))) hits.push(path.relative(REPO_ROOT, f).replace(/\\/g, "/"));
    }
    return hits;
  };

  it("the application and execution root call all six provider registrars", () => {
    const drivers = source("src/lib/platform/drivers.ts");
    for (const provider of ["Aws", "Gcp", "Azure", "Oci", "Kubernetes", "Zenith"]) {
      expect(drivers).toMatch(new RegExp(`\\bregister${provider}Drivers\\(`));
    }
    const aws = source("src/lib/providers/aws/drivers/index.ts");
    expect(aws).toContain("[...networkDrivers, ...COMPUTE_DRIVERS, ...awsDataDrivers, snsTopicDriver, ebsVolumeDriver, eksClusterDriver]");
    expect(aws).toContain("for (const driver of awsDrivers) registerDriver(");
    for (const file of ["app.ts", "execution.ts"]) expect(source(`src/lib/platform/${file}`)).toContain("registerAllDrivers();");
    expect(deploying).toContain("src/lib/platform/drivers.ts");
  });

  it("app composition configures durable broker, scope, runner and reconcile ports", () => {
    const app = source("src/lib/platform/app.ts");
    for (const call of ["assertPlatformSchemaCurrent(sql)", "registerPlatformBrokerStore(new PlatformBrokerStore(sql))", "registerPlatformBrokerPorts({ scopes: platformScopeResolver(sql) })", "configureRunnerRuntime(runnerPorts(sql))", "wireReconcilePorts(() => composeReconcilePorts(sql, credentials))", "registerCredentialBroker(credentials, agentPorts.observability)", "registerInvestigator(agentPorts.investigator)"]) {
      expect(app).toContain(call);
    }
    expect(app).toContain('platformDbConfigFromEnv().source === "default"');
    expect(source("src/lib/capabilities/platform.ts")).toContain("loadPolicyEngine(");
    expect(source("src/lib/platform/broker.ts")).toContain("readPlanEvidence(");
    expect(guide("POLICY.md")).toContain("src/lib/platform/broker.ts");
  });

  it("worker activities delegate to composed implementations; stubs are test-only", () => {
    const factory = source("src/lib/workflows/activities/index.ts");
    const production = factory.slice(factory.indexOf("export function createActivities("), factory.indexOf("export function createStubActivities("));
    expect(production).toContain("return composeExecutionActivities(deps)");
    expect(production).not.toContain("stub(");
    expect(factory).toContain("export function createStubActivities(");
    const worker = source("workers/execution/worker.ts");
    for (const call of ["validateExecutionConfiguration()", "openExecutionStore()", "ensurePlatformApp(db)", "createActivities({ db", "Context.current().heartbeat(detail)", "Context.current().cancellationSignal"]) expect(worker).toContain(call);
    expect(worker).not.toContain("createStubActivities");
    const composition = source("src/lib/platform/execution.ts");
    for (const call of ["derivePlanFingerprintKey(opts.secretKey)", "createExecutionActivities(deps)", "createPlatformPorts(opts.db)", "createExecutionBroker(opts.db)", "platformCredentialBroker(opts.db)", "createReconcileObserveActivity("]) expect(composition).toContain(call);
    expect(composition).toContain("tofu: { planWorkspace, applyVerifiedPlan }");
    expect(deploying).toContain("createStubActivities");
  });

  it("startup validates explicit configuration and schema before connecting to Temporal", () => {
    const startup = source("workers/execution/startup.ts");
    for (const value of ["ZENITH_TEMPORAL_ADDRESS", "ZENITH_SECRET_KEY", "getControlSigner(env)", 'platformDbConfigFromEnv(env).source !== "default"', "assertPlatformSchemaCurrent(db)", "MIGRATE_COMMAND"]) expect(startup).toContain(value);
    const worker = source("workers/execution/worker.ts");
    expect(worker.indexOf("await validateExecutionConfiguration()")).toBeLessThan(worker.indexOf("await NativeConnection.connect("));
    expect(worker.indexOf("await openExecutionStore()")).toBeLessThan(worker.indexOf("await NativeConnection.connect("));
    const execution = source("src/lib/platform/execution.ts");
    expect(execution).toContain('/^[a-f0-9]{64}$/i.test(secretKey)');
    expect(execution).toContain('"zenith.tofu.plan.fingerprint.v1"');
    expect(worker).toContain('process.env.ZENITH_WORKER_PLAN_DIR ?? path.join(process.env.ZENITH_DATA ?? ".data", "platform-plans")');
    expect(deploying).toContain("`ZENITH_WORKER_PLAN_DIR`");
    expect(deploying).toContain("64 hex characters");
  });

  it("the worker identity default satisfies the runtime's lease-holder rule, and the guide says so", () => {
    expect(source("workers/execution/config.ts")).toContain("const WORKER_IDENTITY = /^[A-Za-z0-9._-]{1,64}$/");
    expect(source("src/lib/execution/runtime.ts")).toContain("const WORKER_ID = /^[A-Za-z0-9._-]{1,64}$/");
    expect(squash(deploying)).toContain("`ZENITH_WORKER_IDENTITY` is optional");
  });

  it("deploy bridge, MCP and allowed reconcile repairs claim and start workflows", () => {
    const bridge = source("src/lib/bridge/lifecycle.ts");
    expect(bridge).toContain("beginExecution(");
    expect(bridge).toContain("deps.workflows.startDeploy(");
    expect(source("src/lib/bridge/deps.ts")).toContain('import("@/lib/workflows/client")');
    const mcp = source("src/lib/agent-access/v3/tools/execute.ts");
    expect(mcp).toContain("beginExecution(");
    expect(mcp).toContain("ctx.ports.workflows.startDeploy(");
    expect(mcp).toContain("ctx.ports.workflows.startDayTwo(");
    const reconcile = source("src/lib/platform/reconcile.ts");
    expect(reconcile).toContain("beginExecution(");
    expect(reconcile).toContain("await startDayTwo(");
    expect(source("src/lib/reconcile/repair.ts")).toContain("ports.startRepair(");
    expect(deploying).toContain("Allowed repairs call `startDayTwo`");
  });

  it("REST apply/destroy still requires execution-supplied plan facts", () => {
    expect(source("src/app/api/platform/v1/capabilities/propose/route.ts")).toContain('via: "rest"');
    expect(source("src/lib/capabilities/evaluate.ts")).toContain("plan_required");
    expect(deploying).toContain("`plan_required`");
    const broker = source("src/lib/platform/broker.ts");
    expect(broker).toContain("operationPlanReview(reviewed)");
    expect(broker).toContain("approvalRoundOf(a) === round");
    expect(broker).toContain("if (op.planDigest && round === 0) return { approved: false, rejected }");
    expect(guide("POLICY.md")).toContain("current approval round");
  });

  it("closed middleware/bundle gaps stay closed and five migrations are documented", () => {
    const middleware = source("src/middleware.ts");
    expect(middleware).toContain("isPlatformBearerRequest");
    expect(middleware).toContain("isAgentSignedPath");
    const next = source("next.config.ts");
    expect(next).toContain("outputFileTracingIncludes");
    expect(next).toContain("policy/dist");
    expect(source("docker/worker.Dockerfile")).toContain("policy/dist");
    expect(source("src/lib/controlplane/db/migrations/index.ts")).toContain("[migration0001Core, migration0002Reconcile, migration0003MachineRequests, migration0004ApprovalRounds, migration0005ReadJobs]");
    expect(deploying).toContain("Five migrations exist today");
    expect(deploying).toContain("all five migrations");
  });

  it("reconcile ports are composed after cron auth and its tick is scheduled", () => {
    const route = source("src/app/api/internal/tick/reconcile/route.ts");
    expect(route).toContain("await ensurePlatformCron()");
    expect(route.indexOf("authorizeCron(req)")).toBeLessThan(route.indexOf("await ensurePlatformCron()"));
    expect(route).toContain("await reconcilePass(");
    const tick = source(".github/workflows/tick.yml");
    expect(tick).toMatch(/for pass in [^\n]*\breconcile\b/);
    expect(tick).toContain('cron: "*/5 * * * *"');
    expect(deploying).toContain("every five minutes");
    expect(deploying).toContain("`.github/workflows/tick.yml`");
  });

  it("cron reaps expired jobs and atomically marks owning operations uncertain", () => {
    const cron = source("src/lib/server/cron.ts");
    expect(cron).toContain("await platformRunnerReaperPass()");
    expect([...cron.matchAll(/await reapPlatformJobs\(\)/g)]).toHaveLength(2);
    const app = source("src/lib/platform/app.ts");
    expect(app).toContain("return db.tx(async (tx)");
    expect(app).toContain("await reapExpiredJobs(runnerPorts(tx))");
    expect(app).toContain("await ops.markUncertain(");
    expect(guide("RECOVERY.md")).toContain("same transaction");
    // The ledger backstop runs only in the leased housekeeping pass.
    expect(callers(/\breconcileOperations\s*\(/, ["src/app", "src/lib/platform", "src/lib/server", "workers", "scripts"])).toEqual(["src/lib/platform/housekeeping.ts"]);
    expect(deploying).toContain("runs in the leased housekeeping pass");
  });

  it("platform pages render stored state and protect browser AWS/policy actions", () => {
    const rendered = callers(/@\/components\/platform/, ["src/app/(product)/platform"]);
    for (const file of ["page.tsx", "operations/[id]/page.tsx", "environments/[id]/environment-state.tsx", "environments/[id]/incidents/page.tsx", "connections/aws/aws-flow.tsx", "settings/policy-editor.tsx", "placement/placement-planner.tsx"]) {
      expect(rendered).toContain(`src/app/(product)/platform/${file}`);
    }
    const aws = source("src/app/(product)/platform/connections/aws/action/route.ts");
    expect(aws).toContain("await assertBrowserSession(req)");
    expect(aws).toContain("requireWorkspace().id !== caller.workspaceId");
    expect(aws).toContain('"connection.createAws", "connection.verifyAws"');
    expect(exists("src/app/api/platform/v1/connections")).toBe(false);
    expect(deploying).toContain("No standalone `/api/platform/v1/connections` route exists");
    const actions = source("src/app/(product)/platform/operations/[id]/operation-actions.tsx");
    expect(actions).toContain("plan={plan}");
    const card = source("src/components/platform/approval-card.tsx");
    expect(card).toContain("const missingPlan = boundPlanDigest && !plan");
    expect(card).toContain("plan.planDigest !== boundPlanDigest");
    expect(card).toContain("const approveBlocked = approveDisabledReason ?? missingPlan");
    expect(deploying).toContain("plan-bound approval stays disabled");
  });

  it("placement is exposed by REST, actions, MCP and the browser without cloud mutation", () => {
    const route = source("src/app/api/platform/v1/environments/[id]/placement/route.ts");
    expect(route).toContain("authorizeRead(");
    expect(route).toContain("await recommendPlacement(");
    const action = source("src/lib/actions/defs/placement.ts");
    for (const value of ['id: "placement.recommend"', 'id: "placement.apply"', 'getAction("project.updateManifest")', 'candidate.topology === "multi_region"']) expect(action).toContain(value);
    expect(source("src/lib/placement/recommend.ts")).toContain('provider: "auto"');
    expect(source("src/app/(product)/platform/placement/placement-planner.tsx")).toContain('executeAction("placement.recommend"');
    expect(source("src/lib/agent-access/v3/tools/placement.ts")).toContain("recommendPlacement(");
    expect(guide("COST.md")).toContain("current V1-only manifest editor");
  });

  it("worker compile selects state backends per provider and documents exact object keys", () => {
    expect(source("src/lib/execution/compile.ts")).toContain("backendForConnection(connection,");
    const backends = source("src/lib/tofu/backends.ts");
    for (const token of ['case "aws"', 'case "gcp"', 'case "azure"', 'case "oci"', 'kind: "gcs"', 'kind: "azurerm"', "config.stateNamespace", "config.stateStorageAccount", "config.stateContainer", 'stateKey = `${prefix}/default.tfstate`', '`${prefix}/terraform.tfstate`', "Kubernetes connections need an explicit durable OpenTofu state backend override"]) expect(backends).toContain(token);
    const backendConfig = source("src/lib/tofu/backend-config.ts");
    expect(backendConfig).toContain("use_azuread_auth: true, use_cli: false");
    expect(backendConfig).toContain("OCI_ENDPOINT.exec(backend.endpoint)");
    for (const field of ["`stateBucket`", "`stateKmsKey`", "`stateStorageAccount`", "`stateContainer`", "`stateNamespace`", "`default.tfstate`", "`terraform.tfstate`", "zenith/<workspace>/<environment>/terraform.tfstate"]) expect(deploying).toContain(field);
  });

  it("OCI HTTP is opt-in and constructed; OCI platform sessions go only through a registered runner and verification is runner registration only", () => {
    const executor = source("go/internal/runner/executor.go");
    expect(executor).toContain("cfg.Kinds.OCIHTTP; k != nil && k.Enabled");
    expect(executor).toContain("kinds.NewOCI(");
    expect(executor).toContain("e.kinds[kinds.KindOCIHTTP] = o");
    expect(source("src/lib/runners/dispatch.ts")).toContain('"oci.http": { timeoutSec: 60, maxOutputBytes: 1024 * 1024, queueTtlSec: 120 }');
    expect(source("go/internal/runner/kinds/ocihttp.go")).toContain("if cfg.SecretWrite");
    const credentials = source("src/lib/platform/credentials.ts");
    expect(credentials).toContain('connection.config.provider === "oci"');
    expect(credentials).toContain("createRunnerOciTransport"); // sessions are runner-backed; no OCI credentials in the control plane
    // non-AWS verification is wired; OCI verification is runner registration only
    expect(credentials).toContain("OCI verification checks runner registration only");
    const runner = source("docs/platform/RUNNER.md");
    expect(runner).toContain("enabled: true");
    expect(runner).toContain("secretWrite: false");
    expect(source("docs/platform/RUNNER-PROTOCOL-OCI.md")).toContain("IMPLEMENTED AND WIRED; NOT LIVE-VERIFIED");
  });

  it("machine execution has an activity call but no machine port in default composition", () => {
    expect(source("src/lib/execution/capability.ts")).toContain("executeMachineOperation(");
    expect(source("src/lib/execution/capability.ts")).toContain("if (!plane) throw new StepFailedError");
    const composition = source("src/lib/platform/execution.ts");
    expect(composition).not.toMatch(/^\s*machines:/m);
    expect(deploying).toContain("default composition supplies no `machines` port");
  });

  it("CLI entry points and all fifteen MCP tools are documented", () => {
    const pkg = JSON.parse(source("package.json")) as { scripts: Record<string, string>; bin: Record<string, string> };
    expect(pkg.scripts.cli).toBe("tsx src/cli/bin.ts");
    expect(pkg.bin.zenith).toBe("src/cli/bin.ts");
    expect(source("docs/platform/CLI.md")).toContain("already contains the integrated wiring");
    const catalog = source("src/lib/agent-access/v3/catalog.ts");
    const names = [...new Set([...catalog.matchAll(/\bzenith_[a-z_]+\b/g)].map((m) => m[0]))].sort();
    const mcp = source("docs/platform/MCP.md");
    const listed = [...mcp.matchAll(/^\| `(zenith_[a-z_]+)` \|/gm)].map((m) => m[1]).sort();
    expect(names).toHaveLength(15);
    expect(listed).toEqual(names);
    expect(mcp).toContain("fifteen");
    expect(guide("README.md")).toContain("CLI.md");
  });

  it("the app registers the MCP read hook and the incident investigator (and only the app does)", () => {
    expect(source("src/lib/agent-access/v3/adapters.ts")).toContain("export function registerCredentialBroker(");
    expect(source("src/lib/agent-access/v3/adapters.ts")).toContain("export function registerInvestigator(");
    expect(callers(/(?<!function )\bregister(?:CredentialBroker|Investigator)\s*\(/, ["src/app", "src/lib/platform", "workers"])).toEqual(["src/lib/platform/app.ts"]);
    expect(squash(source("docs/platform/MCP.md"))).toContain("registers the MCP cloud-read hook");
  });

  it("Go guides and live-acceptance harness exist without claiming live verification", () => {
    for (const file of ["go/cmd/zenith-runner/main.go", "go/cmd/zenithd/main.go", "docs/platform/RUNNER.md", "docs/platform/ZENITHD.md", "scripts/acceptance/aws-live.ts", ".github/workflows/live-acceptance.yml"]) expect(exists(file), file).toBe(true);
    expect(squash(guide("README.md"))).toContain("never against a cloud");
    expect(guide("README.md")).toContain("not a live-cloud acceptance run");
  });
});
