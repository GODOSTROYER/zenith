/**
 * Two ceilings on concurrent work, enforced in two different places, and this
 * file pins both.
 *
 *  - **One operation per app.** A partial unique index in the authority means
 *    SQLite refuses the second claim, so a code path that forgot to check
 *    would still not produce two running publishes for one app. The runner
 *    checks anyway, so the second job waits quietly instead of raising.
 *  - **Two builds install-wide.** Nothing but this code enforces
 *    `DEFAULT_LIMITS.buildsPilotWide`, which is exactly why it is worth a
 *    test: a third app's publish stays queued while two others run, and moves
 *    the moment a slot frees.
 *
 * Workstream W7 (hosted R3).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { harness, makeApp, wire, type Harness } from "./_helpers";

const DATA = isolatedDataDir("zenith-w7-flight-");

let h: Harness;
let undo: () => void;
const apps: Record<string, string> = {};

beforeAll(async () => {
  h = await harness(DATA);
  undo = wire(h).restore;
  for (const slug of ["flight-a", "flight-b", "flight-c"]) {
    const app = await makeApp(h, {
      workspaceId: WORKSPACES.one.id,
      slug,
      name: slug,
      subject: IDENTITIES.owner.subject,
    });
    apps[slug] = app.id;
  }
});

afterAll(() => {
  undo();
  h.release.resetReleaseDeps();
  h.release.stopHostedJobRunner();
  h.data.closeAllAppData();
  h.authority.closeAuthority();
  removeDir(DATA);
});

const queue = async (slug: string): Promise<string> => {
  const jobId = uuid();
  await h.release.admitPublish({
    jobId,
    appId: apps[slug],
    workspaceId: WORKSPACES.one.id,
    actor: IDENTITIES.owner.subject,
    source: { kind: "fixture", name: "minimal-app" },
  });
  return jobId;
};

describe("build slots", () => {
  it("runs one job per app and two across the install, and queues the rest", async () => {
    const a1 = await queue("flight-a");
    const a2 = await queue("flight-a");
    const b1 = await queue("flight-b");
    const c1 = await queue("flight-c");

    // First job for app A takes the slot.
    expect(h.release.claimJob(a1)).not.toBeNull();
    expect(h.authority.authority().repos.jobs.get(a1)?.status).toBe("running");

    // Second job for the same app is not started — and the authority itself
    // would refuse it, which is what makes the check above a convenience
    // rather than the guarantee.
    expect(h.release.claimJob(a2)).toBeNull();
    expect(h.authority.authority().repos.jobs.get(a2)?.status).toBe("queued");
    expect(() => h.authority.authority().repos.jobs.claim(a2, "another-worker", 60_000)).toThrowError(
      /Another job is already running for this app/
    );
    expect(h.authority.authority().repos.jobs.get(a2)?.status).toBe("queued");

    // A different app may run concurrently: that is the second pilot slot.
    expect(h.release.buildSlot(apps["flight-b"]).ok).toBe(true);
    expect(h.release.claimJob(b1)).not.toBeNull();
    expect(h.authority.authority().repos.jobs.countRunning()).toBe(2);

    // The third app waits, and the refusal says why.
    const slot = h.release.buildSlot(apps["flight-c"]);
    expect(slot.ok).toBe(false);
    expect(slot.reason).toContain("2 builds are already running");
    expect(h.release.claimJob(c1)).toBeNull();
    // A tick with no room changes nothing.
    h.release.tickJobs();
    expect(h.authority.authority().repos.jobs.get(c1)?.status).toBe("queued");

    // Free a slot and the queued app moves.
    h.authority.authority().repos.jobs.cancel(b1, "test finished with this slot");
    expect(h.authority.authority().repos.jobs.countRunning()).toBe(1);
    expect(h.release.buildSlot(apps["flight-c"]).ok).toBe(true);
    expect(h.release.claimJob(c1)).not.toBeNull();
    expect(h.authority.authority().repos.jobs.get(c1)?.status).toBe("running");

    // And app A's second job still waits behind its own first one.
    expect(h.release.claimJob(a2)).toBeNull();
  });

  it("refuses to claim a job that is not queued, naming its status", async () => {
    const jobId = await queue("flight-b");
    h.authority.authority().repos.jobs.cancel(jobId, "cancelled before it ran");
    await expect(h.release.runJobOnce(jobId)).rejects.toMatchObject({ code: "conflict" });
    await expect(h.release.runJobOnce(uuid())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the ticker", () => {
  it("starts and stops idempotently and never holds the process open", () => {
    expect(h.release.hostedJobRunnerRunning()).toBe(false);
    h.release.startHostedJobRunner();
    h.release.startHostedJobRunner();
    expect(h.release.hostedJobRunnerRunning()).toBe(true);
    h.release.stopHostedJobRunner();
    h.release.stopHostedJobRunner();
    expect(h.release.hostedJobRunnerRunning()).toBe(false);
  });
});
