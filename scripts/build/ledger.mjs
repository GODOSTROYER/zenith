#!/usr/bin/env node
// Renders docs/build/ledger.json (the machine-readable source of truth) into
// docs/build/IMPLEMENTATION-LEDGER.md. `--check` exits 1 when the markdown is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ledger = JSON.parse(readFileSync(join(root, "docs/build/ledger.json"), "utf8"));
const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const rows = ledger.workstreams.map((w) =>
  `| ${w.id} | ${cell(w.title)} | ${w.wave} | ${w.state} | ${cell(w.deps.join(", "))} | ${cell(w.branch ?? "")} | ${cell(w.commit ?? "")} | ${cell(w.tests ?? "")} | ${cell(w.review ?? "")} | ${cell(w.notes ?? "")} |`
);
const blockers = ledger.blockers.map((b) => `| ${b.id} | ${cell(b.what)} | ${cell(b.blocks)} | ${cell(b.workaround)} |`);

const md = `# Implementation ledger

Generated from \`docs/build/ledger.json\` by \`node scripts/build/ledger.mjs\` — edit the JSON, not this file.

- Program: ${ledger.program}
- Integration: branch \`${ledger.integrationBranch}\`, worktree \`${ledger.integrationWorktree}\`
- Baseline: \`${ledger.baseline.commit}\` (${ledger.baseline.date}) — ${ledger.baseline.tests}; typecheck ${ledger.baseline.typecheck}; lint ${ledger.baseline.lint}
- Orchestrator: ${ledger.orchestrator}; workers: ${ledger.workerModel}

States: planned → in_progress → review → integrated (or blocked).

| ID | Workstream | Wave | State | Depends on | Branch | Commit | Tests | Review | Notes |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## External blockers

| ID | What | Blocks | Workaround |
|---|---|---|---|
${blockers.join("\n")}
`;

const out = join(root, "docs/build/IMPLEMENTATION-LEDGER.md");
if (process.argv.includes("--check")) {
  const current = readFileSync(out, "utf8");
  if (current !== md) {
    console.error("docs/build/IMPLEMENTATION-LEDGER.md is stale; run node scripts/build/ledger.mjs");
    process.exit(1);
  }
} else writeFileSync(out, md);
