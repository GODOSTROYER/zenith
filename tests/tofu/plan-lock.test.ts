/**
 * `planWorkspace({ lock: false })` is for plans made with observe-purpose
 * (read-only) credentials, which cannot write OpenTofu's state lock object;
 * the environment's fenced Zenith lease is the real serialisation. Real tofu,
 * local backend, builtin `terraform_data` only.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planWorkspace } from "@/lib/tofu/engine";
import { TofuRunner } from "@/lib/tofu/runner";
import { builtinWorkspace, dataFragment, tempDir, tofuOnPath } from "./_helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe.skipIf(!tofuOnPath())("plan state lock option (real tofu)", () => {
  const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });

  it("plans identically with and without the state lock", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const ws = builtinWorkspace(path.join(t.dir, "state", "terraform.tfstate"), { "resource/a": dataFragment("a", "v1") });
    const locked = await planWorkspace(ws, undefined, { runner });
    const unlocked = await planWorkspace(ws, undefined, { runner, lock: false });
    expect(unlocked.plan.summary).toMatchObject({ create: 1 });
    expect(unlocked.plan.planDigest).toBe(locked.plan.planDigest);
  }, 180_000);
});
