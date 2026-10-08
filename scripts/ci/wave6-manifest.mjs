/** Closed owner-run inventory. Reports establish results, never requirements. */
import fs from "node:fs";

export const WAVE6 = JSON.parse(fs.readFileSync(new URL("./wave6-gates.json", import.meta.url), "utf8"));
export const WAVE6_LANES = ["wave6-contract", ...new Set(WAVE6.gatedCases.map(item => `wave6-${item.lane}`))];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const prerequisite = {
  postgres: "Owned disposable PostgreSQL with current platform migrations; private database URL. PGlite is insufficient.",
  temporal: "Owned default stack, disposable PostgreSQL and Temporal namespace; no pre-existing worker or schedules.",
  kind: "Docker and owned kind cluster, private kubeconfig, required CNI/runtime/Gateway API and digest-pinned probe images.",
  browser: "Owned J1 stack, Mailpit, J2 private config, kind, Chromium and trusted local CA.",
  live: "Deferred: explicit owner DEC-CLOUD approval, private credentials, shared budget file, run scope, teardown and independent leak inventory.",
  docker: "Owned local Docker engine and the file-specific private fixture configuration.",
  "native-tools": "Pinned native tools named by the suite, installed on the Mac verifier.",
};
export function wave6Manifest(lane, root = process.cwd(), reportPath) {
  if (lane === "wave6-contract") {
    const requirements = WAVE6.contractFiles.map(file => ({ file, excludeSuites: [...new Set(WAVE6.gatedCases.filter(item => item.file === file).map(item => item.suite))] }));
    return { schemaVersion: 1, lane, kind: "owner-run", files: WAVE6.contractFiles, requirements, report: reportPath ?? ".data-ci-lane/wave6-contract.json", env: {}, command: [], excludeFiles: [], externalAcceptance: [], steps: [], tools: { node: "22.23.3" }, prerequisites: ["Node 22, local contract/PGlite only"], commands: WAVE6.contractFiles.reduce((batches, file, index) => { if (index % 8 === 0) batches.push([]); batches.at(-1).push(file); return batches; }, []).map(files => ["node", "node_modules/vitest/vitest.mjs", "run", ...files, "--no-file-parallelism", "--maxWorkers=2"]), root, required: true, acceptanceStatus: "verification_pending" };
  }
  const selected = WAVE6.gatedCases.filter(item => `wave6-${item.lane}` === lane);
  if (selected.length === 0) throw new Error("Unknown or empty Wave 6 lane");
  return { schemaVersion: 1, lane, kind: "owner-run", files: [...new Set(selected.map(item => item.file))], requirements: selected,
    report: reportPath ?? `.data-ci-lane/${lane}.json`, env: {}, command: [], excludeFiles: [], externalAcceptance: [], steps: [], tools: { node: "22.23.3" }, prerequisites: [prerequisite[selected[0].lane]],
    commands: selected.map(item => commandFor(item)), root, required: true, acceptanceStatus: "verification_pending" };
}
function commandFor(item) {
  const args = ["node", "node_modules/vitest/vitest.mjs", "run", item.file];
  if (item.file.startsWith("scripts/acceptance/live/dns/")) args.push("--config", "scripts/acceptance/live/dns/vitest.config.ts");
  args.push("--testNamePattern", escape(item.fullName), "--no-file-parallelism", "--maxWorkers=2", "--reporter=json", "--outputFile", `.data-ci-lane/${item.id}.json`);
  return { id: item.id, argv: args, gates: item.gates, privatePrerequisites: item.prerequisites, needs: prerequisite[item.lane],
    verify: ["node", "scripts/ci/wave6-gates.mjs", "--case", item.id, "--report", `.data-ci-lane/${item.id}.json`] };
}
/** Printing does not enable gates, load credentials, start engines or call providers. */
export function commandsForRequirement(id) {
  const files = WAVE6.requirements[id];
  if (!files?.length) throw new Error("Unknown requirement or missing test inventory");
  const commands = [];
  const contracts = files.filter(file => !file.endsWith(".spec.mjs") && !WAVE6.gatedCases.some(item => item.file === file && !WAVE6.contractFiles.includes(file)));
  for (let at = 0; at < contracts.length; at += 8) {
    const batch = contracts.slice(at, at + 8).filter(file => !file.startsWith("scripts/acceptance/live/dns/"));
    if (batch.length) commands.push({ argv: ["node", "node_modules/vitest/vitest.mjs", "run", ...batch, "--no-file-parallelism", "--maxWorkers=2"], needs: "Local contract/PGlite only; skipped engine assertions remain unverified." });
  }
  if (files.some(file => file.endsWith("journey.spec.mjs"))) commands.push({ argv: ["node", "scripts/acceptance/default-journey.mjs", "--config", "<absolute-private-J2-config.json>", "--receipt", "<new-private-J2-receipt.json>"], gates: ["ZENITH_DEFAULT_JOURNEY=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1"], needs: prerequisite.browser });
  if (files.includes("scripts/acceptance/live/dns/offline.test.ts")) commands.push({ argv: ["node", "node_modules/vitest/vitest.mjs", "run", "scripts/acceptance/live/dns/offline.test.ts", "--config", "scripts/acceptance/live/dns/vitest.config.ts", "--no-file-parallelism", "--maxWorkers=2"], needs: "Offline DNS transport contracts." });
  commands.push(...WAVE6.gatedCases.filter(item => files.includes(item.file)).map(commandFor));
  return { requirement: id, status: "implementation_complete_verification_pending", execution: "Sequential, Node 22; Docker Desktop 4 GiB, one kind node, no concurrent profiles; live deferred.", commands };
}
