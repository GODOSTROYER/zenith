#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reportFailures } from "../../tests/ci/assert-lane-report.mjs";
import { WAVE6, wave6Manifest, commandsForRequirement } from "./wave6-manifest.mjs";
export { WAVE6, wave6Manifest, commandsForRequirement } from "./wave6-manifest.mjs";

export function main(args) {
  try {
    if (args.length === 3 && args[0] === "--requirement" && args[2] === "--print") { process.stdout.write(JSON.stringify(commandsForRequirement(args[1]), null, 2) + "\n"); return 0; }
    if (args.length === 4 && ["--lane", "--case"].includes(args[0]) && args[2] === "--report") {
      const requirements = args[0] === "--case" ? WAVE6.gatedCases.filter(item => item.id === args[1]) : wave6Manifest(args[1]).requirements;
      if (!requirements.length) throw new Error("No registered case");
      const failures = reportFailures(requirements, JSON.parse(fs.readFileSync(args[3], "utf8")), process.cwd());
      process.stdout.write(JSON.stringify({ passed: requirements.length - failures.length, failed: failures.length, failures }) + "\n"); return failures.length ? 1 : 0;
    }
    throw new Error("Use --requirement ID --print, --lane wave6-LANE --report FILE or --case ID --report FILE");
  } catch (error) { process.stderr.write(`${error.message}\n`); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
