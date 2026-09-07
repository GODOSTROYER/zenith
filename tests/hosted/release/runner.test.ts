/**
 * The parts of the job runner that are not any one pipeline: the ticker, the
 * lease, the bounded log and what a cleanup sweep is told to keep.
 *
 * The log is worth a test of its own because it is the one thing here that is
 * shown to a person and quoted into support threads. It is bounded, so a
 * runaway build cannot fill the control database with its own output, and it is
 * redacted, so a runner that echoes its environment does not publish a token
 * through the job log. Redaction is a net rather than a proof — no platform
 * secret should reach a build at all — but a net is worth having under it.
 *
 * Workstream W7 (hosted R3).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { buildRunnerDouble } from "./_doubles";
import { harness, makeApp, publishOnce, wire, type Harness } from "./_helpers";

const DATA = isolatedDataDir("zenith-w7-runner-");

let h: Harness;
let undo: (() => void) | undefined;
let appId: string;

beforeAll(async () => {
  h = await harness(DATA);
  const wired = wire(h);
  const app = await makeApp(h, {
    workspaceId: WORKSPACES.one.id,
    slug: "runner-app",
    name: "Runner app",
    subject: IDENTITIES.owner.subject,
  });
  appId = app.id;
  wired.restore();
});

afterEach(() => {
  undo?.();
  undo = undefined;
  h.release.resetReleaseDeps();
  h.release.stopHostedJobRunner();
});

afterAll(() => {
  h.release.stopHostedJobRunner();
  h.data.closeAllAppData();
  h.authority.closeAuthority();
  removeDir(DATA);
});

const until = async (predicate: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
};

describe("the ticker", () => {
  it("picks a queued job up on its own and runs it to completion", async () => {
    undo = wire(h).restore;
    const jobId = uuid();
    await h.release.admitPublish({
      jobId,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
      source: { kind: "fixture", name: "minimal-app" },
    });

    h.release.startHostedJobRunner();
    await until(() => h.authority.authority().repos.jobs.get(jobId)?.status === "succeeded");

    const job = h.authority.authority().repos.jobs.get(jobId)!;
    expect(job.status).toBe("succeeded");
    expect(job.leaseOwner).toBeUndefined();
    expect(h.authority.authority().repos.apps.get(appId)?.activeReleaseId).toBe(job.phaseData.releaseId);
  });
});

describe("the lease", () => {
  it("is renewed under the same fence, and refused once the fence has moved", () => {
    undo = wire(h).restore;
    const a = h.authority.authority();
    const jobId = uuid();
    a.repos.jobs.insert({
      id: jobId,
      kind: "publish",
      workspaceId: WORKSPACES.one.id,
      appId,
      actor: IDENTITIES.owner.subject,
      intentHash: "0".repeat(64),
    });
    const run = h.release.claimJob(jobId)!;
    const first = a.repos.jobs.get(jobId)!.leaseUntil!;

    expect(h.release.renewLease(run, 120_000)).toBe(true);
    expect(Date.parse(a.repos.jobs.get(jobId)!.leaseUntil!)).toBeGreaterThan(Date.parse(first));

    // A worker whose lease expired and whose job was re-claimed holds a stale
    // fence, and may not push the new owner's lease around.
    const stale = { ...run, fence: run.fence - 1 };
    expect(h.release.renewLease(stale)).toBe(false);
    a.repos.jobs.cancel(jobId, "test finished with this job");
  });

  it("reclaims a job whose lease has passed, and only then", () => {
    undo = wire(h).restore;
    const a = h.authority.authority();
    const jobId = uuid();
    a.repos.jobs.insert({
      id: jobId,
      kind: "publish",
      workspaceId: WORKSPACES.one.id,
      appId,
      actor: IDENTITIES.owner.subject,
      intentHash: "1".repeat(64),
    });
    h.release.claimJob(jobId, 60_000);
    expect(h.release.reclaimExpiredJobs()).toBe(0);
    expect(h.release.reclaimExpiredJobs(new Date(Date.now() + 120_000).toISOString())).toBe(1);
    expect(a.repos.jobs.get(jobId)?.status).toBe("queued");
    a.repos.jobs.cancel(jobId, "test finished with this job");
  });
});

describe("job logs", () => {
  it("replace anything that looks like a credential", () => {
    const redacted = h.release.redactLine(
      'env: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG, authorization: Bearer eyJhbGciOiJIUzI1NiJ9, key sk-proj-abcdefghijklmnop'
    );
    expect(redacted).toContain("AWS_SECRET_ACCESS_KEY=•••");
    expect(redacted).not.toContain("wJalrXUtnFEMI");
    expect(redacted).toContain("Bearer •••");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).not.toContain("abcdefghijklmnop");
    // A variable NAME is not a secret, and losing it would make the line useless.
    expect(redacted).toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("keep at most the last 200 lines, so a runaway build cannot fill the database", () => {
    undo = wire(h).restore;
    const a = h.authority.authority();
    const jobId = uuid();
    a.repos.jobs.insert({
      id: jobId,
      kind: "publish",
      workspaceId: WORKSPACES.one.id,
      appId,
      actor: IDENTITIES.owner.subject,
      intentHash: "2".repeat(64),
      phaseData: { logs: Array.from({ length: 500 }, (_, i) => `line ${i}`) },
    });
    const logs = h.release.jobLogs(jobId);
    expect(logs).toHaveLength(h.release.JOB_LOG_LINES);
    expect(logs[logs.length - 1]).toBe("line 499");
    expect(h.release.jobLogs(uuid())).toEqual([]);
    a.repos.jobs.cancel(jobId, "test finished with this job");
  });
});

describe("cleanup", () => {
  it("tells the runtime to keep the active release and the three most recent", async () => {
    let wired = wire(h);
    undo = () => wired.restore();
    const app = h.authority.authority().repos.apps.get(appId)!;

    // Five releases, each from a different build, so the history is real.
    for (let i = 0; i < 4; i++) {
      wired.restore();
      wired = wire(h, { build: buildRunnerDouble({ html: `<!doctype html><title>Release ${i}</title>` }) });
      const job = await publishOnce(h, { app, actor: IDENTITIES.owner.subject });
      expect(job.status).toBe("succeeded");
    }
    undo = () => wired.restore();

    const releases = h.authority.authority().repos.releases.listByApp(appId);
    expect(releases.length).toBeGreaterThanOrEqual(4);
    const retain = wired.runtime.recorder.cleaned.at(-1)!;
    expect(retain.appId).toBe(appId);
    // The active release plus the three newest — the ones a rollback can still
    // select — and nothing older.
    const newest = releases.slice(0, h.release.RETAINED_RELEASES).map((r) => r.id);
    expect(new Set(retain.retain)).toEqual(new Set([...newest, h.authority.authority().repos.apps.get(appId)!.activeReleaseId!]));
    expect(retain.retain).not.toContain(releases[releases.length - 1].id);
  });
});
