/**
 * applyInfrastructure: the one step that changes declarative infrastructure.
 * Covers the happy path and every way it can end, because the workflow's final
 * status depends on which KIND of error leaves this activity.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import { LeaseLostError, StepFailedError, TofuPlanChangedError } from "@/lib/execution/errors";
import { CANARY_GRANT, CANARY_SECRET, CANARY_SESSION_KEY, ENV, OP, bucketManifest, change, makePlan } from "./fakes/fixtures";
import { PLAN_FILE_CANARY } from "./fakes/tofu";
import { createWorld, type World, type WorldOptions } from "./fakes/world";

const worlds: World[] = [];
const world = (opts: WorldOptions = {}): World => {
  const w = createWorld(opts);
  w.product.setManifest(bucketManifest());
  worlds.push(w);
  return w;
};
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

/** validate → lease → plan: the state the workflow is in when it calls apply. */
async function planned(w: World) {
  await w.activities.markOperation({ operationId: OP, status: "running" });
  await w.activities.validateDesiredState({ operationId: OP });
  const lease = await w.lease();
  const plan = await w.activities.planInfrastructure({ operationId: OP, lease });
  return { lease, plan };
}

describe("applyInfrastructure", () => {
  it("applies the approved plan under a deploy session, then records evidence, statuses and events — without a single value", async () => {
    const w = world();
    w.tofu.outputs = {
      alb_dns_name: { sensitive: false, type: "string", value: `lb.example.com/${CANARY_SECRET}` },
      db_master_password: { sensitive: true, type: "string" },
    };
    const { lease, plan } = await planned(w);

    const result = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(result.applied).toBe(1);
    expect(result.outputsDigest).toMatch(/^[0-9a-f]{64}$/);

    // engine call: the approved digest, under the brokered session, with the server fingerprint key
    expect(w.tofu.applyCalls).toHaveLength(1);
    expect(w.tofu.applyCalls[0]).toMatchObject({ approvedDigest: plan.planDigest, fingerprintKey: expect.any(String) });
    expect(w.tofu.applyCalls[0].envKeys).toContain("AWS_SESSION_TOKEN");

    // the apply used the operation's OWN capability (mutating) on the deploy role, bound to the fence
    const grant = w.broker.grants.at(-1)!;
    expect(grant).toMatchObject({ audience: "worker", durationSec: 3600, fence: { scope: `env:${ENV}`, fenceToken: lease.fenceToken } });
    expect(grant.capability).toBeUndefined();
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "deploy", capability: "deployment.deploy", fence: lease.fenceToken, revoked: true });

    // fence asserted before and after the external call
    const asserts = w.leases.assertCalls.filter((c) => c.fenceToken === lease.fenceToken);
    expect(asserts.length).toBeGreaterThanOrEqual(4); // plan before/after + apply before/after

    // evidence: counts, digests, output NAMES and sensitivity
    const [row] = w.evidence.ofKind("tofu_apply");
    expect(row.summary).toMatchObject({ planDigest: plan.planDigest, applied: { create: 1, update: 0, delete: 0, replace: 0 }, exitCode: 0, outputsDigest: result.outputsDigest });
    expect(row.summary.outputs).toEqual([
      { name: "alb_dns_name", sensitive: false },
      { name: "db_master_password", sensitive: true },
    ]);
    expect(w.events.ofType("resource.applying")).toHaveLength(1);
    expect(w.events.ofType("resource.applied")).toHaveLength(1);
    expect(w.events.events.map((e) => e.type).filter((t) => t.startsWith("resource.")).slice(-2)).toEqual(["resource.applying", "resource.applied"]);

    // the touched resource is active in the store
    expect(w.resources.byAddress("object_store/assets")?.status).toBe("active");

    // nothing sensitive anywhere, and the plan file is gone
    const everything = `${w.stored()}${JSON.stringify(result)}${JSON.stringify(w.logs)}`;
    for (const secret of [CANARY_SECRET, CANARY_SESSION_KEY, CANARY_GRANT, PLAN_FILE_CANARY, "session-token-canary"]) expect(everything).not.toContain(secret);
    expect(existsSync(path.join(w.planDir, `${plan.planDigest}.tfplan`))).toBe(false);
  });

  it("marks deleted nodes deleted when the plan deleted them", async () => {
    const w = world();
    w.tofu.planFactory = () => makePlan({ changes: [change({ address: "aws_s3_bucket.assets", nodeAddress: "object_store/assets", type: "aws_s3_bucket", action: "delete", destroysData: true })] });
    const { lease, plan } = await planned(w);
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(w.resources.byAddress("object_store/assets")?.status).toBe("deleted");
  });

  it("heartbeats, renews the environment lease and extends the operation's execution lease while tofu runs", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    let release!: () => void;
    w.tofu.applyGate = new Promise<void>((resolve) => (release = resolve));
    const before = { renewals: w.leases.renewCalls, beats: w.heartbeats.length, opBeats: w.ops.heartbeats };
    const running = w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    await new Promise((r) => setTimeout(r, 60));
    release();
    await running;
    expect(w.leases.renewCalls - before.renewals).toBeGreaterThanOrEqual(3);
    expect(w.heartbeats.length - before.beats).toBeGreaterThanOrEqual(3);
    expect(w.ops.heartbeats - before.opBeats).toBeGreaterThanOrEqual(3);
  });

  it("raises LeaseLost, aborts tofu and marks the operation uncertain when the lease is lost DURING the apply", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "hang";
    w.leases.lostAfterRenewals = w.leases.renewCalls; // the next renewal reports the lease gone
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).code).toBe("lease_lost");
    expect(w.ops.uncertain).toHaveLength(1);
    expect(w.ops.ops.get(OP)!.status).toBe("uncertain");
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0); // it never finished: no claim that it did
    expect(w.events.ofType("resource.applied")).toHaveLength(0);
    expect(existsSync(path.join(w.planDir, `${plan.planDigest}.tfplan`))).toBe(false);
  });

  it("still records the apply when tofu finished but the lease was lost meanwhile, and raises LeaseLost", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    let release!: () => void;
    w.tofu.applyGate = new Promise<void>((resolve) => (release = resolve));
    const running = w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    await w.tofu.applyStarted;
    w.leases.steal(lease.scope); // another writer takes the environment
    await new Promise((r) => setTimeout(r, 30));
    release();
    await expect(running).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(1); // what really happened is on the record
  });

  it("raises LeaseLost when the operation is no longer running in the ledger (the reconciler gave up on it)", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "hang";
    w.ops.heartbeatResult = false;
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("gives up before the lease can lapse when the store stays unreachable for two thirds of its ttl", async () => {
    const w = world({ limits: { leaseTtlMs: 40, heartbeatIntervalMs: 5 } });
    const { lease, plan } = await planned(w);
    w.tofu.apply = "hang";
    w.leases.renewMode = "throw";
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.logs.some((l) => l.message === "lease renewal failed")).toBe(true);
  });

  it("stops tofu when Temporal cancels the activity and reports an unproven outcome, never a clean one", async () => {
    const controller = new AbortController();
    const w = world({ signal: controller.signal });
    const { lease, plan } = await planned(w);
    w.tofu.apply = "hang";
    const running = w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    await w.tofu.applyStarted;
    controller.abort(new Error("cancelled by the workflow"));
    const err = await running;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ApplicationFailure); // plain: the workflow finalizes uncertain
    expect((err as Error).message).toMatch(/partial apply; reconcile will observe the environment/);
    expect(w.ops.uncertain).toHaveLength(1);
  });

  it("says 'partial apply; reconcile will observe' and stays a clean StepFailed when tofu apply exits non-zero", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "fail_apply";
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as ApplicationFailure).type).toBe("StepFailed");
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    expect((err as Error).message).toMatch(/partial apply; reconcile will observe the environment/);
    expect(w.ops.uncertain).toHaveLength(0); // it ended definitively; the workflow finalizes it failed
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    expect(w.resources.byAddress("object_store/assets")?.status).toBe("planned"); // nothing is claimed active
    expect(existsSync(path.join(w.planDir, `${plan.planDigest}.tfplan`))).toBe(false);
  });

  it("treats a failed `tofu output` after the apply as a partial apply too", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "fail_output";
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toThrow(/partial apply; reconcile will observe/);
  });

  it("does not claim 'partial' when tofu failed before it applied anything", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "fail_plan_before_apply";
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/before anything was applied; nothing was changed/);
    expect((err as Error).message).not.toMatch(/partial/);
  });

  it("leaves a timeout or an unclassified error PLAIN (unknown outcome → uncertain) and marks the operation uncertain", async () => {
    for (const behaviour of ["timeout", "unclassified"] as const) {
      const w = world();
      const { lease, plan } = await planned(w);
      w.tofu.apply = behaviour;
      const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ApplicationFailure);
      expect((err as Error).message).toMatch(/partial apply; reconcile will observe the environment/);
      expect(w.ops.uncertain).toHaveLength(1);
      expect(w.ops.ops.get(OP)!.status).toBe("uncertain");
    }
  });

  it("rethrows plan_changed untouched: nothing was applied, re-approval is required", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "plan_changed";
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TofuPlanChangedError);
    expect(w.ops.uncertain).toHaveLength(0);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });

  it("does not start when the fence is already dead: no tofu, no credentials, no applying event", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.leases.steal(lease.scope);
    const sessions = w.credentials.sessions.length;
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.tofu.applyCalls).toHaveLength(0);
    expect(w.credentials.sessions).toHaveLength(sessions);
    expect(w.events.ofType("resource.applying")).toHaveLength(0);
    expect(w.ops.uncertain).toHaveLength(0); // nothing acted
  });

  it("reports a refused credential or grant as 'did not start; nothing was changed', a clean failure", async () => {
    const denied = world();
    const a = await planned(denied);
    denied.credentials.denyNext = 1;
    const err = await denied.activities.applyInfrastructure({ operationId: OP, planDigest: a.plan.planDigest, lease: a.lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/did not start; nothing was changed/);
    expect(denied.tofu.applyCalls).toHaveLength(0);
    expect(denied.ops.uncertain).toHaveLength(0);

    const refused = world();
    const b = await planned(refused);
    refused.broker.refuseGrants = true;
    await expect(refused.activities.applyInfrastructure({ operationId: OP, planDigest: b.plan.planDigest, lease: b.lease })).rejects.toThrow(/did not start; nothing was changed/);
  });

  it("refuses a malformed plan digest and a lease that is not this operation's", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: "../../etc/passwd", lease })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease: { ...lease, scope: "env:other" } })).rejects.toBeInstanceOf(StepFailedError);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });

  it("does not turn a real apply into an error because the evidence ledger hiccuped: it retries, then logs", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.evidence.failNext = 2; // the first two writes fail; the third lands
    const result = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(result.applied).toBe(1);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(1);

    const w2 = world();
    const p2 = await planned(w2);
    w2.evidence.failNext = 10; // the ledger is down for good
    const out = await w2.activities.applyInfrastructure({ operationId: OP, planDigest: p2.plan.planDigest, lease: p2.lease });
    expect(out.applied).toBe(1);
    expect(w2.logs.some((l) => l.level === "error" && l.message.includes("evidence append failed after the action"))).toBe(true);
  });

  it("is idempotent on its evidence and events when the activity is retried", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(1);
    expect(w.events.ofType("resource.applied")).toHaveLength(1);
    expect(w.events.ofType("resource.applying")).toHaveLength(1);
  });
});
