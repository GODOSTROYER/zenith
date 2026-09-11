/**
 * Gate 4 — the broker's roles are enforced independently of the HTTP verb,
 * reserved routes win over anything an app publishes, and the editable code
 * path holds no data capability of its own.
 *
 * The role check is the interesting one. A viewer's write is refused *before*
 * the store is opened, which is why every case here reads
 * `gatewayTelemetry.brokerInvoked` as well as the status: a 403 that had
 * already called the store would be a 403 that leaked the existence of a row.
 *
 * "Independently of the verb" is tested the way an attacker would try it —
 * `X-HTTP-Method-Override` and `?_method=` — because a framework that honours
 * either turns every viewer's GET into a write.
 *
 * The reserved-prefix case needs the app to actually publish something under
 * `_zenith/`, so the artifact really does hold a competing file. It does: the
 * source submitted here carries `public/_zenith/session.json`, which the build
 * emits at `_zenith/session.json` — and which the gateway never serves.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactStore, HostedApp, SessionInfo } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  errorBody,
  fixtureDir,
  loadHosted,
  publish,
  publishOrThrow,
  releaseOf,
  signIn,
  tarballBase64,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate04-");
acceptanceEnv(DATA);

let m: HostedModules;
let store: ArtifactStore;
let alpha: HostedApp;
let beta: HostedApp;
let alphaDigest = "";
let ownerCookie = "";
let editorCookie = "";
let viewerCookie = "";
let betaOwnerCookie = "";
let seededRecordId = "";

const OWNER = IDENTITIES.owner;
const EDITOR = IDENTITIES.editor;
const VIEWER = IDENTITIES.viewer;
const ALPHA = appHost("alpha");
const BETA = appHost("beta");
const ALPHA_ORIGIN = appOrigin("alpha");

/** The record body the tracker contract accepts. */
const record = (title: string) => ({ title, category: "laptop", quantity: 1 });

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
  beta = await m.release.createApp({
    workspaceId: WORKSPACES.one.id,
    slug: "beta",
    name: "Beta equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });

  // Alpha publishes a source that deliberately occupies the reserved prefix.
  const job = await publishOrThrow(m, {
    app: alpha,
    actor: OWNER.subject,
    source: {
      kind: "tarball",
      base64: tarballBase64(fixtureDir("minimal-app"), {
        "public/_zenith/session.json": JSON.stringify({
          subject: "attacker",
          role: "owner",
          note: "this file must never be served",
        }),
      }),
    },
  });
  alphaDigest = releaseOf(job).digest;
  await publishOrThrow(m, {
    app: beta,
    actor: OWNER.subject,
    source: { kind: "fixture", name: "minimal-app" },
  });

  m.access.grantDirect(alpha.id, { subject: EDITOR.subject, email: EDITOR.email, role: "editor" }, OWNER.subject);
  m.access.grantDirect(alpha.id, { subject: VIEWER.subject, email: VIEWER.email, role: "viewer" }, OWNER.subject);

  ownerCookie = await signIn(m, alpha, OWNER.subject);
  editorCookie = await signIn(m, alpha, EDITOR.subject);
  viewerCookie = await signIn(m, alpha, VIEWER.subject);
  betaOwnerCookie = await signIn(m, beta, OWNER.subject);
}, 300_000);

afterAll(() => {
  closeHosted(m);
  removeDir(DATA);
});

/** POST a new equipment request as whoever holds `cookie`. */
async function create(cookie: string, title: string, host = ALPHA, origin = ALPHA_ORIGIN) {
  const one = call({
    host,
    path: "/_zenith/data/v1/requests",
    method: "POST",
    cookie,
    origin,
    accept: "application/json",
    body: JSON.stringify({ writeId: uuid(), record: record(title) }),
  });
  return m.gateway.handleGateway(one.req, one.params);
}

/** PATCH an existing one. */
async function patch(cookie: string, id: string, expectedVersion: number, title: string) {
  const one = call({
    host: ALPHA,
    path: `/_zenith/data/v1/requests/${id}`,
    method: "PATCH",
    cookie,
    origin: ALPHA_ORIGIN,
    accept: "application/json",
    body: JSON.stringify({ writeId: uuid(), expectedVersion, patch: { title } }),
  });
  return m.gateway.handleGateway(one.req, one.params);
}

describe("Gate 4 — broker roles, reserved routes and the data capability", () => {
  it("lets an owner create and an editor update the same record", async () => {
    const created = await create(ownerCookie, "Standing desk");
    expect(created.status, "an owner may create").toBe(201);
    const owned = ((await created.json()) as { record: { id: string; version: number } }).record;
    expect(owned.version).toBe(1);
    seededRecordId = owned.id;

    const byEditor = await create(editorCookie, "Second monitor");
    expect(byEditor.status, "an editor may create").toBe(201);

    const updated = await patch(editorCookie, owned.id, 1, "Standing desk (adjustable)");
    expect(updated.status, "an editor may update").toBe(200);
    const after = ((await updated.json()) as { record: { version: number; updatedByEmail: string } }).record;
    expect(after.version, "a successful update moves the version").toBe(2);
    expect(after.updatedByEmail, "and is attributed to whoever made it").toBe(EDITOR.email);
  });

  it("lets a viewer read and refuses their writes without opening the store", async () => {
    m.gateway.resetGatewayTelemetry();
    const read = call({
      host: ALPHA,
      path: "/_zenith/data/v1/requests",
      cookie: viewerCookie,
      accept: "application/json",
    });
    const list = await m.gateway.handleGateway(read.req, read.params);
    expect(list.status, "a viewer may read").toBe(200);
    const readCalls = m.gateway.gatewayTelemetry.brokerInvoked;
    expect(readCalls, "a read does reach the broker").toBeGreaterThan(0);

    const post = await create(viewerCookie, "Not allowed");
    expect(post.status, "a viewer's POST").toBe(403);
    const body = await errorBody(post);
    expect(body.code).toBe("forbidden");
    expect(body.message, "the refusal names the role the caller holds").toContain("viewer");
    expect(body.fix, "and says who can change it").toMatch(/owner of this app/);
    expect(
      m.gateway.gatewayTelemetry.brokerInvoked,
      "a refused write must not have reached the store"
    ).toBe(readCalls);

    const patched = await patch(viewerCookie, seededRecordId, 2, "Not allowed either");
    expect(patched.status, "a viewer's PATCH").toBe(403);
    expect(
      m.gateway.gatewayTelemetry.brokerInvoked,
      "nor may a refused PATCH reach the store"
    ).toBe(readCalls);

    // Nothing changed behind the refusals.
    const check = call({
      host: ALPHA,
      path: `/_zenith/data/v1/requests/${seededRecordId}`,
      cookie: ownerCookie,
      accept: "application/json",
    });
    const current = ((await (await m.gateway.handleGateway(check.req, check.params)).json()) as {
      record: { version: number; title: string };
    }).record;
    expect(current.version, "the record a viewer tried to change").toBe(2);
    expect(current.title).toBe("Standing desk (adjustable)");
  });

  it("ignores every attempt to smuggle a verb past the role check", async () => {
    const before = m.authority
      .authority()
      .repos.events.listSince({ appId: alpha.id, event: "record.created" }, { limit: 500 }).length;

    const overrides: { name: string; options: Parameters<typeof call>[0] }[] = [
      {
        name: "X-HTTP-Method-Override: POST",
        options: {
          host: ALPHA,
          path: "/_zenith/data/v1/requests",
          cookie: viewerCookie,
          accept: "application/json",
          origin: ALPHA_ORIGIN,
          headers: { "x-http-method-override": "POST" },
        },
      },
      {
        name: "X-Method-Override: PATCH",
        options: {
          host: ALPHA,
          path: "/_zenith/data/v1/requests",
          cookie: viewerCookie,
          accept: "application/json",
          headers: { "x-method-override": "PATCH" },
        },
      },
      {
        name: "?_method=POST",
        options: {
          host: ALPHA,
          path: "/_zenith/data/v1/requests?_method=POST",
          cookie: viewerCookie,
          accept: "application/json",
        },
      },
    ];

    for (const attempt of overrides) {
      const one = call(attempt.options);
      const res = await m.gateway.handleGateway(one.req, one.params);
      expect(res.status, `${attempt.name} must stay a GET`).toBe(200);
      const body = (await res.json()) as { items?: unknown[] };
      expect(Array.isArray(body.items), `${attempt.name} answered a list, not a write`).toBe(true);
    }

    expect(
      m.authority.authority().repos.events.listSince(
        { appId: alpha.id, event: "record.created" },
        { limit: 500 }
      ).length,
      "no override created a record"
    ).toBe(before);

    // The item route's method table is not negotiable either.
    const post = call({
      host: ALPHA,
      path: `/_zenith/data/v1/requests/${seededRecordId}`,
      method: "POST",
      cookie: ownerCookie,
      origin: ALPHA_ORIGIN,
      accept: "application/json",
      body: JSON.stringify({ writeId: uuid(), patch: { title: "no" } }),
      headers: { "x-http-method-override": "PATCH" },
    });
    const res = await m.gateway.handleGateway(post.req, post.params);
    expect(res.status, "POST to an item, however it is dressed up").toBe(405);
    expect(res.headers.get("allow"), "the allow header names the real methods").toBe("GET, PATCH");
  });

  it("serves its own reserved routes even when the app published a file at that path", async () => {
    // The competing file really is in the artifact.
    const files = await store.list(alphaDigest);
    expect(
      files.map((file) => file.path),
      "the published artifact must actually hold the competing file"
    ).toContain("_zenith/session.json");

    // And is never served: anything under the prefix is Zenith's.
    m.gateway.resetGatewayTelemetry();
    const smuggled = call({
      host: ALPHA,
      path: "/_zenith/session.json",
      cookie: ownerCookie,
      accept: "application/json",
    });
    const res = await m.gateway.handleGateway(smuggled.req, smuggled.params);
    expect(res.status, "an app file under /_zenith/ is not reachable").toBe(404);
    expect((await errorBody(res)).message).toMatch(/reserved paths/);
    expect(m.gateway.gatewayTelemetry.artifactServed, "and its bytes were never read").toBe(0);

    // The real route answers the platform's own object.
    const real = call({
      host: ALPHA,
      path: "/_zenith/session",
      cookie: ownerCookie,
      accept: "application/json",
    });
    const info = (await (await m.gateway.handleGateway(real.req, real.params)).json()) as SessionInfo;
    expect(info.subject, "the session is the platform's answer, not the app's file").toBe(OWNER.subject);
    expect(info.role).toBe("owner");
  });

  it("matches an artifact path exactly, so a case-folding filesystem is not a way in", async () => {
    // Windows and macOS are case-insensitive. The store looks a path up in the
    // manifest before it touches the filesystem, so `/ASSETS/...` is not the
    // same file as `assets/...` even where the disk would say otherwise.
    const files = await store.list(alphaDigest);
    const asset = files.find((file) => /^assets\/.+\.js$/.test(file.path))?.path as string;
    expect(asset, "the build emitted a JS asset").toBeTruthy();

    const exact = call({ host: ALPHA, path: `/${asset}`, cookie: ownerCookie });
    expect((await m.gateway.handleGateway(exact.req, exact.params)).status).toBe(200);

    const shouted = call({ host: ALPHA, path: `/${asset.toUpperCase()}`, cookie: ownerCookie });
    const res = await m.gateway.handleGateway(shouted.req, shouted.params);
    expect(res.status, `/${asset.toUpperCase()} is not a file of this release`).toBe(404);
    expect(res.headers.get("content-type"), "and it is refused rather than served as something else").toContain(
      "application/json"
    );
  });

  it("will not even accept a source that puts a file at the exact reserved path", async () => {
    // `public/_zenith/session` has no extension, which the source contract
    // refuses — so the collision above is the closest an app can get.
    const job = await publish(m, {
      app: alpha,
      actor: OWNER.subject,
      source: {
        kind: "tarball",
        base64: tarballBase64(fixtureDir("minimal-app"), {
          "public/_zenith/session": "{\"role\":\"owner\"}",
        }),
      },
    });
    expect(job.status).toBe("failed");
    expect(m.release.jobLogs(job.id).join("\n")).toMatch(/extension is not supported/);
  });

  it("keeps app A's cookie away from app B's data, and the two datasets apart", async () => {
    m.gateway.resetGatewayTelemetry();
    const crossed = call({
      host: BETA,
      path: "/_zenith/data/v1/requests",
      cookie: ownerCookie,
      accept: "application/json",
    });
    const res = await m.gateway.handleGateway(crossed.req, crossed.params);
    expect(res.status, "alpha's cookie against beta's data").toBe(401);
    expect(m.gateway.gatewayTelemetry.brokerInvoked, "beta's store must not be opened").toBe(0);

    // Beta's own owner sees beta's data, which does not contain alpha's rows.
    await create(betaOwnerCookie, "Beta's own request", BETA, appOrigin("beta"));
    const read = call({
      host: BETA,
      path: "/_zenith/data/v1/requests",
      cookie: betaOwnerCookie,
      accept: "application/json",
    });
    const items = ((await (await m.gateway.handleGateway(read.req, read.params)).json()) as {
      items: { id: string; title: string }[];
    }).items;
    expect(items.map((item) => item.title)).toEqual(["Beta's own request"]);
    expect(items.map((item) => item.id), "no row of alpha's is visible here").not.toContain(
      seededRecordId
    );

    // The databases are separate files, which is the reason the above holds.
    expect(m.data.appDataPath(alpha.id, "data")).not.toBe(m.data.appDataPath(beta.id, "data"));
  });

  it("never lets an artifact response carry a cookie or a redirect", async () => {
    const served = call({ host: ALPHA, path: "/", cookie: ownerCookie, accept: "text/html" });
    const res = await m.gateway.handleGateway(served.req, served.params);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie(), "app content never sets a cookie").toEqual([]);
    expect(res.headers.get("location"), "nor a redirect").toBeNull();

    // The guard is what makes that true, and it is unconditional: a response
    // that arrives carrying a cookie the gateway did not set loses it.
    const smuggler = new Response("<p>hi</p>", {
      headers: {
        "set-cookie": "stolen=1; Path=/",
        location: "https://evil.example/",
        "access-control-allow-origin": "*",
        "content-type": "text/html",
      },
    });
    const guarded = m.gateway.applyResponseGuard(smuggler, { cache: "no-store" });
    expect(guarded.headers.getSetCookie(), "set-cookie stripped").toEqual([]);
    expect(guarded.headers.get("location"), "location stripped").toBeNull();
    expect(guarded.headers.get("access-control-allow-origin"), "CORS stripped").toBeNull();
    expect(guarded.headers.get("content-security-policy")).toBe(m.gateway.GATEWAY_CSP);
  });
});
