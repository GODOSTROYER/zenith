/**
 * Recorder for the committed workflow-history fixtures. NOT part of the normal run:
 * it only does anything with ZENITH_RECORD_WORKFLOW_HISTORIES=1 and a Temporal test
 * server (the same local-server rules as the rest of tests/workflows/support.ts).
 *
 *   ZENITH_RECORD_WORKFLOW_HISTORIES=1 npx vitest run tests/workflows/history-record.test.ts
 *
 * It adds a fixture only for a scenario that has none; existing fixtures are the
 * frozen current-code synthetic histories (not earlier-release evidence) and are never overwritten unless ZENITH_RECORD_OVERWRITE=1.
 * Review the diff of tests/fixtures/workflow-histories like code: a changed existing
 * fixture means somebody discarded a recorded history.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowFailedError } from "@temporalio/client";
import { ActivityFailure, ApplicationFailure, defaultPayloadConverter } from "@temporalio/common";
import type { temporal } from "@temporalio/proto";
import { WORKFLOW_HISTORY_SCENARIOS } from "./history-scenarios";
import { serializeFixture, writeFixture } from "./history-fixtures";
import { serverSuite } from "./support";

const recording = process.env.ZENITH_RECORD_WORKFLOW_HISTORIES === "1";
const overwrite = process.env.ZENITH_RECORD_OVERWRITE === "1";
const sdk = (JSON.parse(readFileSync(path.resolve(__dirname, "../../node_modules/@temporalio/worker/package.json"), "utf8")) as { version: string }).version;

function missingActivity(failure?: temporal.api.failure.v1.IFailure | null): boolean {
  return !!failure && (failure.applicationFailureInfo?.type === "ActivityNotFound" || missingActivity(failure.cause));
}

// Only start a server when recording; a normal run must not pay for or require one.
const suite = recording ? serverSuite("local", { concurrent: true }) : undefined;

describe.skipIf(!recording)("record workflow history fixtures (ZENITH_RECORD_WORKFLOW_HISTORIES=1)", () => {
  for (const s of suite ? WORKFLOW_HISTORY_SCENARIOS : []) {
    suite?.scenario(`records ${s.id}`, async (h) => {
      const handles = await s.run(h);
      expect(handles, "a scenario records exactly one workflow").toHaveLength(1);
      const handle = handles[0]!;
      if ("failureType" in s.outcome) {
        let failure: unknown;
        try { await handle.result(); } catch (error) { failure = error; }
        expect(failure, "the intended failure branch must actually fail").toBeInstanceOf(WorkflowFailedError);
        let cause: unknown = (failure as WorkflowFailedError).cause;
        while (cause instanceof ActivityFailure) cause = cause.cause;
        expect(cause).toBeInstanceOf(ApplicationFailure);
        expect((cause as ApplicationFailure).type).toBe(s.outcome.failureType);
        expect((cause as ApplicationFailure).nonRetryable).toBe(true);
      } else {
        const result = await handle.result();
        expect(result, "the recorded workflow must reach its declared terminal outcome").toMatchObject(s.outcome.result);
        if (s.outcome.errorIncludes) expect(result.error).toContain(s.outcome.errorIncludes);
      }
      const history = await handle.fetchHistory();
      expect(history.events!.length).toBeGreaterThan(3);
      const first = history.events![0]!.workflowExecutionStartedEventAttributes;
      expect(first?.workflowType?.name, "history belongs to the declared workflow type").toBe(s.workflowType);
      const unregistered = history.events!.filter(event => missingActivity(event.activityTaskFailedEventAttributes?.failure) || missingActivity(event.workflowExecutionFailedEventAttributes?.failure)).map(event => String(event.eventId));
      expect(unregistered, "no candidate may carry an unregistered activity failure, even if workflow code catches it").toEqual([]);
      const scheduled = history.events!.flatMap(event => event.activityTaskScheduledEventAttributes?.activityType?.name ?? []);
      for (const [activity, count] of Object.entries(s.activityCounts ?? {})) expect(scheduled.filter(name => name === activity), `actual scheduled ${activity} branch`).toHaveLength(count);
      for (const [activity, expected] of Object.entries(s.completedActivityResults ?? {})) {
        const starts = history.events!.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === activity);
        expect(starts.length).toBe(1);
        const completions = history.events!.flatMap(event => {
          const completed = event.activityTaskCompletedEventAttributes;
          return completed && String(completed.scheduledEventId) === String(starts[0].eventId) ? [completed] : [];
        });
        expect(completions.length, `the actual scheduled ${activity} must complete, even if the workflow suppresses its failure`).toBe(1);
        const payloads = completions[0].result?.payloads;
        expect(payloads?.length).toBe(1);
        expect(defaultPayloadConverter.fromPayload(payloads![0])).toEqual(expected);
      }
      for (const [activity, count] of Object.entries(s.fakeActivityCounts ?? {})) expect(h.fake.calls.filter(call => call.activity === activity), `actual ${activity} retry attempts`).toHaveLength(count);
      writeFixture(`${s.id}.json`, serializeFixture({ scenario: s.id, workflowType: s.workflowType, covers: s.covers, workflowId: handle.workflowId, temporalSdk: sdk, history }), { overwrite });
    }, 120_000);
  }
});

// Keeps the file a valid (skipped, never passed) test file when the recorder is off.
it.skip("recorder is opt-in: set ZENITH_RECORD_WORKFLOW_HISTORIES=1 to record", () => undefined);
