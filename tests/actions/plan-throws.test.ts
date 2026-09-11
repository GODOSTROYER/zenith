/**
 * Planning against something that no longer exists must come back as a
 * blocked plan carrying the fix, not escape the runner as a 500.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-plan-throws-");
const { runAction } = await import("@/lib/actions/core");
const { resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const ctx: ActionContext = {
  workspaceId: "ws-x",
  projectId: "prj-gone",
  actor: { type: "user", id: "local", name: "You" },
};

beforeAll(() => {
  resetDb({ workspaces: [{ id: "ws-x", name: "X", slug: "x", createdAt: new Date().toISOString() }] });
});

describe("planning something that does not exist", () => {
  it("returns a blocked plan with the thrown message instead of throwing", async () => {
    const out = await runAction("env.create", ctx, { name: "staging", class: "staging" }, { mode: "plan" });
    const plan = "plan" in out ? out.plan : undefined;
    expect(plan).toBeDefined();
    if (!plan) return;
    expect(plan.blocked).toBeTruthy();
    expect(plan.blocked).toMatch(/project/i);
    expect(plan.details[0]).toBe(plan.blocked);
    expect(plan.requiredRole).toBe("editor");
  });
});
