import { requireScope, ScopeError } from "../../release/scope";
import type { EnvLike } from "../config";
import type { Plan } from "./contracts";

/** Root approval and the exact awsLive envelope are both required. Keep the
 * strict root manifest in its own FILE; adding fields must not change its digest. */
export function requireProductionScope(plan: Plan, budgetUsd: number, env: EnvLike, cleanupOnly = false, now?: () => Date): void {
  const scope = requireScope("aws-live", "aws", env, now);
  scope.assertGrant("aws-live", "aws", "teardown_run_tagged");
  if (cleanupOnly) {
    scope.authorize({ harness: "aws-live", provider: "aws", action: "teardown_run_tagged", runId: plan.settings.runId, tags: plan.tags });
    return;
  }
  scope.assertGrant("aws-live", "aws", "mutate_run_tagged");
  const cap = Math.min(scope.manifest.budgets.perRunUsd, scope.manifest.budgets.perProviderPerRunUsd.aws ?? 0,
    scope.manifest.budgets.totalUsd, scope.manifest.harnesses["aws-live"].maxRunUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > cap) {
    throw new ScopeError("budget_exceeded", "The explicit AWS budget exceeds the approved root scope ceiling.");
  }
  scope.authorize({ harness: "aws-live", provider: "aws", action: "create_disposable", estimatedUsd: plan.estimate.usd,
    runId: plan.settings.runId, resourceName: `zenith-${plan.settings.runId}-fixtures`, ttlMinutes: plan.settings.durationMinutes });
}
