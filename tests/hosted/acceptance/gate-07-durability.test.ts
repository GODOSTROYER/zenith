/**
 * Gate 7 — what was acknowledged is still there after the authority is closed
 * and reopened, and a retried write is one row rather than two.
 *
 * "Acknowledged" here means what the contract says it means: the request
 * returned. Every record below was created through the real gateway, over the
 * real broker, into the real per-app SQLite file; every grant went through the
 * real access module. Then both connections are closed — the control authority
 * and every app database — and reopened from the files on disk, and the same
 * reads are done again.
 *
 * The replay half is the other durability property. A client that never saw
 * the 201 retries with the same write id: the platform must answer with the
 * record it already made, mark it as a replay, and *not* make a second one.
 * That is checked both immediately and across the reopen, because a write
 * ledger held only in memory would pass the first and fail the second.
 *
 * A caveat this file states rather than hides: closing a database is not a
 * crash and a crash is not power loss. See ACCEPTANCE-R3.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { HostedApp } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  OUTSIDER,
  RECIPIENT,
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  loadHosted,
  publishOrThrow,
  releaseOf,
  signIn,
  verifiedIdentity,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate07-");
acceptanceEnv(DATA);

let m: HostedModules;
let app: HostedApp;
let releaseId = "";
let digest = "";
let cookie = "";

const OWNER = IDENTITIES.owner;
const EDITOR = IDENTITIES.editor;
const HOST = appHost("alpha");
const ORIGIN = appOrigin("alpha");

/** The write ids this run uses, so a replay can be asked for by name. */
const WRITE_IDS = { first: uuid(), second: uuid(), lostAck: uuid() };
const created: Record<string, string> = {};

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
  const job = await publishOrThrow(m, {
    app,
    actor: OWNER.subject,
    source: { kind: "fixture", name: "minimal-app" },
  });
  ({ releaseId, digest } = releaseOf(job));
  cookie = await signIn(m, app, OWNER.subject);
}, 300_000);

afterAll(() => {
  closeHosted(m);
  removeDir(DATA);
});

/** Create one equipment request through the gateway, with a stated write id. */
async function createWith(writeId: string, title: string): Promise<Response> {
  const one = call({
    host: HOST,
    path: "/_zenith/data/v1/requests",
    method: "POST",
    cookie,
    origin: ORIGIN,
    accept: "application/json",
    body: JSON.stringify({ writeId, record: { title, category: "laptop", quantity: 2 } }),
  });
  return m.gateway.handleGateway(one.req, one.params);
}

/** Read the app's own database directly, without going through the store. */
function readAppDb<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(m.data.appDataPath(app.id, "data"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

describe("Gate 7 — acknowledged work survives a reopen", () => {
  it("acknowledges records and grants that are really on disk", async () => {
    for (const [key, title] of [
      [WRITE_IDS.first, "Standing desk"],
      [WRITE_IDS.second, "Second monitor"],
    ] as const) {
      const res = await createWith(key, title);
      expect(res.status, `creating ${title}`).toBe(201);
      expect(res.headers.get("x-zenith-replayed"), "a first write is not a replay").toBeNull();
      created[key] = ((await res.json()) as { record: { id: string } }).record.id;
    }

    // Grants two ways: a direct grant and an accepted invitation.
    m.access.grantDirect(app.id, { subject: EDITOR.subject, email: EDITOR.email, role: "editor" }, OWNER.subject);
    const issued = m.access.createInvite(app.id, { email: RECIPIENT.email, role: "viewer" }, OWNER.subject);
    m.access.acceptInvite(
      new URL(issued.acceptUrl).searchParams.get("token") as string,
      verifiedIdentity(RECIPIENT)
    );
    // And one that is revoked, so the *absence* has to survive too.
    const doomed = m.access.grantDirect(
      app.id,
      { subject: OUTSIDER.subject, email: OUTSIDER.email, role: "editor" },
      OWNER.subject
    );
    m.access.revokeGrant(doomed.id, OWNER.subject, "left the pilot", { appId: app.id });

    expect(m.access.listGrants(app.id).length, "four grants, one of them revoked").toBe(4);
    expect(readAppDb((db) => Number(db.prepare("SELECT COUNT(*) AS n FROM equipment_requests").get()?.n))).toBe(
      2
    );
  });

  it("answers a retried write with the record it already made, and makes no second one", async () => {
    const before = readAppDb((db) => Number(db.prepare("SELECT COUNT(*) AS n FROM equipment_requests").get()?.n));
    const res = await createWith(WRITE_IDS.first, "Standing desk");
    expect(res.status, "a replay answers as the original did").toBe(201);
    expect(res.headers.get("x-zenith-replayed"), "and says it was a replay").toBe("true");
    const record = ((await res.json()) as { record: { id: string; version: number } }).record;
    expect(record.id, "the same record, not a new one").toBe(created[WRITE_IDS.first]);
    expect(record.version).toBe(1);
    expect(
      readAppDb((db) => Number(db.prepare("SELECT COUNT(*) AS n FROM equipment_requests").get()?.n)),
      "the row count after the retry"
    ).toBe(before);
  });

  /* -------------------------------- reopen -------------------------------- */

  it("finds every app, grant, release, record and counter after closing and reopening", async () => {
    const a = m.authority.authority();
    const before = {
      apps: a.repos.apps.listByWorkspace(WORKSPACES.one.id).map((one) => one.id).sort(),
      grants: m.access.listGrants(app.id).map((g) => `${g.id}:${g.role}:${g.state}`).sort(),
      releases: a.repos.releases.listByApp(app.id).map((r) => `${r.id}:${r.status}`).sort(),
      quota: a.repos.quotas.get(app.id, m.authority.utcDay()).requests,
      events: a.repos.events.listSince({ appId: app.id }, { limit: 500 }).length,
      records: readAppDb((db) =>
        db
          .prepare("SELECT id, title, version FROM equipment_requests ORDER BY id")
          .all()
          .map((row) => `${String(row.id)}:${String(row.title)}:${Number(row.version)}`)
      ),
      storage: await m.data.openAppData(app.id).store.storageBytes(app.id),
    };

    // Everything this process was holding, let go of.
    m.data.closeAllAppData();
    m.authority.closeAuthority();
    expect(m.authority.authorityOpen(), "the authority really is closed").toBe(false);

    // And opened again from the files that are on disk.
    const reopened = m.authority.openAuthority();
    expect(reopened.path, "the same control database").toContain("control.sqlite");

    expect(
      reopened.repos.apps.listByWorkspace(WORKSPACES.one.id).map((one) => one.id).sort(),
      "apps after the reopen"
    ).toEqual(before.apps);
    expect(
      m.access.listGrants(app.id).map((g) => `${g.id}:${g.role}:${g.state}`).sort(),
      "grants after the reopen, revocation included"
    ).toEqual(before.grants);
    expect(
      reopened.repos.releases.listByApp(app.id).map((r) => `${r.id}:${r.status}`).sort(),
      "releases after the reopen"
    ).toEqual(before.releases);
    expect(
      reopened.repos.quotas.get(app.id, m.authority.utcDay()).requests,
      "the day's counter after the reopen"
    ).toBe(before.quota);
    expect(
      reopened.repos.events.listSince({ appId: app.id }, { limit: 500 }).length,
      "the event log after the reopen"
    ).toBe(before.events);
    expect(
      readAppDb((db) =>
        db
          .prepare("SELECT id, title, version FROM equipment_requests ORDER BY id")
          .all()
          .map((row) => `${String(row.id)}:${String(row.title)}:${Number(row.version)}`)
      ),
      "records after the reopen"
    ).toEqual(before.records);
    expect(
      await m.data.openAppData(app.id).store.storageBytes(app.id),
      "logical bytes after the reopen"
    ).toBe(before.storage);
    expect(
      reopened.repos.apps.get(app.id)?.activeReleaseId,
      "and the app still points at the release it was serving"
    ).toBe(releaseId);
  });

  it("still serves the app, on the same cookie, after the reopen", async () => {
    const one = call({ host: HOST, path: "/", cookie, accept: "application/json" });
    const res = await m.gateway.handleGateway(one.req, one.params);
    expect(res.status, "the session outlived the connection, because it is a row").toBe(200);
    expect(res.headers.get("x-zenith-release")).toBe(releaseId);

    const store = new m.artifacts.FsArtifactStore(m.config.hostedConfig().artifactDir);
    expect((await store.verify(digest)).ok, "and the artifact is still what it was").toBe(true);
  });

  it("replays a write id first seen before the reopen — the lost-ACK case", async () => {
    // The first attempt commits, and the client never sees the answer.
    const first = await createWith(WRITE_IDS.lostAck, "Ergonomic chair");
    expect(first.status).toBe(201);
    const id = ((await first.json()) as { record: { id: string } }).record.id;
    const count = () =>
      readAppDb((db) => Number(db.prepare("SELECT COUNT(*) AS n FROM equipment_requests").get()?.n));
    const before = count();

    // The process goes away before the retry arrives.
    m.data.closeAllAppData();
    m.authority.closeAuthority();
    m.authority.openAuthority();

    const retry = await createWith(WRITE_IDS.lostAck, "Ergonomic chair");
    expect(retry.status, "the retry after the reopen").toBe(201);
    expect(retry.headers.get("x-zenith-replayed"), "and it is answered as a replay").toBe("true");
    expect(((await retry.json()) as { record: { id: string } }).record.id, "the same record").toBe(id);
    expect(count(), "and there is still one row for that write id").toBe(before);

    // The ledger row is what makes that possible, and it is on disk.
    expect(
      readAppDb((db) =>
        Number(db.prepare("SELECT COUNT(*) AS n FROM writes WHERE write_id = ?").get(WRITE_IDS.lostAck)?.n)
      ),
      "one write-ledger row for one write id"
    ).toBe(1);
  });

  it("refuses to replay a write id under a different intent instead of silently accepting it", async () => {
    const different = call({
      host: HOST,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({
        writeId: WRITE_IDS.first,
        record: { title: "Something else entirely", category: "other", quantity: 9 },
      }),
    });
    const res = await m.gateway.handleGateway(different.req, different.params);
    expect(res.status, "the same write id with different content").toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("idempotency_conflict");
  });
});
