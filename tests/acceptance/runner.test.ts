import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "../../scripts/acceptance/runner";
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
  it("attempts hooks and sweep after failure, reports cleanup loudly, and finalizes evidence", async () => {
    const c = await context("simulated"); const calls: string[] = [];
    const d = definition({ runsLocally: false, cleanup: async () => { calls.push("hook"); throw new Error("cleanup hook broke"); }, steps: [{ id: "throw", title: "throw", effect: "none", plan: () => ["throw"], run: async () => { throw new Error("step broke"); } }] });
    const err = vi.fn(); expect(await executeScenarios(c, [d], {}, async () => { calls.push("sweep"); throw new Error("sweep broke"); }, { out: () => undefined, err })).toBe(1);
    expect(calls).toEqual(["hook", "sweep"]); expect(err).toHaveBeenCalledWith(expect.stringContaining("CLEANUP INCOMPLETE")); expect(c.evidence.hasCheck("harness", "cleanup")).toBe(true); expect(await readFile(path.join(c.evidence.dir, "summary.md"), "utf8")).toContain("FAILED");
  });
});
