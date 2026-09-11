/**
 * `intake` — validate the submitted source and write it into the job's work
 * directory.
 *
 * The first phase of the publish pipeline (see `../publish.ts`). Nothing here
 * executes anything a builder submitted: the source is read, bounded, hashed
 * and materialized, and that is all.
 */
import fs from "node:fs";
import { HostedError, type HostedJob, type ValidatedSource } from "@/lib/hosted/contracts";
import { materializeSource, removeMaterialized, validateSource } from "@/lib/hosted/source";
import { fixtureDirectory } from "../intent";
import {
  appendLog,
  emit,
  jobSourcePath,
  jobWorkPath,
  type JobRun,
  type PhaseData,
} from "../shared";

/** Validate the submitted source and write it into the job's work directory. */
export async function intake(run: JobRun, data: PhaseData): Promise<void> {
  const source = readSource(run.job, data);
  let validated: ValidatedSource;
  try {
    validated = validateSource(source);
  } catch (err) {
    emit({
      event: "source.rejected",
      workspaceId: run.job.workspaceId,
      appId: run.job.appId,
      subject: run.job.actor,
      outcome: "denied",
      logicalId: run.job.id,
    });
    const reasons = err instanceof HostedError ? (err.details?.reasons as string[] | undefined) : undefined;
    for (const reason of reasons ?? []) appendLog(data, `source rejected: ${reason}`);
    throw err;
  }

  const work = jobWorkPath(run.job.id);
  removeMaterialized(work);
  materializeSource(validated, work);

  data.sourceDigest = validated.digest;
  data.sourceKind = validated.kind;
  data.sourceFiles = validated.files.length;
  data.sourceBytes = validated.totalBytes;
  data.materializedDir = work;
  data.appName = validated.manifest.name;
  appendLog(
    data,
    `intake accepted ${validated.files.length} files (${validated.totalBytes} bytes), source ${validated.digest.slice(0, 12)}`
  );
  await Promise.resolve();
}

/* --------------------------------- sources -------------------------------- */

/** Where this job's source comes from, whichever way it was submitted. */
function readSource(job: HostedJob, data: PhaseData): Parameters<typeof validateSource>[0] {
  const source = data.source as { kind?: string; name?: string } | undefined;
  if (source?.kind === "fixture" && typeof source.name === "string")
    return { kind: "directory", path: fixtureDirectory(source.name) };

  const stored = typeof data.sourcePath === "string" ? data.sourcePath : jobSourcePath(job.id);
  if (!fs.existsSync(stored))
    throw new HostedError("unsupported_source", "The submitted source is no longer on disk, so it cannot be built.", {
      fix: "Publish again with the source attached; a queued job's package is kept under ORRERY_DATA/jobs and this one is gone.",
      details: { jobId: job.id },
    });
  return { kind: "tarball", bytes: fs.readFileSync(stored) };
}
