/**
 * Event dedupe, and the quota, usage, artifact, release and backup rows the
 * rest of the hosted subsystem measures itself with.
 *
 * The dedupe test is the one that matters: every hosted operation is safe to
 * retry, so an analytics table that counted attempts would report activity
 * that never happened.
 *
 * Workstream W1 (hosted R3).
 */
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-authority-events-");

const { closeAuthority, openAuthority, utcDay } = await import("@/lib/hosted/authority");
const { iso, seedApp, seedRelease, uuid } = await import("./_helpers");

const a = openAuthority();

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

describe("event dedupe", () => {
  it("records one row per (event, logical id) and answers with the row that already existed", () => {
    const app = seedApp(a, { slug: "events-app" });
    const logicalId = `write-${uuid()}`;
    const write = (id: string) =>
      a.tx(() =>
        a.repos.events.append({
          id,
          event: "record.created",
          workspaceId: "ws-one",
          appId: app.id,
          outcome: "ok",
          logicalId,
          assisted: false,
          actorClass: "external",
          props: { attempt: 1 },
        })
      );

    const first = write("event-1");
    const retry = write("event-2");

    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    expect(retry.event.id).toBe("event-1");
    expect(a.repos.events.count({ appId: app.id })).toBe(1);
    expect(a.repos.events.listSince({ appId: app.id })[0]).toMatchObject({
      id: "event-1",
      event: "record.created",
      outcome: "ok",
      assisted: false,
      actorClass: "external",
      props: { attempt: 1 },
    });
  });

  it("dedupes per event name, not across the whole log", () => {
    const app = seedApp(a, { slug: "events-app-2" });
    const logicalId = `job-${uuid()}`;
    const append = (id: string, event: "build.started" | "build.succeeded") =>
      a.tx(() =>
        a.repos.events.append({
          id,
          event,
          workspaceId: "ws-one",
          appId: app.id,
          outcome: "ok",
          logicalId,
          assisted: true,
          actorClass: "founder",
        })
      );

    expect(append("b1", "build.started").inserted).toBe(true);
    expect(append("b2", "build.succeeded").inserted).toBe(true);
    expect(append("b3", "build.started").inserted).toBe(false);
    expect(a.repos.events.count({ appId: app.id })).toBe(2);
  });

  it("never dedupes rows that name no logical operation", () => {
    const app = seedApp(a, { slug: "events-app-3" });
    const append = (id: string) =>
      a.tx(() =>
        a.repos.events.append({
          id,
          event: "access.denied",
          workspaceId: "ws-one",
          appId: app.id,
          outcome: "denied",
          assisted: false,
          actorClass: "external",
        })
      );

    expect(append("d1").inserted).toBe(true);
    expect(append("d2").inserted).toBe(true);
    expect(a.repos.events.count({ appId: app.id, event: "access.denied" })).toBe(2);
  });

  it("filters by workspace, app, event and time with one shared predicate", () => {
    const mine = seedApp(a, { slug: "events-app-4", workspaceId: "ws-filter" });
    const before = iso(-60_000);
    a.tx(() => {
      a.repos.events.append({
        id: uuid(),
        event: "app.opened",
        workspaceId: "ws-filter",
        appId: mine.id,
        outcome: "ok",
        assisted: false,
        actorClass: "external",
        ts: before,
      });
      a.repos.events.append({
        id: uuid(),
        event: "app.opened",
        workspaceId: "ws-filter",
        appId: mine.id,
        outcome: "ok",
        assisted: false,
        actorClass: "external",
      });
    });

    const cutoff = iso(-30_000);
    expect(a.repos.events.count({ workspaceId: "ws-filter" })).toBe(2);
    expect(a.repos.events.count({ workspaceId: "ws-filter", since: cutoff })).toBe(1);
    expect(a.repos.events.listSince({ workspaceId: "ws-filter", since: cutoff })).toHaveLength(1);
    expect(a.repos.events.count({ workspaceId: "ws-nothing-here" })).toBe(0);
  });
});

describe("quota counters", () => {
  it("counts every request atomically and answers with the totals that committed", () => {
    const app = seedApp(a, { slug: "quota-app" });
    const day = utcDay();

    expect(a.repos.quotas.get(app.id, day)).toEqual({ appId: app.id, day, requests: 0, denied: 0 });
    expect(a.tx(() => a.repos.quotas.increment(app.id, day, false))).toEqual({
      appId: app.id,
      day,
      requests: 1,
      denied: 0,
    });
    expect(a.tx(() => a.repos.quotas.increment(app.id, day, true))).toEqual({
      appId: app.id,
      day,
      requests: 2,
      denied: 1,
    });

    // A denial still counts as a request, per PLAN-R3 R3-12.
    const other = utcDay(Date.now() + 86_400_000);
    expect(a.tx(() => a.repos.quotas.increment(app.id, other, false)).requests).toBe(1);
    expect(a.repos.quotas.get(app.id, day).requests).toBe(2);
    expect(a.repos.quotas.listByApp(app.id).map((c) => c.day)).toEqual([other, day]);
  });
});

describe("usage ledger", () => {
  it("totals only the slice it was asked about", () => {
    const app = seedApp(a, { slug: "usage-app", workspaceId: "ws-usage" });
    const sibling = seedApp(a, { slug: "usage-app-2", workspaceId: "ws-usage" });
    const at = iso();
    a.tx(() => {
      a.repos.usage.append({ id: uuid(), workspaceId: "ws-usage", appId: app.id, kind: "provider_usd", amount: 1.5, at });
      a.repos.usage.append({ id: uuid(), workspaceId: "ws-usage", appId: app.id, kind: "provider_usd", amount: 2.25, at });
      a.repos.usage.append({ id: uuid(), workspaceId: "ws-usage", appId: sibling.id, kind: "provider_usd", amount: 4, at });
      a.repos.usage.append({ id: uuid(), workspaceId: "ws-usage", appId: app.id, kind: "build_ms", amount: 900, at });
      a.repos.usage.append({
        id: uuid(),
        workspaceId: "ws-usage",
        kind: "provider_usd",
        amount: 100,
        at: iso(-86_400_000),
      });
    });

    const since = iso(-60_000);
    expect(a.repos.usage.sumSince({ workspaceId: "ws-usage", kind: "provider_usd", since })).toBe(7.75);
    expect(
      a.repos.usage.sumSince({ workspaceId: "ws-usage", appId: app.id, kind: "provider_usd", since })
    ).toBe(3.75);
    expect(a.repos.usage.sumSince({ workspaceId: "ws-usage", kind: "emails", since })).toBe(0);
    expect(a.repos.usage.listSince({ workspaceId: "ws-usage", since })).toHaveLength(4);
  });
});

describe("artifacts, releases and backup manifests", () => {
  it("indexes an artifact once and never replaces it", () => {
    const app = seedApp(a, { slug: "artifact-app" });
    const release = seedRelease(a, app.id);
    const artifact = a.repos.artifacts.get(release.artifactDigest);
    expect(artifact).toMatchObject({ byteSize: 1024, fileCount: 3, verifiedAt: undefined });

    const again = a.tx(() =>
      a.repos.artifacts.insert({
        digest: release.artifactDigest,
        byteSize: 999_999,
        fileCount: 1,
        provenance: artifact!.provenance,
      })
    );
    expect(again.inserted).toBe(false);
    expect(a.repos.artifacts.get(release.artifactDigest)?.byteSize).toBe(1024);

    expect(a.tx(() => a.repos.artifacts.markVerified(release.artifactDigest))).toBe(true);
    expect(a.repos.artifacts.get(release.artifactDigest)?.verifiedAt).toBeTruthy();
  });

  it("numbers releases per app and supersedes the previous active one", () => {
    const app = seedApp(a, { slug: "release-app" });
    const sibling = seedApp(a, { slug: "release-app-2" });
    const first = seedRelease(a, app.id);
    const second = seedRelease(a, app.id);
    const elsewhere = seedRelease(a, sibling.id);

    expect([first.number, second.number, elsewhere.number]).toEqual([1, 2, 1]);
    expect(a.repos.releases.nextNumber(app.id)).toBe(3);

    a.tx(() => a.repos.releases.setStatus(first.id, "active", { activatedAt: iso() }));
    a.tx(() => a.repos.releases.setStatus(second.id, "active", { activatedAt: iso() }));
    expect(a.tx(() => a.repos.releases.markSuperseded(app.id, second.id))).toBe(1);
    expect(a.repos.releases.get(first.id)).toMatchObject({ status: "superseded" });
    expect(a.repos.releases.get(first.id)?.supersededAt).toBeTruthy();
    expect(a.repos.releases.get(second.id)?.status).toBe("active");
    expect(a.repos.releases.get(elsewhere.id)?.status).toBe("candidate");

    a.tx(() =>
      a.repos.releases.setProbe(second.id, {
        ok: true,
        checkedAt: iso(),
        checks: [{ id: "index", ok: true, detail: "200" }],
        testDatabase: "disposable",
      })
    );
    expect(a.repos.releases.get(second.id)?.probe).toMatchObject({ ok: true });
  });

  it("keeps the newest backup manifest and the revocation sequence it covers", () => {
    a.tx(() => {
      a.repos.backups.insert({
        id: "backup-1",
        digest: "a".repeat(64),
        byteSize: 10,
        files: [{ name: "control.sqlite", sha256: "b".repeat(64), bytes: 10 }],
        revocationSeq: 0,
        keyId: "key-2026-09",
        createdAt: iso(-60_000),
      });
      a.repos.backups.insert({
        id: "backup-2",
        digest: "c".repeat(64),
        byteSize: 20,
        files: [],
        revocationSeq: 7,
        keyId: "key-2026-09",
      });
    });

    expect(a.repos.backups.latest()).toMatchObject({ id: "backup-2", revocationSeq: 7 });
    expect(a.repos.backups.list().map((m) => m.id)).toEqual(["backup-2", "backup-1"]);
    expect(a.repos.backups.list()[1].files[0]).toMatchObject({ name: "control.sqlite", bytes: 10 });
  });
});
