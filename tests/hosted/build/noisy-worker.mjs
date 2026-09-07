/**
 * A worker double that prints far more than the log ceiling allows, so the
 * truncation notice is checked against a real stream rather than a string.
 *
 * Test support only. Workstream W2 (hosted R3).
 */
import fs from "node:fs";

const [, resultFile] = process.argv.slice(2);
for (let i = 0; i < 2000; i++) process.stdout.write(`line ${i} ${"x".repeat(200)}\n`);
fs.writeFileSync(resultFile, JSON.stringify({ ok: false, error: "noisy worker: built nothing" }));
process.exit(1);
