/**
 * Gate 12 — the recipient's journey over a real socket, and the browser script
 * that finishes the gate in a real rendering engine.
 *
 * A rendering engine cannot be a dependency of `npm test`, so gate 12 is split.
 * `scripts/hosted-browser.ts` does the half that needs Chrome — keyboard-only
 * creation, a reload, a conflict panel, a revocation, and zero console errors,
 * at 1280px and 375px — and this file does the half that can run anywhere:
 *
 *  - it starts the same loopback server the script starts, in front of the
 *    same `handleGateway`, and walks the whole journey over real HTTP with real
 *    `Set-Cookie` and `Cookie` headers, so the Node → `NextRequest` adapter the
 *    browser depends on is itself covered by the suite rather than trusted;
 *  - it reads `scripts/hosted-browser.ts` and pins the properties that make it
 *    honest: it drives an installed Chrome or Edge, it exits 2 with an
 *    explanation when there is none, and it never skips.
 *
 * What this file does **not** establish is stated plainly in ACCEPTANCE-R3.md:
 * no JavaScript is executed here, no layout happens, and a passing run of this
 * file is not a passing run of gate 12.
 *
 * Workstream W10 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactStore, HostedApp } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  acceptanceEnv,
  closeHosted,
  loadHosted,
  loopbackRequest,
  publishOrThrow,
  releaseOf,
  startGatewayServer,
  type GatewayServer,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate12-");
acceptanceEnv(DATA);

let m: HostedModules;
let store: ArtifactStore;
let app: HostedApp;
let server: GatewayServer;
let releaseId = "";
let digest = "";
let host = "";
let origin = "";
let cookie = "";
let grantId = "";
let recordId = "";

const OWNER = IDENTITIES.owner;
const EDITOR = IDENTITIES.editor;
const SCRIPT = path.join(process.cwd(), "scripts", "hosted-browser.ts");

beforeAll(async () => {
  m = await loadHosted();
  m.authority.openAuthority();
  store = new m.artifacts.FsArtifactStore(m.config.hostedConfig().artifactDir);

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
    source: { kind: "fixture", name: "tracker-app" },
  });
  ({ releaseId, digest } = releaseOf(job));

  grantId = m.access.grantDirect(
    app.id,
    { subject: EDITOR.subject, email: EDITOR.email, role: "editor" },
    OWNER.subject
  ).id;

  server = await startGatewayServer(m.gateway.handleGateway);
  // App hostnames carry the control origin's port, so the exchange redirects
  // land on the server that was just started.
  process.env.ZENITH_CONTROL_ORIGIN = `http://localhost:${server.port}`;
  host = `alpha.apps.localhost:${server.port}`;
  origin = `http://${host}`;
}, 300_000);

afterAll(async () => {
  await server?.close();
  process.env.ZENITH_CONTROL_ORIGIN = "http://localhost:3400";
  closeHosted(m);
  removeDir(DATA);
});

describe("Gate 12 — the journey over a real socket, and the browser script", () => {
  it("redeems a real exchange over HTTP and is handed a host-locked cookie", async () => {
    const state = `state-${uuid()}`;
    const redirect = new URL(m.access.createExchange(app.id, EDITOR.subject, state).redirect);
    expect(redirect.host, "the launch URL carries the running port").toBe(host);

    const res = await loopbackRequest(server.port, {
      host,
      path: `${redirect.pathname}${redirect.search}`,
      headers: { accept: "text/html" },
    });
    expect(res.status, "the callback over a socket").toBe(303);
    expect(res.headers.location).toBe("/");

    const raw = res.setCookie.join("\n");
    expect(raw).toContain("__Host-zenith_app=");
    expect(raw, "Secure").toContain("Secure");
    expect(raw, "HttpOnly").toContain("HttpOnly");
    expect(raw, "SameSite=Lax").toContain("SameSite=Lax");
    expect(raw, "Path=/").toContain("Path=/");
    expect(raw, "a __Host- cookie carries no Domain").not.toMatch(/;\s*Domain=/i);

    const value = /__Host-zenith_app=([^;]+)/.exec(raw)?.[1];
    expect(value).toBeTruthy();
    cookie = `__Host-zenith_app=${value}`;
  });

  it("serves the built app and its hashed asset over the wire", async () => {
    const page = await loopbackRequest(server.port, {
      host,
      path: "/",
      headers: { cookie, accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.headers["x-zenith-release"]).toBe(releaseId);
    expect(page.headers["content-security-policy"], "the guard is on a real response too").toBe(
      m.gateway.GATEWAY_CSP
    );
    expect(page.headers["cache-control"]).toBe("private, no-store");
    expect(page.body, "the tracker fixture's entry document").toContain('<div id="root">');

    const asset = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
    expect(asset, "the entry document names a hashed module").toBeTruthy();
    const js = await loopbackRequest(server.port, { host, path: asset as string, headers: { cookie } });
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
    expect(js.headers["cache-control"]).toBe("private, max-age=300, immutable");
    expect(js.body.length, "and it has bytes").toBeGreaterThan(1000);

    // The bytes on the wire are the bytes in the store.
    const stored = await store.open(digest, (asset as string).replace(/^\//, ""));
    expect(js.body).toBe(stored?.bytes.toString("utf8"));
  });

  it("takes a write from the app's own origin and refuses one from anywhere else", async () => {
    const body = JSON.stringify({
      writeId: uuid(),
      record: { title: "Written over a socket", category: "laptop" },
    });

    const forged = await loopbackRequest(server.port, {
      host,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      headers: { cookie, accept: "application/json", "content-type": "application/json", origin: "https://evil.example" },
      body,
    });
    expect(forged.status, "a cross-origin write").toBe(403);

    const created = await loopbackRequest(server.port, {
      host,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      headers: { cookie, accept: "application/json", "content-type": "application/json", origin },
      body,
    });
    expect(created.status, "a write from the app's own page").toBe(201);
    recordId = (JSON.parse(created.body) as { record: { id: string } }).record.id;

    const listed = await loopbackRequest(server.port, {
      host,
      path: "/_zenith/data/v1/requests?limit=100",
      headers: { cookie, accept: "application/json" },
    });
    expect(listed.status).toBe(200);
    expect(
      (JSON.parse(listed.body) as { items: { id: string }[] }).items.map((one) => one.id)
    ).toContain(recordId);
  });

  it("answers a stale write with the conflict payload the app's UI renders", async () => {
    // A second identity moves the record on.
    const ownerState = `state-${uuid()}`;
    const ownerRedirect = new URL(m.access.createExchange(app.id, OWNER.subject, ownerState).redirect);
    const callback = await loopbackRequest(server.port, {
      host,
      path: `${ownerRedirect.pathname}${ownerRedirect.search}`,
      headers: { accept: "text/html" },
    });
    const ownerCookie = `__Host-zenith_app=${/__Host-zenith_app=([^;]+)/.exec(callback.setCookie.join("\n"))?.[1]}`;

    const patched = await loopbackRequest(server.port, {
      host,
      path: `/_zenith/data/v1/requests/${recordId}`,
      method: "PATCH",
      headers: { cookie: ownerCookie, accept: "application/json", "content-type": "application/json", origin },
      body: JSON.stringify({ writeId: uuid(), expectedVersion: 1, patch: { details: "changed by the owner" } }),
    });
    expect(patched.status).toBe(200);

    const stale = await loopbackRequest(server.port, {
      host,
      path: `/_zenith/data/v1/requests/${recordId}`,
      method: "PATCH",
      headers: { cookie, accept: "application/json", "content-type": "application/json", origin },
      body: JSON.stringify({ writeId: uuid(), expectedVersion: 1, patch: { title: "my edit" } }),
    });
    expect(stale.status, "the second editor's stale write").toBe(409);
    const conflict = JSON.parse(stale.body) as {
      error: { code: string; details: { current: { version: number; updatedByEmail: string } } };
    };
    expect(conflict.error.code).toBe("stale_version");
    expect(conflict.error.details.current.version).toBe(2);
    expect(
      conflict.error.details.current.updatedByEmail,
      "the payload names who got there first, which is what the panel shows"
    ).toBe(OWNER.email);
  });

  it("refuses the next navigation once the grant is revoked", async () => {
    m.access.revokeGrant(grantId, OWNER.subject, "acceptance run", { appId: app.id });

    const navigation = await loopbackRequest(server.port, {
      host,
      path: "/",
      headers: { cookie, accept: "text/html" },
    });
    expect(navigation.status, "a person following a link").toBe(303);
    expect(navigation.headers.location).toBe("/_zenith/auth/signin");

    const page = await loopbackRequest(server.port, {
      host,
      path: "/_zenith/auth/signin",
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.body, "and lands somewhere that explains what to do").toContain(
      "Open this app from Zenith"
    );

    const api = await loopbackRequest(server.port, {
      host,
      path: "/_zenith/data/v1/requests",
      headers: { cookie, accept: "application/json" },
    });
    expect(api.status, "a program gets the envelope, not the page").toBe(401);
  });

  it("is not an app host when the request carries the control origin's Host", async () => {
    const direct = await loopbackRequest(server.port, {
      host: `localhost:${server.port}`,
      path: "/",
      headers: { accept: "text/html" },
    });
    expect(direct.status).toBe(404);
    expect(direct.headers["x-zenith-release"], "no attribution on an unknown host").toBeUndefined();
  });

  it("saw every one of those requests, and answered each of them itself", () => {
    const statuses = server.seen.map((one) => one.status);
    expect(server.seen.length, "the loopback server handled the whole journey").toBeGreaterThan(8);
    expect(statuses, "and never fell through to the adapter's own error path").not.toContain(599);
    expect(new Set(statuses)).toEqual(new Set([303, 200, 403, 201, 409, 401, 404]));
  });

  /* --------------------------- the browser script ------------------------- */

  it("ships a browser script that drives an installed Chrome or Edge", () => {
    expect(fs.existsSync(SCRIPT), `${SCRIPT} must exist`).toBe(true);
    const source = fs.readFileSync(SCRIPT, "utf8");

    expect(source, "it launches the installed browser rather than downloading one").toContain(
      'chromium.launch({ channel: candidate, headless: true })'
    );
    expect(source, "Chrome first").toMatch(/\["chrome", "msedge"\]/);
    expect(source, "it drives playwright-core, the devDependency this repo has").toContain(
      'await import("playwright-core")'
    );
  });

  it("fails loudly, with exit code 2, when there is no browser to run in", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source, "the no-browser path returns 2").toMatch(/return 2;/);
    expect(source, "and says what is missing").toContain("gate 12 needs a real browser and found none");
    expect(source, "and says explicitly that nothing was verified").toContain(
      "This step is not skipped when a browser is missing"
    );
    expect(source, "a missing browser is never a pass").not.toMatch(/process\.exit\(0\)[^;]*browser/i);
    expect(source, "and the script never skips itself").not.toMatch(/\bskip\b/i);

    // "No browser installed" and "the browser would not start" are different
    // answers. Only the first may be exit 2; a sandbox refusal or a missing
    // library must surface as itself.
    expect(source, "a launch failure that is not a missing binary is re-thrown").toContain(
      "if (!/not found|no such file|ENOENT|Chromium distribution/i.test(message)) throw err;"
    );
  });

  it("covers the steps gate 12 names, at both widths", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source, "a 375px width").toContain("width: 375");
    expect(source, "and a desktop width").toContain("width: 1280");
    expect(source, "keyboard reach rather than programmatic focus").toContain('page.keyboard.press("Tab")');
    expect(source, "keyboard activation").toContain('page.keyboard.press("Enter")');
    expect(source, "a reload").toContain("page.reload(");
    expect(source, "a conflict panel").toContain(".conflict[role=alert]");
    expect(source, "a revocation mid-session").toContain("access.revokeGrant(");
    expect(source, "console errors are collected").toContain('page.on("console"');
    expect(source, "and uncaught exceptions too").toContain('page.on("pageerror"');
    expect(source, "the run exits non-zero when a step failed").toContain(
      "return failed.length === 0 ? 0 : 1;"
    );
    expect(source, "and prints a JSON summary").toMatch(/JSON\.stringify\(summary, null, 2\)/);
  });

  it("gives the browser script its own data directory, and clears it", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source, "it never runs against .data").toContain('".data-hosted-browser"');
    expect(source, "and starts from empty").toContain("fs.rmSync(DATA_DIR, { recursive: true, force: true })");
    expect(source, "with the real build runner").toContain('process.env.ZENITH_BUILD_RUNNER = "recipe-local"');
    expect(source, "and the real fixture").toContain('{ kind: "fixture", name: "tracker-app" }');
  });
});
