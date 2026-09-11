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
  const app = requireApp(run.job.appId);
  const digest = String(data.artifactDigest);

  const known = typeof data.releaseId === "string" ? a.repos.releases.get(data.releaseId) : null;
  // The release row and the job's knowledge of it commit together. Inserting
  // first and recording afterwards would let a crash in between produce a
  // second release on the next attempt — a candidate nobody asked for, holding
  // a number that is now missing from the history.
  const release: Release =
    known ??
    a.tx(() => {
      const inserted = a.repos.releases.insert({
        id: crypto.randomUUID(),
        appId: app.id,
        number: a.repos.releases.nextNumber(app.id),
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
      if (!a.repos.jobs.advance(run.job.id, run.fence, "stage", data)) throw new LeaseLost(run.job.id);
      return inserted;
    });
  data.releaseId = release.id;
  data.releaseNumber = release.number;

  const artifact = await releaseDeps.artifactStore().get(digest);
  if (!artifact)
    throw new HostedError("internal", `Artifact ${digest} is indexed but not in the store.`, {
      fix: "Publish again; the artifact store and the control database disagree about this digest.",
    });

  const candidate = await releaseDeps.runtime().stageCandidate(app, release, artifact);
  data.candidateRef = candidate as unknown as Record<string, unknown>;
  // TODO(ceiling): `ReleasesRepo` has no runtime-ref setter, so the staged
  // identifiers are written here. Move to `releases.setRuntimeRef` when W1
  // adds one.
  a.tx((db) => {
    db.prepare("UPDATE releases SET runtime_ref = ? WHERE id = ?").run(
      JSON.stringify(candidate.ref ?? {}),
      release.id
    );
  });
  appendLog(data, `release ${release.number} staged as a candidate on ${app.runtime}`);
  return release.id;
}
