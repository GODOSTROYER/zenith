/**
 * The failure -> final-status table (definitions/failures.ts), tested without a
 * Temporal server: errors are built the way the SDK delivers them to workflow
 * code (an ActivityFailure wrapping the real cause), and the classifier is a
 * pure function. The end-to-end behaviour of the same table is covered in
 * deploy.test.ts and operations.test.ts.
 */

import { describe, expect, it } from "vitest";
import { ActivityFailure, ApplicationFailure, CancelledFailure, RetryState, TimeoutFailure, TimeoutType } from "@temporalio/common";
import { classifyFailure, describeError, failureTypeOf, redactDetail } from "@/lib/workflows/definitions/failures";
import { ACTIVITY_OPTIONS, MAX_DETAIL_CHARS, STEP_MAY_HAVE_ACTED } from "@/lib/workflows/definitions/policies";
import { FAILURE_TYPES, type StepName } from "@/lib/workflows/types";

const wrap = (cause: Error, activityType = "someActivity"): ActivityFailure =>
  new ActivityFailure("Activity task failed", activityType, "1", RetryState.NON_RETRYABLE_FAILURE, "worker-1", cause);

const typed = (type: string, message = "boom"): ActivityFailure => wrap(ApplicationFailure.create({ message, type, nonRetryable: true }));
const plain = (message = "boom"): ActivityFailure => wrap(ApplicationFailure.create({ message, type: "Error", nonRetryable: false }));
const timeout = (kind: TimeoutType = TimeoutType.HEARTBEAT): ActivityFailure => wrap(new TimeoutFailure("Activity timed out", undefined, kind));

type Row = { name: string; step: StepName; mutationStarted: boolean; err: unknown; status: "failed" | "uncertain"; message: RegExp };

const TABLE: Row[] = [
  // plan_changed: always failed, always "nothing applied"
  { name: "plan_changed at final_plan", step: "final_plan", mutationStarted: false, err: typed(FAILURE_TYPES.planChanged), status: "failed", message: /plan changed after it was reviewed.*nothing was applied.*new approval/ },
  // LeaseBusy / not_implemented: nothing acted
  { name: "LeaseBusy at lease", step: "lease", mutationStarted: false, err: typed(FAILURE_TYPES.leaseBusy), status: "failed", message: /environment is busy/ },
  { name: "not_implemented at apply", step: "apply_infrastructure", mutationStarted: true, err: typed(FAILURE_TYPES.notImplemented), status: "failed", message: /not implemented in this worker build; nothing was changed/ },
  // StepFailed: clean failure
  { name: "StepFailed at apply", step: "apply_infrastructure", mutationStarted: true, err: typed(FAILURE_TYPES.stepFailed), status: "failed", message: /partial apply; reconcile will observe/ },
  { name: "StepFailed at deploy", step: "deploy", mutationStarted: true, err: typed(FAILURE_TYPES.stepFailed), status: "failed", message: /may have partially completed/ },
  { name: "StepFailed at build after an apply", step: "build", mutationStarted: true, err: typed(FAILURE_TYPES.stepFailed), status: "failed", message: /nothing was rolled back/ },
  { name: "StepFailed at verify before any mutation", step: "verify_application", mutationStarted: false, err: typed(FAILURE_TYPES.stepFailed), status: "failed", message: /verify_application failed\./ },
  // LeaseLost
  { name: "LeaseLost at apply", step: "apply_infrastructure", mutationStarted: true, err: typed(FAILURE_TYPES.leaseLost), status: "uncertain", message: /lease was lost during apply_infrastructure/ },
  { name: "LeaseLost at deploy", step: "deploy", mutationStarted: true, err: typed(FAILURE_TYPES.leaseLost), status: "uncertain", message: /lease was lost during deploy/ },
  { name: "LeaseLost at renewal after an apply", step: "lease", mutationStarted: true, err: typed(FAILURE_TYPES.leaseLost), status: "uncertain", message: /during lease renewal/ },
  { name: "LeaseLost at plan (nothing mutated)", step: "plan", mutationStarted: false, err: typed(FAILURE_TYPES.leaseLost), status: "failed", message: /before any change was made/ },
  { name: "LeaseLost at renewal before any mutation", step: "lease", mutationStarted: false, err: typed(FAILURE_TYPES.leaseLost), status: "failed", message: /before any change was made/ },
  // unknown errors and timeouts: uncertain iff the step may act
  { name: "unknown error at apply", step: "apply_infrastructure", mutationStarted: true, err: plain("reset by peer"), status: "uncertain", message: /may have acted; the outcome is unknown/ },
  { name: "unknown error at deploy", step: "deploy", mutationStarted: true, err: plain(), status: "uncertain", message: /deploy did not complete cleanly/ },
  { name: "unknown error at migrate", step: "migrate", mutationStarted: true, err: plain(), status: "uncertain", message: /migrate did not complete cleanly/ },
  { name: "unknown error at execute_capability", step: "execute_capability", mutationStarted: true, err: plain(), status: "uncertain", message: /execute_capability did not complete cleanly/ },
  { name: "heartbeat timeout at apply", step: "apply_infrastructure", mutationStarted: true, err: timeout(TimeoutType.HEARTBEAT), status: "uncertain", message: /timed out \(HEARTBEAT\)/ },
  { name: "start-to-close timeout at deploy", step: "deploy", mutationStarted: true, err: timeout(TimeoutType.START_TO_CLOSE), status: "uncertain", message: /timed out \(START_TO_CLOSE\)/ },
  { name: "unknown error at validate", step: "validate", mutationStarted: false, err: plain(), status: "failed", message: /validate failed before any change was made/ },
  { name: "unknown error at plan", step: "plan", mutationStarted: false, err: plain(), status: "failed", message: /plan failed before any change was made/ },
  { name: "unknown error at build after an apply", step: "build", mutationStarted: true, err: plain(), status: "failed", message: /Earlier steps had already changed the environment; nothing was rolled back/ },
  { name: "timeout at verify after a deploy", step: "verify_application", mutationStarted: true, err: timeout(TimeoutType.START_TO_CLOSE), status: "failed", message: /nothing was rolled back/ },
  // not an ActivityFailure at all (a bug in workflow code, a bare Error)
  { name: "bare Error at a read step", step: "policy", mutationStarted: false, err: new Error("kaboom"), status: "failed", message: /policy failed before any change was made.*kaboom/ },
  { name: "bare Error at a mutating step", step: "deploy", mutationStarted: true, err: new Error("kaboom"), status: "uncertain", message: /kaboom/ },
];

describe("classifyFailure: the failure -> status table", () => {
  it.each(TABLE)("$name -> $status", ({ step, mutationStarted, err, status, message }) => {
    const result = classifyFailure({ step, err, mutationStarted });
    expect(result.status).toBe(status);
    expect(result.message).toMatch(message);
  });

  it("reads the type through the ActivityFailure wrapper and reports it", () => {
    expect(failureTypeOf(typed(FAILURE_TYPES.leaseLost))).toBe("LeaseLost");
    expect(failureTypeOf(plain())).toBe("Error");
    expect(failureTypeOf(timeout())).toBeUndefined();
    expect(failureTypeOf(new Error("x"))).toBeUndefined();
    expect(classifyFailure({ step: "apply_infrastructure", err: typed(FAILURE_TYPES.leaseLost), mutationStarted: true }).failureType).toBe("LeaseLost");
  });

  it("never classifies a cancellation as anything but its own path", () => {
    // Cancellation is handled before classification (isCancellation); if one reached here it is still not success.
    const result = classifyFailure({ step: "deploy", err: wrap(new CancelledFailure("cancelled")), mutationStarted: true });
    expect(["failed", "uncertain"]).toContain(result.status);
    expect(describeError(wrap(new CancelledFailure("cancelled")))).toBe("activity was cancelled");
  });

  it("only ever answers failed or uncertain", () => {
    for (const row of TABLE) expect(["failed", "uncertain"]).toContain(classifyFailure(row).status);
  });
});

describe("the may-have-acted table and retry policies (policies.ts)", () => {
  it("marks exactly the steps that change something outside the workflow", () => {
    const acts: StepName[] = ["apply_network", "apply_data", "apply_infrastructure", "publish", "deploy", "secrets", "ingress", "dns_tls", "migrate", "execute_capability"];
    for (const step of acts) expect(STEP_MAY_HAVE_ACTED[step], step).toBe(true);
    const reads: StepName[] = ["validate", "lease", "credentials", "plan", "policy", "approval", "final_plan", "build", "verify_infrastructure", "verify_application", "observe", "finalize", "release"];
    for (const step of reads) expect(STEP_MAY_HAVE_ACTED[step], step).toBe(false);
  });

  it("gives every mutating activity exactly one Temporal attempt, a heartbeat timeout and wait-for-cancel", () => {
    for (const name of ["applyInfrastructure", "deployWorkloads", "runMigrations", "executeCapability"] as const) {
      const o = ACTIVITY_OPTIONS[name];
      expect(o.retry?.maximumAttempts, name).toBe(1);
      expect(o.heartbeatTimeout, name).toBe("60s");
      expect(o.cancellationType, name).toBe("WAIT_CANCELLATION_COMPLETED");
    }
    expect(ACTIVITY_OPTIONS.applyInfrastructure.startToCloseTimeout).toBe("60m");
  });

  it("gives reads 5 attempts with exponential backoff and lease operations 3", () => {
    for (const name of ["validateDesiredState", "evaluatePolicy", "checkApproval", "verifyInfrastructure", "verifyApplication", "observeEnvironment"] as const) {
      expect(ACTIVITY_OPTIONS[name].retry, name).toMatchObject({ maximumAttempts: 5, backoffCoefficient: 2 });
    }
    for (const name of ["acquireLease", "renewLease", "releaseLease"] as const) expect(ACTIVITY_OPTIONS[name].retry?.maximumAttempts, name).toBe(3);
  });

  it("never retries the failure types the workflow understands", () => {
    for (const [name, o] of Object.entries(ACTIVITY_OPTIONS)) {
      expect(o.retry?.nonRetryableErrorTypes, name).toEqual(expect.arrayContaining(["LeaseLost", "plan_changed", "LeaseBusy", "StepFailed", "not_implemented"]));
    }
  });

  it("lets the terminal status write retry without a cap", () => {
    expect(ACTIVITY_OPTIONS.markOperation.retry?.maximumAttempts).toBeUndefined();
    expect(ACTIVITY_OPTIONS.markOperation.scheduleToCloseTimeout).toBe("1h");
  });
});

describe("redactDetail", () => {
  const cases: [string, string, string][] = [
    ["an AWS access key id", "denied for AKIAIOSFODNN7EXAMPLE in us-east-1", "AKIAIOSFODNN7EXAMPLE"],
    ["a temporary key id", "ASIAY34FZKBOKMUTVV7A failed", "ASIAY34FZKBOKMUTVV7A"],
    ["a bearer token", "Authorization failed: Bearer abcdEFGH1234.ijkl-mnop_qrst", "abcdEFGH1234"],
    ["a JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U rejected", "eyJzdWIiOiIx"],
    ["a password assignment", "connect failed password=hunter2 host=db", "hunter2"],
    ["a quoted JSON secret", 'response {"password":"hunter2","user":"admin"}', "hunter2"],
    ["an api key header", "sent api_key: sk-live-1234567890", "sk-live-1234567890"],
    ["a private key block", "key -----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- leaked", "MIIEow"],
  ];
  it.each(cases)("scrubs %s", (_name, input, secret) => {
    expect(redactDetail(input)).not.toContain(secret);
  });

  it("keeps ordinary diagnostic text, including fence tokens", () => {
    expect(redactDetail("env:prod fence 42 lease lost during apply_infrastructure")).toBe("env:prod fence 42 lease lost during apply_infrastructure");
    expect(redactDetail("Lease env:x (fence 7) is no longer held")).toBe("Lease env:x (fence 7) is no longer held");
  });

  it("bounds the length and flattens newlines", () => {
    const long = redactDetail("x".repeat(5000));
    expect(long.length).toBe(MAX_DETAIL_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(redactDetail("line one\nline two\r\n\tline three")).toBe("line one line two line three");
  });
});
