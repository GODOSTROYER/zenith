/**
 * `probe` — health and data round trip against the disposable test database.
 *
 * A candidate that does not pass here is never activated, and the message on
 * the release is the probe's own words.
 */
import { authority } from "@/lib/hosted/authority";
import {
  HostedError,
  type CandidateProbeResult,
  type RuntimeCandidateRef,
} from "@/lib/hosted/contracts";
import { releaseDeps } from "../deps";
import { appendLog, emit, requireApp, type JobRun, type PhaseData } from "../shared";

/** Health and data round trip against the disposable test database. */
export async function probe(run: JobRun, data: PhaseData): Promise<void> {
  if (data.probeOk === true) return;
  const a = authority();
  const app = await requireApp(run.job.appId);
  const releaseId = String(data.releaseId);
  const candidate = data.candidateRef as unknown as RuntimeCandidateRef;

  const result: CandidateProbeResult = await releaseDeps.runtime().probeCandidate(app, candidate);
  await a.repos.releases.setProbe(releaseId, result);
  for (const check of result.checks) appendLog(data, `probe ${check.id}: ${check.ok ? "ok" : "failed"} — ${check.detail}`);

  if (!result.ok) {
    const failed = result.checks.filter((check) => !check.ok).map((check) => `${check.id} (${check.detail})`);
    await emit({
      event: "release.verified",
      workspaceId: run.job.workspaceId,
      appId: app.id,
      releaseId,
      subject: run.job.actor,
      outcome: "error",
      logicalId: run.job.id,
    });
    // The candidate is marked failed here rather than by the catch below, so
    // the message on the release is the probe's own words.
    throw new HostedError(
      "conflict",
      `The candidate release did not pass its health probe, so it was not activated: ${failed.join("; ") || "no check reported a reason"}.`,
      {
        fix: `${app.name} is still serving its previous release. Fix the app, then publish again.`,
        details: { releaseId, checks: result.checks },
      }
    );
  }

  await a.repos.releases.setStatus(releaseId, "verified", { verifiedAt: result.checkedAt });
  data.probeOk = true;
  await emit({
    event: "release.verified",
    workspaceId: run.job.workspaceId,
    appId: app.id,
    releaseId,
    subject: run.job.actor,
    outcome: "ok",
    logicalId: run.job.id,
    props: { checks: result.checks.length },
  });
}
