/**
 * Job admission, single flight, leases and fencing — the four properties that
 * make "retry the publish" a safe instruction.
 */
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-authority-jobs-");

const { admitJob, closeAuthority, hashIntent, openAuthority } = await import("@/lib/hosted/authority");
const { iso, seedApp, seedRelease, uuid } = await import("./_helpers");

const a = openAuthority();

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const publish = (appId: string, id: string, intent: unknown, actor = OWNER) =>
  admitJob({ id, kind: "publish" as const, workspaceId: "ws-one", appId, actor, intent });

describe("hashIntent", () => {
  it("is stable under key reordering at every depth", async () => {
    const one = { source: { kind: "tarball", digest: "abc" }, notes: ["a", "b"], schema: 1 };
    const other = { schema: 1, notes: ["a", "b"], source: { digest: "abc", kind: "tarball" } };
    expect(hashIntent(one)).toBe(hashIntent(other));
    expect(hashIntent(one)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores undefined properties but not array order or values", async () => {
    expect(hashIntent({ a: 1, b: undefined })).toBe(hashIntent({ a: 1 }));
    expect(hashIntent({ notes: ["a", "b"] })).not.toBe(hashIntent({ notes: ["b", "a"] }));
    expect(hashIntent({ a: 1 })).not.toBe(hashIntent({ a: "1" }));
    expect(hashIntent(undefined)).toBe(hashIntent(null));
  });

  it("refuses values JSON would silently flatten", async () => {
    expect(() => hashIntent({ when: Number.NaN })).toThrow(/no stable JSON form/);
    expect(() => hashIntent({ size: 10n })).toThrow(/no stable JSON form/);
    expect(() => hashIntent({ at: new Map([["a", 1]]) })).toThrow(/no stable JSON form/);
  });
});

describe("admitJob idempotency", () => {
  it("returns the same job for the same id and intent, and creates it only once", async () => {
    const app = await seedApp(a, { slug: "idem-app" });
    const id = uuid();
    const intent = { source: { kind: "fixture", name: "tracker-app" }, schema: 1 };

    const first = await publish(app.id, id, intent);
    const second = await publish(app.id, id, {
      schema: 1,
      source: { name: "tracker-app", kind: "fixture" },
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.intentHash).toBe(hashIntent(intent));
    expect(await a.repos.jobs.listByApp(app.id)).toHaveLength(1);
  });

  it("refuses the same id with a different intent, actor, kind or app", async () => {
    const app = await seedApp(a, { slug: "conflict-app" });
    const otherApp = await seedApp(a, { slug: "conflict-app-2" });
    const id = uuid();
    await publish(app.id, id, { source: { kind: "fixture", name: "one" } });

    const cases: [string, () => Promise<unknown>][] = [
      ["intent", () => publish(app.id, id, { source: { kind: "fixture", name: "two" } })],
      ["actor", () => publish(app.id, id, { source: { kind: "fixture", name: "one" } }, OTHER)],
      ["app", () => publish(otherApp.id, id, { source: { kind: "fixture", name: "one" } })],
      [
        "kind",
        () =>
          admitJob({
            id,
            kind: "rollback",
            workspaceId: "ws-one",
            appId: app.id,
            actor: OWNER,
            intent: { source: { kind: "fixture", name: "one" } },
          }),
      ],
    ];

    for (const [field, run] of cases) {
      let thrown: unknown;
      try {
        await run();
      } catch (err) {
        thrown = err;
      }
      const error = thrown as Error & { code?: string; status?: number; details?: { field?: string } };
      expect(error, field).toBeInstanceOf(Error);
      expect(error.code, field).toBe("idempotency_conflict");
      expect(error.status, field).toBe(409);
      expect(error.details?.field, field).toBe(field);
    }

    // The original job is untouched by any of the refusals.
    expect(await a.repos.jobs.listByApp(app.id)).toHaveLength(1);
    expect(await a.repos.jobs.get(id)).toMatchObject({ kind: "publish", actor: OWNER, appId: app.id });
  });
});

describe("single flight", () => {
  it("refuses a second running job for one app and allows one per other app", async () => {
    const app = await seedApp(a, { slug: "flight-app" });
    const sibling = await seedApp(a, { slug: "flight-app-2" });
    const first = (await publish(app.id, uuid(), { n: 1 })).job;
    const second = (await publish(app.id, uuid(), { n: 2 })).job;
    const elsewhere = (await publish(sibling.id, uuid(), { n: 3 })).job;

    expect((await a.tx((repos) => repos.jobs.claim(first.id, "worker-a", 60_000)))?.fence).toBe(1);

    let thrown: unknown;
    try {
      await a.tx((repos) => repos.jobs.claim(second.id, "worker-b", 60_000));
    } catch (err) {
      thrown = err;
    }
    const error = thrown as Error & { code?: string; details?: { constraint?: string; appId?: string } };
    expect(error.code).toBe("conflict");
    expect(error.details?.constraint).toBe("hosted_jobs_single_flight");
    expect(error.details?.appId).toBe(app.id);

    // The refusal changed nothing: the second job is still queued and unclaimed.
    expect(await a.repos.jobs.get(second.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      fenceToken: 0,
      leaseOwner: undefined,
    });
    expect((await a.repos.jobs.runningFor(app.id))?.id).toBe(first.id);

    // A different app is unaffected.
    expect((await a.tx((repos) => repos.jobs.claim(elsewhere.id, "worker-c", 60_000)))?.fence).toBe(1);
    expect(await a.repos.jobs.countRunning()).toBe(2);
  });

  it("does not claim a job that is not queued", async () => {
    const app = await seedApp(a, { slug: "flight-app-3" });
    const job = (await publish(app.id, uuid(), { n: 1 })).job;
    expect((await a.tx((repos) => repos.jobs.claim(job.id, "worker-a", 60_000)))?.fence).toBe(1);
    expect(await a.tx((repos) => repos.jobs.claim(job.id, "worker-a", 60_000))).toBeNull();
    expect(await a.tx((repos) => repos.jobs.claim("no-such-job", "worker-a", 60_000))).toBeNull();
  });
});

describe("leases and fencing", () => {
  it("hands an expired lease to a new claimant and refuses the old fence", async () => {
    const app = await seedApp(a, { slug: "fence-app" });
    const job = (await publish(app.id, uuid(), { n: 1 })).job;

    // Claim with a lease that has already run out.
    const first = await a.tx((repos) => repos.jobs.claim(job.id, "worker-a", 1_000, iso(-60_000)));
    expect(first?.fence).toBe(1);
    expect(await a.repos.jobs.get(job.id)).toMatchObject({ status: "running", leaseOwner: "worker-a" });
    expect(await a.tx((repos) => repos.jobs.advance(job.id, 1, "build", { step: "install" }))).toBe(true);

    // The abandoned job goes back on the queue and is claimed by somebody else.
    expect(await a.tx((repos) => repos.jobs.reclaimExpired())).toBe(1);
    expect(await a.repos.jobs.get(job.id)).toMatchObject({
      status: "queued",
      leaseOwner: undefined,
      leaseUntil: undefined,
      phase: "build",
      phaseData: { step: "install" },
    });

    const second = await a.tx((repos) => repos.jobs.claim(job.id, "worker-b", 60_000));
    expect(second?.fence).toBe(2);
    expect((await a.repos.jobs.get(job.id))?.attempts).toBe(2);

    // Worker A wakes up holding fence 1 and can no longer do anything.
    expect(await a.tx((repos) => repos.jobs.advance(job.id, 1, "activate"))).toBe(false);
    expect(await a.tx((repos) => repos.jobs.finish(job.id, 1, { released: "yes" }))).toBe(false);
    expect(await a.tx((repos) => repos.jobs.fail(job.id, 1, "worker A says so"))).toBe(false);
    expect(await a.repos.jobs.get(job.id)).toMatchObject({ status: "running", phase: "build" });

    // Worker B, holding fence 2, can.
    expect(await a.tx((repos) => repos.jobs.advance(job.id, 2, "activate", { releaseId: "r1" }))).toBe(true);
    expect(await a.tx((repos) => repos.jobs.finish(job.id, 2, { releaseId: "r1" }))).toBe(true);
    expect(await a.repos.jobs.get(job.id)).toMatchObject({
      status: "succeeded",
      phase: "activate",
      result: { releaseId: "r1" },
      leaseOwner: undefined,
    });
    expect(await a.tx((repos) => repos.jobs.reclaimExpired())).toBe(0);
  });

  it("refuses to move the active release pointer with a stale fence", async () => {
    const app = await seedApp(a, { slug: "cas-app" });
    const first = await seedRelease(a, app.id);
    const second = await seedRelease(a, app.id);

    expect(await a.tx((repos) => repos.apps.setActiveRelease(app.id, first.id, 0))).toBe(true);
    expect(await a.repos.apps.get(app.id)).toMatchObject({ activeReleaseId: first.id, activeFence: 1 });

    // A worker that read the app before the first activation still holds 0.
    expect(await a.tx((repos) => repos.apps.setActiveRelease(app.id, second.id, 0))).toBe(false);
    expect(await a.repos.apps.get(app.id)).toMatchObject({ activeReleaseId: first.id, activeFence: 1 });

    // The current fence works, and moves the fence on again.
    expect(await a.tx((repos) => repos.apps.setActiveRelease(app.id, second.id, 1))).toBe(true);
    expect(await a.repos.apps.get(app.id)).toMatchObject({ activeReleaseId: second.id, activeFence: 2 });
  });

  it("cancels a queued or running job without a fence, and finished jobs not at all", async () => {
    const app = await seedApp(a, { slug: "cancel-app" });
    const queued = (await publish(app.id, uuid(), { n: 1 })).job;
    expect(await a.tx((repos) => repos.jobs.cancel(queued.id, "operator stopped it"))).toBe(true);
    expect(await a.repos.jobs.get(queued.id)).toMatchObject({
      status: "cancelled",
      error: "operator stopped it",
    });
    expect(await a.tx((repos) => repos.jobs.cancel(queued.id))).toBe(false);
  });
});

describe("the queue", () => {
  it("lists waiting jobs oldest first and drops them as they are claimed", async () => {
    const app = await seedApp(a, { slug: "queue-app" });
    const sibling = await seedApp(a, { slug: "queue-app-2" });

    // Queued through the repository rather than `admitJob`, because this is the
    // one test about *ordering*: `queued()` orders by `(created_at, id)`, and
    // two jobs admitted in the same millisecond tie on `created_at` and fall
    // back to a random UUID. Explicit, distinct timestamps make "oldest first"
    // the thing being asserted instead of a coin toss.
    const queue = (appId: string, createdAt: string) =>
      a.tx((repos) =>
        repos.jobs.insert({
          id: uuid(),
          kind: "publish" as const,
          workspaceId: "ws-one",
          appId,
          actor: OWNER,
          intentHash: hashIntent({ appId, createdAt }),
          createdAt,
        })
      );

    const first = await queue(app.id, iso(-2_000));
    const second = await queue(sibling.id, iso(-1_000));

    // What the release runner ticks over: ids and apps, oldest first, and no
    // raw connection anywhere near it. Filtered to this test's own two apps —
    // every other test in this file leaves queued jobs behind.
    const waiting = await a.repos.jobs.queued();
    expect(waiting.filter((job) => job.appId === app.id || job.appId === sibling.id)).toEqual([
      { id: first.id, appId: app.id },
      { id: second.id, appId: sibling.id },
    ]);

    await a.tx((repos) => repos.jobs.claim(first.id, "worker-a", 60_000));
    expect((await a.repos.jobs.queued()).map((job) => job.id)).not.toContain(first.id);
    expect(await a.repos.jobs.queued(1)).toHaveLength(1);
  });
});
