/**
 * Require the real-engine scenarios in a Vitest JSON report to pass. Unit tests
 * in the same file cannot stand in for skipped Temporal/provider/Postgres tests.
 * This proves test execution only: clouds in the platform e2e remain mocked.
 * Prints repository-owned requirement names, never report payloads or errors.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Each network-gated describe block, including files with passing unit tests. */
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
];

/** @param {string} root @param {string} directory @returns {string[]} */
function testFiles(root, directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    return entry.isDirectory() ? testFiles(root, relative) : relative.endsWith(".test.ts") ? [relative] : [];
  }).sort();
}

/** @typedef {{ file: string, suite?: string, postgres?: boolean }} Requirement */

/** @param {string} lane @param {string} root @returns {Requirement[]} */
export function requirementsFor(lane, root) {
  switch (lane) {
    case "tofu":
      return TOFU_SUITES.map(([file, suite]) => ({ file, suite }));
    case "workflows":
      return [
        ...testFiles(root, "tests/workflows"),
        ...testFiles(root, "tests/platform"),
        "tests/security/workflow-history.test.ts",
      ].map((file) => ({ file }));
    case "platform-postgres":
      return ["tests/controlplane", "tests/capabilities", "tests/reconcile"].flatMap((directory) =>
        testFiles(root, directory).filter((file) => {
          const source = fs.readFileSync(path.join(root, file), "utf8");
          return /describe\.each\((LANES|STORE_KINDS)\)/.test(source) || /describe\.skipIf\(!PG_URL\)/.test(source);
        }).map((file) => ({ file, postgres: true }))
      );
    default:
      throw new Error("Unknown CI lane");
  }
}

/**
 * @param {Requirement[]} requirements
 * @param {unknown} report
 * @param {string} root
 * @returns {string[]} A missing, skipped, failed or malformed requirement fails closed.
 */
export function reportFailures(requirements, report, root) {
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) return ["Malformed Vitest report"];
  if (report.success !== true) return ["Vitest run did not succeed"];
  if (requirements.length === 0) return ["No required scenarios found"];
  const normalize = (value) => value.replaceAll("\\", "/");
  const failures = [];
  for (const required of requirements) {
    const expected = normalize(path.resolve(root, required.file));
    const files = report.testResults.filter((entry) =>
      entry && typeof entry.name === "string" && normalize(path.resolve(root, entry.name)) === expected
    );
    const label = `${required.file}${required.suite ? `: ${required.suite}` : required.postgres ? ": [postgres]" : ""}`;
    if (files.length !== 1 || !Array.isArray(files[0].assertionResults) || files[0].status !== "passed") {
      failures.push(`${label}: missing, duplicate or unsuccessful file`);
      continue;
    }
    const assertions = files[0].assertionResults.filter((assertion) => {
      if (!assertion || typeof assertion.fullName !== "string") return false;
      // Vitest includes the file name in fullName on some releases. Exact
      // ancestor titles identify the describe block without that prefix.
      if (required.suite && (!Array.isArray(assertion.ancestorTitles) || !assertion.ancestorTitles.includes(required.suite))) return false;
      return !required.postgres || /\[postgres\]/i.test(assertion.fullName);
    });
    if (assertions.length === 0 || assertions.some((assertion) => assertion.status !== "passed")) {
      failures.push(`${label}: required scenarios did not all pass`);
    }
  }
  return failures;
}

/** @param {string[]} args @returns {number} */
export function main(args) {
  const [lane, reportPath] = args;
  if (args.length !== 2 || !["tofu", "workflows", "platform-postgres"].includes(lane)) {
    console.error("usage: node tests/ci/assert-lane-report.mjs <tofu|workflows|platform-postgres> <vitest-json-report>");
    return 2;
  }
  try {
    const requirements = requirementsFor(lane, process.cwd());
    const failures = reportFailures(requirements, JSON.parse(fs.readFileSync(reportPath, "utf8")), process.cwd());
    for (const failure of failures) console.error(`::error::${failure}`);
    if (failures.length > 0) return 1;
    console.log(`${lane}: all ${requirements.length} real-engine requirements passed`);
    return 0;
  } catch {
    console.error("::error::Cannot verify required scenarios: source files or the Vitest report are unavailable/invalid.");
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
