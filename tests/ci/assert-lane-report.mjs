/** Strict report validation uses the same canonical requirements as local/CI commands. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertionMatches, requirementsFor } from "../../scripts/ci/gate-manifest.mjs";
export { requirementsFor, TOFU_SUITES } from "../../scripts/ci/gate-manifest.mjs";

/**
 * @param {{ file: string, suite?: string, postgres?: boolean }[]} requirements
 * @param {unknown} report
 * @param {string} root
 * @returns {string[]} A missing, skipped, failed or malformed requirement fails closed.
 */
export function reportFailures(requirements, report, root) {
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) return ["Malformed Vitest report"];
  if (report.success !== true) return ["Vitest run did not succeed"];
  if (requirements.length === 0) return ["No required scenarios found"];
  const normalize = (value) => value.replaceAll("\\", "/");
  const fileEvidence = new Map();
  const namedAssertions = new Map();
  for (const entry of report.testResults) {
    if (!entry || typeof entry.name !== "string" || !Array.isArray(entry.assertionResults) || typeof entry.status !== "string") return ["Malformed Vitest file evidence"];
    const key = normalize(path.resolve(root, normalize(entry.name)));
    if (fileEvidence.has(key)) return ["Duplicate Vitest file evidence"];
    fileEvidence.set(key, entry);
    if (entry.assertionResults.some((assertion) => !assertion || typeof assertion.fullName !== "string" || assertion.fullName.trim().length === 0 || typeof assertion.status !== "string" || (assertion.ancestorTitles !== undefined && (!Array.isArray(assertion.ancestorTitles) || assertion.ancestorTitles.some((title) => typeof title !== "string"))))) return ["Malformed Vitest assertion evidence"];
    // fullName is a display label, not a case ID: distinct it.each inputs can
    // produce identical names. Standard Vitest JSON does not export task IDs,
    // so case deduplication cannot be verified from this format. File identity,
    // exact required suite ancestry, every assertion status and totals remain
    // mandatory; repeated displays cannot satisfy a different missing suite.
    if (entry.status !== "passed" || entry.assertionResults.some((assertion) => !["passed", "failed", "pending", "skipped", "todo"].includes(assertion.status) || assertion.status === "failed")) return ["Vitest file or assertion did not succeed"];
    const byTitle = new Map();
    for (const assertion of entry.assertionResults) {
      const named = byTitle.get(assertion.title) ?? [];
      named.push(assertion);
      byTitle.set(assertion.title, named);
    }
    namedAssertions.set(key, byTitle);
  }
  const total = report.testResults.reduce((count, entry) => count + entry.assertionResults.length, 0);
  if ((report.numTotalTests !== undefined && (!Number.isSafeInteger(report.numTotalTests) || report.numTotalTests !== total)) || (report.numFailedTests !== undefined && report.numFailedTests !== 0)) return ["Inconsistent Vitest report counts"];
  const failures = [];
  for (const required of requirements) {
    const expected = normalize(path.resolve(root, required.file));
    const file = fileEvidence.get(expected);
    const label = `${required.file}${required.suite ? `: ${required.suite}` : required.postgres ? ": [postgres]" : ""}`;
    if (!file || !Array.isArray(file.assertionResults) || file.status !== "passed") {
      failures.push(`${label}: missing, duplicate or unsuccessful file`);
      continue;
    }
    // Exact-case requirements cannot match another title. Keep every same-title
    // assertion so duplicates and a nonpassing sibling still fail closed.
    const candidates = required.test ? namedAssertions.get(expected).get(required.test) ?? [] : file.assertionResults;
    const assertions = candidates.filter((assertion) => assertionMatches(required, assertion));
    if (assertions.length === 0 || assertions.some((assertion) => assertion.status !== "passed")) {
      failures.push(`${label}: required scenarios did not all pass`);
    }
  }
  return failures;
}

/** @param {string[]} args @returns {number} */
export function main(args) {
  const [lane, reportPath] = args;
  if (args.length !== 2 || !["postgres", "policy", "tofu", "workflows", "platform-postgres", "drv1-private-source", "drv1-update-rollback"].includes(lane)) {
    console.error("usage: node tests/ci/assert-lane-report.mjs <postgres|policy|tofu|workflows|platform-postgres|drv1-private-source|drv1-update-rollback> <vitest-json-report>");
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
