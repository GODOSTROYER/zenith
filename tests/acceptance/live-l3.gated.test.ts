/** Real owner-run Mac checks. Disabled gates are explicit skips, never passed acceptance. */
import { describe, expect, it } from "vitest";
import { scopeSkipReason } from "../../scripts/release/scope";
import { cli } from "../../scripts/acceptance/live/managed/cli";
for (const profile of ["managed", "mixed", "release"] as const) {
  const gate = `ZENITH_LIVE_${profile === "managed" ? "MANAGED" : profile === "mixed" ? "MIXED" : "RELEASE"}`;
  const fixture = process.env[`ZENITH_L3_${profile.toUpperCase()}_RECIPE_FILE`];
  const reason = process.env[gate] !== "1" ? `${gate}=1 is not set; needs owner-approved real sandbox`
    : !fixture ? "owner recipe FILE is absent"
    : scopeSkipReason(profile === "mixed" ? "mixed-traffic-live" : `${profile}-acceptance-live`, "control_plane");
  if (reason) console.warn(`L3 ${profile} NOT RUN: ${reason}`);
  describe.skipIf(Boolean(reason))(`L3 ${profile} live sandbox, not contract evidence`, () => {
    it("all requested observations, exact approved teardown and independent leak scans pass", async () => {
      expect(await cli(["--profile", profile, "--run", "--fixture", fixture!])).toBe(0);
    }, 4 * 60 * 60 * 1000);
  });
}
