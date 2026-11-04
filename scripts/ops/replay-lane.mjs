#!/usr/bin/env node
/**
 * Named workflow-history tools (PROD-OPS-03). The canonical workflow gate also
 * selects replay against the frozen current-code synthetic corpus; recording remains opt-in.
 *   npm run replay:record   record fixtures (needs a Temporal test server; ZENITH_TEST_TEMPORAL=1 is set)
 *   npm run replay:check    replay every committed fixture; missing fixtures FAIL
 */
import { spawnSync } from "node:child_process";
const mode = process.argv[2];
const lanes = {
  record: { env: { ZENITH_RECORD_WORKFLOW_HISTORIES: "1", ZENITH_TEST_TEMPORAL: "1" }, files: ["tests/workflows/history-record.test.ts"] },
  check: { env: { ZENITH_REPLAY_LANE: "1" }, files: ["tests/workflows/history-replay.test.ts", "tests/workflows/versioning-audit.test.ts"] },
};
if (!lanes[mode]) { process.stderr.write("usage: replay-lane.mjs record|check\n"); process.exit(2); }
const r = spawnSync("npx", ["vitest", "run", ...lanes[mode].files], { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...lanes[mode].env } });
process.exit(r.status ?? 1);
