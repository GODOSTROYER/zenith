/**
 * The recipient's journey, end to end, with **no doubles at all**.
 *
 * Every other file in this directory injects stand-ins for the sibling
 * modules so the gateway's own decisions can be exercised in isolation.
 * This one does the opposite: the real access module mints the exchange, the
 * real quota module counts the requests, the real events module records them,
 * the real artifact store holds the bytes and the real tracker store holds the
 * data. If a signature between W6 and W5/W8 ever drifts, this is the test that
 * notices.
 *
 * The journey: launch → callback → session → read the app → write a record →
 * a viewer is refused → the grant is revoked → the same cookie stops working →
 * sign out.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "@/lib/hosted/contracts";
import { IDENTITIES, isolatedDataDir, removeDir } from "../_fixtures";
import {
  appOrigin,
  call,
  errorBody,
  provenance,
  seedActiveRelease,
  seedApp,
  seedArtifactRow,
  writeBuiltTree,
} from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-gateway-journey-");

const { closeAuthority, openAuthority, utcDay } = await import("@/lib/hosted/authority");
const { createExchange } = await import("@/lib/hosted/access");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { hostedConfig } = await import("@/lib/hosted/config");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { gatewayTelemetry, handleGateway, resetGatewayDeps, resetGatewayTelemetry } = await import(
  "@/lib/hosted/gateway"
);

const authority = openAuthority();
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(await writeBuiltTree(DATA_DIR), provenance("job-journey"));
await seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const app = await seedApp(authority, { slug: "alpha" });
const release = await seedActiveRelease(authority, app, artifact.digest);
const ORIGIN = await appOrigin("alpha");

/** A real, live grant. */
function grant(subject: string, email: string, role: "owner" | "editor" | "viewer") {
  return authority.tx((repos) =>
    repos.grants.insert({
      id: randomUUID(),
      appId: app.id,
      subject,
      email,
      role,
      grantedBy: IDENTITIES.owner.subject,
    })
  );
}

const ownerGrant = await grant(IDENTITIES.owner.subject, IDENTITIES.owner.email, "owner");
await grant(IDENTITIES.viewer.subject, IDENTITIES.viewer.email, "viewer");
// Revoked by one of the cases below, so it must be nobody else's grant.
const editorGrant = await grant(IDENTITIES.editor.subject, IDENTITIES.editor.email, "editor");

/**
 * Walk the real launch: mint an exchange on the control side, follow the
 * callback on the app host, and answer with the cookie the browser now holds.
 */
async function signIn(subject: string): Promise<string> {
  const state = `state-${randomUUID()}`;
  const { redirect } = await createExchange(app.id, subject, state);
  const url = new URL(redirect);
  expect(url.host).toBe("alpha.apps.localhost:3400");
  expect(url.pathname).toBe("/_zenith/auth/callback");

  const { req, params } = await call({ path: `${url.pathname}${url.search}`, accept: "text/html" });
  const res = await handleGateway(req, params);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");

  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("HttpOnly");
  const value = /__Host-zenith_app=([^;]+)/.exec(setCookie)?.[1];
  expect(value, "the callback set an app session cookie").toBeTruthy();
  return `__Host-zenith_app=${value}`;
}

beforeEach(async () => {
  await resetGatewayDeps();
  await resetGatewayTelemetry();
});

afterAll(async () => {
  await resetGatewayDeps();
  await closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

describe("the whole journey, against the real modules", () => {
  it("signs a recipient in, serves the app, and lets an owner write a record", async () => {
    const cookie = await signIn(IDENTITIES.owner.subject);

    const page = await call({ path: "/", cookie, accept: "text/html" });
    const served = await handleGateway(page.req, page.params);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-zenith-release")).toBe(release.id);
    expect(await served.text()).toContain("<div id=\"root\"></div>");

    const session = await call({ path: "/_zenith/session", cookie, accept: "application/json" });
    const info = (await (await handleGateway(session.req, session.params)).json()) as SessionInfo;
    expect(info.subject).toBe(IDENTITIES.owner.subject);
    expect(info.role).toBe("owner");
    expect(info.email).toBe(IDENTITIES.owner.email);
    expect(info.controlOrigin).toBe("http://localhost:3400");

    const writeId = randomUUID();
    const create = await call({
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({ writeId, record: { title: "Standing desk", category: "furniture" } }),
    });
    const created = await handleGateway(create.req, create.params);
    expect(created.status).toBe(201);
    const record = ((await created.json()) as { record: { id: string; version: number } }).record;
    expect(record.version).toBe(1);

    const read = await call({ path: "/_zenith/data/v1/requests", cookie, accept: "application/json" });
    const list = (await (await handleGateway(read.req, read.params)).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toContain(record.id);
  });

  it("refuses a viewer's write through the real role check, without calling the store", async () => {
    const cookie = await signIn(IDENTITIES.viewer.subject);
    await resetGatewayTelemetry();

    const write = await call({
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({ writeId: randomUUID(), record: { title: "Laptop", category: "laptop" } }),
    });
    const res = await handleGateway(write.req, write.params);
    expect(res.status).toBe(403);
    expect((await errorBody(res)).code).toBe("forbidden");
    expect(gatewayTelemetry.brokerInvoked).toBe(0);

    // The same viewer may still read.
    const read = await call({ path: "/_zenith/data/v1/requests", cookie, accept: "application/json" });
    expect((await handleGateway(read.req, read.params)).status).toBe(200);
  });

  it("stops honouring a cookie the moment its grant is revoked", async () => {
    const cookie = await signIn(IDENTITIES.editor.subject);
    const before = await call({ path: "/", cookie, accept: "application/json" });
    expect((await handleGateway(before.req, before.params)).status).toBe(200);

    await authority.tx((repos) =>
      repos.grants.revoke(editorGrant.id, IDENTITIES.owner.subject, "left the project")
    );
    await resetGatewayTelemetry();

    const after = await call({ path: "/", cookie, accept: "application/json" });
    const res = await handleGateway(after.req, after.params);
    expect(res.status).toBe(401);
    expect((await errorBody(res)).code).toBe("sign_in_required");
    expect(gatewayTelemetry.artifactServed).toBe(0);
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
  });

  it("ends a session on sign-out, and the cookie stops working immediately", async () => {
    const cookie = await signIn(IDENTITIES.owner.subject);

    const out = await call({
      path: "/_zenith/auth/signout",
      method: "POST",
      cookie,
      origin: ORIGIN,
      accept: "application/json",
    });
    const res = await handleGateway(out.req, out.params);
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");

    const after = await call({ path: "/", cookie, accept: "application/json" });
    expect((await handleGateway(after.req, after.params)).status).toBe(401);
  });

  it("counts every one of those requests against the app's real daily quota", async () => {
    const before = (await authority.repos.quotas.get(app.id, utcDay())).requests;
    const c = await call({ path: "/", accept: "application/json" });
    await handleGateway(c.req, c.params);
    expect((await authority.repos.quotas.get(app.id, utcDay())).requests).toBe(before + 1);
  });

  it("records the opening and the write in the real events table", async () => {
    const cookie = await signIn(IDENTITIES.owner.subject);
    const write = await call({
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({ writeId: randomUUID(), record: { title: "Monitor", category: "monitor" } }),
    });
    expect((await handleGateway(write.req, write.params)).status).toBe(201);

    const events = (await authority.repos.events.listSince({ appId: app.id })).map((e) => e.event);
    expect(events).toContain("app.opened");
    expect(events).toContain("record.created");
  });

  it("keeps the owner's grant usable throughout", async () => {
    expect((await authority.repos.grants.activeFor(app.id, IDENTITIES.owner.subject))?.id).toBe(ownerGrant.id);
  });
});
