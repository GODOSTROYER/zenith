/**
 * Creating an app is one transaction, and the owner grant is why.
 *
 * An app row that committed without its grant would be an app nobody can
 * publish to, invite to or suspend — and the only way to be sure that state
 * cannot exist is for both writes to be one commit. The runtime is asked
 * afterwards, outside the transaction, and a runtime that refuses leaves a
 * real app carrying the reason rather than a creation that half-happened.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APPS, IDENTITIES, WORKSPACES, isolatedDataDir, removeDir } from "../_fixtures";
import { harness, makeApp, wire, type Harness } from "./_helpers";

const DATA = isolatedDataDir("zenith-w7-apps-");

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
  h.authority.closeAuthority();
  removeDir(DATA);
});

describe("createApp", () => {
  it("writes the app, its owner grant and its creation event in one transaction", async () => {
    const wired = await wire(h);
    undo = wired.restore;

    const app = await makeApp(h, {
      workspaceId: WORKSPACES.one.id,
      slug: APPS.alpha.slug,
      name: APPS.alpha.name,
      subject: IDENTITIES.owner.subject,
      email: IDENTITIES.owner.email,
    });

    expect(app.state).toBe("active");
    expect(app.activeReleaseId).toBeNull();
    expect(app.activeFence).toBe(0);
    expect(app.runtime).toBe("local");
    expect(app.stateReason).toBeUndefined();

    const grants = await h.authority.authority().repos.grants.listByApp(app.id);
    expect(grants).toHaveLength(1);
    expect(grants[0].role).toBe("owner");
    expect(grants[0].subject).toBe(IDENTITIES.owner.subject);
    expect(grants[0].email).toBe(IDENTITIES.owner.email);
    expect(grants[0].state).toBe("active");

    // The runtime is prepared after the commit, never inside it.
    expect(wired.runtime.recorder.ensured).toEqual([app.id]);
  });

  it("refuses a slug another app already has, without touching that app", async () => {
    undo = (await wire(h)).restore;
    const first = await h.authority.authority().repos.apps.getBySlug(APPS.alpha.slug);
    expect(first).not.toBeNull();

    await expect(
      makeApp(h, {
        workspaceId: WORKSPACES.two.id,
        slug: APPS.alpha.slug,
        name: "Someone else's alpha",
        subject: IDENTITIES.stranger.subject,
      })
    ).rejects.toMatchObject({ code: "conflict" });

    // Nothing about the app that owns the slug changed, and no second app,
    // grant or half-written row was left behind.
    expect((await h.authority.authority().repos.apps.getBySlug(APPS.alpha.slug))?.id).toBe(first?.id);
    expect(await h.authority.authority().repos.apps.listByWorkspace(WORKSPACES.two.id)).toHaveLength(0);
    expect(await h.authority.authority().repos.grants.listByApp(first!.id)).toHaveLength(1);
  });

  it("refuses a reserved slug and an illegal one, naming the rule", async () => {
    undo = (await wire(h)).restore;
    for (const slug of ["api", "admin", "zenith"]) {
      await expect(
        makeApp(h, {
          workspaceId: WORKSPACES.one.id,
          slug,
          name: "Reserved",
          subject: IDENTITIES.owner.subject,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const slug of ["ab", "-nope", "under_score", "a".repeat(41)]) {
      await expect(
        makeApp(h, {
          workspaceId: WORKSPACES.one.id,
          slug,
          name: "Illegal",
          subject: IDENTITIES.owner.subject,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await h.authority.authority().repos.apps.listByWorkspace(WORKSPACES.one.id)).toHaveLength(1);
  });

  it("normalises a slug to the lowercase hostname it becomes", async () => {
    undo = (await wire(h)).restore;
    const app = await makeApp(h, {
      workspaceId: WORKSPACES.one.id,
      slug: "  Gamma-Tracker  ",
      name: "Gamma",
      subject: IDENTITIES.owner.subject,
    });
    expect(app.slug).toBe("gamma-tracker");
  });

  it("refuses a name that is not a name", async () => {
    undo = (await wire(h)).restore;
    await expect(
      makeApp(h, {
        workspaceId: WORKSPACES.one.id,
        slug: "namecheck",
        name: "   ",
        subject: IDENTITIES.owner.subject,
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps the app when the runtime cannot prepare it, and records why", async () => {
    undo = (await wire(h, { ensureAppError: new Error("the local runtime has no data directory") })).restore;

    const app = await makeApp(h, {
      workspaceId: WORKSPACES.one.id,
      slug: APPS.beta.slug,
      name: APPS.beta.name,
      subject: IDENTITIES.owner.subject,
    });

    expect(app.state).toBe("active");
    expect(app.stateReason).toContain("no data directory");
    // The record is the durable truth: the app and its grant are both real.
    expect((await h.authority.authority().repos.apps.get(app.id))?.stateReason).toContain("no data directory");
    expect(await h.authority.authority().repos.grants.listByApp(app.id)).toHaveLength(1);
  });
});

describe("appSummary", () => {
  it("answers with the app, its hostname and the fact that nothing is serving yet", async () => {
    undo = (await wire(h)).restore;
    const app = (await h.authority.authority().repos.apps.getBySlug(APPS.alpha.slug))!;
    const summary = await h.release.appSummary(app.id);
    expect(summary.app.id).toBe(app.id);
    expect(summary.activeRelease).toBeNull();
    expect(summary.releases).toEqual([]);
    expect(summary.runningJob).toBeNull();
    expect(summary.hostname).toBe(`${APPS.alpha.slug}.apps.localhost`);
    expect(summary.origin).toContain(`${APPS.alpha.slug}.apps.localhost`);
  });
});
