/**
 * A worker double that reports the environment a build actually receives.
 *
 * `RecipeLocalRunner` cannot see inside the child it spawns, so the claim "no
 * platform secret reaches a build" is only worth something if something in the
 * child says what it got. This prints the environment variable NAMES (never a
 * value) on stdout, where the runner captures them as build log lines, and then
 * fails honestly: it compiled nothing.
 *
 * Test support only. Workstream W2 (hosted R3).
 */
import fs from "node:fs";

const [jobFile, resultFile] = process.argv.slice(2);

process.stdout.write(`env-keys ${Object.keys(process.env).sort().join(",")}\n`);
process.stdout.write(`argv-job ${jobFile}\n`);
process.stdout.write(`exec-argv ${process.execArgv.join(" ")}\n`);

fs.writeFileSync(
  resultFile,
  JSON.stringify({ ok: false, error: "debug worker: reported the environment and built nothing" })
);
process.exit(1);
