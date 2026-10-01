import { describe, expect, it, vi } from "vitest";
import { demoJ } from "../../scripts/acceptance/scenarios/j-multicloud-planning";
import { runScenario } from "../../scripts/acceptance/runner";
import { runLiveCli } from "../../scripts/acceptance/aws-live";
import { context, temp } from "./_helpers";

describe("Demo J real local planning", () => {
  it("runs the merged pipeline with ten local passes and cross-cloud evidence", async () => {
    const c = await context(); const fetch = vi.fn(() => { throw new Error("no network"); }); vi.stubGlobal("fetch", fetch);
    try { expect((await runScenario(demoJ, c, {}, [])).status).toBe("completed"); expect(c.evidence.summary()).toMatchObject({ verdict: "passed", counts: { passedLocal: 10, passedLive: 0, failed: 0, skipped: 0 } }); for (const text of ["Cross-boundary traffic", "cross-cloud", "/month", "+10 ms", "not an invoice"]) expect(c.state.get("j.report")).toEqual(expect.stringContaining(text)); expect(fetch).not.toHaveBeenCalled(); await c.evidence.finalize(); }
    finally { vi.unstubAllGlobals(); }
  });
  it("CLI runs J with no account/config and rejects malformed selections", async () => { const out: string[] = []; const io = { out: (s: string) => out.push(s), err: () => undefined }; expect(await runLiveCli(["--scenario", "J", "--out", await temp()], {}, io)).toBe(0); expect(out.join("\n")).toContain("10 check(s) passed locally"); expect(await runLiveCli(["--scenario", "K"], {}, io)).toBe(2); });
  it("CLI automatically downgrades unconfirmed AWS mutations to no-cloud dry run", async () => { const out: string[] = []; expect(await runLiveCli(["--scenario", "A", "--out", await temp()], {}, { out: (s) => out.push(s), err: () => undefined })).toBe(0); expect(out.join("\n")).toContain("dry run: pass --confirm-billable"); });
});
