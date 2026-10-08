import { redactAcceptance } from "../redact";
import type { Journal } from "./contracts";
import { digest } from "./plan";

/** Ledger-shaped entries are emitted only for complete product checks from real
 * execution. Fixtures and pending/unperformed requirements stay separate. */
export function evidencePacket(journal: Journal, finishedAt = new Date()) {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const c of journal.checks) counts[c.status]++;
  const requirements = journal.plan.requirements.map(r => {
    const check = journal.checks.find(c => c.scope === "product_requirement" && c.id === r.id);
    const complete = journal.provenance === "live_sandbox" && journal.closed && check?.status === "passed" && !counts.failed;
    return { id: r.id, requiredLevel: "live_sandbox", status: complete ? "passed" : check?.status === "failed" ? "failed" : "pending", reason: check?.reason ?? "Product scenario unperformed", evidence: complete ? [{ level: "live_sandbox", commit: journal.commit, result: check!.reason, artifact: `${journal.plan.settings.runId}/evidence.json`, planSha256: journal.plan.sha256 }] : [] };
  });
  const packet = {
    schema: 1, provenance: journal.provenance, runId: journal.plan.settings.runId, commit: journal.commit,
    accountId: journal.plan.settings.accountId, region: journal.plan.settings.region,
    startedAt: journal.startedAt, finishedAt: finishedAt.toISOString(), planSha256: journal.plan.sha256,
    permissionSha256: journal.permissionSha256, estimatedUsd: journal.plan.estimate.usd,
    costProvisional: true, billingMeasured: false, cleanupComplete: journal.closed,
    counts, verdict: counts.failed || !journal.closed ? "failed" : requirements.some(r => r.status !== "passed") ? "incomplete" : "passed",
    checks: journal.checks, requirements,
    releaseStatus: { implementationComplete: false, sandboxVerified: false, pilotReady: false, productionApproved: false },
  };
  const safe = redactAcceptance(packet);
  return { ...safe, sha256: digest(safe) };
}
