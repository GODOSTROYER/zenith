/**
 * `stage` — record the candidate release and ask the runtime to stage it.
 *
 * The release row and the job's knowledge of it commit together, and the fence
 * the candidate is being built to replace is read *here* — at the moment the
 * worker decided "this release supersedes what is live now" — and compared at
 * activation, which may be minutes later.
 */
import { authority } from "@/lib/hosted/authority";
import { HostedError, type Release } from "@/lib/hosted/contracts";
import { releaseDeps } from "../deps";
import { LeaseLost, appendLog, requireApp, type JobRun, type PhaseData } from "../shared";

/** Record the candidate release and ask the runtime to stage it. */
export async function stage(run: JobRun, data: PhaseData): Promise<string> {
  const a = authority();
  const app = await requireApp(run.job.appId);
  const digest = String(data.artifactDigest);

  const known =
    typeof data.releaseId === "string" ? await a.repos.releases.get(data.releaseId) : null;
  // The release row and the job's knowledge of it commit together. Inserting
  // first and recording afterwards would let a crash in between produce a
  // second release on the next attempt — a candidate nobody asked for, holding
  // a number that is now missing from the history.
  const release: Release =
    known ??
    (await a.tx(async (repos) => {
      const inserted = await repos.releases.insert({
        id: crypto.randomUUID(),
        appId: app.id,
        number: await repos.releases.nextNumber(app.id),
        artifactDigest: digest,
        jobId: run.job.id,
        runtime: app.runtime,
        status: "candidate",
      });
      data.releaseId = inserted.id;
      data.releaseNumber = inserted.number;
      // The fence this candidate is being built to replace. Read here, at the
      // moment the worker decided "this release supersedes what is live now",
      // and compared at activation — which may be minutes later. Re-reading it
      // then would make the compare-and-swap compare a value with itself and
      // guard nothing.
      data.observedFence = app.activeFence;
      if (!(await repos.jobs.advance(run.job.id, run.fence, "stage", data)))
        throw new LeaseLost(run.job.id);
      return inserted;
    }));
  data.releaseId = release.id;
  data.releaseNumber = release.number;

  const artifact = await releaseDeps.artifactStore().get(digest);
  if (!artifact)
    throw new HostedError("internal", `Artifact ${digest} is indexed but not in the store.`, {
      fix: "Publish again; the artifact store and the control database disagree about this digest.",
    });

  const candidate = await releaseDeps.runtime().stageCandidate(app, release, artifact);
  data.candidateRef = candidate as unknown as Record<string, unknown>;
  // The runtime's own identifiers for the staged candidate, durable on the row:
  // activation and rollback read them minutes later, long after this job's
  // phase data stopped being the thing anyone consults.
  await a.tx((repos) => repos.releases.setRuntimeRef(release.id, candidate.ref ?? {}));
  appendLog(data, `release ${release.number} staged as a candidate on ${app.runtime}`);
  return release.id;
}
