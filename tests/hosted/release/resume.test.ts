/**
 * A publish interrupted mid-phase resumes where it stopped, and does not
 * rebuild what it already built.
 *
 * The crash is real rather than described: the runtime double closes the
 * control database in the middle of the `stage` phase, so every subsequent
 * write fails exactly as it would if the process had been killed. What is left
 * on disk afterwards is the job as a dead worker leaves it — `running`, phase
 * `stage`, lease held, `phaseData` carrying the artifact the earlier phases
 * produced.
 *
 * A second process then does what a second process does: reopen the authority,
 * reclaim the expired lease, claim the job, and carry on. The assertion that
 * matters is the negative one — the build runner is not asked a second time,
 * and the release the first attempt inserted is reused rather than duplicated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { buildRunnerDouble } from "./_doubles";
import { harness, makeApp, wire, type Harness } from "./_helpers";

const DATA = isolatedDataDir("zenith-w7-resume-");

let h: Harness;
let appId: string;

beforeAll(async () => {
  h = await harness(DATA);
  const undo = wire(h).restore;
  const app = await makeApp(h, {
    workspaceId: WORKSPACES.one.id,
    slug: "resumable",
    name: "Resumable",
    subject: IDENTITIES.owner.subject,
  });
  appId = app.id;
  undo();
});

afterAll(() => {
  h.release.resetReleaseDeps();
  h.release.stopHostedJobRunner();
  h.data.closeAllAppData();
  h.authority.closeAuthority();
  removeDir(DATA);
});

describe("a publish whose worker dies at stage", () => {
  it("resumes from stage in a new process without rebuilding", async () => {
    const build = buildRunnerDouble({ html: "<!doctype html><title>Resumable</title>" });
    let crashed = false;
    const first = wire(h, {
      build,
      beforeStage: () => {
        // The worker dies here: the phase and its data are already committed,
        // the candidate has not been staged, and nothing after this can write.
        if (crashed) return;
        crashed = true;
        h.authority.closeAuthority();
      },
    });

    const jobId = uuid();
    await h.release.admitPublish({
      jobId,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
      source: { kind: "fixture", name: "minimal-app" },
    });
    await expect(h.release.runJobOnce(jobId)).rejects.toThrow();
    first.restore();
    expect(build.recorder.calls).toBe(1);

    // A new process opens the same file and finds the job exactly as the dead
    // worker left it.
    h.authority.openAuthority();
    const stranded = h.authority.authority().repos.jobs.get(jobId)!;
    expect(stranded.status).toBe("running");
    expect(stranded.phase).toBe("stage");
    expect(stranded.phaseData.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(stranded.phaseData.artifactVerified).toBe(true);
    expect(stranded.phaseData.releaseId).toBeTruthy();
    const strandedRelease = String(stranded.phaseData.releaseId);
    expect(h.authority.authority().repos.releases.get(strandedRelease)?.status).toBe("candidate");

    // Nothing moves until the lease expires — that is what stops two workers
    // running one job — so the reclaim is asked about a time after it does.
    expect(h.release.reclaimExpiredJobs(new Date(Date.now() - 60_000).toISOString())).toBe(0);
    const future = new Date(Date.now() + 120_000).toISOString();
    expect(h.release.reclaimExpiredJobs(future)).toBe(1);
    expect(h.authority.authority().repos.jobs.get(jobId)?.status).toBe("queued");

    const second = wire(h, { build });
    const finished = await h.release.runJobOnce(jobId);
    second.restore();

    expect(finished.status).toBe("succeeded");
    expect(finished.phase).toBe("finish");
    // The whole point: the second attempt starts at stage, so nothing is built
    // again and the candidate release the first attempt created is the one
    // that activates. The phase trail spans both attempts and every phase
    // appears exactly once — a re-entered `build` would show up here.
    expect(build.recorder.calls).toBe(1);
    expect(finished.phaseData.phases).toEqual([...h.release.PUBLISH_PHASES, "finish"]);
    expect(finished.phaseData.releaseId).toBe(strandedRelease);
    expect(finished.phaseData.artifactDigest).toBe(stranded.phaseData.artifactDigest);
    expect(finished.attempts).toBe(2);

    const releases = h.authority.authority().repos.releases.listByApp(appId);
    expect(releases).toHaveLength(1);
    expect(releases[0].id).toBe(strandedRelease);
    expect(releases[0].status).toBe("active");
    expect(h.authority.authority().repos.apps.get(appId)?.activeReleaseId).toBe(strandedRelease);
    expect(h.authority.authority().repos.apps.get(appId)?.activeFence).toBe(1);
  });
});
