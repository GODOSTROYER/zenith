/**
 * Gate 9 — a candidate that fails its probe never replaces a healthy release,
 * and rollback is not restore.
 *
 * The failing probe is the only injection in this suite, and it is the kind the
 * rules allow: a failure the real world produces and a test cannot otherwise
 * arrange. The runtime here is the **real** `LocalRuntime`. Every method is
 * delegated to it — staging really stages, activation really compares the
 * fence — and only `probeCandidate` is wrapped, to answer `ok: false` with the
 * real checks plus one that failed. Nothing is faked into succeeding.
 *
 * "Rollback is not restore" is asserted the way it can go wrong: records are
 * written *after* release 2 went live, the app is rolled back to release 1, and
 * those records are still there. A rollback that reached for a snapshot would
 * lose exactly them.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CandidateProbeResult, HostedApp, HostedRuntime } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  fixtureDir,
  loadHosted,
  publish,
  publishOrThrow,
  releaseOf,
  signIn,
  tarballBase64,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate09-");
acceptanceEnv(DATA);

let m: HostedModules;
let app: HostedApp;
let cookie = "";
let r1: { releaseId: string; number: number; digest: string };
let r2: { releaseId: string; number: number; digest: string };
const written: { under: string; id: string; title: string }[] = [];

const OWNER = IDENTITIES.owner;
const HOST = appHost("alpha");
const ORIGIN = appOrigin("alpha");

/** The minimal fixture with a marker in its entry document, so releases differ. */
function markedSource(marker: string): string {
  const index = fs.readFileSync(path.join(fixtureDir("minimal-app"), "index.html"), "utf8");
  return tarballBase64(fixtureDir("minimal-app"), {
    "index.html": index.replace("</head>", `  <meta name="release" content="${marker}">\n  </head>`),
  });
}

/** Write one record and remember which release it was written under. */
async function write(title: string, under: string): Promise<void> {
  const one = call({
    host: HOST,
    path: "/_zenith/data/v1/requests",
    method: "POST",
    cookie,
    origin: ORIGIN,
    accept: "application/json",
    body: JSON.stringify({ writeId: uuid(), record: { title, category: "laptop" } }),
  });
  const res = await m.gateway.handleGateway(one.req, one.params);
  if (res.status !== 201) throw new Error(`creating ${title} answered ${res.status}: ${await res.text()}`);
  written.push({ under, id: ((await res.json()) as { record: { id: string } }).record.id, title });
}

/** Every record the app holds, as `id|title|version`. */
async function records(): Promise<string[]> {
  const one = call({
    host: HOST,
    path: "/_zenith/data/v1/requests?limit=100",
    cookie,
    accept: "application/json",
  });
  const res = await m.gateway.handleGateway(one.req, one.params);
  const { items } = (await res.json()) as { items: { id: string; title: string; version: number }[] };
  return items.map((item) => `${item.id}|${item.title}|v${item.version}`).sort();
}

/**
 * The real local runtime, with one probe that answers no.
 *
 * Everything else is delegated, so a candidate really is staged and the fence
 * really is checked; the only difference from production is a probe result
 * that says a check failed — which is the state a broken candidate produces
 * and which no fixture can otherwise create on demand.
 */
function runtimeWithFailingProbe(real: HostedRuntime): HostedRuntime {
  return {
    id: real.id,
    label: real.label,
    enforcement: real.enforcement,
    availability: () => real.availability(),
    hostname: (one) => real.hostname(one),
    ensureApp: (one) => real.ensureApp(one),
    stageCandidate: (one, release, artifact) => real.stageCandidate(one, release, artifact),
    async probeCandidate(one, candidate): Promise<CandidateProbeResult> {
      const result = await real.probeCandidate(one, candidate);
      return {
        ...result,
        ok: false,
        checks: [
          ...result.checks,
          {
            id: "index_fetch",
            ok: false,
            detail: "the candidate answered 500 when its entry document was fetched",
          },
        ],
      };
    },
    activate: (one, release, fence) => real.activate(one, release, fence),
    readBindings: (candidate) => real.readBindings(candidate),
    cleanup: (one, retain) => real.cleanup(one, retain),
  };
}

beforeAll(async () => {
  m = await loadHosted();
  m.authority.openAuthority();
  app = await m.release.createApp({
    workspaceId: WORKSPACES.one.id,
    slug: "alpha",
    name: "Alpha equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });

  r1 = releaseOf(
    await publishOrThrow(m, { app, actor: OWNER.subject, source: { kind: "tarball", base64: markedSource("r1") } })
  );
  cookie = await signIn(m, app, OWNER.subject);
  await write("Written under release 1", r1.releaseId);

  r2 = releaseOf(
    await publishOrThrow(m, { app, actor: OWNER.subject, source: { kind: "tarball", base64: markedSource("r2") } })
  );
  await write("Written under release 2", r2.releaseId);
}, 300_000);

afterAll(() => {
  m.release.resetReleaseDeps();
  closeHosted(m);
  removeDir(DATA);
});

describe("Gate 9 — a failed candidate, and rollback that is not restore", () => {
  it("set the scene: two releases, records under each, release 2 serving", async () => {
    expect(r2.digest, "the two releases are different builds").not.toBe(r1.digest);
    const a = m.authority.authority();
    expect(a.repos.apps.get(app.id)?.activeReleaseId).toBe(r2.releaseId);
    expect(a.repos.apps.get(app.id)?.activeFence).toBe(2);
    expect((await records()).length).toBe(2);

    const page = call({ host: HOST, path: "/", cookie, accept: "text/html" });
    expect(await (await m.gateway.handleGateway(page.req, page.params)).text()).toContain(
      'content="r2"'
    );
  });

  it("refuses to activate a candidate whose probe failed, and keeps serving release 2", async () => {
    const before = m.authority.authority().repos.apps.get(app.id)!;
    const restore = m.release.setReleaseDepsForTests({
      runtime: () => runtimeWithFailingProbe(m.runtime.selectedHostedRuntime()),
    });
    let job;
    try {
      job = await publish(m, {
        app,
        actor: OWNER.subject,
        source: { kind: "tarball", base64: markedSource("r3-broken") },
      });
    } finally {
      restore();
    }

    expect(job.status, "a candidate that did not pass its probe").toBe("failed");
    expect(job.phase, "and it failed at the probe, not later").toBe("probe");
    expect(job.error, "the refusal names the check that failed").toMatch(/index_fetch/);
    expect(job.error, "and says the app is still up").toMatch(/still serving its previous release/);

    // The candidate exists, is marked failed, and is not the active release.
    const candidateId = String(job.phaseData.releaseId);
    const a = m.authority.authority();
    const candidate = a.repos.releases.get(candidateId);
    expect(candidate?.number, "the candidate took the next number").toBe(3);
    expect(candidate?.status).toBe("failed");
    expect(candidate?.probe?.ok, "the probe result is recorded on the release").toBe(false);
    expect(candidate?.activatedAt, "it was never activated").toBeFalsy();

    const after = a.repos.apps.get(app.id)!;
    expect(after.activeReleaseId, "the pointer did not move").toBe(before.activeReleaseId);
    expect(after.activeFence, "and neither did the fence").toBe(before.activeFence);

    const page = call({ host: HOST, path: "/", cookie, accept: "text/html" });
    const res = await m.gateway.handleGateway(page.req, page.params);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-zenith-release")).toBe(r2.releaseId);
    expect(await res.text(), "release 2's bytes are what users still get").toContain('content="r2"');
  }, 300_000);

  it("will not roll back to the release that failed its probe", async () => {
    const candidate = m.authority
      .authority()
      .repos.releases.listByApp(app.id)
      .find((release) => release.status === "failed");
    expect(candidate, "there is a failed release to try").toBeTruthy();

    // `admitRollback` refuses synchronously, at admission, so the operator is
    // told before a job exists rather than by a job that fails later.
    expect(() =>
      m.release.admitRollback({
        jobId: uuid(),
        appId: app.id,
        workspaceId: app.workspaceId,
        actor: OWNER.subject,
        releaseId: candidate?.id as string,
      })
    ).toThrowError(/only a release that passed its health probe/);
  });

  it("writes more records under release 2, so the rollback has something to lose", async () => {
    await write("Written after release 2 went live", r2.releaseId);
    await write("Written just before the rollback", r2.releaseId);
    expect((await records()).length).toBe(4);
  });

  it("rolls back to release 1 and keeps every record, whichever release wrote it", async () => {
    const before = await records();

    const admitted = m.release.admitRollback({
      jobId: uuid(),
      appId: app.id,
      workspaceId: app.workspaceId,
      actor: OWNER.subject,
      releaseId: r1.releaseId,
    });
    const job = await m.release.runJobOnce(admitted.job.id);
    expect(job.status, `rollback: ${job.error ?? ""}`).toBe("succeeded");

    const a = m.authority.authority();
    expect(a.repos.apps.get(app.id)?.activeReleaseId, "the app is back on release 1").toBe(r1.releaseId);
    expect(a.repos.apps.get(app.id)?.activeFence, "a rollback is an activation, so the fence moves").toBe(3);
    expect(a.repos.releases.get(r1.releaseId)?.status).toBe("active");
    expect(
      a.repos.releases.get(r2.releaseId)?.status,
      "the release stepped off is rolled_back, not superseded"
    ).toBe("rolled_back");

    const page = call({ host: HOST, path: "/", cookie, accept: "text/html" });
    const res = await m.gateway.handleGateway(page.req, page.params);
    expect(res.headers.get("x-zenith-release")).toBe(r1.releaseId);
    expect(await res.text(), "release 1's bytes are what users get again").toContain('content="r1"');

    // The whole point: nothing a user wrote went anywhere.
    expect(await records(), "every record survives a rollback").toEqual(before);
    for (const record of written)
      expect(
        before.some((line) => line.startsWith(`${record.id}|`)),
        `${record.title} (written under ${record.under}) must still exist`
      ).toBe(true);
  }, 120_000);

  it("kept the records written after release 2 — which is what makes it a rollback, not a restore", async () => {
    const now = await records();
    const later = written.filter((record) => record.title.includes("after release 2") || record.title.includes("before the rollback"));
    expect(later.length, "there were records written after release 2 activated").toBe(2);
    for (const record of later)
      expect(
        now.some((line) => line.startsWith(`${record.id}|`)),
        `${record.title} would be lost by a restore and must survive a rollback`
      ).toBe(true);

    // And the app's data schema never moved, which is what allowed the swap.
    expect(await m.data.openAppData(app.id).store.schemaVersion(app.id)).toBe(
      m.data.LATEST_TRACKER_SCHEMA_VERSION
    );
  });

  it("can roll forward again, because release 2 is still a legitimate target", async () => {
    const admitted = m.release.admitRollback({
      jobId: uuid(),
      appId: app.id,
      workspaceId: app.workspaceId,
      actor: OWNER.subject,
      releaseId: r2.releaseId,
    });
    const job = await m.release.runJobOnce(admitted.job.id);
    expect(job.status, `roll forward: ${job.error ?? ""}`).toBe("succeeded");
    expect(m.authority.authority().repos.apps.get(app.id)?.activeReleaseId).toBe(r2.releaseId);
    expect((await records()).length, "still four records").toBe(4);
  }, 120_000);
});
