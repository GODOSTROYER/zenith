/**
 * Opt-in real OpenTofu on built-in terraform_data and private local state.
 * Drivers and brokers are contracts, not real AWS; no network/cloud calls.
 * Run with ZENITH_TEST_DELETION_GUARDS_TOFU=1 when tofu can execute.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { createExecutionActivities } from "@/lib/execution/activities";
import { planWorkspace, applyVerifiedPlan } from "@/lib/tofu/engine";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { tofuOnPath } from "../tofu/_helpers";
import { createWorld, type World } from "./fakes/world";
import { bucketManifest, ENV, OP, REVISION } from "./fakes/fixtures";

const enabled = process.env.ZENITH_TEST_DELETION_GUARDS_TOFU === "1" && tofuOnPath();
const worlds: World[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.dispose()));

describe.skipIf(!enabled)("real tofu deploy removal (ZENITH_TEST_DELETION_GUARDS_TOFU=1)", () => {
  it("refuses unapproved stateful removal and applies the exact approved deletion", async () => {
    const w = createWorld(); worlds.push(w);
    const old = "rev-real-deployed";
    const before = upgradeManifest(bucketManifest(), { provider: "aws", region: "us-east-1" });
    before.policies = { ...before.policies, backup: "daily", deletion: "allow" };
    w.product.setManifest(before, old);
    w.product.setManifest({ version: 1, services: [], resources: [], routes: [], bindings: [] }, REVISION);
    const operation = w.ops.ops.get(OP)!;
    operation.proposal.input = { revisionId: old };
    const state = path.join(w.planDir, "terraform.tfstate");
    w.deps.tofuWorkspace = { providerSet: () => "builtin", backend: () => ({ backend: { kind: "local", path: state } }) };
    w.activities = createExecutionActivities({ ...w.deps, tofu: { planWorkspace, applyVerifiedPlan } });
    const lease = await w.lease();
    await w.activities.validateDesiredState({ operationId: OP });
    const created = await w.activities.planInfrastructure({ operationId: OP, lease });
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: created.planDigest, lease });
    expect(existsSync(state)).toBe(true);
    await w.leases.release(lease);

    w.product.base.environment.deployedRevisionId = old;
    const operationId = "op-real-removal";
    w.ops.seed({ id: operationId, proposal: { ...operation.proposal, input: { revisionId: REVISION } } });
    const deletionLease = await w.activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 300_000 });
    const deletion = await w.activities.planInfrastructure({ operationId, lease: deletionLease });
    expect(deletion).toMatchObject({ create: 0, delete: 1, destroysData: true });
    const row = w.evidence.ofKind("tofu_plan").find((r) => r.digest === deletion.planDigest)!;
    expect(row.summary).toMatchObject({ statefulDeletes: ["terraform_data.object_store_assets"], dnsDeletes: [] });
    const args = { operationId, planDigest: deletion.planDigest, lease: deletionLease };
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/human approval/);
    expect(w.ops.uncertain).toHaveLength(0);
    // The refused apply must leave the resource in state: re-plan still deletes it.
    expect((await w.activities.planInfrastructure({ operationId, lease: deletionLease })).delete).toBe(1);
    w.broker.approval = { approved: true, rejected: false, approvalId: "app-real-contract" };
    await w.activities.finalPlan({ operationId, approvedPlanDigest: deletion.planDigest, lease: deletionLease });
    await expect(w.activities.applyInfrastructure(args)).resolves.toMatchObject({ applied: 1 });
    expect((await w.activities.planInfrastructure({ operationId, lease: deletionLease })).empty).toBe(true);
  }, 120_000);
});
