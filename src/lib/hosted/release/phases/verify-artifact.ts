/**
 * `verify_artifact` — recompute the stored bytes and check the provenance
 * before a release may name them.
 *
 * This is the re-verification the publish property depends on: a healthy app
 * is only replaced by a candidate whose bytes have been read back and hashed
 * again, from the store, by the publisher.
 */
import { authority } from "@/lib/hosted/authority";
import { verifyForRelease } from "@/lib/hosted/artifacts";
import { HostedError, RECIPE_V1 } from "@/lib/hosted/contracts";
import { releaseDeps } from "../deps";
import { appendLog, type JobRun, type PhaseData } from "../shared";

/** Recompute the stored bytes and check the provenance before a release may name them. */
export async function verifyArtifact(run: JobRun, data: PhaseData): Promise<void> {
  if (data.artifactVerified === true) return;
  const digest = String(data.artifactDigest);
  const reused = data.artifactReused === true;
  // A fresh artifact is checked against what *this* job did: these bytes were
  // built now, from this source, by this job, and any disagreement is a
  // publisher failure. An artifact this job joined rather than created is
  // checked against its own immutable record instead — demanding that it name
  // this job would refuse every legitimate re-publish — and the recipe is
  // pinned to today's either way, which is the cross-check that matters.
  const verdict = await verifyForRelease(releaseDeps.artifactStore(), digest, {
    sourceDigest: reused ? String(data.artifactSourceDigest) : String(data.sourceDigest),
    jobId: reused ? String(data.artifactJobId) : run.job.id,
    recipe: RECIPE_V1,
  });
  if (!verdict.ok)
    throw new HostedError("internal", `The artifact did not pass publisher verification: ${verdict.detail}`, {
      fix: "Publish again. Nothing was activated, and the app is still serving its previous release.",
    });
  await authority().repos.artifacts.markVerified(digest);
  data.artifactVerified = true;
  appendLog(
    data,
    reused
      ? `artifact ${digest.slice(0, 12)} was already stored by job ${String(data.artifactJobId)} and re-verified here: ${verdict.detail}`
      : `artifact verified: ${verdict.detail}`
  );
}
