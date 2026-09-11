/**
 * Rollback replaces code and leaves data exactly where it is.
 *
 * The test writes real equipment requests through the real tracker store
 * between the two publishes, rolls back, and then checks not only that the
 * records are still there but that their *versions* are unchanged — a
 * "restore" dressed as a rollback would show up as records reverting, and a
 * rollback that touched data at all would show up as versions moving.
 *
 * The refusals are the other half: a release that never passed a probe is not
 * a rollback target, the release already serving is not one either, and a
 * target built for a different data schema is refused with both versions
 * named rather than attempted.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { buildRunnerDouble } from "./_doubles";
import { harness, makeApp, publishOnce, wire, type Harness } from "./_helpers";

const DATA = isolatedDataDir("zenith-w7-rollback-");

let h: Harness;
let undo: (() => void) | undefined;
let appId: string;
let releaseOne: string;
let releaseTwo: string;
const recordIds: string[] = [];

beforeAll(async () => {
  h = await harness(DATA);
  const wired = wire(h);
  const app = await makeApp(h, {
    workspaceId: WORKSPACES.one.id,
    slug: "rollbackable",
    name: "Rollbackable",
    subject: IDENTITIES.owner.subject,
  });
  appId = app.id;

  const first = await publishOnce(h, { app, actor: IDENTITIES.owner.subject });
  expect(first.status).toBe("succeeded");
  releaseOne = String(first.phaseData.releaseId);
  wired.restore();

  // Real records, written by the release that is live, through the real store.
  const { store } = h.data.openAppData(appId);
  for (const title of ["Standing desk", "Second monitor"]) {
    const created = await store.create(
      {
        appId,
        subject: IDENTITIES.editor.subject,
        email: IDENTITIES.editor.email,
        role: "editor",
        releaseId: releaseOne,
      },
      {
        writeId: uuid(),
        record: {
          title,
          details: "",
          category: "furniture",
          quantity: 1,
          priority: "normal",
          status: "requested",
          requestedFor: "Sam Rivera",
          neededBy: null,
        },
      }
    );
    recordIds.push(created.record.id);
  }

  const second = wire(h, { build: buildRunnerDouble({ html: "<!doctype html><title>Release two</title>" }) });
  const job = await publishOnce(h, { app, actor: IDENTITIES.owner.subject });
  expect(job.status).toBe("succeeded");
  releaseTwo = String(job.phaseData.releaseId);
  second.restore();
});

afterEach(() => {
  undo?.();
  undo = undefined;
  h.release.resetReleaseDeps();
});

afterAll(() => {
  h.release.stopHostedJobRunner();
  h.data.closeAllAppData();
  h.authority.closeAuthority();
  removeDir(DATA);
});

describe("rolling back to a superseded release", () => {
  it("moves the pointer, marks the release it left rolled_back, and does not touch a record", async () => {
    const wired = wire(h);
    undo = wired.restore;

    const before = h.authority.authority().repos.apps.get(appId)!;
    expect(before.activeReleaseId).toBe(releaseTwo);
    const { store } = h.data.openAppData(appId);
    const priorVersions = await Promise.all(
      recordIds.map(async (id) => (await store.get({ appId, subject: IDENTITIES.editor.subject, email: IDENTITIES.editor.email, role: "editor", releaseId: releaseTwo }, id))?.version)
    );
    expect(priorVersions).toEqual([1, 1]);

    const jobId = uuid();
    const admitted = h.release.admitRollback({
      jobId,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
      releaseId: releaseOne,
    });
    expect(admitted.created).toBe(true);

    const job = await h.release.runJobOnce(jobId);
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("succeeded");
    expect(job.phaseData.phases).toEqual(["check", "activate", "finish"]);

    const app = h.authority.authority().repos.apps.get(appId)!;
    expect(app.activeReleaseId).toBe(releaseOne);
    expect(app.activeFence).toBe(before.activeFence + 1);
    expect(h.authority.authority().repos.releases.get(releaseOne)?.status).toBe("active");
    // Left deliberately, not overtaken: the history has to say which.
    expect(h.authority.authority().repos.releases.get(releaseTwo)?.status).toBe("rolled_back");
    expect(wired.runtime.recorder.activated).toHaveLength(1);

    // Every record is still there, at the version it was at.
    const after = await Promise.all(
      recordIds.map((id) =>
        store.get(
          { appId, subject: IDENTITIES.editor.subject, email: IDENTITIES.editor.email, role: "editor", releaseId: releaseOne },
          id
        )
      )
    );
    expect(after.map((r) => r?.title)).toEqual(["Standing desk", "Second monitor"]);
    expect(after.map((r) => r?.version)).toEqual([1, 1]);

    const events = h.authority
      .authority()
      .repos.events.listSince({ appId }, { limit: 200 })
      .map((event) => event.event);
    expect(events).toContain("release.rolled_back");
  });
});

describe("rollback refusals", () => {
  it("refuses a release that never passed a probe", async () => {
    const wired = wire(h, {
      build: buildRunnerDouble({ html: "<!doctype html><title>Never healthy</title>" }),
      probe: () => ({
        ok: false,
        checkedAt: new Date().toISOString(),
        checks: [{ id: "index_fetch", ok: false, detail: "nothing answered" }],
        testDatabase: "test.sqlite (disposable)",
      }),
    });
    undo = wired.restore;

    const publishJob = uuid();
    await h.release.admitPublish({
      jobId: publishJob,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
      source: { kind: "fixture", name: "minimal-app" },
    });
    const failed = await h.release.runJobOnce(publishJob);
    const failedRelease = String(failed.phaseData.releaseId);
    expect(h.authority.authority().repos.releases.get(failedRelease)?.status).toBe("failed");

    expect(() =>
      h.release.admitRollback({
        jobId: uuid(),
        appId,
        workspaceId: WORKSPACES.one.id,
        actor: IDENTITIES.owner.subject,
        releaseId: failedRelease,
      })
    ).toThrowError(/only a release that passed its health probe/);
  });

  it("refuses the release that is already serving, and one from another app", () => {
    undo = wire(h).restore;
    expect(() =>
      h.release.admitRollback({
        jobId: uuid(),
        appId,
        workspaceId: WORKSPACES.one.id,
        actor: IDENTITIES.owner.subject,
        releaseId: releaseOne,
      })
    ).toThrowError(/already the release this app is serving/);

    expect(() =>
      h.release.admitRollback({
        jobId: uuid(),
        appId,
        workspaceId: WORKSPACES.one.id,
        actor: IDENTITIES.owner.subject,
        releaseId: "rel-does-not-exist",
      })
    ).toThrowError(/not a release of this app/);
  });

  it("refuses a target built for a different data schema, without reading a record", async () => {
    // The app's records report schema 2; every release here was built for 1.
    undo = wire(h, { schemaVersion: 2 }).restore;
    const jobId = uuid();
    h.release.admitRollback({
      jobId,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
      releaseId: releaseTwo,
    });
    const job = await h.release.runJobOnce(jobId);

    expect(job.status).toBe("failed");
    expect(job.phase).toBe("check");
    expect(job.error).toContain("data schema 1");
    expect(job.error).toContain("schema 2");

    // Nothing moved, and neither release changed status.
    const app = h.authority.authority().repos.apps.get(appId)!;
    expect(app.activeReleaseId).toBe(releaseOne);
    expect(h.authority.authority().repos.releases.get(releaseTwo)?.status).toBe("rolled_back");
  });
});
