/** Demo F: real API revocation is performed by a human. Runner revocation is
 * explicitly skipped until the runner path exists. No live verification yet. */
import { ControlPlaneError } from "../clients/control-plane";
import type { PassCriterion, ScenarioDefinition } from "../types";
import { checker, configPrerequisite, cp } from "./_shared";

const CRITERIA: readonly PassCriterion[] = [
  { id: "baseline-ok", text: "The integration credential initially lists operations successfully." },
  { id: "rejected-after-revoke", text: "After operator revocation, a request returns HTTP 401 or 403." },
  { id: "stays-rejected", text: "Five subsequent requests all return HTTP 401 or 403." },
  { id: "runner-revocation", text: "Revoked runner/AWS connection credentials reject the next cloud request (requires the runner)." },
];
const C = checker("F", CRITERIA);
export const demoF: ScenarioDefinition = {
  id: "F", title: "Credential revocation", summary: "Observe rejection of a revoked integration token; report the runner phase as skipped.",
  needs: { cloud: "none", controlPlane: true, temporal: false }, mutates: false, createsResources: false, dependsOn: [],
  prerequisites: [configPrerequisite("api-config", "Control plane URL and integration token are configured", (c) => !!c.apiUrl && !!c.apiToken, "set ZENITH_LIVE_API_URL and ZENITH_LIVE_API_TOKEN")],
  steps: [
    { id: "baseline", title: "List operations with the integration credential", effect: "read", plan: () => ["GET /api/platform/v1/operations; require success before revocation"],
      async run(ctx) { const r = await cp(ctx).listOperations({ limit: 1 }); if (!Array.isArray(r?.operations)) throw new Error("Baseline returned no operations list."); C.pass(ctx, "baseline-ok"); } },
    { id: "revoke", title: "Wait for operator revocation, then check rejection stability", effect: "read",
      plan: () => ["ask the operator to revoke this integration credential in the browser", "poll every 2 seconds until HTTP 401/403, then make five further requests; errors such as timeout/500 do not count as revocation"],
      async run(ctx) {
        ctx.log("OPERATOR ACTION: revoke this integration credential in the Zenith browser settings. The harness cannot revoke it. Keep this terminal running.");
        const rejected = async () => {
          try { await cp(ctx).listOperations({ limit: 1 }); return false; }
          catch (err) { if (err instanceof ControlPlaneError && (err.status === 401 || err.status === 403)) return true; throw err; }
        };
        const deadline = ctx.now().getTime() + ctx.config.approvalTimeoutMs;
        let saw = false;
        while (!ctx.signal.aborted && ctx.now().getTime() <= deadline) {
          if (await rejected()) { saw = true; break; }
          await ctx.sleep(2_000);
        }
        C.expect(ctx, "rejected-after-revoke", saw, saw ? "HTTP 401/403 observed." : "No revocation observed before the deadline.");
        if (!saw) throw new Error("Revocation was not observed.");
        let stable = true;
        for (let i = 0; i < 5; i++) { await ctx.sleep(2_000); if (!(await rejected())) stable = false; }
        C.expect(ctx, "stays-rejected", stable, "Five further requests checked; only HTTP 401/403 counts as rejection.");
      } },
    { id: "runner", title: "Report the unavailable runner phase", effect: "none", plan: () => ["SKIP runner/AWS connection revocation: needs zenith-runner (unmerged)"],
      async run(ctx) { C.skip(ctx, "runner-revocation", "needs zenith-runner (unmerged)"); } },
  ], passCriteria: CRITERIA, proves: ["The integration credential is rejected after a human revokes it and stays rejected across five requests."],
  cannotProve: ["Runner or AWS session revocation; that phase is skipped.", "Existing STS sessions expire independently; integration rejection does not prove their invalidation."],
  blockedOn: ["Needs a running WS-CAP API and a disposable integration token with a human able to revoke it.", "Runner phase needs zenith-runner (unmerged)."], runsLocally: false, costNote: "API requests only; no cloud resources.",
};
