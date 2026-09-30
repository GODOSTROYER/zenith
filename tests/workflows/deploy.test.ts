/**
 * infrastructureDeployWorkflow against a real Temporal server (the dev server:
 * no time skipping) with the scriptable fake activities. What this proves is how
 * the workflow behaves for each activity outcome; it says nothing about any
 * real cloud, OpenTofu or store: the fakes return canned values.
 *
 * The suite skips itself, with the reason, when no Temporal test server can be
 * started (see support.ts).
 */

import { describe, expect } from "vitest";
import { WorkflowFailedError } from "@temporalio/client";
import { FAILURE_TYPES, SIGNALS, WORKFLOW_ID, WORKFLOW_TYPES, type DeployWorkflowInput, type WorkflowResult } from "@/lib/workflows/types";
import { cancelOperation, signalApproval } from "@/lib/workflows/client";
import { deployInput, findCredentialKeys, serverSuite, waitFor, waitForStatus, type Harness } from "./support";

const { scenario } = serverSuite("local", { concurrent: true });

async function start(h: Harness, input: DeployWorkflowInput) {
  return h.client.workflow.start(WORKFLOW_TYPES.deploy, {
    workflowId: WORKFLOW_ID(input.operationId),
    taskQueue: h.taskQueue,
    args: [input],
  });
}

async function runDeploy(h: Harness, input: DeployWorkflowInput): Promise<WorkflowResult> {
  const handle = await start(h, input);
  return (await handle.result()) as WorkflowResult;
}

const finalStatus = (h: Harness) => h.fake.statuses.at(-1);
const stepStatuses = (result: WorkflowResult) => Object.fromEntries(result.steps.map((s) => [s.step, s.status]));

describe("deploy: happy path", () => {
  scenario("runs every step in order, records progress, and releases the lease", async (h) => {
    const input = deployInput();
    const result = await h.run(() => runDeploy(h, input));

    expect(result.status).toBe("succeeded");
    expect(result.error).toBeUndefined();

    // The activities, ignoring the recordStep bookkeeping between them.
    const work = h.fake.names().filter((n) => n !== "recordStep");
    expect(work).toEqual([
      "markOperation",
      "validateDesiredState",
      "acquireLease",
      "renewLease",
      "planInfrastructure",
      "renewLease",
      "evaluatePolicy",
      "renewLease",
      "finalPlan",
      "renewLease",
      "applyInfrastructure",
      "renewLease",
      "buildArtifacts",
      "renewLease",
      "deployWorkloads",
      "renewLease",
      "runMigrations",
      "renewLease",
      "verifyInfrastructure",
      "renewLease",
      "verifyApplication",
      "renewLease",
      "observeEnvironment",
      "markOperation",
      "releaseLease",
    ]);

    // Every declared step ended done, except approval (policy allowed) which was skipped.
    expect(stepStatuses(result)).toEqual({
      validate: "done",
      lease: "done",
      plan: "done",
      policy: "done",
      approval: "skipped",
      final_plan: "done",
      apply_infrastructure: "done",
      build: "done",
      deploy: "done",
      migrate: "done",
      verify_infrastructure: "done",
      verify_application: "done",
      observe: "done",
      finalize: "done",
      release: "done",
    });

    expect(h.fake.statuses.map((s) => s.status)).toEqual(["running", "succeeded"]);
    // One lease, acquired once and released once, and every fenced step carried it.
    expect(h.fake.lease.acquired).toHaveLength(1);
    expect(h.fake.lease.released).toHaveLength(1);
    expect(h.fake.lease.held).toBeUndefined();
    const fence = h.fake.lease.acquired[0]!.fenceToken;
    for (const name of ["planInfrastructure", "finalPlan", "applyInfrastructure", "buildArtifacts", "deployWorkloads", "runMigrations"] as const) {
      expect((h.fake.callsTo(name)[0]!.input as { lease: { fenceToken: number } }).lease.fenceToken).toBe(fence);
    }
    // The reviewed plan digest is what the final plan and the apply were bound to.
    expect(h.fake.callsTo("finalPlan")[0]!.input).toMatchObject({ approvedPlanDigest: "sha256:fake-plan-digest" });
    expect(h.fake.callsTo("applyInfrastructure")[0]!.input).toMatchObject({ planDigest: "sha256:fake-plan-digest" });
    // Built images flow to the deploy.
    expect(h.fake.callsTo("deployWorkloads")[0]!.input).toMatchObject({ images: [{ service: "web" }] });
    // The deployment record the UI follows is projected on every step.
    expect(h.fake.steps.every((s) => s.deploymentId === "dep-1" || s.step === "finalize" || s.step === "release")).toBe(true);
    expect(h.fake.steps.filter((s) => s.step === "apply_infrastructure").map((s) => s.status)).toEqual(["running", "done"]);
  });

  scenario("skips the build when the manifest pins images", async (h) => {
    const result = await h.run(() => runDeploy(h, deployInput({ build: false })));
    expect(result.status).toBe("succeeded");
    expect(h.fake.callsTo("buildArtifacts")).toHaveLength(0);
    expect(stepStatuses(result).build).toBe("skipped");
    expect(h.fake.callsTo("deployWorkloads")[0]!.input).toMatchObject({ images: [] });
  });

  scenario("answers the progress query while running and after it finishes", async (h) => {
    const input = deployInput();
    await h.run(async () => {
      const handle = await start(h, input);
      const done = await waitFor("query answers", async () => handle.query("progress").catch(() => undefined));
      expect(done).toMatchObject({ operationId: input.operationId });
      await handle.result();
      const after = (await handle.query("progress")) as { status: string; steps: { step: string; status: string }[] };
      expect(after.status).toBe("succeeded");
      expect(after.steps.find((s) => s.step === "release")?.status).toBe("done");
    });
  });

  scenario("carries no credential-shaped keys in any activity input or result", async (h) => {
    const input = deployInput();
    // Exercise the approval path too, so every activity that can run does.
    h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-1", reasons: ["prod"] });
    const result = await h.run(async () => {
      const handle = await start(h, input);
      await waitForStatus(handle, "awaiting_approval");
      h.fake.approve();
      await signalApproval(input.operationId, { client: h.client });
      return (await handle.result()) as WorkflowResult;
    });
    expect(result.status).toBe("succeeded");
    expect(h.fake.calls.length).toBeGreaterThan(10);
    for (const call of h.fake.calls) {
      expect(findCredentialKeys(call.input), `${call.activity} input`).toEqual([]);
      expect(findCredentialKeys(call.result), `${call.activity} result`).toEqual([]);
    }
    expect(findCredentialKeys(result)).toEqual([]);
  });
});

describe("deploy: validation and policy", () => {
  scenario("stops on an invalid desired state before taking the lease", async (h) => {
    h.fake.setResult("validateDesiredState", { graphDigest: "sha256:g", nodes: 2, problems: ["service web has no image", "port 0 is invalid", "a", "b"] });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/desired state is invalid: service web has no image; port 0 is invalid; a \(\+1 more\)/);
    expect(h.fake.callsTo("acquireLease")).toHaveLength(0);
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
    expect(finalStatus(h)).toMatchObject({ status: "failed" });
    expect(stepStatuses(result).release).toBe("skipped");
  });

  scenario("policy deny fails the operation with the reasons and never applies", async (h) => {
    h.fake.setResult("evaluatePolicy", { outcome: "deny", decisionId: "d-9", reasons: ["region eu-west-1 is not allowed", "budget exceeded"] });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("region eu-west-1 is not allowed; budget exceeded");
    expect(finalStatus(h)).toMatchObject({ status: "failed", error: expect.stringContaining("budget exceeded") });
    expect(h.fake.callsTo("finalPlan")).toHaveLength(0);
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
    // The lease taken for the plan is still released.
    expect(h.fake.lease.released).toHaveLength(1);
    expect(h.fake.lease.held).toBeUndefined();
  });

  scenario("a pre-approved proposal whose policy now requires approval still waits", async (h) => {
    h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-2", reasons: [] });
    await h.run(async () => {
      const input = deployInput({ preApproved: true });
      const handle = await start(h, input);
      await waitForStatus(handle, "awaiting_approval");
      expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
      await handle.cancel();
      await handle.result().catch(() => undefined);
    });
  });
});

describe("deploy: approval", () => {
  const needsApproval = (h: Harness): void => h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-2", reasons: ["production"] });

  scenario("waits without a lease, then continues on signal + approval with a fresh lease", async (h) => {
    needsApproval(h);
    const input = deployInput();
    const result = await h.run(async () => {
      const handle = await start(h, input);
      const waiting = await waitForStatus(handle, "awaiting_approval");
      expect(waiting.steps.find((s) => s.step === "approval")?.status).toBe("running");

      // Nothing has been applied, and the wait holds no lease.
      expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
      expect(h.fake.lease.held).toBeUndefined();
      expect(h.fake.lease.released).toHaveLength(1);
      expect(h.fake.statuses.map((s) => s.status)).toEqual(["running", "awaiting_approval"]);

      h.fake.approve();
      expect(await signalApproval(input.operationId, { client: h.client })).toEqual({ delivered: true });
      return (await handle.result()) as WorkflowResult;
    });

    expect(result.status).toBe("succeeded");
    expect(h.fake.statuses.map((s) => s.status)).toEqual(["running", "awaiting_approval", "running", "succeeded"]);
    // Two leases (before and after the wait) with increasing fences; the apply used the second.
    expect(h.fake.lease.acquired.map((l) => l.fenceToken)).toEqual([1, 2]);
    expect(h.fake.lease.released).toHaveLength(2);
    expect((h.fake.callsTo("applyInfrastructure")[0]!.input as { lease: { fenceToken: number } }).lease.fenceToken).toBe(2);
    // final_plan ran after the approval, against the reviewed digest.
    const names = h.fake.names();
    expect(names.indexOf("finalPlan")).toBeGreaterThan(names.lastIndexOf("checkApproval"));
    expect(stepStatuses(result).approval).toBe("done");
  });

  scenario("takes an approval that already exists on the spot: no wait, no awaiting_approval flicker, the lease is kept", async (h) => {
    needsApproval(h);
    h.fake.approve(); // the row exists before the workflow ever looks
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("succeeded");
    expect(h.fake.callsTo("checkApproval")).toHaveLength(1);
    expect(h.fake.statuses.map((s) => s.status)).toEqual(["running", "succeeded"]);
    expect(h.fake.lease.acquired).toHaveLength(1);
    expect(h.fake.lease.released).toHaveLength(1);
    expect(stepStatuses(result).approval).toBe("done");
  });

  scenario("a rejected approval fails the operation and applies nothing", async (h) => {
    needsApproval(h);
    const input = deployInput();
    const result = await h.run(async () => {
      const handle = await start(h, input);
      await waitForStatus(handle, "awaiting_approval");
      h.fake.reject();
      await signalApproval(input.operationId, { client: h.client });
      return (await handle.result()) as WorkflowResult;
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/approval was rejected/);
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
    expect(h.fake.callsTo("finalPlan")).toHaveLength(0);
    expect(stepStatuses(result).approval).toBe("failed");
    expect(h.fake.lease.held).toBeUndefined();
  });

  scenario("a signal with no decision recorded does not proceed", async (h) => {
    needsApproval(h);
    const input = deployInput();
    await h.run(async () => {
      const handle = await start(h, input);
      await waitForStatus(handle, "awaiting_approval");
      await signalApproval(input.operationId, { client: h.client }); // spurious: nothing approved
      await waitFor("second approval check", () => h.fake.callsTo("checkApproval").length >= 2);
      expect((await handle.query("progress")) as { status: string }).toMatchObject({ status: "awaiting_approval" });
      expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
      await cancelOperation(input.operationId, { client: h.client });
      const result = (await handle.result()) as WorkflowResult;
      expect(result.status).toBe("cancelled");
    });
  });

  scenario("a plan that changed during the approval wait is caught by final_plan and never applied", async (h) => {
    needsApproval(h);
    const input = deployInput();
    const result = await h.run(async () => {
      const handle = await start(h, input);
      await waitForStatus(handle, "awaiting_approval");
      h.fake.failOn("finalPlan", { type: FAILURE_TYPES.planChanged, message: "plan drifted while waiting" });
      h.fake.approve();
      await signalApproval(input.operationId, { client: h.client });
      return (await handle.result()) as WorkflowResult;
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/new approval are required/);
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
  });
});

describe("deploy: plan changed", () => {
  scenario("plan_changed at final_plan fails with a re-approval message; apply is never called", async (h) => {
    h.fake.failOn("finalPlan", { type: FAILURE_TYPES.planChanged, message: "approved abc123 != current def456" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/plan changed after it was reviewed/);
    expect(result.error).toMatch(/new approval are required/);
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
    // Non-retryable: exactly one attempt.
    expect(h.fake.callsTo("finalPlan")).toHaveLength(1);
    expect(stepStatuses(result).final_plan).toBe("failed");
    expect(h.fake.lease.released).toHaveLength(1);
  });

  scenario("a re-plan whose digest differs is refused even if the activity did not throw", async (h) => {
    h.fake.setResult("finalPlan", { planDigest: "sha256:other", create: 9, update: 0, delete: 0, replace: 0, destroysData: false, empty: false });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/plan changed after it was reviewed/);
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
  });
});

describe("deploy: lease loss and mutating-step failures", () => {
  scenario("LeaseLost during apply -> uncertain, and the release is still attempted", async (h) => {
    h.fake.failOn("applyInfrastructure", { type: FAILURE_TYPES.leaseLost, message: "fence moved" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("uncertain");
    expect(result.error).toMatch(/lease was lost during apply_infrastructure/);
    expect(finalStatus(h)).toMatchObject({ status: "uncertain" });
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1);
    expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
    expect(h.fake.callsTo("buildArtifacts")).toHaveLength(0);
    expect(h.fake.callsTo("deployWorkloads")).toHaveLength(0);
  });

  scenario("the lease expiring between steps after an apply -> uncertain, no further mutation", async (h) => {
    const held = h.fake.hold("buildArtifacts");
    const result = await h.run(async () => {
      const handle = await start(h, deployInput());
      await held.started;
      h.fake.expireLease();
      held.release();
      return (await handle.result()) as WorkflowResult;
    });
    expect(result.status).toBe("uncertain");
    expect(h.fake.callsTo("deployWorkloads")).toHaveLength(0);
    expect(h.fake.callsTo("runMigrations")).toHaveLength(0);
    expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
  });

  scenario("a lease lost before anything mutated is a plain failure", async (h) => {
    h.fake.failOn("planInfrastructure", { type: FAILURE_TYPES.leaseLost, message: "fence moved during plan" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/before any change was made/);
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
  });

  scenario("a busy environment fails cleanly without acting", async (h) => {
    h.fake.failOn("acquireLease", { type: FAILURE_TYPES.leaseBusy, message: "env:env-1 held by op-other" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/environment is busy/);
    expect(h.fake.callsTo("planInfrastructure")).toHaveLength(0);
    expect(h.fake.callsTo("acquireLease")).toHaveLength(1);
  });

  scenario("an unclassified apply error is one attempt and ends uncertain (never replayed)", async (h) => {
    h.fake.failOn("applyInfrastructure", { message: "connection reset by peer" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("uncertain");
    expect(result.error).toMatch(/apply_infrastructure did not complete cleanly and may have acted/);
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1);
    expect(h.fake.callsTo("deployWorkloads")).toHaveLength(0);
    expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
  });

  scenario("an apply that ran to a clean failure is failed, with the partial-apply note", async (h) => {
    h.fake.failOn("applyInfrastructure", { type: FAILURE_TYPES.stepFailed, message: "tofu exited 1: quota exceeded" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("partial apply; reconcile will observe");
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1);
  });

  for (const step of [
    ["deployWorkloads", "deploy"],
    ["runMigrations", "migrate"],
  ] as const) {
    scenario(`an unclassified ${step[1]} error is uncertain and later steps do not run`, async (h) => {
      h.fake.failOn(step[0], { message: "socket hang up" });
      const result = await h.run(() => runDeploy(h, deployInput()));
      expect(result.status).toBe("uncertain");
      expect(h.fake.callsTo(step[0])).toHaveLength(1);
      expect(h.fake.callsTo("verifyInfrastructure")).toHaveLength(0);
    });
  }

  scenario("a build that fails after the apply is failed, and says the apply stays", async (h) => {
    h.fake.failOn("buildArtifacts", { type: FAILURE_TYPES.stepFailed, message: "docker build exited 1" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Earlier steps had already changed the environment; nothing was rolled back/);
    expect(h.fake.callsTo("deployWorkloads")).toHaveLength(0);
  });
});

describe("deploy: verification", () => {
  scenario("failed infrastructure verification -> failed, changes stay applied", async (h) => {
    h.fake.setResult("verifyInfrastructure", { status: "failed", checks: 4, failed: 2 });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/verification failed \(2 of 4 checks\).*nothing was rolled back/);
    expect(h.fake.callsTo("verifyApplication")).toHaveLength(0);
  });

  scenario("inconclusive application verification -> uncertain, not success", async (h) => {
    h.fake.setResult("verifyApplication", { status: "unknown", checks: 0, failed: 0 });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("uncertain");
    expect(result.error).toMatch(/inconclusive/);
  });

  scenario("a failed observation does not undo a verified deployment", async (h) => {
    h.fake.failOn("observeEnvironment", { type: FAILURE_TYPES.stepFailed, message: "describe failed" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("succeeded");
    expect(stepStatuses(result).observe).toBe("failed");
  });
});

describe("deploy: retries and bookkeeping", () => {
  scenario("a transient read failure is retried and the deploy still succeeds", async (h) => {
    h.fake.failOn("evaluatePolicy", { message: "temporarily unavailable", times: 2 });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("succeeded");
    expect(h.fake.callsTo("evaluatePolicy").map((c) => c.attempt)).toEqual([1, 2, 3]);
  });

  scenario("a read that keeps failing exhausts 5 attempts, then fails without mutating", async (h) => {
    h.fake.failOn("validateDesiredState", { message: "store unavailable" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(h.fake.callsTo("validateDesiredState")).toHaveLength(5);
    expect(h.fake.callsTo("acquireLease")).toHaveLength(0);
  }, 90_000);

  scenario("a progress-projection failure does not abort the deploy", async (h) => {
    h.fake.failOn("recordStep", { type: FAILURE_TYPES.stepFailed, message: "store down" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("succeeded");
    expect(finalStatus(h)).toMatchObject({ status: "succeeded" });
  });

  scenario("the terminal status write is retried until it lands", async (h) => {
    h.fake.failOn("markOperation", { message: "database restarting", times: 3 });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("succeeded");
    expect(h.fake.statuses.map((s) => s.status)).toEqual(["running", "succeeded"]);
    expect(h.fake.callsTo("markOperation").length).toBe(5);
  }, 90_000);

  scenario("a stub activity fails the operation immediately with a clear reason", async (h) => {
    h.fake.failOn("validateDesiredState", { type: FAILURE_TYPES.notImplemented, message: "not implemented" });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not implemented in this worker build; nothing was changed/);
    expect(h.fake.callsTo("validateDesiredState")).toHaveLength(1);
  });

  scenario("redacts credential-shaped text from error messages before they are recorded", async (h) => {
    h.fake.failOn("applyInfrastructure", {
      type: FAILURE_TYPES.stepFailed,
      message: "auth failed for AKIAIOSFODNN7EXAMPLE with password=hunter2 Bearer abcdefghijklmnop.qrstuvwx",
    });
    const result = await h.run(() => runDeploy(h, deployInput()));
    expect(result.status).toBe("failed");
    const recorded = JSON.stringify([result, h.fake.statuses, h.fake.steps]);
    expect(recorded).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(recorded).not.toContain("hunter2");
    expect(recorded).not.toContain("abcdefghijklmnop");
  });
});

describe("deploy: cancellation", () => {
  const noDestroy = (h: Harness): void => {
    const suspicious = h.fake.names().filter((n) => /destroy|delete|teardown|rollback|remove/i.test(n));
    expect(suspicious).toEqual([]);
  };

  scenario("a cancel signal during deploy cancels the activity, marks cancelled, releases the lease, destroys nothing", async (h) => {
    const held = h.fake.hold("deployWorkloads");
    const input = deployInput();
    const result = await h.run(async () => {
      const handle = await start(h, input);
      await held.started;
      expect(await cancelOperation(input.operationId, { client: h.client })).toEqual({ delivered: true });
      return (await handle.result()) as WorkflowResult;
    });
    expect(result.status).toBe("cancelled");
    expect(result.error).toMatch(/Cancelled by request.*nothing was rolled back or destroyed/);
    expect(finalStatus(h)).toMatchObject({ status: "cancelled" });
    expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
    expect(h.fake.lease.held).toBeUndefined();
    // The cancelled step is marked, and nothing after it ran.
    expect(stepStatuses(result).deploy).toBe("failed");
    expect(h.fake.callsTo("runMigrations")).toHaveLength(0);
    expect(h.fake.callsTo("verifyApplication")).toHaveLength(0);
    noDestroy(h);
  });

  scenario("Temporal-level cancellation behaves the same as the cancel signal", async (h) => {
    const held = h.fake.hold("deployWorkloads");
    const result = await h.run(async () => {
      const handle = await start(h, deployInput());
      await held.started;
      await handle.cancel();
      return (await handle.result()) as WorkflowResult;
    });
    expect(result.status).toBe("cancelled");
    expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
    noDestroy(h);
  });

  scenario("cancelling during a read step (before any lease) cancels cleanly with no release", async (h) => {
    const held = h.fake.hold("validateDesiredState");
    const input = deployInput();
    const result = await h.run(async () => {
      const handle = await start(h, input);
      await held.started;
      await cancelOperation(input.operationId, { client: h.client });
      const r = (await handle.result()) as WorkflowResult;
      held.release();
      return r;
    });
    expect(result.status).toBe("cancelled");
    expect(result.error).not.toMatch(/had started/);
    expect(h.fake.callsTo("acquireLease")).toHaveLength(0);
    expect(stepStatuses(result).release).toBe("skipped");
  });

  scenario("cancelling while awaiting approval cancels; the lease was already released for the wait", async (h) => {
    h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-2", reasons: [] });
    const input = deployInput();
    const result = await h.run(async () => {
      const handle = await start(h, input);
      await waitForStatus(handle, "awaiting_approval");
      await cancelOperation(input.operationId, { client: h.client });
      return (await handle.result()) as WorkflowResult;
    });
    expect(result.status).toBe("cancelled");
    expect(h.fake.lease.released).toHaveLength(1); // released once, for the wait; not again
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
  });

  scenario("a cancel signal sent to a workflow that already finished is reported, not thrown", async (h) => {
    const input = deployInput();
    await h.run(() => runDeploy(h, input));
    expect(await cancelOperation(input.operationId, { client: h.client })).toEqual({ delivered: false, reason: "not_found" });
    expect(SIGNALS.cancel).toBe("cancel");
  });
});

describe("deploy: workflow failure surface", () => {
  scenario("if the terminal status cannot be written at all, the workflow itself fails loudly", async (h) => {
    h.fake.failOn("markOperation", { type: FAILURE_TYPES.notImplemented, message: "stub" });
    await h.run(async () => {
      const handle = await start(h, deployInput());
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    });
    // The lease (if any was taken) is still released; here the first activity failed, so none was.
    expect(h.fake.lease.held).toBeUndefined();
  });
});
