/**
 * The Navigator executor's two ceilings and its floor.
 *
 * Autonomy is the agent's ceiling. The role of the human who pressed Run is
 * the floor: every step runs as the Navigator actor, so `runAction`'s own role
 * check never sees a human, and without this check a viewer could execute
 * through the agent what they cannot execute from the System Map.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Actor, NavigatorRun, NavigatorStep } from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-nav-exec-"));
process.env.ORRERY_FAST = "1";

const { defineAction, runAction } = await import("@/lib/actions/core");
await import("@/lib/actions/defs");
const { db, resetDb, save } = await import("@/lib/db/store");
const { cancelRun, createRun, executeRun, findRun } = await import("@/lib/navigator/run");
const verification = await import("@/lib/navigator/verification");

const WS = "ws-nav";
let projectId = "";
let runSequence = 0;

const human = (id: string, name: string): Actor => ({ type: "user", id, name });

const step = (over: Partial<NavigatorStep> & Pick<NavigatorStep, "actionId">): NavigatorStep => ({
  id: `s-${over.seq ?? 0}`,
  seq: over.seq ?? 0,
  title: over.title ?? "Step",
  rationale: "because the goal asked for it",
  input: {},
  risk: "low",
  needsApproval: false,
  status: "proposed",
  ...over,
});

function makeRun(steps: NavigatorStep[], status: NavigatorRun["status"] = "awaiting_approval"): NavigatorRun {
  const run: NavigatorRun = {
    // The action replay cache survives resetDb; a new test is a new intent.
    id: `run-${runSequence++}`,
    projectId,
    goal: "do the thing",
    status,
    steps,
    createdAt: new Date().toISOString(),
  };
  db().navigatorRuns.push(run);
  save();
  return run;
}

beforeEach(async () => {
  resetDb({
    workspaces: [{ id: WS, name: "Nav", slug: "nav", createdAt: new Date().toISOString() }],
    members: [
      { id: "u-admin", workspaceId: WS, name: "Ada", email: "ada@x.dev", role: "admin" },
      { id: "u-editor", workspaceId: WS, name: "Eli", email: "eli@x.dev", role: "editor" },
      { id: "u-viewer", workspaceId: WS, name: "Vic", email: "vic@x.dev", role: "viewer" },
    ],
    settings: { autonomy: "autonomous" },
  });
  const created = await runAction(
    "project.applyBlueprint",
    { workspaceId: WS, actor: human("u-admin", "Ada") },
    { blueprint: "internal-tool", name: "Atlas" },
    { mode: "execute" }
  );
  projectId = (created.result!.data as { projectId: string }).projectId;
});

describe("the human's role is the floor", () => {
  it("refuses a nonmember even when every requested step needs only viewer", async () => {
    const run = makeRun([step({ actionId: "ops.investigate" })]);
    await expect(executeRun(run.id, { human: human("stranger", "Stranger") })).rejects.toThrow(/member/i);
    expect(run.status).toBe("awaiting_approval");
  });

  it.each(["remove", "downgrade"])("rechecks the human before the next step after a %s", async (change) => {
    defineAction({
      id: "test.changeMembership", title: "Change membership during a step", category: "navigator",
      risk: "low", requiredRole: "editor", mutates: false, input: z.object({}),
      plan: () => ({ summary: "Fixture", details: [], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false }),
      execute: () => {
        if (change === "remove") db().members = db().members.filter((member) => member.id !== "u-editor");
        else db().members.find((member) => member.id === "u-editor")!.role = "viewer";
        return { ok: true, summary: "An admin changed the caller's membership." };
      },
    });
    const run = makeRun([
      step({ seq: 0, actionId: "test.changeMembership" }),
      step({ seq: 1, actionId: "system.addService", input: { name: "after-revocation", kind: "worker", image: "busybox:1" } }),
    ]);
    const result = await executeRun(run.id, { human: human("u-editor", "Eli") });
    expect(result.status).toBe("failed");
    expect(result.steps[0].status).toBe("done");
    expect(result.steps[1].status).toBe("failed");
    expect(result.steps[1].error).toMatch(change === "remove" ? /member/i : /viewer/);
    expect(db().projects[0].workingManifest.services.some((service) => service.name === "after-revocation")).toBe(false);
  });

  it("does not let removal fall back to viewer access for a later read", async () => {
    const read = vi.fn(() => ({ ok: true, summary: "Private read" }));
    for (const [actionId, execute] of [
      ["test.removeCaller", () => { db().members = []; return { ok: true, summary: "Removed" }; }],
      ["test.readAfterRemoval", read],
    ] as const) defineAction({
      id: actionId, title: actionId, category: "navigator", risk: "low", requiredRole: "viewer",
      mutates: false, input: z.object({}),
      plan: () => ({ summary: "Fixture", details: [], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false }), execute,
    });
    const run = makeRun([step({ seq: 0, actionId: "test.removeCaller" }), step({ seq: 1, actionId: "test.readAfterRemoval" })]);
    const result = await executeRun(run.id, { human: human("u-admin", "Ada") });
    expect(read).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.steps[1].error).toMatch(/member/i);
  });

  it("refuses a run whose steps outrank the person who pressed Run", async () => {
    const run = makeRun([step({ actionId: "workspace.setAutonomy", title: "Raise autonomy", input: { level: "bounded" } })]);
    await expect(executeRun(run.id, { human: human("u-viewer", "Vic") })).rejects.toThrow(
      /needs the admin role and you are viewer/
    );
  });

  it("names the fix, and changes nothing at all — not even the run's status", async () => {
    const run = makeRun([step({ actionId: "workspace.setAutonomy", input: { level: "bounded" } })]);
    await executeRun(run.id, { human: human("u-viewer", "Vic") }).catch((e: Error) => {
      expect(e.message).toMatch(/Settings → Members/);
    });
    expect(findRun(run.id)!.status).toBe("awaiting_approval");
    expect(findRun(run.id)!.steps[0].status).toBe("proposed");
    expect(db().settings.autonomy).toBe("autonomous");
  });

  it("stops an editor at an admin step even when the editor step below it is fine", async () => {
    const run = makeRun([
      step({ seq: 0, actionId: "system.addService", input: { name: "worker-a", kind: "worker", image: "busybox:1" } }),
      step({ seq: 1, actionId: "workspace.setAutonomy", input: { level: "bounded" } }),
    ]);
    await expect(executeRun(run.id, { human: human("u-editor", "Eli") })).rejects.toThrow(/Step 1/);
    // Refused before the first step ran, so the working manifest is untouched.
    expect(findRun(run.id)!.steps[0].status).toBe("proposed");
  });

  it("lets a step through when the human's role covers it", async () => {
    const run = makeRun([
      step({ actionId: "system.addService", input: { name: "worker-a", kind: "worker", image: "busybox:1" } }),
    ]);
    const done = await executeRun(run.id, { human: human("u-editor", "Eli") });
    expect(done.steps[0].status).toBe("done");
    expect(done.status).toBe("done");
  });

  it("ignores a step the human has not approved — it was never going to run", async () => {
    const run = makeRun([
      step({ actionId: "workspace.setAutonomy", needsApproval: true, input: { level: "bounded" } }),
    ]);
    const out = await executeRun(run.id, { human: human("u-viewer", "Vic") });
    expect(out.status).toBe("awaiting_approval");
    expect(out.steps[0].status).toBe("proposed");
  });
});

describe("cancel", () => {
  it("stops the executor before its next step", async () => {
    // A cancel that lands while the executor is mid-run, through the real
    // path: step 0 cancels the run from inside its own action.
    let cancelTarget = "";
    defineAction({
      id: "test.cancelFromInside",
      title: "Cancel from inside",
      category: "navigator",
      risk: "low",
      requiredRole: "editor",
      mutates: false,
      input: z.object({}),
      plan: () => ({
        summary: "cancels the run",
        details: [],
        costDeltaUsd: 0,
        risk: "low" as const,
        warnings: [],
        requiresApproval: false,
      }),
      execute: () => {
        cancelRun(cancelTarget);
        return { ok: true, summary: "the human cancelled while this step ran" };
      },
    });

    const run = makeRun([
      step({ seq: 0, actionId: "test.cancelFromInside" }),
      step({ seq: 1, actionId: "system.addService", input: { name: "worker-b", kind: "worker", image: "busybox:1" } }),
    ]);
    cancelTarget = run.id;

    const out = await executeRun(run.id, { human: human("u-admin", "Ada") });
    expect(out.status).toBe("cancelled");
    expect(out.steps[0].status).toBe("done"); // the step in flight finished honestly
    expect(out.steps[1].status).toBe("skipped"); // and nothing after it started
    expect(out.summary).toMatch(/cancelled/i);
    expect(out.endedAt).toBeTruthy();
    expect(db().projects[0].workingManifest.services.some((s) => s.name === "worker-b")).toBe(false);
  });

  it("refuses to resume a cancelled run", async () => {
    const run = makeRun([step({ actionId: "system.addService" })]);
    cancelRun(run.id);
    await expect(executeRun(run.id, { human: human("u-admin", "Ada") })).rejects.toThrow(
      /cancelled.*Start a new run/s
    );
  });

  it("cancels a run that is only waiting for approval", () => {
    const run = makeRun([step({ actionId: "system.addService", needsApproval: true })]);
    const out = cancelRun(run.id);
    expect(out.status).toBe("cancelled");
    expect(out.steps[0].status).toBe("skipped");
    expect(out.endedAt).toBeTruthy();
  });

  it("refuses to cancel a finished run, and says what to do instead", () => {
    const run = makeRun([step({ actionId: "system.addService" })], "done");
    expect(() => cancelRun(run.id)).toThrow(/already done.*Start a new run/s);
  });
});

describe("goal length", () => {
  it("caps the goal before it reaches the model or the store", async () => {
    await expect(createRun(projectId, "a".repeat(2001))).rejects.toThrow(/limit is 2000/);
    expect(db().navigatorRuns).toHaveLength(0);
  });

  it("names the fix", async () => {
    await createRun(projectId, "a".repeat(2001)).catch((e: Error) => {
      expect(e.message).toMatch(/Shorten it/);
    });
  });
});

describe("verification handoff", () => {
  const evidence = () => ({ scope: "run" as const, source: "provider" as const, status: "passed" as const,
    simulated: false, checkedAt: new Date().toISOString(), evidenceRef: "test-provider-readback" });
  it("persists returned evidence only after the executor completes the checks", async () => {
    const verify = vi.spyOn(verification, "verifyRun").mockImplementation(async (run) => {
      expect(run.status).toBe("executing"); expect(run.verificationPending).toBe(true);
      return { verification: evidence(), note: "Provider checks passed" };
    });
    try {
      const run = makeRun([step({ actionId: "system.addService", input: { name: "verified-worker", kind: "worker", image: "busybox:1" } })]);
      const result = await executeRun(run.id);
      expect(verify).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ status: "done", verificationPending: false, verification: { evidenceRef: "test-provider-readback" } });
    } finally { verify.mockRestore(); }
  });
  it("does not attach successful evidence if cancelled during provider checks", async () => {
    const verify = vi.spyOn(verification, "verifyRun").mockImplementation(async (run) => {
      cancelRun(run.id); return { verification: evidence(), note: "Provider checks passed" };
    });
    try {
      const run = makeRun([step({ actionId: "system.addService", input: { name: "cancel-worker", kind: "worker", image: "busybox:1" } })]);
      const result = await executeRun(run.id);
      expect(result.status).toBe("cancelled"); expect(result.verification).toBeUndefined();
      expect(result.verificationPending).toBe(false);
    } finally { verify.mockRestore(); }
  });
  it("keeps completed work recorded when the provider check is unavailable", async () => {
    const verify = vi.spyOn(verification, "verifyRun").mockRejectedValue(new Error("Provider is unreachable"));
    try {
      const run = makeRun([step({ actionId: "system.addService", input: { name: "offline-worker", kind: "worker", image: "busybox:1" } })]);
      const result = await executeRun(run.id);
      expect(result).toMatchObject({ status: "done", verificationPending: false, verificationNote: "Provider is unreachable" });
      expect(result.verification).toBeUndefined();
    } finally { verify.mockRestore(); }
  });
});
