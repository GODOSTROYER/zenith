/**
 * The two ways a candidate is refused the pointer, and the one thing that must
 * be true after both: the app is still serving what it was serving.
 *
 *  - **A candidate that fails its probe never activates.** The release is
 *    marked failed, the job is marked failed, and `activeReleaseId` and
 *    `activeFence` are exactly what they were.
 *  - **A worker whose fence moved never activates.** The fence is bumped in
 *    SQL between this job's probe and its activation — the shape of a
 *    concurrent publish or an operator rollback landing first — and the
 *    compare-and-swap refuses rather than overwriting the newer choice.
 *
 * The first publish in each case is a real, successful one, so what is being
 * protected is a healthy release rather than an empty pointer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { buildRunnerDouble } from "./_doubles";
import { harness, makeApp, publishOnce, wire, type Harness } from "./_helpers";

const DATA = isolatedDataDir("zenith-w7-activation-");

let h: Harness;
let undo: (() => void) | undefined;

beforeAll(async () => {
  h = await harness(DATA);
});

afterEach(async () => {
  undo?.();
  undo = undefined;
  await h.release.resetReleaseDeps();
});

afterAll(async () => {
  await h.release.stopHostedJobRunner();
  await h.data.closeAllAppData();
  h.authority.closeAuthority();
  removeDir(DATA);
});

/** An app with one healthy release already serving. */
async function appWithRelease(slug: string) {
  const wired = await wire(h);
  const app = await makeApp(h, {
    workspaceId: WORKSPACES.one.id,
    slug,
    name: slug,
    subject: IDENTITIES.owner.subject,
  });
  const job = await publishOnce(h, { app, actor: IDENTITIES.owner.subject });
  expect(job.status).toBe("succeeded");
  wired.restore();
  const serving = (await h.authority.authority().repos.apps.get(app.id))!;
  expect(serving.activeReleaseId).toBeTruthy();
  expect(serving.activeFence).toBe(1);
  return serving;
}

describe("a candidate that fails its probe", () => {
  it("is marked failed and leaves the healthy release serving", async () => {
    const app = await appWithRelease("probefail");
    const before = (await h.authority.authority().repos.apps.get(app.id))!;

    // A different build output, so this really is a new candidate rather than
    // the artifact that is already live.
    const wired = await wire(h, {
      build: await buildRunnerDouble({ html: "<!doctype html><title>Broken</title>" }),
      probe: () => ({
        ok: false,
        checkedAt: new Date().toISOString(),
        checks: [
          { id: "index_fetch", ok: true, detail: "index.html was served." },
          { id: "data_round_trip", ok: false, detail: "the test database refused the write: no such table: requests" },
        ],
        testDatabase: "test.sqlite (disposable)",
      }),
    });
    undo = wired.restore;

    const jobId = uuid();
    await h.release.admitPublish({
      jobId,
      appId: app.id,
      workspaceId: app.workspaceId,
      actor: IDENTITIES.owner.subject,
      source: { kind: "fixture", name: "minimal-app" },
    });
    const job = await h.release.runJobOnce(jobId);

    expect(job.status).toBe("failed");
    expect(job.phase).toBe("probe");
    expect(job.error).toContain("data_round_trip");
    expect(job.error).toContain("no such table");

    const candidate = (await h.authority.authority().repos.releases.get(String(job.phaseData.releaseId)))!;
    expect(candidate.status).toBe("failed");
    expect(candidate.probe?.ok).toBe(false);
    expect(candidate.activatedAt).toBeUndefined();

    // The pointer never moved, and the runtime was never asked to activate.
    const after = (await h.authority.authority().repos.apps.get(app.id))!;
    expect(after.activeReleaseId).toBe(before.activeReleaseId);
    expect(after.activeFence).toBe(before.activeFence);
    expect(wired.runtime.recorder.activated).toEqual([]);
    expect((await h.authority.authority().repos.releases.get(before.activeReleaseId!))?.status).toBe("active");
  });
});

describe("a worker whose fence moved while it was probing", () => {
  it("is refused the pointer, and the release it was activating is marked failed", async () => {
    const app = await appWithRelease("stalefence");
    const before = (await h.authority.authority().repos.apps.get(app.id))!;

    const wired = await wire(h, {
      build: await buildRunnerDouble({ html: "<!doctype html><title>Racer</title>" }),
      beforeProbe: () => {
        // Something else activated while this job was in its probe: the fence
        // this worker read is no longer the app's.
        h.authority
          .sqliteConnection(h.authority.authority())
          .prepare("UPDATE apps SET active_fence = active_fence + 1 WHERE id = ?")
          .run(app.id);
      },
    });
    undo = wired.restore;

    const jobId = uuid();
    await h.release.admitPublish({
      jobId,
      appId: app.id,
      workspaceId: app.workspaceId,
      actor: IDENTITIES.owner.subject,
      source: { kind: "fixture", name: "minimal-app" },
    });
    const job = await h.release.runJobOnce(jobId);

    expect(job.status).toBe("failed");
    expect(job.phase).toBe("activate");
    expect(job.error).toContain("Another activation moved");
    expect(job.phaseData.activated).toBeUndefined();

    const candidate = (await h.authority.authority().repos.releases.get(String(job.phaseData.releaseId)))!;
    // It passed its probe — it was a healthy candidate that simply lost a race.
    expect(candidate.probe?.ok).toBe(true);
    expect(candidate.status).toBe("failed");

    const after = (await h.authority.authority().repos.apps.get(app.id))!;
    expect(after.activeReleaseId).toBe(before.activeReleaseId);
    expect(after.activeFence).toBe(before.activeFence + 1); // only the injected bump
    expect(wired.runtime.recorder.activated).toEqual([]);
  });
});

describe("a build that did not run", () => {
  it("fails the job with the runner's own reason and never stages anything", async () => {
    const app = await appWithRelease("nobuild");
    const before = (await h.authority.authority().repos.apps.get(app.id))!;

    const wired = await wire(h, { build: await buildRunnerDouble({ fail: "esbuild: src/main.tsx:3:9: ERROR: Expected \")\"" }) });
    undo = wired.restore;

    const jobId = uuid();
    await h.release.admitPublish({
      jobId,
      appId: app.id,
      workspaceId: app.workspaceId,
      actor: IDENTITIES.owner.subject,
      source: { kind: "fixture", name: "minimal-app" },
    });
    const job = await h.release.runJobOnce(jobId);

    expect(job.status).toBe("failed");
    expect(job.phase).toBe("build");
    expect(job.error).toContain("src/main.tsx");
    expect((await h.release.jobLogs(jobId)).join("\n")).toContain("ERROR");
    expect(wired.runtime.recorder.staged).toEqual([]);

    const after = (await h.authority.authority().repos.apps.get(app.id))!;
    expect(after.activeReleaseId).toBe(before.activeReleaseId);
    expect(after.activeFence).toBe(before.activeFence);
    // A build that produced nothing produced no release either.
    expect(await h.authority.authority().repos.releases.listByApp(app.id)).toHaveLength(1);
  });

  it("refuses when this install has no build runner at all", async () => {
    const app = await appWithRelease("norunner");
    undo = await h.release.setReleaseDepsForTests({ buildRunner: () => null });

    const jobId = uuid();
    await h.release.admitPublish({
      jobId,
      appId: app.id,
      workspaceId: app.workspaceId,
      actor: IDENTITIES.owner.subject,
      source: { kind: "fixture", name: "minimal-app" },
    });
    const job = await h.release.runJobOnce(jobId);

    expect(job.status).toBe("failed");
    expect(job.error).toContain("No build runner is configured");
    expect(job.error).toContain("ZENITH_BUILD_RUNNER");
  });
});
