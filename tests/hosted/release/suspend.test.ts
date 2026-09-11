/**
 * Suspension takes the app away and nothing else.
 *
 * The assertion that carries the weight is the list of things that are still
 * there afterwards: the active release, the releases behind it, the owner
 * grant, the artifact. Suspension is a state on one row, so resuming is one
 * word rather than a recovery — and this test would fail loudly if it ever
 * started deleting on the way out.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { harness, makeApp, publishOnce, wire, type Harness } from "./_helpers";

const DATA = isolatedDataDir("zenith-w7-suspend-");

let h: Harness;
let undo: (() => void) | undefined;
let appId: string;
let releaseId: string;
let artifactDigest: string;

beforeAll(async () => {
  h = await harness(DATA);
  const wired = await wire(h);
  const app = await makeApp(h, {
    workspaceId: WORKSPACES.one.id,
    slug: "suspendable",
    name: "Suspendable",
    subject: IDENTITIES.owner.subject,
  });
  appId = app.id;
  const job = await publishOnce(h, { app, actor: IDENTITIES.owner.subject });
  releaseId = String(job.phaseData.releaseId);
  artifactDigest = String(job.phaseData.artifactDigest);
  wired.restore();
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

describe("suspend and resume", () => {
  it("moves the state, records the reason and the event, and keeps everything else", async () => {
    undo = (await wire(h)).restore;
    const before = (await h.authority.authority().repos.apps.get(appId))!;

    const suspendJob = uuid();
    await h.release.admitSuspend({
      jobId: suspendJob,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
      reason: "A recipient reported a data problem; paused while we look.",
    });
    const suspended = await h.release.runJobOnce(suspendJob);
    expect(suspended.status).toBe("succeeded");
    expect(suspended.phaseData.phases).toEqual(["suspend", "finish"]);

    const app = (await h.authority.authority().repos.apps.get(appId))!;
    expect(app.state).toBe("suspended");
    expect(app.stateReason).toContain("data problem");

    // Everything the app is made of is still there.
    expect(app.activeReleaseId).toBe(before.activeReleaseId);
    expect(app.activeFence).toBe(before.activeFence);
    expect((await h.authority.authority().repos.releases.get(releaseId))?.status).toBe("active");
    expect(await h.authority.authority().repos.grants.listByApp(appId)).toHaveLength(1);
    expect(await h.store.get(artifactDigest)).not.toBeNull();

    const resumeJob = uuid();
    await h.release.admitResume({
      jobId: resumeJob,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
    });
    const resumed = await h.release.runJobOnce(resumeJob);
    expect(resumed.status).toBe("succeeded");

    const back = (await h.authority.authority().repos.apps.get(appId))!;
    expect(back.state).toBe("active");
    expect(back.stateReason).toBeUndefined();
    expect(back.activeReleaseId).toBe(before.activeReleaseId);

    const events = (
      await h.authority.authority().repos.events.listSince({ appId }, { limit: 200 })
    ).map((event) => event.event);
    expect(events).toContain("app.suspended");
    expect(events).toContain("app.resumed");
  });

  it("records the default reason when an operator gives none", async () => {
    undo = (await wire(h)).restore;
    const jobId = uuid();
    await h.release.admitSuspend({ jobId, appId, workspaceId: WORKSPACES.one.id, actor: IDENTITIES.owner.subject });
    await h.release.runJobOnce(jobId);
    expect((await h.authority.authority().repos.apps.get(appId))?.stateReason).toBe(h.release.SUSPEND_DEFAULT_REASON);
  });

  it("refuses to suspend twice or resume an app that is already active", async () => {
    undo = (await wire(h)).restore;
    await expect(h.release.admitSuspend({
        jobId: uuid(),
        appId,
        workspaceId: WORKSPACES.one.id,
        actor: IDENTITIES.owner.subject,
      })).rejects.toThrowError(/already suspended/);

    const resumeJob = uuid();
    await h.release.admitResume({ jobId: resumeJob, appId, workspaceId: WORKSPACES.one.id, actor: IDENTITIES.owner.subject });
    await h.release.runJobOnce(resumeJob);

    await expect(h.release.admitResume({
        jobId: uuid(),
        appId,
        workspaceId: WORKSPACES.one.id,
        actor: IDENTITIES.owner.subject,
      })).rejects.toThrowError(/already active/);
  });

  it("refuses a rollback while the app is suspended", async () => {
    undo = (await wire(h)).restore;
    const suspendJob = uuid();
    await h.release.admitSuspend({ jobId: suspendJob, appId, workspaceId: WORKSPACES.one.id, actor: IDENTITIES.owner.subject });
    await h.release.runJobOnce(suspendJob);

    await expect(h.release.admitRollback({
        jobId: uuid(),
        appId,
        workspaceId: WORKSPACES.one.id,
        actor: IDENTITIES.owner.subject,
        releaseId,
      })).rejects.toThrowError(/suspended/);

    const resumeJob = uuid();
    await h.release.admitResume({ jobId: resumeJob, appId, workspaceId: WORKSPACES.one.id, actor: IDENTITIES.owner.subject });
    await h.release.runJobOnce(resumeJob);
  });
});
