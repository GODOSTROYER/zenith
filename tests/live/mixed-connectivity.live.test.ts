/**
 * LIVE protected-endpoint probes of a deployed mixed run (PROD-MIX-05). GATED and never counted as a pass when skipped:
 * without ZENITH_LIVE_MIXED=1 and every reference below, the live suite is skipped with the reason in its name.
 *
 * It reads the approved connectivity declaration of ONE stored mixed plan (`GET /api/platform/v1/mixed/plans/:id`) and
 * probes each protected endpoint (DNS targets, pinned TLS with the client certificate, mutual-TLS requirement, TLS floor,
 * and, if the operator declares this machine outside the allowlist, allowlist denial). Read-only: no resource is created,
 * changed or deleted. An approved scope manifest granting `mixed-connectivity-live` is required (PROD-REL-04).
 *
 *   ZENITH_LIVE_MIXED=1
 *   ZENITH_LIVE_MIXED_API_URL, ZENITH_LIVE_MIXED_WORKSPACE_ID, ZENITH_LIVE_MIXED_PLAN_ID, ZENITH_LIVE_MIXED_TOKEN_FILE
 *   ZENITH_LIVE_MIXED_CLIENT_CERT_FILE, ZENITH_LIVE_MIXED_CLIENT_KEY_FILE   (FILES; optional ZENITH_LIVE_MIXED_CLIENT_CA_FILE)
 *   optional ZENITH_LIVE_MIXED_SOURCE_OUTSIDE_ALLOWLIST=1
 *
 * The always-on suite below is contract level: it checks that an unreadable or empty plan is never accepted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchPlanView } from "../../scripts/acceptance/mixed-evidence";
import { nodeProbeIo, runConnectivityProbes, type ProbeEndpoint } from "../../scripts/acceptance/mixed/connectivity-probe";
import { scopeSkipReason } from "../../scripts/release/scope";

const env = process.env;
const enabled = env.ZENITH_LIVE_MIXED === "1";
const missing = ["ZENITH_LIVE_MIXED_API_URL", "ZENITH_LIVE_MIXED_WORKSPACE_ID", "ZENITH_LIVE_MIXED_PLAN_ID", "ZENITH_LIVE_MIXED_TOKEN_FILE", "ZENITH_LIVE_MIXED_CLIENT_CERT_FILE", "ZENITH_LIVE_MIXED_CLIENT_KEY_FILE"].filter((name) => !env[name]);
const SKIP_REASON = enabled
  ? missing.length ? `ZENITH_LIVE_MIXED=1 but ${missing.join(", ")} not set` : scopeSkipReason("mixed-connectivity-live", "control_plane")
  : "live protected-connectivity probes are deferred; set ZENITH_LIVE_MIXED=1 and the ZENITH_LIVE_MIXED_* references to run them";

if (SKIP_REASON) console.warn(`[mixed connectivity live] SKIPPED, not a pass: ${SKIP_REASON}`);

describe.skipIf(Boolean(SKIP_REASON))("live protected-endpoint probes", () => {
  it("every approved endpoint resolves, pins, requires mutual TLS and refuses an old protocol", async () => {
    const view = (await fetchPlanView({ apiUrl: env.ZENITH_LIVE_MIXED_API_URL!, workspaceId: env.ZENITH_LIVE_MIXED_WORKSPACE_ID!, planId: env.ZENITH_LIVE_MIXED_PLAN_ID!, tokenFile: env.ZENITH_LIVE_MIXED_TOKEN_FILE! })) as { connectivity?: { endpoints: ProbeEndpoint[] } | null };
    const endpoints = view.connectivity?.endpoints ?? [];
    expect(endpoints.length, "the plan carries no approved connectivity declaration").toBeGreaterThan(0);
    const verdict = await runConnectivityProbes({
      endpoints, io: nodeProbeIo,
      client: { cert: readFileSync(env.ZENITH_LIVE_MIXED_CLIENT_CERT_FILE!), key: readFileSync(env.ZENITH_LIVE_MIXED_CLIENT_KEY_FILE!), ...(env.ZENITH_LIVE_MIXED_CLIENT_CA_FILE ? { ca: readFileSync(env.ZENITH_LIVE_MIXED_CLIENT_CA_FILE) } : {}) },
      sourceOutsideAllowlist: env.ZENITH_LIVE_MIXED_SOURCE_OUTSIDE_ALLOWLIST === "1",
    });
    process.stdout.write(`${JSON.stringify(verdict.results, null, 2)}\n`);
    expect(verdict.results.filter((r) => r.status === "failed"), "failed probes").toEqual([]);
    expect(verdict.complete, "skipped or inconclusive applicable probes are not passes").toBe(true);
    // Probes this vantage point cannot establish are reported, never counted: run again from the other vantage point for them.
    process.stdout.write(`not checked from this vantage point (${verdict.vantage}): ${verdict.notChecked.join(", ") || "none"}\n`);
  }, 120_000);
});

describe("live connectivity probes (contract level, always runs)", () => {
  it("never accepts an empty endpoint list as evidence", async () => {
    const verdict = await runConnectivityProbes({ endpoints: [], io: { resolve: async () => [], tlsConnect: async () => ({ outcome: "refused", reason: "timeout" }) } });
    expect(verdict.ok).toBe(false);
  });
});
