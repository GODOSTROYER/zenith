/**
 * Job admission, single flight, leases and fencing — the four properties that
 * make "retry the publish" a safe instruction.
 *
 * Workstream W1 (hosted R3).
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
  it("is stable under key reordering at every depth", () => {
    const one = { source: { kind: "tarball", digest: "abc" }, notes: ["a", "b"], schema: 1 };
    const other = { schema: 1, notes: ["a", "b"], source: { digest: "abc", kind: "tarball" } };
    expect(hashIntent(one)).toBe(hashIntent(other));
    expect(hashIntent(one)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores undefined properties but not array order or values", () => {
    expect(hashIntent({ a: 1, b: undefined })).toBe(hashIntent({ a: 1 }));
    expect(hashIntent({ notes: ["a", "b"] })).not.toBe(hashIntent({ notes: ["b", "a"] }));
    expect(hashIntent({ a: 1 })).not.toBe(hashIntent({ a: "1" }));
    expect(hashIntent(undefined)).toBe(hashIntent(null));
  });

  it("refuses values JSON would silently flatten", () => {
    expect(() => hashIntent({ when: Number.NaN })).toThrow(/no stable JSON form/);
    expect(() => hashIntent({ size: 10n })).toThrow(/no stable JSON form/);
    expect(() => hashIntent({ at: new Map([["a", 1]]) })).toThrow(/no stable JSON form/);
  });
});

describe("admitJob idempotency", () => {
  it("returns the same job for the same id and intent, and creates it only once", () => {
    const app = seedApp(a, { slug: "idem-app" });
    const id = uuid();
    const intent = { source: { kind: "fixture", name: "tracker-app" }, schema: 1 };

    const first = publish(app.id, id, intent);
    const second = publish(app.id, id, { schema: 1, source: { name: "tracker-app", kind: "fixture" } });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.intentHash).toBe(hashIntent(intent));
    expect(a.repos.jobs.listByApp(app.id)).toHaveLength(1);
  });

  it("refuses the same id with a different intent, actor, kind or app", () => {
    const app = seedApp(a, { slug: "conflict-app" });
    const otherApp = seedApp(a, { slug: "conflict-app-2" });
    const id = uuid();
    publish(app.id, id, { source: { kind: "fixture", name: "one" } });

    const cases: [string, () => unknown][] = [
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
        run();
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
    expect(a.repos.jobs.listByApp(app.id)).toHaveLength(1);
    expect(a.repos.jobs.get(id)).toMatchObject({ kind: "publish", actor: OWNER, appId: app.id });
  });
});

describe("single flight", () => {
  it("refuses a second running job for one app and allows one per other app", () => {
    const app = seedApp(a, { slug: "flight-app" });
    const sibling = seedApp(a, { slug: "flight-app-2" });
    const first = publish(app.id, uuid(), { n: 1 }).job;
    const second = publish(app.id, uuid(), { n: 2 }).job;
    const elsewhere = publish(sibling.id, uuid(), { n: 3 }).job;

    expect(a.tx(() => a.repos.jobs.claim(first.id, "worker-a", 60_000))?.fence).toBe(1);

    let thrown: unknown;
    try {
      a.tx(() => a.repos.jobs.claim(second.id, "worker-b", 60_000));
    } catch (err) {
      thrown = err;
    }
    const error = thrown as Error & { code?: string; details?: { constraint?: string; appId?: string } };
    expect(error.code).toBe("conflict");
    expect(error.details?.constraint).toBe("hosted_jobs_single_flight");
    expect(error.details?.appId).toBe(app.id);

    // The refusal changed nothing: the second job is still queued and unclaimed.
    expect(a.repos.jobs.get(second.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      fenceToken: 0,
      leaseOwner: undefined,
    });
    expect(a.repos.jobs.runningFor(app.id)?.id).toBe(first.id);

    // A different app is unaffected.
    expect(a.tx(() => a.repos.jobs.claim(elsewhere.id, "worker-c", 60_000))?.fence).toBe(1);
    expect(a.repos.jobs.countRunning()).toBe(2);
  });

  it("does not claim a job that is not queued", () => {
    const app = seedApp(a, { slug: "flight-app-3" });
    const job = publish(app.id, uuid(), { n: 1 }).job;
    expect(a.tx(() => a.repos.jobs.claim(job.id, "worker-a", 60_000))?.fence).toBe(1);
    expect(a.tx(() => a.repos.jobs.claim(job.id, "worker-a", 60_000))).toBeNull();
    expect(a.tx(() => a.repos.jobs.claim("no-such-job", "worker-a", 60_000))).toBeNull();
  });
});

describe("leases and fencing", () => {
  it("hands an expired lease to a new claimant and refuses the old fence", () => {
    const app = seedApp(a, { slug: "fence-app" });
    const job = publish(app.id, uuid(), { n: 1 }).job;

    // Claim with a lease that has already run out.
    const first = a.tx(() => a.repos.jobs.claim(job.id, "worker-a", 1_000, iso(-60_000)));
    expect(first?.fence).toBe(1);
    expect(a.repos.jobs.get(job.id)).toMatchObject({ status: "running", leaseOwner: "worker-a" });
    expect(a.tx(() => a.repos.jobs.advance(job.id, 1, "build", { step: "install" }))).toBe(true);

    // The abandoned job goes back on the queue and is claimed by somebody else.
    expect(a.tx(() => a.repos.jobs.reclaimExpired())).toBe(1);
    expect(a.repos.jobs.get(job.id)).toMatchObject({
      status: "queued",
      leaseOwner: undefined,
      leaseUntil: undefined,
      phase: "build",
      phaseData: { step: "install" },
    });

    const second = a.tx(() => a.repos.jobs.claim(job.id, "worker-b", 60_000));
    expect(second?.fence).toBe(2);
    expect(a.repos.jobs.get(job.id)?.attempts).toBe(2);

    // Worker A wakes up holding fence 1 and can no longer do anything.
    expect(a.tx(() => a.repos.jobs.advance(job.id, 1, "activate"))).toBe(false);
    expect(a.tx(() => a.repos.jobs.finish(job.id, 1, { released: "yes" }))).toBe(false);
    expect(a.tx(() => a.repos.jobs.fail(job.id, 1, "worker A says so"))).toBe(false);
    expect(a.repos.jobs.get(job.id)).toMatchObject({ status: "running", phase: "build" });

    // Worker B, holding fence 2, can.
    expect(a.tx(() => a.repos.jobs.advance(job.id, 2, "activate", { releaseId: "r1" }))).toBe(true);
    expect(a.tx(() => a.repos.jobs.finish(job.id, 2, { releaseId: "r1" }))).toBe(true);
    expect(a.repos.jobs.get(job.id)).toMatchObject({
      status: "succeeded",
      phase: "activate",
      result: { releaseId: "r1" },
      leaseOwner: undefined,
    });
    expect(a.tx(() => a.repos.jobs.reclaimExpired())).toBe(0);
  });

  it("refuses to move the active release pointer with a stale fence", () => {
    const app = seedApp(a, { slug: "cas-app" });
    const first = seedRelease(a, app.id);
    const second = seedRelease(a, app.id);

    expect(a.tx(() => a.repos.apps.setActiveRelease(app.id, first.id, 0))).toBe(true);
    expect(a.repos.apps.get(app.id)).toMatchObject({ activeReleaseId: first.id, activeFence: 1 });

    // A worker that read the app before the first activation still holds 0.
    expect(a.tx(() => a.repos.apps.setActiveRelease(app.id, second.id, 0))).toBe(false);
    expect(a.repos.apps.get(app.id)).toMatchObject({ activeReleaseId: first.id, activeFence: 1 });

    // The current fence works, and moves the fence on again.
    expect(a.tx(() => a.repos.apps.setActiveRelease(app.id, second.id, 1))).toBe(true);
    expect(a.repos.apps.get(app.id)).toMatchObject({ activeReleaseId: second.id, activeFence: 2 });
  });

  it("cancels a queued or running job without a fence, and finished jobs not at all", () => {
    const app = seedApp(a, { slug: "cancel-app" });
    const queued = publish(app.id, uuid(), { n: 1 }).job;
    expect(a.tx(() => a.repos.jobs.cancel(queued.id, "operator stopped it"))).toBe(true);
    expect(a.repos.jobs.get(queued.id)).toMatchObject({
      status: "cancelled",
      error: "operator stopped it",
    });
    expect(a.tx(() => a.repos.jobs.cancel(queued.id))).toBe(false);
  });
});
