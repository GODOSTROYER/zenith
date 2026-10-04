import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "../../scripts/acceptance/runner";
import { cleanupBlockPath, readCleanupBlock } from "../../scripts/acceptance/run-state";
import { executeScenarios } from "../../scripts/acceptance/aws-live";
import { establishLiveSession } from "../../scripts/acceptance/safety";
import { access, ACCOUNT, context, definition } from "./_helpers";

describe("runner failure boundaries", () => {
  it("a session budget refusal fails the timed mutation step before it runs", async () => {
    const c = await context("simulated");
    c.session = await establishLiveSession({ config: c.config, access: access(), runId: c.runId, mutating: true, confirmBillable: true, probe: { callerAccount: async () => ({ account: ACCOUNT }), liveMarker: async () => "true" } });
    const run = vi.fn(); const d = definition({ mutates: true, createsResources: true, steps: [{ id: "create", title: "create", effect: "mutate", plan: () => ["create"], run }] });
    await runScenario(d, c, {}, []); expect(run).not.toHaveBeenCalled(); expect(c.evidence.checksFor("J").find((r) => r.id === "step:create")?.status).toBe("failed");
  });
  it("blocks a missing dependency and skips every criterion", async () => { const c = await context(); const outcome = await runScenario(definition({ dependsOn: ["A"] }), c, {}, []); expect(outcome.status).toBe("blocked"); expect(c.evidence.checksFor("J")[0]?.status).toBe("skipped"); });
  it("fails a thrown step and skips later work", async () => {
    const c = await context(); const later = vi.fn();
    const d = definition({ steps: [{ id: "broken", title: "break", effect: "none", plan: () => ["break"], run: async () => { throw new Error("failure"); } }, { id: "later", title: "later", effect: "none", plan: () => ["later"], run: later }] });
    expect((await runScenario(d, c, {}, [])).status).toBe("failed"); expect(c.evidence.summary().verdict).toBe("failed"); expect(c.evidence.hasCheck("J", "step:broken")).toBe(true); expect(later).not.toHaveBeenCalled();
  });
  it("skips an unrecorded criterion and does not set completed", async () => { const c = await context(); await runScenario(definition(), c, {}, []); expect(c.evidence.summary().counts.skipped).toBe(1); expect(c.state.has("completed:J")).toBe(false); });
  it("records mutation refusal inside the timed step", async () => { const c = await context(); const run = vi.fn(); await runScenario(definition({ mutates: true, steps: [{ id: "create", title: "create", effect: "mutate", plan: () => ["create"], run }] }), c, {}, []); expect(run).not.toHaveBeenCalled(); expect(c.evidence.summary().verdict).toBe("failed"); });
  it("sets completed only for passed criteria", async () => { const c = await context(); const d = definition({ steps: [{ id: "check", title: "check", effect: "none", plan: () => ["check"], run: async (ctx) => { ctx.evidence.pass("J", "checked", "observed"); } }] }); expect((await runScenario(d, c, {}, [])).status).toBe("completed"); expect(c.state.get("completed:J")).toBe(true); });
  it("refuses unverified external hooks/sweep after failure, reports cleanup loudly, and finalizes evidence", async () => {
    const c = await context("simulated"); const calls: string[] = [];
    const d = definition({ runsLocally: false, cleanup: async () => { calls.push("hook"); throw new Error("cleanup hook broke"); }, steps: [{ id: "throw", title: "throw", effect: "none", plan: () => ["throw"], run: async () => { throw new Error("step broke"); } }] });
    const err = vi.fn(); expect(await executeScenarios(c, [d], {}, async () => { calls.push("sweep"); throw new Error("sweep broke"); }, { out: () => undefined, err })).toBe(1);
    expect(calls).toEqual([]); expect(err).toHaveBeenCalledWith(expect.stringContaining("CLEANUP INCOMPLETE")); expect(c.evidence.hasCheck("harness", "cleanup")).toBe(true); expect(await readFile(path.join(c.evidence.dir, "summary.md"), "utf8")).toContain("FAILED");
  });
  it("journals a mutation before dispatch and refuses hooks/sweep after an accepted call loses its response", async () => {
    const c = await context("simulated"); c.confirmBillable = true;
    const hook = vi.fn(); const sweep = vi.fn(async () => true);
    const run = vi.fn(async () => {
      expect(await readCleanupBlock(c.runStateFile, { runId: c.runId })).toMatchObject({ status: "blocked" });
      throw new Error("response lost after acceptance");
    });
    const d = definition({ runsLocally: false, mutates: true, cleanup: hook, steps: [{ id: "create", title: "create", effect: "mutate", plan: () => ["create"], run }] });
    expect(await executeScenarios(c, [d], {}, sweep, { out: () => undefined, err: () => undefined })).toBe(1);
    expect(run).toHaveBeenCalledOnce(); expect(hook).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled();
    expect(await readFile(cleanupBlockPath(c.runStateFile), "utf8")).toContain("provider_quiescence_unverified");
  });
  it("a returned mutation without a provider-resolution authority still cannot permit teardown", async () => {
    const c = await context("simulated"); c.confirmBillable = true;
    const hook = vi.fn(); const sweep = vi.fn(async () => true);
    const d = definition({ runsLocally: false, mutates: true, cleanup: hook, steps: [{ id: "create", title: "create", effect: "mutate", plan: () => ["create"], run: async () => { c.evidence.pass("J", "checked", "scenario observation"); } }] });
    expect(await executeScenarios(c, [d], {}, sweep, { out: () => undefined, err: () => undefined })).toBe(1);
    expect(c.evidence.checksFor("J").find((check) => check.id === "checked")?.status).toBe("passed");
    expect(c.evidence.hasCheck("harness", "cleanup")).toBe(true); expect(hook).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled();
  });
  it("local observation finalizes without external cleanup hooks or sweep", async () => {
    const c = await context("local"); const hook = vi.fn(); const sweep = vi.fn(async () => true);
    const d = definition({ cleanup: hook, steps: [{ id: "observe", title: "observe", effect: "none", plan: () => ["observe"], run: async () => { c.evidence.pass("J", "checked", "observed condition"); } }] });
    expect(await executeScenarios(c, [d], {}, sweep, { out: () => undefined, err: () => undefined })).toBe(0);
    expect(hook).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled();
    expect(await readCleanupBlock(c.runStateFile, { runId: c.runId })).toBeUndefined();
    expect(c.evidence.hasCheck("harness", "cleanup")).toBe(false);
  });

});
