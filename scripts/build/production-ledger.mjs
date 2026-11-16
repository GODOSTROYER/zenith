#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseStatus } from "../release/status.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, "docs/build/production");
const ledger = JSON.parse(fs.readFileSync(path.join(directory, "ledger.json"), "utf8"));
// Trust is an explicit verifier input, never a key supplied by the ledger or sign-off record.
const keyFlag = process.argv.indexOf("--signoff-keys");
const keys = keyFlag >= 0 ? JSON.parse(fs.readFileSync(process.argv[keyFlag + 1], "utf8")) : [];
const releaseErrors = validateReleaseStatus(ledger, { root, keys });
if (releaseErrors.length) throw new Error(`Invalid release status:\n${releaseErrors.join("\n")}`);
const ids = new Set(ledger.requirements.map((requirement) => requirement.id));
if (ids.size !== ledger.requirements.length) throw new Error("Duplicate production requirement ID");
const byId = new Map(ledger.requirements.map((requirement) => [requirement.id, requirement]));
const visited = new Set();
const active = new Set();
function visit(id) {
  if (!ids.has(id)) throw new Error(`Unknown production dependency: ${id}`);
  if (active.has(id)) throw new Error(`Cyclic production dependency: ${id}`);
  if (visited.has(id)) return;
  active.add(id);
  for (const dependency of byId.get(id).dependencies) visit(dependency);
  active.delete(id);
  visited.add(id);
}
for (const requirement of ledger.requirements) {
  if (!/^PROD-[A-Z]+-\d{2}$/.test(requirement.id)) throw new Error("Invalid production requirement ID");
  if (!requirement.acceptance.length) throw new Error(`Missing acceptance: ${requirement.id}`);
  for (const evidence of requirement.evidence) {
    if (!ledger.evidenceLevels.includes(evidence.level)) throw new Error(`Unknown evidence level: ${requirement.id}`);
    if (!/^[a-f0-9]{40}$/.test(evidence.commit)) throw new Error(`Unbound evidence: ${requirement.id}`);
  }
  visit(requirement.id);
}
const escape = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const lines = [
  "# Production requirements",
  "",
  "Generated from `ledger.json` with `node scripts/build/production-ledger.mjs`. Requirement IDs remain stable; add evidence and state changes rather than restating the program.",
  "",
  `Source baseline: \`${ledger.baseline.branch}\` at \`${ledger.baseline.commit}\`. Historical wave-8 implementation remains complete. Its local evidence and the failed remote run are separate facts.`,
  "",
  "Evidence levels: " + ledger.evidenceLevels.map((level) => `\`${level}\``).join(", ") + ".",
  "",
  "| Requirement | Acceptance | State | Dependencies | Evidence |",
  "|---|---|---|---|---|",
];
for (const requirement of ledger.requirements) {
  lines.push(`| ${requirement.id}: ${escape(requirement.title)} | ${escape(requirement.acceptance.join(" "))} | ${escape(requirement.state)} / ${escape(requirement.implementationStatus)} | ${requirement.dependencies.join(", ") || "None"} | ${requirement.evidence.map((evidence) => escape(`${evidence.level}: ${evidence.result}`)).join("; ") || "Pending"} |`);
}
lines.push("", "Release states remain separate:", "");
for (const [name, value] of Object.entries(ledger.releaseStatus)) lines.push(`- ${name}: ${value ? "yes" : "no"}`);
lines.push("", "Operator decisions:", "");
for (const decision of ledger.operatorDecisions) lines.push(`- ${escape(decision.id)}: ${escape(decision.description ?? decision.scope ?? JSON.stringify(decision))}`);
const rendered = lines.join("\n") + "\n";
const target = path.join(directory, "REQUIREMENTS.md");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== rendered) {
    process.stderr.write("Production requirements are stale; run node scripts/build/production-ledger.mjs.\n");
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(target, rendered);
  process.stdout.write(`Rendered ${ledger.requirements.length} production requirements.\n`);
}
