/** Actual runner/engine, scripted process port. No real tofu or cloud calls. */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planDestroy, applyVerifiedPlan, planWorkspace } from "@/lib/tofu/engine";
import { TofuRunner } from "@/lib/tofu/runner";
import { TOFU_VERSION } from "@/lib/tofu/types";
import type { ShowJson } from "@/lib/tofu/plan";
import type { RunProcessOptions } from "@/lib/tofu/process";
import { builtinWorkspace, dataFragment, tempDir } from "./_helpers";

const port = vi.hoisted(() => ({ calls: [] as RunProcessOptions[], raw: {} as ShowJson }));
vi.mock("@/lib/tofu/process", () => ({
  runProcess: async (opts: RunProcessOptions) => {
    port.calls.push(opts);
    const command = opts.args[0];
    if (command === "plan") await writeFile(path.join(opts.cwd, "tfplan"), "server-only-binary");
    const stdout = command === "version" ? JSON.stringify({ terraform_version: TOFU_VERSION, platform: "test" }) : command === "show" ? JSON.stringify(port.raw) : command === "output" ? "{}" : undefined;
    return { exitCode: command === "plan" ? 2 : 0, output: "", truncated: false, timedOut: false, aborted: false, stdoutOverflow: false, durationMs: 1, stdout };
  },
}));
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
beforeEach(() => {
  port.calls = [];
  port.raw = { format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: [{ address: "terraform_data.test", type: "terraform_data", mode: "managed", change: { actions: ["delete"], before: { input: "private" }, after: null } }] };
});
function fixture() {
  const temp = tempDir(); cleanups.push(temp.cleanup);
  // Node's executable is a real file for binary resolution; the process port
  // above supplies the pinned tofu version and commands, never runs Node as tofu.
  const runner = new TofuRunner({ bin: process.execPath, pluginCacheDir: path.join(temp.dir, "cache"), workRoot: temp.dir });
  return { runner, ws: builtinWorkspace(path.join(temp.dir, "state.tfstate"), { "resource/test": dataFragment("test", "private") }) };
}

describe("destroy through the runner process boundary", () => {
  it("adds -destroy only to destroy plans, leaves apply locked, and applies the verified file", async () => {
    const f = fixture();
    const planned = await planDestroy(f.ws, undefined, { runner: f.runner, lock: false });
    const first = port.calls.find((c) => c.args[0] === "plan")!;
    expect(first.args).toContain("-destroy"); expect(first.args).toContain("-lock=false");
    await applyVerifiedPlan(f.ws, { runner: f.runner, destroy: true, approvedDigest: planned.plan.planDigest });
    const second = port.calls.filter((c) => c.args[0] === "plan")[1];
    expect(second.args).toContain("-destroy"); expect(second.args).toContain("-lock-timeout=60s");
    const apply = port.calls.find((c) => c.args[0] === "apply")!;
    expect(apply.args.at(-1)).toBe("tfplan"); expect(apply.args).not.toContain("-auto-approve");
    expect(apply.env).not.toHaveProperty("ZENITH_CONTROL_SIGNING_JWK");
    await planWorkspace(f.ws, undefined, { runner: f.runner });
    expect(port.calls.filter((c) => c.args[0] === "plan").at(-1)!.args).not.toContain("-destroy");
  });
  it("refuses a moved digest before the process can apply", async () => {
    const f = fixture(); const approved = await planDestroy(f.ws, undefined, { runner: f.runner });
    port.raw.resource_changes![0].change!.before = { input: "moved" };
    await expect(applyVerifiedPlan(f.ws, { runner: f.runner, destroy: true, approvedDigest: approved.plan.planDigest })).rejects.toMatchObject({ code: "plan_changed" });
    expect(port.calls.some((c) => c.args[0] === "apply")).toBe(false);
  });
  it("refuses a file modified by an asynchronous pre-apply guard", async () => {
    const f = fixture(); const approved = await planDestroy(f.ws, undefined, { runner: f.runner });
    await expect(applyVerifiedPlan(f.ws, { runner: f.runner, destroy: true, approvedDigest: approved.plan.planDigest, inspectPlan: async () => {
      const shown = port.calls.filter((c) => c.args[0] === "show").at(-1)!;
      await writeFile(path.join(shown.cwd, "tfplan"), "tampered");
    } })).rejects.toThrow(/saved plan file changed/);
    expect(port.calls.some((c) => c.args[0] === "apply")).toBe(false);
  });
  it("refuses unguarded DNS deletes and stateful deletes with no policy", async () => {
    const f = fixture();
    for (const type of ["aws_route53_record", "google_storage_bucket"]) {
      port.raw.resource_changes![0].type = type;
      await expect(planDestroy(f.ws, undefined, { runner: f.runner })).rejects.toMatchObject({ code: "deletion_refused" });
    }
  });
});
