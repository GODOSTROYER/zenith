/**
 * LIVE mixed-cloud acceptance (PROD-MIX-01 / PROD-MIX-02). GATED and never counted as
 * a pass when skipped: without ZENITH_LIVE_MIXED=1 every test here is skipped with the
 * reason below, and the verifier's gate manifest must not treat a skip as evidence.
 *
 * What it does when enabled: it reads the stored evidence of ONE mixed plan that an
 * operator already ran (plan, person's approval of the child set, one operation per
 * child, start) through the read-only plan endpoint and verifies it with the same
 * rules the contract tests exercise. It calls no cloud API. The run itself needs a
 * person's browser for the approvals; see docs/build/production/verify/PROD-MIX-01-02.md.
 *
 *   ZENITH_LIVE_MIXED=1
 *   ZENITH_LIVE_MIXED_API_URL=https://control-plane.example     (https, or a local dev host)
 *   ZENITH_LIVE_MIXED_WORKSPACE_ID=<workspace id>
 *   ZENITH_LIVE_MIXED_PLAN_ID=<mpp_...>
 *   ZENITH_LIVE_MIXED_TOKEN_FILE=<path to a file holding an integration token>   (a FILE, never a value)
 */
import { describe, expect, it } from "vitest";
import { fetchPlanView, verifyMixedEvidence } from "../../scripts/acceptance/mixed-evidence";
import { scopeSkipReason } from "../../scripts/release/scope";

const env = process.env;
const enabled = env.ZENITH_LIVE_MIXED === "1";
const missing = ["ZENITH_LIVE_MIXED_API_URL", "ZENITH_LIVE_MIXED_WORKSPACE_ID", "ZENITH_LIVE_MIXED_PLAN_ID", "ZENITH_LIVE_MIXED_TOKEN_FILE"].filter((name) => !env[name]);
const SKIP_REASON = enabled
  ? missing.length ? `ZENITH_LIVE_MIXED=1 but ${missing.join(", ")} not set` : scopeSkipReason("mixed-evidence-live", "control_plane") // PROD-REL-04: the approved scope must grant this harness
  : "live mixed-cloud acceptance is deferred; set ZENITH_LIVE_MIXED=1 and the ZENITH_LIVE_MIXED_* references to run it";

if (SKIP_REASON) console.warn(`[mixed-cloud live] SKIPPED, not a pass: ${SKIP_REASON}`);

describe.skipIf(Boolean(SKIP_REASON))("live mixed-cloud evidence", () => {
  it("the stored plan, receipts and addresses of the operator's run are complete and consistent", async () => {
    const view = await fetchPlanView({ apiUrl: env.ZENITH_LIVE_MIXED_API_URL!, workspaceId: env.ZENITH_LIVE_MIXED_WORKSPACE_ID!, planId: env.ZENITH_LIVE_MIXED_PLAN_ID!, tokenFile: env.ZENITH_LIVE_MIXED_TOKEN_FILE! });
    const verdict = verifyMixedEvidence(view);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  }, 60_000);
});

describe("live mixed-cloud verifier (contract level, always runs)", () => {
  it("never accepts a skip or an unreadable view as evidence", () => {
    expect(verifyMixedEvidence(null).ok).toBe(false);
    expect(verifyMixedEvidence({}).ok).toBe(false);
  });
});
