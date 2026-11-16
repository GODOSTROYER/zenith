/** Real pinned tofu, local state; registry access is explicitly gated. No cloud credentials. */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyVerifiedPlan, planWorkspace, planDestroy } from "@/lib/tofu/engine";
import { TofuRunner } from "@/lib/tofu/runner";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { builtinWorkspace, dataFragment, graphOf, node, tempDir, tofuOnPath } from "./_helpers";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && tofuOnPath();

describe.skipIf(!enabled)("real tofu destroy (ZENITH_TEST_TOFU_NETWORK=1)", () => {
  it.each(["builtin", "random"] as const)("creates, reviews and destroys %s state through verified apply", async (providerSet) => {
    const temp = tempDir(); cleanups.push(temp.cleanup);
    const state = path.join(temp.dir, "state.tfstate");
    const ws = providerSet === "builtin" ? builtinWorkspace(state, { "resource/test": dataFragment("test", "local") }) : assembleWorkspace({ graph: graphOf([node("resource/test")]), fragments: new Map([["resource/test", { resource: { random_id: { test: { byte_length: 4 } } }, addresses: ["random_id.test"] }]]), providerSet, backend: { kind: "local", path: state }, region: "us-east-1", tags: {} });
    const runner = new TofuRunner({ pluginCacheDir: path.join(temp.dir, "cache"), limits: { timeoutMs: 120_000 } });
    const created = await planWorkspace(ws, undefined, { runner });
    await applyVerifiedPlan(ws, { runner, approvedDigest: created.plan.planDigest });
    const reviewed = await planDestroy(ws, undefined, { runner });
    expect(reviewed.plan.summary.delete).toBe(1);
    await expect(applyVerifiedPlan(ws, { runner, destroy: true, approvedDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "plan_changed" });
    const applied = await applyVerifiedPlan(ws, { runner, destroy: true, approvedDigest: reviewed.plan.planDigest });
    expect(applied.apply.exitCode).toBe(0);
    expect((await planDestroy(ws, undefined, { runner })).plan.empty).toBe(true);
  }, 300_000);
});
