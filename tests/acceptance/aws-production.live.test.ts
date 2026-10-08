/** Actual provider-fixture lane. Does not certify the pending product requirements. */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProductionCli } from "../../scripts/acceptance/live/cli";

const enabled = process.env.ZENITH_LIVE_AWS === "1";
describe.skipIf(!enabled)("LIVE AWS fixtures (not run without ZENITH_LIVE_AWS=1; requires DEC-CLOUD and explicit budget)", () => {
  it("observes six actual provider fixtures and native teardown; reports pending product journeys honestly", async () => {
    const env = process.env;
    // Enabling the flag without any other prerequisite fails, rather than skips.
    expect(env.ZENITH_LIVE_AWS_RUN_ID).toBeTruthy();
    expect(env.ZENITH_LIVE_AWS_PERMISSIONS).toBeTruthy();
    expect(Number(env.ZENITH_LIVE_AWS_BUDGET_USD)).toBeGreaterThan(0);
    const code = await runProductionCli([]);
    expect(code).toBe(3); // This source has no Wave 5 ProductScenarioPort implementation.
    const directory = path.join(env.ZENITH_LIVE_AWS_OUT ?? path.join(tmpdir(), "zenith-aws-production"), env.ZENITH_LIVE_AWS_RUN_ID!);
    const packet = JSON.parse(await readFile(path.join(directory, "evidence.json"), "utf8"));
    expect(packet.provenance).toBe("live_sandbox");
    expect(packet.cleanupComplete).toBe(true);
    expect(packet.counts.failed).toBe(0);
    expect(packet.checks.filter((c: { scope: string; status: string }) => c.scope === "aws_fixture" && c.status === "passed")).toHaveLength(6);
    expect(packet.checks.filter((c: { scope: string; status: string }) => c.scope === "cleanup" && c.status === "passed")).toHaveLength(6);
    expect(packet.requirements).toHaveLength(27);
    expect(packet.requirements.every((r: { status: string; evidence: unknown[] }) => r.status === "pending" && r.evidence.length === 0)).toBe(true);
    expect(packet.verdict).toBe("incomplete");
  }, 50 * 60_000);
});
