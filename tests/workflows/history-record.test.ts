/**
 * Recorder for the committed workflow-history fixtures. NOT part of the normal run:
 * it only does anything with ZENITH_RECORD_WORKFLOW_HISTORIES=1 and a Temporal test
 * server (the same local-server rules as the rest of tests/workflows/support.ts).
 *
 *   ZENITH_RECORD_WORKFLOW_HISTORIES=1 npx vitest run tests/workflows/history-record.test.ts
 *
 * It adds a fixture only for a scenario that has none; existing fixtures are the
 * frozen released histories and are never overwritten unless ZENITH_RECORD_OVERWRITE=1.
 * Review the diff of tests/fixtures/workflow-histories like code: a changed existing
 * fixture means somebody discarded a recorded history.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOW_HISTORY_SCENARIOS } from "./history-scenarios";
import { serializeFixture, writeFixture } from "./history-fixtures";
import { serverSuite } from "./support";

const recording = process.env.ZENITH_RECORD_WORKFLOW_HISTORIES === "1";
const overwrite = process.env.ZENITH_RECORD_OVERWRITE === "1";
const sdk = (JSON.parse(readFileSync(path.resolve(__dirname, "../../node_modules/@temporalio/worker/package.json"), "utf8")) as { version: string }).version;

// Only start a server when recording; a normal run must not pay for or require one.
const suite = recording ? serverSuite("local", { concurrent: true }) : undefined;

describe.skipIf(!recording)("record workflow history fixtures (ZENITH_RECORD_WORKFLOW_HISTORIES=1)", () => {
  for (const s of suite ? WORKFLOW_HISTORY_SCENARIOS : []) {
    suite?.scenario(`records ${s.id}`, async (h) => {
      const handles = await s.run(h);
      expect(handles, "a scenario records exactly one workflow").toHaveLength(1);
      const handle = handles[0]!;
      const history = await handle.fetchHistory();
      expect(history.events!.length).toBeGreaterThan(3);
      const first = history.events![0]!.workflowExecutionStartedEventAttributes;
      expect(first?.workflowType?.name, "history belongs to the declared workflow type").toBe(s.workflowType);
      writeFixture(`${s.id}.json`, serializeFixture({ scenario: s.id, workflowType: s.workflowType, covers: s.covers, workflowId: handle.workflowId, temporalSdk: sdk, history }), { overwrite });
    }, 120_000);
  }
});

// Keeps the file a valid (skipped, never passed) test file when the recorder is off.
it.skip("recorder is opt-in: set ZENITH_RECORD_WORKFLOW_HISTORIES=1 to record", () => undefined);
