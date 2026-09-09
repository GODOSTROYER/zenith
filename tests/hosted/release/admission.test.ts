/**
 * What publish admission accepts, what it refuses, and what it does with the
 * bytes in between.
 *
 * The idempotency rule is the one that matters most here, because it is the
 * difference between a retry and a second publish. The job id is the client's;
 * sending it twice with the same intent joins the job that already exists, and
 * sending it twice with *different* intent is two operations wearing one name
 * — refused rather than silently resolved to either of them.
 *
 * The rest is admission's job of saying no early: a suspended app, a workspace
 * whose builds are paused, a fixture that does not exist. A hostile archive is
 * the one refusal that has to happen later, inside the job, because reading it
 * is what proves it hostile — so the job fails with every reason listed and the
 * app keeps serving whatever it was serving.
 *
 * Workstream W7 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { entriesFromDirectory, gzip, writeTar } from "../../_support/tar";
import { harness, makeApp, wire, type Harness } from "./_helpers";

const DATA = isolatedDataDir("zenith-w7-admission-");
const FIXTURE = path.join(process.cwd(), "fixtures", "hosted", "minimal-app");

let h: Harness;
let undo: (() => void) | undefined;
let appId: string;

beforeAll(async () => {
  h = await harness(DATA);
  undo = wire(h).restore;
  const app = await makeApp(h, {
    workspaceId: WORKSPACES.one.id,
    slug: "admission",
    name: "Admission",
    subject: IDENTITIES.owner.subject,
  });
  appId = app.id;
  undo();
  undo = undefined;
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

const publish = (
  jobId: string,
  source: { kind: "fixture"; name: string } | { kind: "tarball"; base64: string; filename?: string },
  actor: string = IDENTITIES.owner.subject
) =>
  h.release.admitPublish({ jobId, appId, workspaceId: WORKSPACES.one.id, actor, source });

describe("idempotency", () => {
  it("joins the job a repeated id already names, and queues nothing twice", async () => {
    undo = wire(h).restore;
    const jobId = uuid();
    const first = await publish(jobId, { kind: "fixture", name: "minimal-app" });
    const second = await publish(jobId, { kind: "fixture", name: "minimal-app" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.intentHash).toBe(first.job.intentHash);
    expect(h.authority.authority().repos.jobs.listByApp(appId)).toHaveLength(1);
  });

  it("refuses the same id carrying a different source", async () => {
    undo = wire(h).restore;
    const jobId = uuid();
    await publish(jobId, { kind: "fixture", name: "minimal-app" });
    await expect(publish(jobId, { kind: "fixture", name: "tracker-app" })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    // The job that exists is untouched: still the source it was admitted with.
    const job = h.authority.authority().repos.jobs.get(jobId)!;
    expect((job.phaseData.source as { name: string }).name).toBe("minimal-app");
  });

  it("refuses the same id from a different actor", async () => {
    undo = wire(h).restore;
    const jobId = uuid();
    await publish(jobId, { kind: "fixture", name: "minimal-app" });
    await expect(
      publish(jobId, { kind: "fixture", name: "minimal-app" }, IDENTITIES.editor.subject)
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("keeps a submitted tarball on disk before it answers, and does not overwrite it on a conflict", async () => {
    undo = wire(h).restore;
    const jobId = uuid();
    const tarball = gzip(writeTar(entriesFromDirectory(FIXTURE)));
    const admitted = await publish(jobId, { kind: "tarball", base64: tarball.toString("base64") });

    const stored = path.join(DATA, "jobs", jobId, "source.tgz");
    expect(fs.existsSync(stored)).toBe(true);
    expect(fs.readFileSync(stored).equals(tarball)).toBe(true);
    expect(admitted.job.phaseData.sourceSha256).toMatch(/^[0-9a-f]{64}$/);

    // A different archive under the same id is refused, and the bytes the
    // admitted job is going to build are exactly the ones it was admitted with.
    const other = gzip(writeTar([...entriesFromDirectory(FIXTURE), { path: "src/extra.ts", bytes: Buffer.from("export const x = 1;\n") }]));
    await expect(publish(jobId, { kind: "tarball", base64: other.toString("base64") })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(fs.readFileSync(stored).equals(tarball)).toBe(true);
  });

  it("treats the same bytes under a different filename as the same publish", async () => {
    undo = wire(h).restore;
    const jobId = uuid();
    const base64 = gzip(writeTar(entriesFromDirectory(FIXTURE))).toString("base64");

    const first = await publish(jobId, { kind: "tarball", base64, filename: "minimal-app.tar.gz" });
    // The browser downloaded it again and the OS renamed it. Same operation.
    const retry = await publish(jobId, { kind: "tarball", base64, filename: "minimal-app (1).tar.gz" });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.job.intentHash).toBe(first.job.intentHash);
    // The name is kept for the person reading the job, not for the comparison.
    expect((retry.job.phaseData.source as { filename: string }).filename).toBe("minimal-app.tar.gz");
  });
});

describe("admission refusals", () => {
  it("refuses a fixture this install does not ship", async () => {
    undo = wire(h).restore;
    await expect(publish(uuid(), { kind: "fixture", name: "../../etc/passwd" })).rejects.toMatchObject({
      code: "unsupported_source",
    });
    await expect(publish(uuid(), { kind: "fixture", name: "not-a-fixture" })).rejects.toMatchObject({
      code: "unsupported_source",
    });
  });

  it("refuses a publish to a suspended app, and queues nothing", async () => {
    undo = wire(h).restore;
    const suspendJob = uuid();
    await h.release.admitSuspend({
      jobId: suspendJob,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
      reason: "paused while we investigate",
    });
    await h.release.runJobOnce(suspendJob);
    expect(h.authority.authority().repos.apps.get(appId)?.state).toBe("suspended");

    const jobId = uuid();
    await expect(publish(jobId, { kind: "fixture", name: "minimal-app" })).rejects.toMatchObject({
      code: "suspended",
    });
    expect(h.authority.authority().repos.jobs.get(jobId)).toBeNull();

    const resumeJob = uuid();
    await h.release.admitResume({
      jobId: resumeJob,
      appId,
      workspaceId: WORKSPACES.one.id,
      actor: IDENTITIES.owner.subject,
    });
    await h.release.runJobOnce(resumeJob);
    expect(h.authority.authority().repos.apps.get(appId)?.state).toBe("active");
  });

  it("refuses a publish while spending has paused builds, quoting the reason", async () => {
    undo = wire(h, {
      paused: { paused: true, reason: "Builds are paused: this workspace is at 92 % of its approved envelope." },
    }).restore;
    const jobId = uuid();
    await expect(publish(jobId, { kind: "fixture", name: "minimal-app" })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("92 %"),
    });
    expect(h.authority.authority().repos.jobs.get(jobId)).toBeNull();
  });

  it("refuses an app in another workspace exactly as it refuses one that does not exist", async () => {
    undo = wire(h).restore;
    await expect(
      h.release.admitPublish({
        jobId: uuid(),
        appId,
        workspaceId: WORKSPACES.two.id,
        actor: IDENTITIES.stranger.subject,
        source: { kind: "fixture", name: "minimal-app" },
      })
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("a hostile archive", () => {
  it("fails the job with every reason, and never reaches a build runner", async () => {
    const wired = wire(h);
    undo = wired.restore;
    const hostile = gzip(
      writeTar([
        ...entriesFromDirectory(FIXTURE),
        { path: "../escape.txt", bytes: Buffer.from("owned\n") },
        { path: "src/../../etc/passwd", bytes: Buffer.from("root:x:0:0\n") },
        { path: "vite.config.ts", bytes: Buffer.from("export default {}\n") },
        { path: "package-lock.json", bytes: Buffer.from("{}\n") },
      ])
    );
    const jobId = uuid();
    await publish(jobId, { kind: "tarball", base64: hostile.toString("base64") });
    const job = await h.release.runJobOnce(jobId);

    expect(job.status).toBe("failed");
    expect(job.error).toBeTruthy();
    expect(job.phase).toBe("intake");
    expect(wired.build.recorder.calls).toBe(0);

    const logs = h.release.jobLogs(jobId).join("\n");
    expect(logs).toContain("vite.config.ts");
    expect(logs).toContain("package-lock.json");
    expect(logs).toMatch(/escape\.txt|passwd/);

    // Nothing about the app moved: no release, no artifact, no pointer.
    const app = h.authority.authority().repos.apps.get(appId)!;
    expect(app.activeReleaseId).toBeNull();
    expect(h.authority.authority().repos.releases.listByApp(appId)).toEqual([]);
  });
});
