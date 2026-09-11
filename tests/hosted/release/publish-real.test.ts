/**
 * The whole publish path with a real build: `fixtures/hosted/minimal-app`
 * through the pinned Vite recipe, into a content-addressed artifact, out as a
 * verified, probed, activated release.
 *
 * Nothing here is simulated except the runtime's bookkeeping, and even its
 * probe is real: it reads the artifact out of the store and passes only if
 * `index.html` is actually there. The build is `recipe-local`, which spawns a
 * node child process and takes a couple of seconds — which is why it is the
 * only file in this suite that uses it.
 *
 * The second publish is the interesting one. Identical source produces
 * identical bytes, so it lands on the artifact the first job stored: the
 * release history grows, the pointer moves, and the platform does not rebuild
 * or re-store what it already has.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { harness, makeApp, wire, type Harness } from "./_helpers";

const DATA = isolatedDataDir("zenith-w7-real-");
process.env.ZENITH_BUILD_RUNNER = "recipe-local";

let h: Harness;
let undo: () => void;
let appId: string;
const firstJob = uuid();
const secondJob = uuid();

beforeAll(async () => {
  h = await harness(DATA);
  undo = (await wire(h, { useRealBuildRunner: true })).restore;
  const app = await makeApp(h, {
    workspaceId: WORKSPACES.one.id,
    slug: "realpublish",
    name: "Real publish",
    subject: IDENTITIES.owner.subject,
    email: IDENTITIES.owner.email,
  });
  appId = app.id;
});

afterAll(async () => {
  undo();
  await h.release.resetReleaseDeps();
  await h.release.stopHostedJobRunner();
  await h.data.closeAllAppData();
  h.authority.closeAuthority();
  delete process.env.ZENITH_BUILD_RUNNER;
  removeDir(DATA);
});

const jobDir = (jobId: string): string => path.join(DATA, "jobs", jobId);

describe("a real publish of fixtures/hosted/minimal-app", () => {
  it("runs every phase in order and leaves the app serving release 1", async () => {
    const admitted = await h.release.admitPublish({
      jobId: firstJob,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
      source: { kind: "fixture", name: "minimal-app" },
    });
    expect(admitted.created).toBe(true);
    expect(admitted.job.status).toBe("queued");

    const job = await h.release.runJobOnce(firstJob);
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("succeeded");
    expect(job.phase).toBe("finish");
    expect(job.phaseData.phases).toEqual([...h.release.PUBLISH_PHASES, "finish"]);

    // The artifact is real, stored under the digest of its own bytes, and the
    // publisher check has recomputed those bytes since.
    const digest = String(job.phaseData.artifactDigest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const indexed = await h.authority.authority().repos.artifacts.get(digest);
    expect(indexed?.verifiedAt).toBeTruthy();
    expect(indexed?.provenance.jobId).toBe(firstJob);
    expect(indexed?.provenance.recipe.id).toBe("vite-react-v1");
    const files = await h.store.list(digest);
    expect(files.some((f) => f.path === "index.html")).toBe(true);
    expect(files.some((f) => f.path.startsWith("assets/") && f.path.endsWith(".js"))).toBe(true);

    // The release is active and the app points at it under fence 1.
    const app = (await h.authority.authority().repos.apps.get(appId))!;
    const release = (await h.authority.authority().repos.releases.get(String(job.phaseData.releaseId)))!;
    expect(release.number).toBe(1);
    expect(release.status).toBe("active");
    expect(release.probe?.ok).toBe(true);
    expect(release.verifiedAt).toBeTruthy();
    expect(release.activatedAt).toBeTruthy();
    expect(app.activeReleaseId).toBe(release.id);
    expect(app.activeFence).toBe(1);

    // Scratch space is gone: the submitted source and its expansion existed to
    // be built, and the content-addressed store is the copy that is kept.
    expect(fs.existsSync(jobDir(firstJob))).toBe(false);
  }, 120_000);

  it("recorded the events the pipeline claims to record", async () => {
    const events = (
      await h.authority.authority().repos.events.listSince({ appId }, { limit: 100 })
    ).map((event) => event.event);
    expect(events).toContain("app.created");
    expect(events).toContain("source.accepted");
    expect(events).toContain("build.started");
    expect(events).toContain("build.succeeded");
    expect(events).toContain("release.verified");
    expect(events).toContain("release.activated");
  });

  it("publishes a second release, supersedes the first, and reuses the identical artifact", async () => {
    await h.release.admitPublish({
      jobId: secondJob,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
      source: { kind: "fixture", name: "minimal-app" },
    });
    const job = await h.release.runJobOnce(secondJob);
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("succeeded");

    const app = (await h.authority.authority().repos.apps.get(appId))!;
    const releases = await h.authority.authority().repos.releases.listByApp(appId);
    expect(releases.map((r) => r.number)).toEqual([2, 1]);

    const [second, first] = releases;
    expect(second.status).toBe("active");
    expect(first.status).toBe("superseded");
    expect(first.supersededAt).toBeTruthy();
    expect(app.activeReleaseId).toBe(second.id);
    expect(app.activeFence).toBe(2);

    // The same source builds to the same bytes, so this is the same artifact —
    // stored once, attributed to the job that first produced it, and verified
    // again here rather than trusted.
    expect(second.artifactDigest).toBe(first.artifactDigest);
    expect(job.phaseData.artifactReused).toBe(true);
    expect(job.phaseData.artifactJobId).toBe(firstJob);
    expect((await h.release.jobLogs(secondJob)).some((line) => line.includes("re-verified"))).toBe(true);
  }, 120_000);

  it("refuses a second job id for the same source with a different actor", async () => {
    await expect(
      h.release.admitPublish({
        jobId: secondJob,
        appId,
        workspaceId: WORKSPACES.one.id,
        actor: IDENTITIES.editor.subject,
        source: { kind: "fixture", name: "minimal-app" },
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
