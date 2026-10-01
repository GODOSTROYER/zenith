/** Real local OpenTofu tests need no external provider or network. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyVerifiedPlan, planWorkspace } from "@/lib/tofu/engine";
import { TofuRunner } from "@/lib/tofu/runner";
import type { ShowJson } from "@/lib/tofu/plan";
import { verifyDestroyPlan, destroyRunWorkspace } from "../../scripts/acceptance/tofu-destroy";
import { builtinWorkspace, dataFragment, tofuOnPath } from "../tofu/_helpers";
import { access, RUN, temp } from "./_helpers";

function show(type: string, before: unknown, actions = ["delete"]): ShowJson { return { resource_changes: [{ address: `${type}.test`, type, mode: "managed", change: { before, actions } }] }; }
describe("destroy plan verification", () => {
  it.each([{ tags: {} }, { tags_all: { "zenith:live-run": "other" } }])("refuses missing/foreign tags %j", (before) => { expect(verifyDestroyPlan(show("aws_db_instance", before), RUN).ok).toBe(false); });
  it("refuses unknown untagged types; permits only allowlisted untagged types", () => { expect(verifyDestroyPlan(show("aws_unknown", {}), RUN).ok).toBe(false); expect(verifyDestroyPlan(show("terraform_data", { input: "local" }), RUN).ok).toBe(true); });
  it.each(["update", "create"])("refuses %s in a destroy plan", (action) => { expect(verifyDestroyPlan(show("aws_vpc", { tags: { "zenith:live-run": RUN } }, [action]), RUN).ok).toBe(false); });
  it("refuses an errored plan and accepts matching tags", () => { expect(verifyDestroyPlan({ errored: true }, RUN).ok).toBe(false); expect(verifyDestroyPlan(show("aws_vpc", { tags_all: { "zenith:live-run": RUN } }), RUN).deletes).toHaveLength(1); });
});
describe.skipIf(!tofuOnPath())("real tofu 1.12.5: builtin provider, local backend", () => {
  it("applies terraform_data, plans a dry destroy, destroys and detects missing state", async () => {
    const dir = await temp(); const state = path.join(dir, "state", "terraform.tfstate");
    const ws = builtinWorkspace(state, { "resource/test": dataFragment("test", "local-only") });
    const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });
    const plan = await planWorkspace(ws, undefined, { runner });
    await applyVerifiedPlan(ws, { approvedDigest: plan.plan.planDigest, runner });
    const input = { access: access(), runId: RUN, workspaceId: "ws_test", environmentId: "env_test", region: "us-east-1", stateBucket: "unused", providerSet: "builtin" as const, backend: { kind: "local" as const, path: state }, noCredentials: true, dryRun: true };
    const dry = await destroyRunWorkspace(input); expect(dry.status, dry.detail).toBe("planned"); expect(dry.deletes).toHaveLength(1);
    const result = await destroyRunWorkspace({ ...input, dryRun: false }); expect(result.status, result.detail).toBe("destroyed"); expect(result.deletes).toHaveLength(1);
    expect((await destroyRunWorkspace({ ...input, backend: { kind: "local", path: path.join(dir, "missing.tfstate") } })).status).toBe("no_state");
  }, 180_000);
});
