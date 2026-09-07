/**
 * Gate 8 — data survives a compatible update, and a stale write is an explicit
 * 409 carrying the record as it stands.
 *
 * Three real publishes of `fixtures/tracker-app`, none of them from the fixture
 * directory after the first: the second and third are tarballs assembled in
 * memory from the same tree with one file edited, so the committed fixture is
 * never touched and the submitted source really is different bytes.
 *
 * The second publish changes only `README.md`, which the build does not emit.
 * That is worth its own assertion: the *source* digest moves, a new release is
 * created and activated, and the artifact is the one the first job stored —
 * content addressing means an identical build is the same artifact, and the
 * pipeline records that it joined one rather than made one.
 *
 * The third changes `index.html`, so the artifact digest really does move. In
 * both cases every equipment request written under the previous release is
 * still there, at the version it had, readable through the new one.
 *
 * Workstream W10 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostedApp, StaleVersionDetails } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  fixtureDir,
  loadHosted,
  publishOrThrow,
  releaseOf,
  signIn,
  tarballBase64,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate08-");
acceptanceEnv(DATA);

let m: HostedModules;
let app: HostedApp;
let ownerCookie = "";
let editorCookie = "";
let r1: { releaseId: string; number: number; digest: string };
let r2: { releaseId: string; number: number; digest: string };
let r3: { releaseId: string; number: number; digest: string };
let contested = "";

const OWNER = IDENTITIES.owner;
const EDITOR = IDENTITIES.editor;
const HOST = appHost("alpha");
const ORIGIN = appOrigin("alpha");

/** Every record the app holds right now, as a comparable fingerprint. */
async function fingerprint(cookie: string): Promise<string[]> {
  const one = call({
    host: HOST,
    path: "/_zenith/data/v1/requests?limit=100",
    cookie,
    accept: "application/json",
  });
  const res = await m.gateway.handleGateway(one.req, one.params);
  if (res.status !== 200) throw new Error(`listing answered ${res.status}: ${await res.text()}`);
  const { items } = (await res.json()) as {
    items: { id: string; title: string; version: number; updatedAt: string }[];
  };
  return items
    .map((item) => `${item.id}|${item.title}|v${item.version}|${item.updatedAt}`)
    .sort();
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
  m.access.grantDirect(app.id, { subject: EDITOR.subject, email: EDITOR.email, role: "editor" }, OWNER.subject);

  r1 = releaseOf(
    await publishOrThrow(m, { app, actor: OWNER.subject, source: { kind: "fixture", name: "tracker-app" } })
  );
  ownerCookie = await signIn(m, app, OWNER.subject);
  editorCookie = await signIn(m, app, EDITOR.subject);
}, 300_000);

afterAll(() => {
  closeHosted(m);
  removeDir(DATA);
});

/** The fixture's README, plus a trailing space: different bytes, same meaning. */
const readmeWithWhitespace = (): string =>
  `${fs.readFileSync(path.join(fixtureDir("tracker-app"), "README.md"), "utf8")}\n`;

describe("Gate 8 — a compatible update leaves the data alone", () => {
  let before: string[] = [];

  it("writes real records under release 1", async () => {
    for (const title of ["Standing desk", "Second monitor", "Docking station"]) {
      const one = call({
        host: HOST,
        path: "/_zenith/data/v1/requests",
        method: "POST",
        cookie: ownerCookie,
        origin: ORIGIN,
        accept: "application/json",
        body: JSON.stringify({ writeId: uuid(), record: { title, category: "furniture" } }),
      });
      const res = await m.gateway.handleGateway(one.req, one.params);
      expect(res.status, `creating ${title}`).toBe(201);
      const record = ((await res.json()) as { record: { id: string } }).record;
      if (title === "Standing desk") contested = record.id;
    }

    // One of them is edited, so a version that is not 1 has to survive too.
    const edit = call({
      host: HOST,
      path: `/_zenith/data/v1/requests/${contested}`,
      method: "PATCH",
      cookie: editorCookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({ writeId: uuid(), expectedVersion: 1, patch: { status: "approved" } }),
    });
    expect((await m.gateway.handleGateway(edit.req, edit.params)).status).toBe(200);

    before = await fingerprint(ownerCookie);
    expect(before.length).toBe(3);
    expect(before.some((line) => line.includes("|v2|")), "one record is at version 2").toBe(true);
  });

  it("publishes release 2 from changed source that builds to the same bytes", async () => {
    const job = await publishOrThrow(m, {
      app,
      actor: OWNER.subject,
      source: {
        kind: "tarball",
        base64: tarballBase64(fixtureDir("tracker-app"), { "README.md": readmeWithWhitespace() }),
      },
    });
    r2 = releaseOf(job);

    expect(r2.number, "the release number moves").toBe(2);
    expect(String(job.phaseData.sourceDigest), "the source digest moves").not.toBe(
      String(m.authority.authority().repos.artifacts.get(r1.digest)?.provenance.sourceDigest)
    );
    expect(r2.digest, "identical output is the same artifact").toBe(r1.digest);
    expect(job.phaseData.artifactReused, "and the pipeline says it joined one").toBe(true);
    expect(
      m.release.jobLogs(job.id).some((line) => line.includes("re-verified")),
      "a reused artifact is re-verified, not trusted"
    ).toBe(true);

    const a = m.authority.authority();
    expect(a.repos.apps.get(app.id)?.activeReleaseId).toBe(r2.releaseId);
    expect(a.repos.apps.get(app.id)?.activeFence, "one activation, one fence step").toBe(2);
    expect(a.repos.releases.get(r1.releaseId)?.status, "release 1 after release 2").toBe("superseded");
    expect(a.repos.releases.get(r1.releaseId)?.supersededAt).toBeTruthy();
  }, 300_000);

  it("still holds every record, at the version it had, under release 2", async () => {
    expect(await fingerprint(ownerCookie), "records across a compatible update").toEqual(before);

    const page = call({ host: HOST, path: "/", cookie: ownerCookie, accept: "text/html" });
    const res = await m.gateway.handleGateway(page.req, page.params);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-zenith-release"), "served by the new release").toBe(r2.releaseId);
  });

  it("publishes release 3 whose output really is different bytes, and keeps the data", async () => {
    const index = fs.readFileSync(path.join(fixtureDir("tracker-app"), "index.html"), "utf8");
    const job = await publishOrThrow(m, {
      app,
      actor: OWNER.subject,
      source: {
        kind: "tarball",
        base64: tarballBase64(fixtureDir("tracker-app"), {
          "index.html": index.replace("</head>", "  <meta name=\"acceptance\" content=\"gate-08\">\n  </head>"),
        }),
      },
    });
    r3 = releaseOf(job);

    expect(r3.number).toBe(3);
    expect(r3.digest, "a changed entry document is a different artifact").not.toBe(r2.digest);
    expect(job.phaseData.artifactReused, "and this one was made, not joined").toBe(false);

    const store = new m.artifacts.FsArtifactStore(m.config.hostedConfig().artifactDir);
    expect((await store.verify(r3.digest)).ok, "the new artifact verifies").toBe(true);
    expect(
      (await store.verify(r1.digest)).ok,
      "and the old one is still there, so a rollback has something to go back to"
    ).toBe(true);

    const page = call({ host: HOST, path: "/", cookie: ownerCookie, accept: "text/html" });
    const res = await m.gateway.handleGateway(page.req, page.params);
    expect(res.headers.get("x-zenith-release")).toBe(r3.releaseId);
    expect(await res.text(), "the new bytes are what is served").toContain('content="gate-08"');

    expect(await fingerprint(ownerCookie), "records across the second update").toEqual(before);
  }, 300_000);

  it("kept the app on one data schema throughout, which is what made the update compatible", async () => {
    const version = await m.data.openAppData(app.id).store.schemaVersion(app.id);
    expect(version).toBe(m.data.LATEST_TRACKER_SCHEMA_VERSION);
    for (const release of m.authority.authority().repos.releases.listByApp(app.id))
      expect(
        m.authority.authority().repos.artifacts.get(release.artifactDigest)?.provenance.schemaVersion,
        `release ${release.number} was built for schema 1`
      ).toBe(1);
  });

  /* -------------------------------- conflict ------------------------------ */

  it("refuses a second editor's stale write with 409 and the record as it stands", async () => {
    // Both editors read version 2.
    const read = call({
      host: HOST,
      path: `/_zenith/data/v1/requests/${contested}`,
      cookie: editorCookie,
      accept: "application/json",
    });
    const current = ((await (await m.gateway.handleGateway(read.req, read.params)).json()) as {
      record: { version: number };
    }).record;
    expect(current.version).toBe(2);

    // The owner writes first.
    const firstWrite = call({
      host: HOST,
      path: `/_zenith/data/v1/requests/${contested}`,
      method: "PATCH",
      cookie: ownerCookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({ writeId: uuid(), expectedVersion: 2, patch: { quantity: 4 } }),
    });
    expect((await m.gateway.handleGateway(firstWrite.req, firstWrite.params)).status).toBe(200);

    // The editor writes against the version they read, and is refused with it.
    const stale = call({
      host: HOST,
      path: `/_zenith/data/v1/requests/${contested}`,
      method: "PATCH",
      cookie: editorCookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({ writeId: uuid(), expectedVersion: 2, patch: { priority: "high" } }),
    });
    const res = await m.gateway.handleGateway(stale.req, stale.params);
    expect(res.status, "a stale write").toBe(409);

    const body = (await res.json()) as {
      error: { code: string; message: string; fix?: string; details: StaleVersionDetails };
    };
    expect(body.error.code).toBe("stale_version");
    expect(body.error.details.expectedVersion, "what the caller thought it was editing").toBe(2);
    expect(body.error.details.current.version, "what it actually is now").toBe(3);
    expect(body.error.details.current.quantity, "the other editor's change is in the payload").toBe(4);
    expect(body.error.details.current.updatedByEmail).toBe(OWNER.email);
    expect(body.error.fix, "and the refusal says how to settle it").toMatch(/new writeId/);

    // Nothing of the refused write was applied, not even its write id.
    const after = call({
      host: HOST,
      path: `/_zenith/data/v1/requests/${contested}`,
      cookie: ownerCookie,
      accept: "application/json",
    });
    const settled = ((await (await m.gateway.handleGateway(after.req, after.params)).json()) as {
      record: { version: number; priority: string; quantity: number };
    }).record;
    expect(settled.version).toBe(3);
    expect(settled.priority, "the refused patch was not applied").not.toBe("high");
    expect(settled.quantity).toBe(4);

    // The rebase succeeds, which is what the 409 was telling the caller to do.
    const rebased = call({
      host: HOST,
      path: `/_zenith/data/v1/requests/${contested}`,
      method: "PATCH",
      cookie: editorCookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({ writeId: uuid(), expectedVersion: 3, patch: { priority: "high" } }),
    });
    const done = await m.gateway.handleGateway(rebased.req, rebased.params);
    expect(done.status).toBe(200);
    expect(((await done.json()) as { record: { version: number } }).record.version).toBe(4);

    // And the conflict is on the record, for the owner to see.
    expect(
      m.authority
        .authority()
        .repos.events.listSince({ appId: app.id, event: "record.conflict" }, { limit: 10 }).length,
      "a conflict is an event, not just a status code"
    ).toBeGreaterThan(0);
  });
});
