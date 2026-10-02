/** Canonical local/CI execution contract. Report payloads never define requirements. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const TOFU_SUITES = [
  ["tests/tofu/network.test.ts", "real provider install through the committed lockfile (network)"],
  ["tests/tofu/network.test.ts", "AWS provider blocks validate against the real provider schema (network, ~160 MB first run)"],
  ["tests/tofu/backends.test.ts", "real backend block validation (network gate, no cloud calls)"],
  ["tests/tofu/destroy-real.test.ts", "real tofu destroy (ZENITH_TEST_TOFU_NETWORK=1)"],
  ["tests/providers/aws/drivers/compute/assemble.test.ts", "real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache)"],
  ["tests/providers/aws/drivers/data/assemble.test.ts", "compiled data fragments validate against the real hashicorp/aws provider (network)"],
  ["tests/providers/aws/drivers/messaging/assemble.test.ts", "OpenTofu AWS 6.66.0 schema validation (requires binary/network)"],
  ["tests/providers/aws/drivers/network/compile-graph.test.ts", "tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1)"],
  ["tests/providers/aws/drivers/e2e-compile.test.ts", "real OpenTofu AWS 6.66.0 schema validation (opt-in)"],
  ["tests/providers/aws/identity/trust.test.ts", "IRSA pinned provider schema"],
  ["tests/providers/gcp/tofu-validate.test.ts", "tofu validate against hashicorp/google 8.5.0 (network)"],
  ["tests/providers/gcp/bootstrap.test.ts", "tofu validate (network)"],
  ["tests/providers/gcp/identity/trust.test.ts", "GKE trust pinned provider schema"],
  ["tests/providers/azure/validate.test.ts", "compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network)"],
  ["tests/providers/azure/deploy.test.ts", "deploy/azure validates against the real azurerm 5.7.0 schema (network)"],
  ["tests/providers/azure/identity/trust.test.ts", "AKS trust pinned provider schema"],
  ["tests/providers/oci/validate.test.ts", "tofu validate against oracle/oci 9.7.1 (network)"],
  ["tests/providers/oci/validate.test.ts", "the customer bootstrap module (deploy/oci) validates against the locked provider (network)"],
  ["tests/execution/compile-refs-providers.test.ts", "real AWS schema validation through the execution compiler (opt-in)"],
  ["tests/security/tofu-secrets.test.ts", "part 3: real OpenTofu 1.12.5, plan -> approve -> apply, scanning every surface"],
  ["tests/security/tofu-runner-env.test.ts", "part 1: a provisioner inside real tofu inherits nothing of the control plane's environment"],
  ["tests/security/tofu-workspace-injection.test.ts", "what the assembler ACCEPTS, real OpenTofu must not turn into a file read or a path leak (SEC-F5)"],
  ["tests/execution/journey.test.ts", "deploy journey on the real OpenTofu engine, platform store and product store"],
  ["tests/tofu/ephemeral-network.test.ts", "real ephemeral resources (network)"],
  ["tests/providers/azure/mysql.test.ts", "Azure MySQL real pinned tofu validate (network, no Azure account)"],
  ["tests/providers/oci/mysql.test.ts", "OCI MySQL real pinned tofu schema and persistence controls (network)"],
];


export const EXTERNAL_ACCEPTANCE = [
  {
    id: "external-temporal-mtls", file: "tests/workflows/mtls-live.test.ts",
    suite: "external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1)", wholeFile: true,
    prerequisites: ["An authorized external Temporal namespace", "ZENITH_TEMPORAL_ADDRESS", "ZENITH_TEMPORAL_NAMESPACE", "ZENITH_TEMPORAL_TLS_CERT_FILE", "ZENITH_TEMPORAL_TLS_KEY_FILE", "ZENITH_TEST_TEMPORAL_MTLS=1"],
    releaseBlocker: "External Temporal mTLS execution remains unverified until separate authorized acceptance passes.",
  },

];

export const CORE_CHECKS = [
  { id: "typecheck", command: ["npm", "run", "typecheck"] },
  { id: "lint", command: ["npm", "run", "lint"] },
  { id: "unit", command: ["node", "node_modules/vitest/vitest.mjs", "run", "--project=node", "--project=dom", "--maxWorkers=1"] },
  { id: "smoke", command: ["npm", "run", "smoke"] },
  { id: "gimbal", command: ["npm", "run", "gimbal:verify"] },
];

const ECS_REPLICA_REPAIR_FILES = {
  execution: "tests/execution/ecs-replica-repair.test.ts",
  ownership: "tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts",
  grants: "tests/platform/ecs-replica-repair-grants.test.ts",
  workflows: "tests/workflows/ecs-replica-repair.test.ts",
};
const ECS_REPLICA_REPAIR_WORKFLOW_REQUIREMENTS = [
  ...["immutable ECS replica materialization", "raw full-environment repair plan", "existing plan/apply activity integration"]
    .map((suite) => ({ file: ECS_REPLICA_REPAIR_FILES.execution, suite })),
  { file: ECS_REPLICA_REPAIR_FILES.ownership, suite: "ECS replica ownership reads" },
  { file: ECS_REPLICA_REPAIR_FILES.grants },
  { file: ECS_REPLICA_REPAIR_FILES.workflows },
];
const ECS_REPLICA_REPAIR_POSTGRES_SUITES = [
  "initial planning authority", "planning policy denial", "browser plan approval",
  "resumed planning authority", "stricter approval policy", "immutable repair evidence",
];

export const GATE_LANES = {
  postgres: {
    files: ["tests/hosted/authority/contract", "tests/scripts/migrate-hosted-to-postgres.test.ts", "tests/agent-link/pg-contract.test.ts", "tests/agent-control/pg-contract.test.ts", "tests/db/contract/workspace-sharing.test.ts", "tests/waitlist/pg-contract.test.ts"],
    env: { ZENITH_CONTRACT_POSTGRES: "1", ZENITH_FAST: "1" }, report: ".data-ci-lane/postgres-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "PostgreSQL 16.15 at SUPABASE_DB_URL", "Hosted, agent, membership and waitlist migrations applied with scripts/ci/apply-supabase-migrations.sh"],
    tools: { node: "22.23.3", postgres: "16.15" },
  },
  policy: {
    files: ["tests/policy"], env: {}, report: ".data-ci-lane/policy-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "OPA 1.19.1 at ZENITH_OPA_BIN", "Committed policy bundle verified with policy/build.mjs --check"],
    tools: { node: "22.23.3", opa: "1.19.1" },
  },
  tofu: {
    files: ["tests/tofu", "tests/providers/aws/drivers", "tests/providers/aws/identity", "tests/providers/gcp", "tests/providers/azure", "tests/providers/oci", "tests/execution/compile-refs-providers.test.ts", "tests/execution/journey.test.ts", "tests/security/tofu-secrets.test.ts", "tests/security/tofu-runner-env.test.ts", "tests/security/tofu-workspace-injection.test.ts"],
    env: { ZENITH_TEST_TOFU_NETWORK: "1" }, report: ".data-ci-lane/tofu-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "OpenTofu 1.12.5 at ZENITH_TOFU_BIN", "Provider registry network access and committed lockfiles", "Writable plugin cache at ZENITH_TOFU_PLUGIN_CACHE"],
    tools: { node: "22.23.3", tofu: "1.12.5" },
  },
  workflows: {
    files: ["tests/workflows", "tests/platform", "tests/security/workflow-history.test.ts", ECS_REPLICA_REPAIR_FILES.execution, ECS_REPLICA_REPAIR_FILES.ownership],
    excludeFiles: ["tests/workflows/mtls-live.test.ts"],
    env: { ZENITH_COMPOSE_TEMPORAL_MODE: "time-skipping", ZENITH_TEST_TEMPORAL_DOWNLOAD: "1", ZENITH_SEC_TEMPORAL: "1", ZENITH_TEST_TEMPORAL: "1", ZENITH_TEST_SOURCE_GITHUB: "1", ZENITH_TEST_SOURCE_REPO: "https://github.com/GODOSTROYER/zenith", ZENITH_TEST_SOURCE_REF: "37be7340536ccb68ae4bb49294e8ab3799d1f01b" },
    report: ".data-ci-lane/workflows-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "Temporal CLI 1.9.1 at ZENITH_TEST_TEMPORAL_CLI", "Local Temporal dev and time-skipping servers; SDK test-server cache or download access", "Public GitHub codeload access for the immutable source fixture"],
    tools: { node: "22.23.3", temporal: "1.9.1" },
  },
  "platform-postgres": {
    files: ["tests/controlplane", "tests/capabilities", "tests/runners", "tests/reconcile/platform.test.ts", ECS_REPLICA_REPAIR_FILES.grants],
    env: { ZENITH_FAST: "1" }, report: ".data-ci-lane/platform-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "PostgreSQL 16.15", "ZENITH_TEST_PLATFORM_PG_URL points to the real test database", "Platform migrations applied with scripts/ci/apply-platform-migrations.sh"],
    tools: { node: "22.23.3", postgres: "16.15" },
  },
};

/** @param {string} root @param {string} directory @returns {string[]} */
export function testFiles(root, directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    return entry.isDirectory() ? testFiles(root, relative) : relative.endsWith(".test.ts") ? [relative] : [];
  }).sort();
}

/** Normalize only complete backend labels; mismatched quotes never identify a backend. */
export function canonicalSuite(value) {
  return String(value).replace(/^(['"])(PostgresAuthority)\1(?=\s|$)/, "$2").replace(/\[\s*(?:'([^']+)'|"([^"]+)"|([a-z]+))\s*\]/gi, (_all, single, double, bare) => `[${single ?? double ?? bare}]`);
}

export function assertionMatches(required, assertion) {
  if (!assertion || typeof assertion.fullName !== "string") return false;
  const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : [];
  if (required.suite && !ancestors.some((title) => typeof title === "string" && canonicalSuite(title) === canonicalSuite(required.suite))) return false;
  if (required.ancestorSuite && !ancestors.some((title) => typeof title === "string" && canonicalSuite(title) === canonicalSuite(required.ancestorSuite))) return false;
  if (required.excludeSuites?.some((suite) => ancestors.includes(suite))) return false;
  if (!required.postgres) return true;
  // Prefer suite ancestry. A test title mentioning PostgreSQL cannot turn a
  // PGlite suite into real-engine evidence. Older reports omit the ancestry.
  const labels = ancestors.length > 0 ? ancestors : [assertion.fullName];
  return labels.some((title) => typeof title === "string" && canonicalSuite(title).includes("[postgres]"));
}

/** Stable IDs contain only trusted source paths and a digest of the owned suite. */
export function requirementId(lane, required) {
  const identity = `${required.suite ?? ""}:${required.postgres ?? false}${required.ancestorSuite !== undefined ? `:${required.ancestorSuite}` : ""}`;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `${lane}:${required.file}:${suffix}`;
}

/** @typedef {Readonly<{ file: string, suite?: string, ancestorSuite?: string, postgres?: boolean, backend?: string, id: string, excludeSuites?: readonly string[] }>} GateRequirement */
/**
 * Backend suite identity comes from committed gate declarations, never assertions.
 * @param {string} lane
 * @param {string} root
 * @returns {GateRequirement[]}
 */
export function requirementsFor(lane, root) {
  let requirements;
  switch (lane) {
    case "postgres":
      requirements = [
        ...testFiles(root, "tests/hosted/authority/contract").map((file) => ({ file, suite: file.endsWith("ledgers.test.ts") ? "PostgresAuthority ledgers" : "PostgresAuthority", backend: "postgres" })),
        { file: "tests/scripts/migrate-hosted-to-postgres.test.ts", suite: "migrate-hosted-to-postgres — against the real Supabase project", backend: "postgres" },
        ...[["tests/agent-link/pg-contract.test.ts", "AgentLinkPostgres"], ["tests/agent-control/pg-contract.test.ts", "AgentControlPostgres"], ["tests/db/contract/workspace-sharing.test.ts", "WorkspaceSharingPostgres"], ["tests/waitlist/pg-contract.test.ts", "WaitlistPostgres"]].map(([file, suite]) => ({ file, suite, backend: "postgres" })),
      ];
      break;
    case "policy":
      requirements = testFiles(root, "tests/policy").map((file) => ({ file }));
      break;
    case "tofu":
      requirements = TOFU_SUITES.map(([file, suite]) => ({ file, suite }));
      // The runner binary tests must not disappear behind passing mocked tests.
      requirements.push({ file: "tests/tofu/runner.test.ts" });
      break;
    case "workflows":
      requirements = [...testFiles(root, "tests/workflows"), ...testFiles(root, "tests/platform"), "tests/security/workflow-history.test.ts"]
        .filter((file) => !EXTERNAL_ACCEPTANCE.some((group) => group.wholeFile && group.file === file))
        .filter((file) => !Object.values(ECS_REPLICA_REPAIR_FILES).includes(file))
        .flatMap((file) => file === "tests/platform/source-bundle.test.ts"
          ? ["source acquisition and canonical archives", "customer source bucket uploads", "GCS source upload through authorizedFetch", "live public GitHub source (opt-in network)"].map((suite) => ({ file, suite }))
          : [{ file }]);
      requirements.push(...ECS_REPLICA_REPAIR_WORKFLOW_REQUIREMENTS);
      break;
    case "platform-postgres":
      requirements = ["tests/controlplane", "tests/capabilities", "tests/reconcile"].flatMap((directory) => testFiles(root, directory).flatMap((file) => {
        const source = fs.readFileSync(path.join(root, file), "utf8");
        const backendSuites = [...source.matchAll(/describe\.each\((?:LANES|STORE_KINDS|lanes)\)\(\s*(["'])(.*?)\1/g)].map((match) => ({
          file, suite: match[2].replace("$name", "postgres").replace("%s", "postgres"), postgres: true,
        }));
        const postgresOnly = [...source.matchAll(/describe\.skipIf\(!PG_URL\)\(\s*(["'])(.*?)\1/g)].map((match) => ({ file, suite: match[2], backend: "postgres" }));
        return [...backendSuites, ...postgresOnly];
      }));
      requirements.push(...ECS_REPLICA_REPAIR_POSTGRES_SUITES.map((suite) => ({ file: ECS_REPLICA_REPAIR_FILES.grants, suite, ancestorSuite: "replica repair authority [postgres]", postgres: true })));
      break;
    default:
      throw new Error("Unknown CI lane");
  }
  return requirements.map((required) => ({ ...required, id: requirementId(lane, required) }));
}

/**
 * @typedef {object} GateManifest
 * @property {number} schemaVersion
 * @property {string} lane
 * @property {string[]} files
 * @property {string[]} excludeFiles
 * @property {Record<string, string>} env
 * @property {string} report
 * @property {string[]} command
 * @property {GateRequirement[]} requirements
 * @property {typeof EXTERNAL_ACCEPTANCE} externalAcceptance
 * @property {{ id: string, command: string[] }[]} steps
 * @property {Record<string, string>} tools
 * @property {string[]} prerequisites
 * @property {string} [reportValidation]
 */
/** @param {string} lane @param {string} [root] @param {string} [reportPath] @returns {GateManifest} */
export function manifestFor(lane, root = process.cwd(), reportPath) {
  if (lane === "core" || lane === "fresh") return { schemaVersion: 1, lane, files: [], excludeFiles: [], env: {}, report: "", command: [], requirements: [], externalAcceptance: [], tools: { node: "22.23.3" }, prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts"], steps: lane === "fresh" ? [{ id: "install", command: ["npm", "ci", "--ignore-scripts"] }, ...CORE_CHECKS] : CORE_CHECKS, reportValidation: "Command exits establish core checks; real-engine requirements are validated by their dedicated lanes." };
  if (!Object.hasOwn(GATE_LANES, lane)) throw new Error("Unknown CI lane");
  const config = GATE_LANES[lane];
  const report = reportPath ?? config.report;
  const args = ["run", ...config.files, ...(config.excludeFiles ?? []).flatMap((file) => ["--exclude", file]), "--maxWorkers=1", "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`];
  return { schemaVersion: 1, lane, ...config, excludeFiles: config.excludeFiles ?? [], steps: [], report, command: ["node", "node_modules/vitest/vitest.mjs", ...args], requirements: requirementsFor(lane, root), externalAcceptance: lane === "workflows" ? EXTERNAL_ACCEPTANCE : [] };
}

export function main(args) {
  try {
    if (args.length > 1) throw new Error("usage");
    const result = args[0] === "external-acceptance" ? { schemaVersion: 1, groups: EXTERNAL_ACCEPTANCE.map((group) => ({ ...group, status: "unverified", command: ["node", "node_modules/vitest/vitest.mjs", "run", group.file, "--testNamePattern", group.suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "--maxWorkers=1"] })) } : args[0] ? manifestFor(args[0]) : { schemaVersion: 1, lanes: ["fresh", "core", ...Object.keys(GATE_LANES)].map((lane) => manifestFor(lane)) };
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch {
    console.error("usage: node scripts/ci/gate-manifest.mjs [fresh|core|postgres|policy|tofu|workflows|platform-postgres|external-acceptance]");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
