/**
 * Gate 6 — quotas, the body cap, single-flight, the pilot-wide build ceiling,
 * and what suspension does and does not destroy.
 *
 * The daily quota is checked from both ends. `admitRequest` is driven directly
 * with a low ceiling, because that is the only way to watch the boundary
 * itself — the request numbered exactly `limit` is the last one admitted, and
 * the one after it is counted *and* denied. Then the app's real counter row is
 * moved to the real ceiling through the authority and a real gateway request
 * is made, so the mapping from "the counter says no" to "429 with a
 * `retry-after`" is exercised end to end rather than assumed.
 *
 * Suspension is the opposite kind of claim: that nothing is lost. Records,
 * grants, releases and the artifact are all counted and compared before and
 * after, the app is resumed, and it serves the same release again.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { ArtifactStore, HostedApp } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  errorBody,
  loadHosted,
  publishOrThrow,
  releaseOf,
  signIn,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate06-");
acceptanceEnv(DATA);

let m: HostedModules;
let store: ArtifactStore;
let alpha: HostedApp;
let digest = "";
let releaseId = "";
let cookie = "";
const flight: Record<string, HostedApp> = {};

const OWNER = IDENTITIES.owner;
const EDITOR = IDENTITIES.editor;
const HOST = appHost("alpha");
const ORIGIN = appOrigin("alpha");

beforeAll(async () => {
  m = await loadHosted();
  m.authority.openAuthority();
  store = new m.artifacts.FsArtifactStore(m.config.hostedConfig().artifactDir);

  alpha = await m.release.createApp({
    workspaceId: WORKSPACES.one.id,
    slug: "alpha",
    name: "Alpha equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });
  const job = await publishOrThrow(m, {
    app: alpha,
    actor: OWNER.subject,
    source: { kind: "fixture", name: "minimal-app" },
  });
  ({ digest, releaseId } = releaseOf(job));

  await m.access.grantDirect(alpha.id, { subject: EDITOR.subject, email: EDITOR.email, role: "editor" }, OWNER.subject);
  cookie = await signIn(m, alpha, OWNER.subject);

  for (const slug of ["flighta", "flightb", "flightc"])
    flight[slug] = await m.release.createApp({
      workspaceId: WORKSPACES.one.id,
      slug,
      name: `Build slot ${slug}`,
      createdBy: OWNER.subject,
      email: OWNER.email,
    });
}, 300_000);

afterAll(async () => {
  await closeHosted(m);
  removeDir(DATA);
});

describe("Gate 6 — quotas, limits, single-flight and suspension", () => {
  it("admits exactly `limit` requests in a UTC day and counts the refusals", async () => {
    const day = m.authority.utcDay();
    await m.quota.resetDayForTests(alpha.id, day);

    const verdicts = [];
    for (const _ of [1, 2, 3, 4]) verdicts.push(await m.quota.admitRequest(alpha.id, { limit: 3 }));
    expect(
      verdicts.map((v) => v.allowed),
      "the request numbered exactly `limit` is the last one admitted"
    ).toEqual([true, true, true, false]);
    expect(verdicts.map((v) => v.counter.requests), "consecutive positions in the day").toEqual([
      1, 2, 3, 4,
    ]);
    expect(verdicts[3].counter.denied, "a refusal is counted as a refusal too").toBe(1);
    expect(verdicts[3].limit).toBe(3);

    // The number lives in SQLite, not in this process.
    const row = await m.authority.authority().repos.quotas.get(alpha.id, day);
    expect(row.requests).toBe(4);
    expect(row.denied).toBe(1);
    await m.quota.resetDayForTests(alpha.id, day);
  });

  it("maps a counter that is already at the ceiling to a 429 on the app host", async () => {
    const day = m.authority.utcDay();
    const limit = m.contracts.DEFAULT_LIMITS.requestsPerDay;
    await m.quota.resetDayForTests(alpha.id, day);
    // Put today's row at the ceiling through the authority, as a day of real
    // traffic would have. The next request is the one over the line.
    m.authority
      .sqliteConnection(m.authority.authority())
      .prepare(
        "INSERT INTO quota_counters (app_id, day, requests, denied) VALUES (?, ?, ?, 0) " +
          "ON CONFLICT (app_id, day) DO UPDATE SET requests = excluded.requests"
      )
      .run(alpha.id, day, limit);

    await m.gateway.resetGatewayTelemetry();
    const one = call({ host: HOST, path: "/", cookie, accept: "application/json" });
    const res = await m.gateway.handleGateway(one.req, one.params);
    expect(res.status, "over the daily ceiling").toBe(429);
    const body = await errorBody(res);
    expect(body.code).toBe("quota_exceeded");
    expect(body.message, "the refusal names the ceiling").toContain(String(limit));
    expect(body.fix, "and when it resets").toMatch(/00:00 UTC/);
    const retry = Number(res.headers.get("retry-after"));
    expect(Number.isFinite(retry) && retry > 0, `retry-after was ${res.headers.get("retry-after")}`).toBe(
      true
    );
    expect(retry, "retry-after is seconds to the next UTC midnight").toBeLessThanOrEqual(86_400);
    expect(m.gateway.gatewayTelemetry.artifactServed, "nothing was served").toBe(0);
    expect(m.gateway.gatewayTelemetry.brokerInvoked, "nothing was brokered").toBe(0);

    // The refused request is itself counted, both ways.
    const after = await m.authority.authority().repos.quotas.get(alpha.id, day);
    expect(after.requests).toBe(limit + 1);
    expect(after.denied).toBe(1);

    await m.quota.resetDayForTests(alpha.id, day);
    const again = call({ host: HOST, path: "/", cookie, accept: "application/json" });
    expect(
      (await m.gateway.handleGateway(again.req, again.params)).status,
      "with the day cleared, the same request is served"
    ).toBe(200);
  });

  it("refuses a body over one megabyte with 413, without storing any of it", async () => {
    const limit = m.contracts.DEFAULT_LIMITS.bodyBytes;
    const before = (
      await m.authority
        .authority()
        .repos.events.listSince({ appId: alpha.id, event: "record.created" }, { limit: 500 })
    ).length;

    const oversize = JSON.stringify({
      writeId: uuid(),
      record: { title: "Big", category: "laptop", details: "x".repeat(limit) },
    });
    expect(Buffer.byteLength(oversize), "the fixture body must actually be over the cap").toBeGreaterThan(
      limit
    );

    await m.gateway.resetGatewayTelemetry();
    const one = call({
      host: HOST,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie,
      origin: ORIGIN,
      accept: "application/json",
      body: oversize,
    });
    const res = await m.gateway.handleGateway(one.req, one.params);
    expect(res.status, "a body over the cap").toBe(413);
    const body = await errorBody(res);
    expect(body.code).toBe("body_too_large");
    expect(body.fix ?? body.message, "the refusal names the ceiling").toContain(String(limit));
    expect(
      (await m.authority.authority().repos.events.listSince(
        { appId: alpha.id, event: "record.created" },
        { limit: 500 }
      )).length,
      "nothing was created"
    ).toBe(before);

    // The other half of the cap: a chunked body has no `Content-Length` to
    // check, so the reader has to stop counting at one byte past the limit.
    // Sending it as a stream is the only way to exercise that path.
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = Buffer.from(oversize, "utf8");
        for (let at = 0; at < bytes.length; at += 65_536)
          controller.enqueue(new Uint8Array(bytes.subarray(at, at + 65_536)));
        controller.close();
      },
    });
    const chunked = new NextRequest(`http://${HOST}/_zenith/data/v1/requests`, {
      method: "POST",
      headers: {
        host: HOST,
        cookie,
        origin: ORIGIN,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: streamed,
      // Required by undici whenever the body is a stream.
      duplex: "half",
    });
    expect(
      chunked.headers.get("content-length"),
      "the streaming case is only meaningful without a Content-Length"
    ).toBeNull();
    const chunkedRes = await m.gateway.handleGateway(chunked, {
      host: HOST,
      path: ["_zenith", "data", "v1", "requests"],
    });
    expect(chunkedRes.status, "a chunked body over the cap").toBe(413);
    expect((await errorBody(chunkedRes)).code).toBe("body_too_large");

    // A body just under the cap is accepted, so the refusal is the cap and not
    // the route.
    const fits = JSON.stringify({
      writeId: uuid(),
      record: { title: "Fits", category: "laptop", details: "y".repeat(1000) },
    });
    const ok = call({
      host: HOST,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie,
      origin: ORIGIN,
      accept: "application/json",
      body: fits,
    });
    expect((await m.gateway.handleGateway(ok.req, ok.params)).status).toBe(201);
  });

  it("measures storage as the logical bytes it says it measures", async () => {
    const { store: appStore } = await m.data.openAppData(alpha.id);
    expect(appStore.storageLimitBytes, "the ceiling an owner is told about").toBe(
      m.contracts.DEFAULT_LIMITS.storageBytes
    );
    expect(
      m.data.LOGICAL_BYTES_DISCLOSURE,
      "and it says which bytes it counts, so nobody reads it as disk usage"
    ).toMatch(/logical bytes/);
    expect(m.data.LOGICAL_BYTES_DISCLOSURE).toMatch(/not the physical size of the database file/);

    const before = await appStore.storageBytes(alpha.id);
    const one = call({
      host: HOST,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({
        writeId: uuid(),
        record: { title: "Measured", category: "laptop", details: "z".repeat(500) },
      }),
    });
    expect((await m.gateway.handleGateway(one.req, one.params)).status).toBe(201);
    const after = await appStore.storageBytes(alpha.id);
    expect(after, "a record moves the number it is measured by").toBeGreaterThan(before);
    expect(after - before, "and by roughly what it stored, not by a page of the file").toBeLessThan(
      2000
    );
  });

  /* ------------------------------ suspension ------------------------------ */

  it("keeps every record, grant, release and artifact byte across a suspension", async () => {
    const a = m.authority.authority();

    // Something worth keeping.
    for (const title of ["Desk lamp", "Docking station"]) {
      const one = call({
        host: HOST,
        path: "/_zenith/data/v1/requests",
        method: "POST",
        cookie,
        origin: ORIGIN,
        accept: "application/json",
        body: JSON.stringify({ writeId: uuid(), record: { title, category: "other" } }),
      });
      expect((await m.gateway.handleGateway(one.req, one.params)).status).toBe(201);
    }

    const snapshot = async () => ({
      records: ((await (async () => {
        const read = call({
          host: HOST,
          path: "/_zenith/data/v1/requests?limit=100",
          cookie,
          accept: "application/json",
        });
        const res = await m.gateway.handleGateway(read.req, read.params);
        return res.status === 200
          ? ((await res.json()) as { items: { id: string; title: string; version: number }[] }).items
          : null;
      })()) ?? []).map((item) => `${item.id}:${item.title}:${item.version}`).sort(),
      grants: (await a.repos.grants.listByApp(alpha.id))
        .map((grant) => `${grant.id}:${grant.role}:${grant.state}`)
        .sort(),
      releases: (await a.repos.releases.listByApp(alpha.id)).map((r) => `${r.id}:${r.status}`).sort(),
      artifactOk: (await store.verify(digest)).ok,
      storageBytes: await m.data.openAppData(alpha.id).store.storageBytes(alpha.id),
    });

    const before = await snapshot();
    expect(before.records.length, "there is something to preserve").toBeGreaterThan(2);

    const suspend = await m.release.admitSuspend({
      jobId: uuid(),
      appId: alpha.id,
      workspaceId: alpha.workspaceId,
      actor: OWNER.subject,
      reason: "acceptance run: pausing on purpose",
    });
    const suspended = await m.release.runJobOnce(suspend.job.id);
    expect(suspended.status, `suspend: ${suspended.error ?? ""}`).toBe("succeeded");
    expect((await a.repos.apps.get(alpha.id))?.state).toBe("suspended");

    // Nothing serves, including to the owner who suspended it.
    const denied = call({ host: HOST, path: "/", cookie, accept: "application/json" });
    const res = await m.gateway.handleGateway(denied.req, denied.params);
    expect(res.status).toBe(423);
    expect((await errorBody(res)).code).toBe("suspended");

    // But every row and every byte is still there, read straight from the store.
    const a2 = m.authority.authority();
    expect(
      (await a2.repos.grants.listByApp(alpha.id)).map((g) => `${g.id}:${g.role}:${g.state}`).sort(),
      "grants across a suspension"
    ).toEqual(before.grants);
    expect(
      (await a2.repos.releases.listByApp(alpha.id)).map((r) => `${r.id}:${r.status}`).sort(),
      "releases across a suspension"
    ).toEqual(before.releases);
    expect((await store.verify(digest)).ok, "the artifact across a suspension").toBe(true);
    expect(
      await m.data.openAppData(alpha.id).store.storageBytes(alpha.id),
      "logical bytes across a suspension"
    ).toBe(before.storageBytes);

    // Resume, sign in again (suspension ended the sessions), and it serves.
    const resume = await m.release.admitResume({
      jobId: uuid(),
      appId: alpha.id,
      workspaceId: alpha.workspaceId,
      actor: OWNER.subject,
    });
    const resumed = await m.release.runJobOnce(resume.job.id);
    expect(resumed.status, `resume: ${resumed.error ?? ""}`).toBe("succeeded");
    expect((await a2.repos.apps.get(alpha.id))?.state).toBe("active");
    expect((await a2.repos.apps.get(alpha.id))?.activeReleaseId, "the same release is live").toBe(releaseId);

    cookie = await signIn(m, alpha, OWNER.subject);
    const after = await snapshot();
    expect(after.records, "every record survived, at the version it had").toEqual(before.records);
    expect(after.grants).toEqual(before.grants);
    expect(after.releases).toEqual(before.releases);
    expect(after.artifactOk).toBe(true);
  }, 120_000);

  it("ended the app's live sessions when it was suspended, rather than leaving them dangling", async () => {
    const rows = m.authority
      .sqliteConnection(m.authority.authority())
      .prepare(
        "SELECT terminated_reason AS reason, COUNT(*) AS n FROM app_sessions WHERE app_id = ? AND terminated_at IS NOT NULL GROUP BY terminated_reason"
      )
      .all(alpha.id)
      .map((row) => String(row.reason));
    expect(rows, "suspension is recorded as the reason a session ended").toContain("operator");
  });

  /* ----------------------------- build slots ----------------------------- */

  it("runs one job per app and two across the install, and queues the rest", async () => {
    const queue = async (app: HostedApp): Promise<string> => {
      const jobId = uuid();
      await m.release.admitPublish({
        jobId,
        appId: app.id,
        workspaceId: app.workspaceId,
        actor: OWNER.subject,
        source: { kind: "fixture", name: "minimal-app" },
      });
      return jobId;
    };

    const a1 = await queue(flight.flighta);
    const a2 = await queue(flight.flighta);
    const b1 = await queue(flight.flightb);
    const c1 = await queue(flight.flightc);
    const a = m.authority.authority();

    expect(await m.release.claimJob(a1), "the first job for an app takes its slot").not.toBeNull();
    expect(await m.release.claimJob(a2), "the second job for the same app waits").toBeNull();
    expect((await a.repos.jobs.get(a2))?.status, "and stays queued rather than failing").toBe("queued");
    // The authority itself refuses it, so the check above is a courtesy.
    await expect(a.repos.jobs.claim(a2, "another-worker", 60_000)).rejects.toThrowError(
      /Another job is already running for this app/
    );

    expect((await m.release.buildSlot(flight.flightb.id)).ok, "the second pilot slot").toBe(true);
    expect(await m.release.claimJob(b1)).not.toBeNull();
    expect(await a.repos.jobs.countRunning()).toBe(2);

    const third = await m.release.buildSlot(flight.flightc.id);
    expect(third.ok, `a third app must wait: ${third.reason ?? ""}`).toBe(false);
    expect(third.reason).toContain(
      `${m.contracts.DEFAULT_LIMITS.buildsPilotWide} at a time`
    );
    expect(await m.release.claimJob(c1), "and it is not claimed").toBeNull();
    await m.release.tickJobs();
    expect((await a.repos.jobs.get(c1))?.status, "a tick with no room changes nothing").toBe("queued");

    await a.repos.jobs.cancel(b1, "acceptance run finished with this slot");
    expect((await m.release.buildSlot(flight.flightc.id)).ok, "freeing a slot lets the queue move").toBe(true);
    expect(await m.release.claimJob(c1)).not.toBeNull();

    // Leave nothing running behind this test.
    for (const jobId of [a1, a2, c1]) await a.repos.jobs.cancel(jobId, "acceptance run teardown");
    expect(await a.repos.jobs.countRunning()).toBe(0);
  });

  it("refuses a publish for a suspended app rather than queueing it for later", async () => {
    const suspend = await m.release.admitSuspend({
      jobId: uuid(),
      appId: flight.flighta.id,
      workspaceId: flight.flighta.workspaceId,
      actor: OWNER.subject,
      reason: "closed for the slot test",
    });
    expect((await m.release.runJobOnce(suspend.job.id)).status).toBe("succeeded");

    await expect(
      m.release.admitPublish({
        jobId: uuid(),
        appId: flight.flighta.id,
        workspaceId: flight.flighta.workspaceId,
        actor: OWNER.subject,
        source: { kind: "fixture", name: "minimal-app" },
      })
    ).rejects.toMatchObject({ code: "suspended" });
  });
});
