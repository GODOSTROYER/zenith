import { describe, expect, it } from "vitest";
import { temporal } from "@temporalio/proto";
import { FIXTURE_FORMAT, historyOf, serializeFixture, type HistoryFixture } from "./history-fixtures";

const identity = { scenario: "codec", workflowType: "deployWorkflow", covers: "codec compatibility", workflowId: "codec-run", temporalSdk: "1.24.0" };
const fixture = (history: unknown): HistoryFixture => ({ format: FIXTURE_FORMAT, ...identity, history });
const jsonOf = (history: unknown) => JSON.parse(serializeFixture({ ...identity, history: historyOf(fixture(history)) })) as HistoryFixture;

describe("recorded history full ProtoJSON codec", () => {
  it("preserves exact long IDs, timestamp nanoseconds and binary payloads through both conversions", () => {
    const history = { events: [{
      eventId: "9007199254740993", eventTime: "2026-10-08T10:20:30.123456789Z", eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
      workflowExecutionStartedEventAttributes: {
        workflowType: { name: "deployWorkflow" }, taskQueue: { name: "codec", kind: "TASK_QUEUE_KIND_NORMAL" },
        input: { payloads: [{ metadata: { encoding: "YmluYXJ5L3BsYWlu" }, data: "AP+A/w==" }] },
      },
    }] };
    const before = historyOf(fixture(history));
    const serialized = jsonOf(history);
    const after = historyOf(serialized);
    expect(serialized.history).toEqual(history);
    expect(temporal.api.history.v1.History.encode(after).finish()).toEqual(temporal.api.history.v1.History.encode(before).finish());
    expect(serializeFixture({ ...identity, history: after })).toBe(serializeFixture({ ...identity, history: before }));
  });

  it.each([null, {}, { events: "invalid" }])("retains malformed history refusal for %j", (history) => {
    expect(() => historyOf(fixture(history))).toThrow("Invalid history, expected an object with an array of events");
  });

  it("retains the missing event attributes refusal", () => {
    expect(() => historyOf(fixture({ events: [{ eventId: "1" }] }))).toThrow("Missing attributes in history event");
  });

  it("retains unknown-field tolerance while preserving all known event values", () => {
    const known = { events: [{ eventId: "1", eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED", workflowExecutionCompletedEventAttributes: {} }] };
    const future = { events: [{ ...known.events[0], futureServerField: "new", workflowExecutionCompletedEventAttributes: { futureAttribute: true } }] };
    expect(jsonOf(future)).toEqual(jsonOf(known));
  });

  it("retains SDK legacy enum aliases for event, task queue, child policies, initiator and retries", () => {
    const aliases = { events: [
      { eventId: "1", eventType: "StartChildWorkflowExecutionInitiated", startChildWorkflowExecutionInitiatedEventAttributes: { taskQueue: { name: "codec", kind: "Normal" }, parentClosePolicy: "Abandon", workflowIdReusePolicy: "AllowDuplicate" } },
      { eventId: "2", eventType: "WorkflowExecutionContinuedAsNew", workflowExecutionContinuedAsNewEventAttributes: { initiator: "Retry" } },
      { eventId: "3", eventType: "ActivityTaskFailed", activityTaskFailedEventAttributes: { retryState: "MaximumAttemptsReached" } },
      { eventId: "4", eventType: "ChildWorkflowExecutionFailed", childWorkflowExecutionFailedEventAttributes: { retryState: "NonRetryableFailure" } },
    ] };
    const canonical = { events: [
      { eventId: "1", eventType: "EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED", startChildWorkflowExecutionInitiatedEventAttributes: { taskQueue: { name: "codec", kind: "TASK_QUEUE_KIND_NORMAL" }, parentClosePolicy: "PARENT_CLOSE_POLICY_ABANDON", workflowIdReusePolicy: "WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE" } },
      { eventId: "2", eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW", workflowExecutionContinuedAsNewEventAttributes: { initiator: "CONTINUE_AS_NEW_INITIATOR_RETRY" } },
      { eventId: "3", eventType: "EVENT_TYPE_ACTIVITY_TASK_FAILED", activityTaskFailedEventAttributes: { retryState: "RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED" } },
      { eventId: "4", eventType: "EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_FAILED", childWorkflowExecutionFailedEventAttributes: { retryState: "RETRY_STATE_NON_RETRYABLE_FAILURE" } },
    ] };
    expect(jsonOf(aliases)).toEqual(jsonOf(canonical));
    expect(jsonOf(aliases).history).toEqual(canonical);
  });
});
