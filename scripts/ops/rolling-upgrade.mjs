#!/usr/bin/env node
/**
 * Rolling upgrade and rollback runbook (PROD-OPS-03), executable.
 *
 *   node scripts/ops/rolling-upgrade.mjs plan     --topology compose|k8s [options]   print the plan, run nothing
 *   node scripts/ops/rolling-upgrade.mjs upgrade  --topology compose|k8s [options] --execute
 *   node scripts/ops/rolling-upgrade.mjs rollback --topology compose|k8s --state <file> [options] --execute
 *
 * Dry-run is the default: without --execute no command that changes anything is run
 * (read-only discovery commands still are, so the plan shows real current images).
 * Every step is printed with its exact argv before it runs; environment values and
 * private files are never printed (only whether a build id matches).
 *
 * Order (expand, then roll, then verify):
 *   1 gates       replay + versioning + schema-compat + protocol-window suites
 *   2 images      every new image is an immutable digest (@sha256:...)
 *   3 discover    record the images currently running (the rollback target)
 *   4 compat      `platform migrate --dry-run` classifies pending migrations; a contract
 *                 migration without registered approval refuses the whole upgrade
 *   5 migrate     expand-only schema step (previous release keeps working on it)
 *   6 worker      replace the execution worker (graceful drain: SIGTERM + grace); with
 *                 versioning, the new build id is promoted only after it is polling
 *   7 api         replace the API, wait for health
 *   8 verify      health, schema current, reported workflow problems
 * Rollback re-deploys the recorded previous images (and, with versioning, the previous
 * current worker version). It does NOT revert the database: expand-only migrations are
 * what make the old code safe on the new schema. It refuses when the state file says a
 * contract migration was applied.
 *
 * Topologies: `compose` drives deploy/self-hosted/compose.yml (the default installation
 * topology) through `docker compose`; `k8s` drives Deployments through `kubectl`. This
 * repository ships no API/worker Deployment manifests, so the k8s names, containers and
 * the migration Job manifest are options, not assumptions.
 *
 * Exit codes: 0 ok, 1 a step failed (the step is named), 2 usage or refused precondition.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DIGEST_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*@sha256:[0-9a-f]{64}$/;
export const GATE_SUITES = [
  "tests/workflows/versioning-audit.test.ts",
  "tests/workflows/history-replay.test.ts",
  "tests/controlplane/migration-compat.test.ts",
  "tests/runners/protocol-window.test.ts",
  "tests/workers/versioning-config.test.ts",
];

export class UsageError extends Error {}

const VALUE_FLAGS = [
  "topology", "compose-file", "env-file", "api-image", "worker-image", "migration-image",
  "namespace", "context", "api-deployment", "worker-deployment", "api-container", "worker-container", "migration-job",
  "worker-build-id", "versioning", "deployment-name", "state", "state-dir", "gates", "confirm-contract", "temporal-cli", "api-health-url", "worker-health-url",
  "previous-api-image", "previous-worker-image", "previous-worker-build-id", "wait-sec",
];
const BOOL_FLAGS = ["execute", "help"];

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, values: {}, flags: new Set() };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (BOOL_FLAGS.includes(name)) opts.flags.add(name);
    else if (VALUE_FLAGS.includes(name)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      opts.values[name] = value;
      i += 1;
    } else throw new UsageError(`unknown option --${name}`);
  }
  return opts;
}

const need = (opts, name) => {
  const v = opts.values[name];
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
};

/**
 * Pure: the ordered steps for a command. A step is `{ id, title, mutates, argv?, env?, check? }`.
 * `argv` is run without a shell. `check(result)` returns an error string to fail the step.
 * Discovery (`discover`) steps are read-only and always run, because they feed later steps.
 */
export function buildPlan(opts, ctx = {}) {
  const topology = need(opts, "topology");
  if (!["compose", "k8s"].includes(topology)) throw new UsageError("--topology must be compose or k8s");
  const versioning = opts.values.versioning ?? "off";
  if (!["off", "auto_upgrade", "pinned"].includes(versioning)) throw new UsageError("--versioning must be off, auto_upgrade or pinned");
  const temporal = opts.values["temporal-cli"] ?? "temporal";
  const deployment = opts.values["deployment-name"] ?? "zenith-execution";
  if (opts.command === "rollback") return rollbackPlan(opts, topology, versioning, temporal, deployment, ctx);
  if (opts.command !== "upgrade" && opts.command !== "plan") throw new UsageError("command must be plan, upgrade or rollback");

  const apiImage = need(opts, "api-image");
  const workerImage = need(opts, "worker-image");
  const migrationImage = need(opts, "migration-image");
  for (const [label, ref] of [["--api-image", apiImage], ["--worker-image", workerImage], ["--migration-image", migrationImage]]) {
    if (!DIGEST_REF.test(ref)) throw new UsageError(`${label} must be an immutable digest reference (name@sha256:<64 hex>), got a mutable tag or malformed value`);
  }
  if (versioning !== "off" && !opts.values["worker-build-id"]) throw new UsageError("--worker-build-id is required when --versioning is not off (use the worker image digest)");
  const gates = opts.values.gates ?? "run";
  if (!["run", "skip"].includes(gates)) throw new UsageError("--gates must be run or skip");
  const steps = [];
  if (gates === "run") {
    steps.push({ id: "gates", title: "replay, versioning, schema-compat and protocol-window gates", mutates: false, argv: ["npx", "vitest", "run", ...GATE_SUITES], env: { ZENITH_REPLAY_LANE: "1" }, check: (r) => (r.status === 0 ? undefined : "a compatibility gate failed; do not roll out this build") });
  } else {
    steps.push({ id: "gates", title: "gates SKIPPED by --gates skip (recorded; not a pass)", mutates: false, note: "SKIPPED" });
  }
  steps.push({ id: "images", title: "all new images are immutable digests", mutates: false, note: "checked while parsing options" });

  if (topology === "compose") {
    const file = opts.values["compose-file"] ?? "deploy/self-hosted/compose.yml";
    const envFile = opts.values["env-file"];
    const compose = (...rest) => ["docker", "compose", "-f", file, ...(envFile ? ["--env-file", envFile] : []), ...rest];
    steps.push({ id: "discover-api", title: "record the running API image", mutates: false, discover: "previous-api-image", composeService: "api", compose });
    steps.push({ id: "discover-worker", title: "record the running worker image", mutates: false, discover: "previous-worker-image", composeService: "execution-worker", compose });
    steps.push({ id: "migrate-dry-run", title: "classify pending platform migrations (contract refused without approval)", mutates: false, argv: ["npx", "tsx", "scripts/platform/migrate.ts", "--dry-run"], check: (r) => (r.status === 0 ? undefined : "pending migrations include a contract change without a registered approval") });
    steps.push({ id: "migrate", title: "apply expand-only platform migrations", mutates: true, argv: compose("--profile", "maintenance", "run", "--rm", "platform-migrate"), env: { ZENITH_MIGRATION_IMAGE: migrationImage, ZENITH_API_IMAGE: apiImage, ZENITH_WORKER_IMAGE: workerImage, ...(opts.values["confirm-contract"] ? { ZENITH_ALLOW_CONTRACT_MIGRATIONS: opts.values["confirm-contract"] } : {}) } });
    steps.push({ id: "worker", title: "replace the execution worker (graceful drain)", mutates: true, argv: compose("up", "-d", "--no-deps", "execution-worker"), env: { ZENITH_API_IMAGE: apiImage, ZENITH_WORKER_IMAGE: workerImage, ZENITH_MIGRATION_IMAGE: migrationImage } });
    steps.push({ id: "worker-ready", title: "wait for the worker to report ready", mutates: false, wait: { service: "execution-worker", compose } });
    if (versioning !== "off") steps.push(promoteStep(temporal, deployment, opts.values["worker-build-id"]));
    steps.push({ id: "api", title: "replace the API", mutates: true, argv: compose("up", "-d", "--no-deps", "api"), env: { ZENITH_API_IMAGE: apiImage, ZENITH_WORKER_IMAGE: workerImage, ZENITH_MIGRATION_IMAGE: migrationImage } });
    steps.push({ id: "api-ready", title: "wait for the API to report healthy", mutates: false, wait: { service: "api", compose } });
  } else {
    const ns = need(opts, "namespace");
    const kube = (...rest) => ["kubectl", ...(opts.values.context ? ["--context", opts.values.context] : []), "-n", ns, ...rest];
    const apiDep = opts.values["api-deployment"] ?? "zenith-api";
    const workerDep = opts.values["worker-deployment"] ?? "zenith-execution-worker";
    const apiCt = opts.values["api-container"] ?? "api";
    const workerCt = opts.values["worker-container"] ?? "execution-worker";
    const job = opts.values["migration-job"] ?? "deploy/k8s/platform-migrate-job.yaml";
    steps.push({ id: "discover-api", title: "record the running API image", mutates: false, discover: "previous-api-image", argv: kube("get", "deployment", apiDep, "-o", `jsonpath={.spec.template.spec.containers[?(@.name=="${apiCt}")].image}`) });
    steps.push({ id: "discover-worker", title: "record the running worker image", mutates: false, discover: "previous-worker-image", argv: kube("get", "deployment", workerDep, "-o", `jsonpath={.spec.template.spec.containers[?(@.name=="${workerCt}")].image}`) });
    steps.push({ id: "migrate-dry-run", title: "classify pending platform migrations (contract refused without approval)", mutates: false, argv: ["npx", "tsx", "scripts/platform/migrate.ts", "--dry-run"], check: (r) => (r.status === 0 ? undefined : "pending migrations include a contract change without a registered approval") });
    steps.push({ id: "migrate-clean", title: "remove the previous migration Job (Job templates are immutable)", mutates: true, argv: kube("delete", "job", "-l", "app.kubernetes.io/component=platform-migrate", "--ignore-not-found") });
    steps.push({ id: "migrate", title: "apply expand-only platform migrations (Job, new migration image substituted)", mutates: true, argv: kube("apply", "-f", "-"), stdin: { file: job, image: migrationImage } });
    steps.push({ id: "migrate-wait", title: "wait for the migration Job", mutates: true, argv: kube("wait", "--for=condition=complete", "job", "-l", "app.kubernetes.io/component=platform-migrate", "--timeout=600s") });
    steps.push({ id: "worker", title: "roll the execution worker", mutates: true, argv: kube("set", "image", `deployment/${workerDep}`, `${workerCt}=${workerImage}`) });
    steps.push({ id: "worker-ready", title: "wait for the worker rollout", mutates: true, argv: kube("rollout", "status", `deployment/${workerDep}`, "--timeout=900s") });
    if (versioning !== "off") steps.push(promoteStep(temporal, deployment, opts.values["worker-build-id"]));
    steps.push({ id: "api", title: "roll the API", mutates: true, argv: kube("set", "image", `deployment/${apiDep}`, `${apiCt}=${apiImage}`) });
    steps.push({ id: "api-ready", title: "wait for the API rollout", mutates: true, argv: kube("rollout", "status", `deployment/${apiDep}`, "--timeout=600s") });
  }
  steps.push({ id: "verify-schema", title: "schema is current for the new build", mutates: false, argv: ["npx", "tsx", "scripts/platform/migrate.ts", "--status"], check: (r) => (r.status === 0 ? undefined : "platform schema is not current after the migration step") });
  steps.push({ id: "verify-workflows", title: "no workflow reports a failing workflow task (nondeterminism shows up here)", mutates: false, argv: [temporal, "workflow", "list", "--query", 'TemporalReportedProblems="category=WorkflowTaskFailed"', "--limit", "20", "--output", "json"], optionalTool: temporal, check: (r) => workflowProblemCheck(r) });
  return steps;
}

function promoteStep(temporal, deployment, buildId) {
  return { id: "promote-version", title: `make worker version ${deployment}.${buildId} current (new workflows and AUTO_UPGRADE workflows route to it)`, mutates: true, argv: [temporal, "worker", "deployment", "set-current-version", "--deployment-name", deployment, "--build-id", buildId, "--yes"], optionalTool: temporal };
}

function workflowProblemCheck(result) {
  if (result.status !== 0) return undefined; // search attribute missing on this server: reported as UNVERIFIED by the executor
  const text = (result.stdout ?? "").trim();
  if (!text || text === "[]" || text === "null") return undefined;
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) && rows.length > 0 ? `${rows.length} workflow(s) report a failing workflow task; roll back or fix the workflow code` : undefined;
  } catch {
    return undefined;
  }
}

function rollbackPlan(opts, topology, versioning, temporal, deployment, ctx) {
  const stateFile = need(opts, "state");
  const state = ctx.readState ? ctx.readState(stateFile) : JSON.parse(readFileSync(stateFile, "utf8"));
  if (state.contractMigrationApplied) throw new UsageError("this upgrade applied an approved contract migration; the previous release cannot run on the new schema, so an image rollback is refused. Restore per docs/platform/operations/RECOVERY.md instead");
  for (const key of ["previousApiImage", "previousWorkerImage"]) if (!DIGEST_REF.test(state[key] ?? "")) throw new UsageError(`state file has no immutable ${key}; cannot roll back safely`);
  const steps = [];
  if (topology === "compose") {
    const file = opts.values["compose-file"] ?? state.composeFile ?? "deploy/self-hosted/compose.yml";
    const envFile = opts.values["env-file"];
    const compose = (...rest) => ["docker", "compose", "-f", file, ...(envFile ? ["--env-file", envFile] : []), ...rest];
    const env = { ZENITH_API_IMAGE: state.previousApiImage, ZENITH_WORKER_IMAGE: state.previousWorkerImage, ZENITH_MIGRATION_IMAGE: state.previousMigrationImage ?? state.previousApiImage };
    steps.push({ id: "api", title: "restore the previous API image", mutates: true, argv: compose("up", "-d", "--no-deps", "api"), env });
    steps.push({ id: "worker", title: "restore the previous execution worker image", mutates: true, argv: compose("up", "-d", "--no-deps", "execution-worker"), env });
  } else {
    const ns = need(opts, "namespace");
    const kube = (...rest) => ["kubectl", ...(opts.values.context ? ["--context", opts.values.context] : []), "-n", ns, ...rest];
    const apiDep = opts.values["api-deployment"] ?? state.apiDeployment ?? "zenith-api";
    const workerDep = opts.values["worker-deployment"] ?? state.workerDeployment ?? "zenith-execution-worker";
    const apiCt = opts.values["api-container"] ?? "api";
    const workerCt = opts.values["worker-container"] ?? "execution-worker";
    steps.push({ id: "api", title: "restore the previous API image", mutates: true, argv: kube("set", "image", `deployment/${apiDep}`, `${apiCt}=${state.previousApiImage}`) });
    steps.push({ id: "worker", title: "restore the previous execution worker image", mutates: true, argv: kube("set", "image", `deployment/${workerDep}`, `${workerCt}=${state.previousWorkerImage}`) });
    steps.push({ id: "rollout", title: "wait for the restored rollouts", mutates: true, argv: kube("rollout", "status", `deployment/${workerDep}`, "--timeout=900s") });
  }
  if (versioning !== "off" || state.versioning !== "off") {
    const prior = opts.values["previous-worker-build-id"] ?? state.previousWorkerBuildId;
    if (!prior) throw new UsageError("worker versioning was on but no previous worker build id is recorded; pass --previous-worker-build-id");
    steps.push({ ...promoteStep(opts.values["temporal-cli"] ?? "temporal", state.deploymentName ?? deployment, prior), title: `make the previous worker version current again (${prior}); pinned workflows on the failed version finish there` });
  }
  steps.push({ id: "verify-workflows", title: "no workflow reports a failing workflow task", mutates: false, argv: [temporal, "workflow", "list", "--query", 'TemporalReportedProblems="category=WorkflowTaskFailed"', "--limit", "20", "--output", "json"], optionalTool: temporal, check: (r) => workflowProblemCheck(r) });
  return steps;
}

/* -------------------------------- execution -------------------------------- */

function run(argv, env, input) {
  const [cmd, ...args] = argv;
  const result = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...(env ?? {}) }, shell: false, maxBuffer: 16 * 1024 * 1024, ...(input !== undefined ? { input } : {}), stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
  return { status: result.status ?? (result.error ? 127 : 1), stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

const say = (line) => process.stdout.write(`${line}\n`);
const quote = (argv) => argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");

/** The migration Job manifest with its placeholder digest image replaced by the new migration image. */
export function manifestWithImage({ file, image }) {
  const text = readFileSync(file, "utf8");
  const replaced = text.replace(/registry\.invalid\/zenith\/migrate@sha256:0{64}/, image);
  if (replaced === text) throw new UsageError(`${file} has no placeholder migration image (registry.invalid/zenith/migrate@sha256:000...) to substitute`);
  return replaced;
}

function toolExists(tool) {
  const probe = run([tool, "--version"]);
  return probe.status === 0 && !probe.error;
}

function readEnvFileValue(file, key) {
  if (!file || !existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.command || opts.flags.has("help")) {
    say("usage: node scripts/ops/rolling-upgrade.mjs <plan|upgrade|rollback> --topology compose|k8s [options] [--execute]");
    say("see the header of this file and docs/platform/operations/ROLLING-UPGRADES.md");
    return opts.command ? 0 : 2;
  }
  const execute = opts.flags.has("execute") && opts.command !== "plan";
  const steps = buildPlan(opts);
  const state = { startedAt: new Date().toISOString(), topology: opts.values.topology, versioning: opts.values.versioning ?? "off", deploymentName: opts.values["deployment-name"] ?? "zenith-execution", composeFile: opts.values["compose-file"], newApiImage: opts.values["api-image"], newWorkerImage: opts.values["worker-image"], newWorkerBuildId: opts.values["worker-build-id"], contractMigrationApplied: Boolean(opts.values["confirm-contract"]), previousWorkerBuildId: opts.values["previous-worker-build-id"] };
  if (opts.values["previous-api-image"]) state.previousApiImage = opts.values["previous-api-image"];
  if (opts.values["previous-worker-image"]) state.previousWorkerImage = opts.values["previous-worker-image"];

  say(`${opts.command.toUpperCase()} ${execute ? "(EXECUTING)" : "(dry run: nothing that changes state will run)"} topology=${opts.values.topology}`);
  const report = [];
  for (const [i, step] of steps.entries()) {
    const label = `[${i + 1}/${steps.length}] ${step.id}: ${step.title}`;
    say(label);
    if (step.note === "SKIPPED") { report.push({ id: step.id, outcome: "skipped" }); continue; }
    if (step.note && !step.argv && !step.wait && !step.discover) { report.push({ id: step.id, outcome: "ok" }); continue; }

    if (step.discover) {
      const found = discoverImage(step, opts);
      if (found) { state[step.discover === "previous-api-image" ? "previousApiImage" : "previousWorkerImage"] = found; say(`    current image: ${found}`); }
      else say("    current image not discovered (tool unavailable or nothing running); pass --previous-api-image / --previous-worker-image to make rollback possible");
      report.push({ id: step.id, outcome: found ? "ok" : "unverified" });
      continue;
    }
    if (!execute) { say(`    would run: ${step.argv ? quote(step.argv) : "(wait for health)"}`); report.push({ id: step.id, outcome: "planned" }); continue; }
    if (step.optionalTool && !toolExists(step.optionalTool)) {
      const required = step.mutates;
      say(`    ${required ? "REFUSED" : "UNVERIFIED"}: ${step.optionalTool} is not available on this machine`);
      if (required) return finish(report, state, opts, execute, 1, step.id);
      report.push({ id: step.id, outcome: "unverified" });
      continue;
    }
    if (step.wait) {
      const ok = await waitHealthy(step.wait, opts);
      report.push({ id: step.id, outcome: ok ? "ok" : "failed" });
      if (!ok) { say(`    FAILED: ${step.wait.service} did not become healthy`); return finish(report, state, opts, execute, 1, step.id); }
      continue;
    }
    if (step.id === "worker" && opts.values.topology === "compose" && opts.values.versioning && opts.values.versioning !== "off") {
      const privateDir = readEnvFileValue(opts.values["env-file"], "ZENITH_PRIVATE_DIR") ?? process.env.ZENITH_PRIVATE_DIR;
      const workerEnv = privateDir ? path.join(privateDir, "worker.env") : undefined;
      const mode = readEnvFileValue(workerEnv, "ZENITH_WORKER_VERSIONING");
      const configured = readEnvFileValue(workerEnv, "ZENITH_WORKER_BUILD_ID");
      if (mode !== opts.values.versioning || configured !== opts.values["worker-build-id"]) {
        say("    REFUSED: worker.env must set ZENITH_WORKER_VERSIONING and ZENITH_WORKER_BUILD_ID to match --versioning and --worker-build-id before the worker is replaced (a mismatch would route workflows to the wrong version)");
        return finish(report, state, opts, execute, 2, step.id);
      }
    }
    say(`    run: ${quote(step.argv)}`);
    const result = run(step.argv, step.env, step.stdin ? manifestWithImage(step.stdin) : undefined);
    const problem = step.check ? step.check(result) : result.status === 0 ? undefined : `exit ${result.status}`;
    if (step.id === "verify-workflows" && result.status !== 0 && !problem) {
      say("    UNVERIFIED: the server rejected the problem query (older server or missing search attribute); inspect workflows manually");
      report.push({ id: step.id, outcome: "unverified" });
      continue;
    }
    if (problem) {
      say(`    FAILED: ${problem}`);
      const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-5).join("\n    ");
      if (tail) say(`    ${tail}`);
      report.push({ id: step.id, outcome: "failed" });
      return finish(report, state, opts, execute, 1, step.id);
    }
    report.push({ id: step.id, outcome: "ok" });
  }
  return finish(report, state, opts, execute, 0);
}

function finish(report, state, opts, execute, code, failedAt) {
  if (execute && opts.command === "upgrade") {
    const dir = opts.values["state-dir"] ?? ".upgrade-state";
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `upgrade-${state.startedAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, `${JSON.stringify({ ...state, outcome: code === 0 ? "succeeded" : `failed_at_${failedAt}`, steps: report }, null, 2)}\n`, "utf8");
    say(`state written: ${file} (rollback: node scripts/ops/rolling-upgrade.mjs rollback --topology ${state.topology} --state ${file} --execute)`);
  }
  say(`${report.filter((r) => r.outcome === "ok").length} ok, ${report.filter((r) => r.outcome === "planned").length} planned, ${report.filter((r) => r.outcome === "skipped" || r.outcome === "unverified").length} skipped or unverified, ${report.filter((r) => r.outcome === "failed").length} failed`);
  return code;
}

function discoverImage(step, opts) {
  if (opts.values[step.discover]) return opts.values[step.discover];
  if (step.composeService) {
    const ids = run(step.compose("ps", "-q", step.composeService));
    const id = ids.stdout.trim().split(/\r?\n/)[0];
    if (ids.status !== 0 || !id) return undefined;
    const inspected = run(["docker", "inspect", "--format", "{{.Config.Image}}", id]);
    return inspected.status === 0 ? inspected.stdout.trim() : undefined;
  }
  const result = run(step.argv);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

async function waitHealthy(wait, opts) {
  const deadline = Date.now() + Number(opts.values["wait-sec"] ?? 300) * 1000;
  while (Date.now() < deadline) {
    const ids = run(wait.compose("ps", "-q", wait.service));
    const id = ids.stdout.trim().split(/\r?\n/)[0];
    if (id) {
      const health = run(["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", id]);
      if (health.stdout.trim() === "healthy") return true;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    if (error instanceof UsageError) { process.stderr.write(`usage error: ${error.message}\n`); process.exit(2); }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
