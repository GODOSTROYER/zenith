/**
 * `artifact` — store the output tree under the SHA-256 of its own bytes and
 * index it.
 *
 * Content addressing means an identical build is the *same* artifact, whoever
 * produced it, so this phase records whether the job created the bytes or
 * joined bytes an earlier job stored; `verify_artifact` checks accordingly.
 *
 * Workstream W7 (hosted R3).
 */
import fs from "node:fs";
import { authority, nowIso } from "@/lib/hosted/authority";
import {
  HostedError,
  RECIPE_V1,
  type ArtifactProvenance,
  type BuildRunnerId,
} from "@/lib/hosted/contracts";
import { removeMaterialized } from "@/lib/hosted/source";
import { releaseDeps } from "../deps";
import { appendLog, type JobRun, type PhaseData } from "../shared";

/** Store the output tree under the SHA-256 of its own bytes and index it. */
export async function storeArtifact(run: JobRun, data: PhaseData): Promise<void> {
  if (typeof data.artifactDigest === "string") return;

  const outputDir = typeof data.outputDir === "string" ? data.outputDir : undefined;
  if (!outputDir || !fs.existsSync(outputDir))
    throw new HostedError("internal", "The build output directory is gone, so no artifact could be stored.", {
      fix: "Publish again — the scratch directory a previous attempt built into no longer exists.",
    });

  const provenance: ArtifactProvenance = {
    sourceDigest: String(data.sourceDigest),
    sourceKind: data.sourceKind === "directory" ? "directory" : "tarball",
    jobId: run.job.id,
    recipe: RECIPE_V1,
    contractVersion: 1,
    schemaVersion: 1,
    builtBy: (data.buildRunner as BuildRunnerId | undefined) ?? "recipe-local",
    buildBoundary: String(data.buildBoundary ?? "unrecorded"),
    builtAt: nowIso(),
  };

  const artifact = await releaseDeps.artifactStore().put(outputDir, provenance);
  // The output tree only had to survive long enough to be copied into the
  // content-addressed store; keeping it would be a second, unversioned copy.
  removeMaterialized(outputDir);
  delete data.outputDir;

  // Content addressing means an identical build is the *same* artifact, whoever
  // produced it: re-publishing after a rollback, or two apps built from one
  // template, land on bytes an earlier job stored. The store keeps that job's
  // provenance, so this job records whether it created the artifact or joined
  // one — and `verify_artifact` checks accordingly.
  data.artifactJobId = artifact.provenance.jobId;
  data.artifactSourceDigest = artifact.provenance.sourceDigest;
  data.artifactReused = artifact.provenance.jobId !== run.job.id;

  authority().repos.artifacts.insert({
    digest: artifact.digest,
    byteSize: artifact.byteSize,
    fileCount: artifact.fileCount,
    provenance: artifact.provenance,
  });

  data.artifactDigest = artifact.digest;
  data.artifactBytes = artifact.byteSize;
  data.artifactFiles = artifact.fileCount;
  appendLog(
    data,
    `artifact ${artifact.digest.slice(0, 12)} stored (${artifact.fileCount} files, ${artifact.byteSize} bytes)`
  );
}
