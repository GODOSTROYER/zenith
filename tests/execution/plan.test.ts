/**
 * planInfrastructure / evaluatePolicy / checkApproval / finalPlan.
 *
 * The OpenTofu port is scripted here (see fakes/tofu.ts); the real engine is run
 * end to end in journey.test.ts.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import { TofuCommandError } from "@/lib/tofu/runner";
import { CredentialDeniedError } from "@/lib/credentials/types";
import { LeaseLostError, StepFailedError, TofuPlanChangedError } from "@/lib/execution/errors";
import { defaultCostPort } from "@/lib/execution/cost";
import type { PlanAttributeChange } from "@/lib/tofu/types";
import { expandManifest } from "@/lib/resources/expand";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { CANARY_GRANT, CANARY_SECRET, CANARY_SESSION_KEY, ENV, OP, WS, bucketManifest, change, makePlan, webDbManifest } from "./fakes/fixtures";
import { PLAN_FILE_CANARY } from "./fakes/tofu";
import { createWorld, FINGERPRINT_KEY, type World } from "./fakes/world";

const worlds: World[] = [];
const world = (...args: Parameters<typeof createWorld>): World => {
  const w = createWorld(...args);
  worlds.push(w);
  return w;
};
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

const attr = (over: Partial<PlanAttributeChange> & Pick<PlanAttributeChange, "path">): PlanAttributeChange => ({ before: null, after: null, sensitive: false, forcesReplacement: false, ...over });

const publicDb = () =>
  makePlan({
    changes: [
      change({ address: "aws_db_instance.db", nodeAddress: "postgres/db", type: "aws_db_instance", action: "create", changes: [attr({ path: "publicly_accessible", after: true })] }),
      change({ address: "aws_s3_bucket.assets", nodeAddress: "object_store/assets", type: "aws_s3_bucket", action: "delete", destroysData: true }),
    ],
  });

describe("planInfrastructure", () => {
  it("plans with an observe session under a plan-only grant, without the state lock, and keeps the plan file in planDir only", async () => {
    const w = world();
    const lease = await w.lease();
    const summary = await w.activities.planInfrastructure({ operationId: OP, lease });

    const plan = w.tofu.planCalls[0];
    expect(summary).toMatchObject({ create: 1, update: 0, delete: 0, replace: 0, destroysData: false, empty: false });
    expect(plan.opts.lock).toBe(false); // the read-only role cannot write the S3 lock object; the env lease serialises
    expect(plan.opts.planDir).toBe(w.planDir);
    expect(plan.opts.normalize?.fingerprintKey).toBe(FINGERPRINT_KEY);
    expect(plan.envKeys).toEqual(expect.arrayContaining(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]));

    // the capability broker was asked for a WEAKER capability than deployment.deploy, bound to the lease fence
    expect(w.broker.grants).toEqual([{ operationId: OP, audience: "worker", fence: { scope: `env:${ENV}`, fenceToken: lease.fenceToken }, capability: "infrastructure.plan", durationSec: 3600 }]);
    expect(w.credentials.sessions).toMatchObject([{ purpose: "observe", capability: "infrastructure.plan", durationSec: 3600, fence: lease.fenceToken, revoked: true }]);

    // the binary plan file is in planDir and nowhere else
    const files = readdirSync(w.planDir);
    expect(files).toEqual([`${summary.planDigest}.tfplan`]);
    expect(w.stored()).not.toContain(PLAN_FILE_CANARY);
  });

  it("assembles a pinned workspace: S3 backend in the connection's bucket, tags, name prefix and a ref() in interpolation form", async () => {
    const seen: { node: string; prefix: string; tags: Record<string, string> }[] = [];
    const w = world({
      overrides: {
        "aws:security_group_rule": {
          onCompile: (node, ctx) => seen.push({ node: node.address, prefix: ctx.namePrefix, tags: ctx.tags }),
          compileExtra: (_node, ctx) => ({ triggers_replace: [ctx.ref("network/main", "id")] }),
        },
      },
    });
    const lease = await w.lease();
    await w.activities.planInfrastructure({ operationId: OP, lease });

    const ws = w.tofu.planCalls[0].ws;
    const backend = JSON.parse(ws.files.find((f) => f.path === "backend.tf.json")!.content);
    expect(backend.terraform.backend.s3).toMatchObject({ bucket: "zenith-state-123456789012", key: `zenith/${WS}/${ENV}/terraform.tfstate`, region: "us-east-1", use_lockfile: true, encrypt: true });
    const providers = JSON.parse(ws.files.find((f) => f.path === "providers.tf.json")!.content);
    expect(providers.provider.aws.default_tags.tags).toEqual({ "zenith:managed": "true", "zenith:workspace": WS, "zenith:project": "proj-act-1", "zenith:environment": ENV });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].prefix).toBe(`zenith-${ENV}`); // the credential broker's session policies key off this prefix
    expect(seen[0].tags).toMatchObject({ "zenith:managed": "true", "zenith:environment": ENV, "zenith:resource": seen[0].node });

    const main = JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content);
    const firewall = main.resource.terraform_data.firewall_internet_to_lb_443 ?? Object.values(main.resource.terraform_data).find((r) => JSON.stringify(r).includes("network_main.id"));
    expect(JSON.stringify(firewall)).toContain("${terraform_data.network_main.id}");
  });

  it("persists plan evidence with digests, counts, facts and a bounded view, and records the plan digest on the operation", async () => {
    const w = world();
    w.tofu.planFactory = () => publicDb();
    const lease = await w.lease();
    const summary = await w.activities.planInfrastructure({ operationId: OP, lease });

    const [row] = w.evidence.ofKind("tofu_plan");
    expect(row).toMatchObject({ workspaceId: WS, operationId: OP, digest: summary.planDigest, simulated: false });
    expect(row.summary).toMatchObject({ stage: "plan", planDigest: summary.planDigest, tofuVersion: "1.12.5", counts: { create: 1, delete: 1 }, destroysData: true });
    expect((row.summary.facts as { publicDatabases: string[] }).publicDatabases).toEqual(["aws_db_instance.db"]);
    expect(w.ops.planDigests).toEqual([summary.planDigest]);
    expect(w.events.ofType("resource.planned")).toHaveLength(1);
    expect(summary.destroysData).toBe(true);
  });

  it("leaks nothing: no plan file, no sensitive value or fingerprint, no credential, no grant, in evidence, events or results", async () => {
    const fingerprint = "f".repeat(64);
    const w = world();
    w.tofu.planFactory = () =>
      makePlan({
        changes: [
          change({
            address: "aws_db_instance.db",
            nodeAddress: "postgres/db",
            type: "aws_db_instance",
            action: "create",
            changes: [
              attr({ path: "password", before: "(sensitive)", after: "(sensitive)", sensitive: true, fingerprint }),
              // a value the provider did NOT flag sensitive but that sits at a secret-looking path: the plan view still hides it
              attr({ path: "master_password", after: CANARY_SECRET }),
              attr({ path: "allocated_storage", after: 20 }),
            ],
          }),
        ],
      });
    const lease = await w.lease();
    const summary = await w.activities.planInfrastructure({ operationId: OP, lease });

    const everything = `${w.stored()}${JSON.stringify(summary)}${JSON.stringify(w.logs)}`;
    for (const secret of [CANARY_SECRET, CANARY_SESSION_KEY, CANARY_GRANT, PLAN_FILE_CANARY, fingerprint, "session-token-canary"]) expect(everything).not.toContain(secret);

    const view = w.evidence.ofKind("tofu_plan")[0].summary.view as { resources: { changes: { path: string; after?: unknown }[] }[] };
    const changes = view.resources[0].changes;
    expect(changes.find((c) => c.path === "password")).toEqual({ path: "password", forcesReplacement: false });
    expect(changes.find((c) => c.path === "master_password")).toEqual({ path: "master_password", forcesReplacement: false });
    expect(changes.find((c) => c.path === "allocated_storage")).toMatchObject({ after: 20 }); // ordinary values stay visible
  });

  it("bounds the evidence of a huge plan so it fits a ledger row, and says it was truncated", async () => {
    const w = world();
    const many = Array.from({ length: 300 }, (_, i) =>
      change({
        address: `aws_thing.t${i}`,
        type: "aws_thing",
        action: "update",
        changes: Array.from({ length: 50 }, (_, j) => attr({ path: `setting_${j}`, before: `old-value-${i}-${j}`, after: `new-value-${i}-${j}-${"x".repeat(150)}` })),
      })
    );
    w.tofu.planFactory = () => makePlan({ changes: many });
    const lease = await w.lease();
    await w.activities.planInfrastructure({ operationId: OP, lease });
    const summary = w.evidence.ofKind("tofu_plan")[0].summary;
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(64 * 1024);
    expect((summary.view as { truncated: boolean }).truncated).toBe(true);
  });

  it("reports a cost delta from the cost port: new cost minus the deployed revision's, zero for a redeploy, absent when unknown", async () => {
    const estimates: number[] = [];
    const w = world({
      cost: {
        estimate: async (graph) => {
          estimates.push(graph.nodes.length);
          return { monthlyUsd: graph.nodes.length, catalogVersion: "test-1" };
        },
      },
    });
    const lease = await w.lease();
    // first deploy: the whole monthly cost is new
    const first = await w.activities.planInfrastructure({ operationId: OP, lease });
    expect(first.costDeltaUsdMonthly).toBe(estimates[0]);
    const evidence = w.evidence.ofKind("tofu_plan")[0].summary.cost as { deltaUsdMonthly: number; projectedMonthlyUsd: number; catalogVersion: string };
    expect(evidence).toEqual({ deltaUsdMonthly: estimates[0], projectedMonthlyUsd: estimates[0], catalogVersion: "test-1" });

    // a different deployed revision: the delta is the difference of the two estimates
    w.product.setManifest(bucketManifest(), "rev-old");
    w.product.base.environment.deployedRevisionId = "rev-old";
    const second = await w.activities.planInfrastructure({ operationId: OP, lease });
    const before = estimates.at(-1)!;
    expect(second.costDeltaUsdMonthly).toBe(estimates.at(-3)! - before);

    // redeploying what is deployed: no cost change
    w.product.base.environment.deployedRevisionId = "rev-act-1";
    expect((await w.activities.planInfrastructure({ operationId: OP, lease })).costDeltaUsdMonthly).toBe(0);
  });

  it("leaves the cost delta absent (never zero) when there is no estimate or the estimator fails", async () => {
    const none = world({ cost: { estimate: async () => null } });
    const l1 = await none.lease();
    expect("costDeltaUsdMonthly" in (await none.activities.planInfrastructure({ operationId: OP, lease: l1 }))).toBe(false);

    const broken = world({
      cost: {
        estimate: async () => {
          throw new Error("catalog exploded");
        },
      },
    });
    const l2 = await broken.lease();
    const result = await broken.activities.planInfrastructure({ operationId: OP, lease: l2 });
    expect("costDeltaUsdMonthly" in result).toBe(false);
    expect(broken.logs.some((l) => l.message.includes("cost estimate failed"))).toBe(true);
  });

  it("prices a real graph through the default cost port (placement cost engine)", async () => {
    const graph = expandManifest(upgradeManifest(webDbManifest(), { provider: "aws", region: "us-east-1" }), { id: ENV, name: "production", class: "production", provider: "aws", region: "us-east-1", baseDomain: "atlas.zenith.test" });
    const estimate = await defaultCostPort().estimate(graph);
    expect(estimate === null || (estimate.monthlyUsd > 0 && /\d/.test(estimate.catalogVersion))).toBe(true);
    // an unpriceable graph is "no estimate", not an exception and not zero
    const odd = { ...graph, nodes: graph.nodes.map((n) => ({ ...n, provider: "oci" as const, region: "mars-1" })) };
    expect(await defaultCostPort().estimate(odd)).toBeNull();
  });

  it("stops before any tofu call when the fence is already dead", async () => {
    const w = world();
    const lease = await w.lease();
    w.leases.steal(lease.scope);
    await expect(w.activities.planInfrastructure({ operationId: OP, lease })).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.tofu.planCalls).toHaveLength(0);
    expect(w.credentials.sessions).toHaveLength(0);
  });

  it("aborts tofu and raises LeaseLost when the lease is lost while planning, recording nothing", async () => {
    const w = world();
    const lease = await w.lease();
    w.leases.lostAfterRenewals = 0;
    let release!: () => void;
    w.tofu.planGate = new Promise<void>((resolve) => (release = resolve));
    const running = w.activities.planInfrastructure({ operationId: OP, lease });
    await new Promise((r) => setTimeout(r, 40)); // several keep-alive ticks
    release();
    await expect(running).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.evidence.rows).toHaveLength(0);
    expect(w.heartbeats.length).toBeGreaterThan(1);
  });

  it("refuses a lease that is not this operation's environment lease, and a lease taken for another operation", async () => {
    const w = world();
    const lease = await w.lease();
    await expect(w.activities.planInfrastructure({ operationId: OP, lease: { ...lease, scope: "env:some-other-env" } })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.planInfrastructure({ operationId: OP, lease: { ...lease, holder: "worker:test-worker:op-someone-else" } })).rejects.toBeInstanceOf(StepFailedError);
    expect(w.tofu.planCalls).toHaveLength(0);
  });

  it("does not hide a tofu plan failure or a refused credential: both stay plain errors (retryable), with no evidence", async () => {
    const w = world();
    const lease = await w.lease();
    w.tofu.planError = new TofuCommandError("tofu_command_failed", "tofu plan failed with exit code 1.", { command: "plan", exitCode: 1, output: "", truncated: false, durationMs: 1 });
    const err = await w.activities.planInfrastructure({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TofuCommandError);
    expect(err).not.toBeInstanceOf(ApplicationFailure);

    w.tofu.planError = undefined;
    w.credentials.denyNext = 1;
    await expect(w.activities.planInfrastructure({ operationId: OP, lease })).rejects.toBeInstanceOf(CredentialDeniedError);
    expect(w.evidence.rows).toHaveLength(0);
  });

  it("refuses to plan a desired state that is not executable", async () => {
    const w = world({ missingDrivers: ["aws:s3_bucket"] });
    w.product.setManifest(bucketManifest());
    const lease = await w.lease();
    const err = await w.activities.planInfrastructure({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/not executable/);
    expect(w.tofu.planCalls).toHaveLength(0);
  });

  it("refuses a connection that has no state bucket, before planning", async () => {
    const w = world();
    w.connections.connections[0] = { ...w.connections.connections[0], config: { ...w.connections.connections[0].config, stateBucket: undefined } as never };
    const lease = await w.lease();
    await expect(w.activities.planInfrastructure({ operationId: OP, lease })).rejects.toThrow(/no state bucket/);
    expect(w.tofu.planCalls).toHaveLength(0);
  });

  it("refuses an unverified or missing connection", async () => {
    const w = world();
    w.connections.connections[0] = { ...w.connections.connections[0], status: "pending_verification" };
    const lease = await w.lease();
    await expect(w.activities.planInfrastructure({ operationId: OP, lease })).rejects.toThrow(/pending verification/);
    w.connections.connections = [];
    await expect(w.activities.planInfrastructure({ operationId: OP, lease })).rejects.toThrow(/no usable provider connection/);
  });
});

describe("evaluatePolicy", () => {
  it("computes the policy facts from OUR plan (kept in the evidence planning wrote), never from the caller", async () => {
    const w = world();
    w.tofu.planFactory = () => publicDb();
    w.broker.outcome = { outcome: "require_approval", decisionId: "dec-7", reasons: ["production database made public"] };
    const lease = await w.lease();
    const plan = await w.activities.planInfrastructure({ operationId: OP, lease });

    const result = await w.activities.evaluatePolicy({ operationId: OP, planDigest: plan.planDigest });
    expect(result).toEqual({ outcome: "require_approval", decisionId: "dec-7", reasons: ["production database made public"] });
    expect(w.ops.policyDecisions).toEqual(["dec-7"]);

    const sent = w.broker.reevaluations.at(-1)!;
    expect(sent.operationId).toBe(OP);
    expect(sent.plan).toMatchObject({ create: 1, delete: 1, destroysData: true, publicDatabases: ["aws_db_instance.db"], destroyedStatefulAddresses: ["aws_s3_bucket.assets"] });
  });

  it("passes the cost numbers along with the facts", async () => {
    const w = world({ cost: { estimate: async () => ({ monthlyUsd: 120, catalogVersion: "test-1" }) } });
    const lease = await w.lease();
    const plan = await w.activities.planInfrastructure({ operationId: OP, lease });
    await w.activities.evaluatePolicy({ operationId: OP, planDigest: plan.planDigest });
    expect(w.broker.reevaluations[0].plan).toMatchObject({ costDeltaUsdMonthly: 120, projectedMonthlyUsd: 120 });
  });

  it("re-evaluates without plan facts when no plan digest is given (day-two, remediation)", async () => {
    const w = world();
    await w.activities.evaluatePolicy({ operationId: OP });
    expect(w.broker.reevaluations).toEqual([{ operationId: OP }]);
  });

  it("refuses a plan digest it has no evidence for, without asking the broker", async () => {
    const w = world();
    const err = await w.activities.evaluatePolicy({ operationId: OP, planDigest: "9".repeat(64) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect(w.broker.reevaluations).toHaveLength(0);
  });

  it("does not use another operation's plan evidence", async () => {
    const w = world();
    const lease = await w.lease();
    const plan = await w.activities.planInfrastructure({ operationId: OP, lease });
    w.ops.seed({ id: "op-second" });
    await expect(w.activities.evaluatePolicy({ operationId: "op-second", planDigest: plan.planDigest })).rejects.toBeInstanceOf(StepFailedError);
  });

  it("refuses evidence whose facts are malformed (a tampered or foreign row)", async () => {
    const w = world();
    const lease = await w.lease();
    const plan = await w.activities.planInfrastructure({ operationId: OP, lease });
    (w.evidence.rows[0].summary as Record<string, unknown>).facts = { create: "lots" };
    await expect(w.activities.evaluatePolicy({ operationId: OP, planDigest: plan.planDigest })).rejects.toBeInstanceOf(StepFailedError);
  });

  it("returns reasons as short scrubbed single lines", async () => {
    const w = world();
    w.broker.outcome = { outcome: "deny", decisionId: "dec-9", reasons: [`token=${CANARY_SECRET}\nsecond line`, "x".repeat(2000)] };
    const result = await w.activities.evaluatePolicy({ operationId: OP });
    expect(JSON.stringify(result)).not.toContain(CANARY_SECRET);
    for (const r of result.reasons) {
      expect(r).not.toMatch(/\n/);
      expect(r.length).toBeLessThanOrEqual(300);
    }
  });
});

describe("checkApproval", () => {
  it("reports what the broker says, nothing more", async () => {
    const w = world();
    expect(await w.activities.checkApproval({ operationId: OP })).toEqual({ approved: false, rejected: false });
    w.broker.approval = { approved: true, rejected: false, approvalId: "apr-1" };
    expect(await w.activities.checkApproval({ operationId: OP })).toEqual({ approved: true, rejected: false, approvalId: "apr-1" });
    w.broker.approval = { approved: false, rejected: true };
    expect(await w.activities.checkApproval({ operationId: OP })).toEqual({ approved: false, rejected: true });
  });
});

describe("finalPlan", () => {
  it("returns the summary when the re-plan matches the approved digest", async () => {
    const w = world();
    const lease = await w.lease();
    const approved = await w.activities.planInfrastructure({ operationId: OP, lease });
    const again = await w.activities.finalPlan({ operationId: OP, approvedPlanDigest: approved.planDigest, lease });
    expect(again.planDigest).toBe(approved.planDigest);
    expect(w.evidence.ofKind("tofu_plan").map((e) => e.summary.stage)).toEqual(["plan", "final_plan"]);
    expect(w.evidence.ofKind("tofu_plan")[1].summary).toMatchObject({ approvedDigest: approved.planDigest, matchesApproved: true });
  });

  it("throws plan_changed when the plan moved, keeps the evidence of what moved, and deletes the unapproved plan file", async () => {
    const w = world();
    const lease = await w.lease();
    const approved = await w.activities.planInfrastructure({ operationId: OP, lease });

    w.tofu.planFactory = () => makePlan({ seed: "moved", changes: [change({ address: "aws_s3_bucket.assets", type: "aws_s3_bucket", action: "create" }), change({ address: "aws_s3_bucket.extra", type: "aws_s3_bucket", action: "create" })] });
    const err = await w.activities.finalPlan({ operationId: OP, approvedPlanDigest: approved.planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TofuPlanChangedError);
    expect((err as TofuPlanChangedError).code).toBe("plan_changed");
    expect((err as TofuPlanChangedError).approvedDigest).toBe(approved.planDigest);
    expect((err as TofuPlanChangedError).currentDigest).not.toBe(approved.planDigest);

    const moved = w.evidence.ofKind("tofu_plan").find((e) => e.summary.stage === "final_plan")!;
    expect(moved.summary).toMatchObject({ matchesApproved: false, approvedDigest: approved.planDigest });
    const files = readdirSync(w.planDir);
    expect(files).toEqual([`${approved.planDigest}.tfplan`]); // only the approved plan's file remains
    expect(existsSync(path.join(w.planDir, `${(err as TofuPlanChangedError).currentDigest}.tfplan`))).toBe(false);
  });

  it("re-plans without the state lock as well (it holds the same observe session)", async () => {
    const w = world();
    const lease = await w.lease();
    const approved = await w.activities.planInfrastructure({ operationId: OP, lease });
    await w.activities.finalPlan({ operationId: OP, approvedPlanDigest: approved.planDigest, lease });
    expect(w.tofu.planCalls.map((c) => c.opts.lock)).toEqual([false, false]);
    expect(w.credentials.sessions.map((s) => s.purpose)).toEqual(["observe", "observe"]);
  });
});
