/**
 * Gate 11 — hosted health is measured, carries the release that served, and is
 * never labelled as something it is not; the infrastructure product's
 * simulated health stays labelled simulated.
 *
 * Every check `appHealth` runs reads something real: the app row, the release
 * row, the artifact's bytes re-hashed off disk, `PRAGMA quick_check` on the
 * app's own database, the schema version, the record count. So the way to test
 * it is to break one of those things and watch the check go red — which is
 * what the tamper case below does, and then puts the byte back.
 *
 * The logs half is a privacy claim as much as an observability one: an app's
 * "logs" are its own event rows, they carry the release id, and they carry no
 * record contents. A record with an unmistakable title is written first, and
 * every rendered line is then searched for it.
 *
 * The contrast with the legacy simulated health is asserted on the source of
 * the two modules rather than by calling the legacy route, which needs a
 * signed-in workspace request this suite does not build. That limitation is in
 * ACCEPTANCE-R3.md.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactStore, HostedApp } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  loadHosted,
  publishOrThrow,
  releaseOf,
  signIn,
  storedFilePath,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate11-");
acceptanceEnv(DATA);

let m: HostedModules;
let store: ArtifactStore;
let app: HostedApp;
let releaseId = "";
let releaseNumber = 0;
let digest = "";
let ownerCookie = "";
let viewerCookie = "";
let artifactDir = "";

const OWNER = IDENTITIES.owner;
const VIEWER = IDENTITIES.viewer;
const HOST = appHost("alpha");
const ORIGIN = appOrigin("alpha");
const SECRET_TITLE = "Confidential-Title-8f31d0a2c7b94e56";

beforeAll(async () => {
  m = await loadHosted();
  m.authority.openAuthority();
  artifactDir = m.config.hostedConfig().artifactDir;
  store = new m.artifacts.FsArtifactStore(artifactDir);

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
  releaseNumber = releaseOf(job).number;

  await m.access.grantDirect(app.id, { subject: VIEWER.subject, email: VIEWER.email, role: "viewer" }, OWNER.subject);
  ownerCookie = await signIn(m, app, OWNER.subject);
  viewerCookie = await signIn(m, app, VIEWER.subject);

  // Real activity, so the digest below has something to describe: a write, a
  // denial and a conflict.
  const created = call({
    host: HOST,
    path: "/_zenith/data/v1/requests",
    method: "POST",
    cookie: ownerCookie,
    origin: ORIGIN,
    accept: "application/json",
    body: JSON.stringify({ writeId: uuid(), record: { title: SECRET_TITLE, category: "laptop" } }),
  });
  const res = await m.gateway.handleGateway(created.req, created.params);
  if (res.status !== 201) throw new Error(`seeding a record answered ${res.status}`);
  const recordId = ((await res.json()) as { record: { id: string } }).record.id;

  const refused = call({
    host: HOST,
    path: "/_zenith/data/v1/requests",
    method: "POST",
    cookie: viewerCookie,
    origin: ORIGIN,
    accept: "application/json",
    body: JSON.stringify({ writeId: uuid(), record: { title: "denied", category: "other" } }),
  });
  await m.gateway.handleGateway(refused.req, refused.params);

  const stale = call({
    host: HOST,
    path: `/_zenith/data/v1/requests/${recordId}`,
    method: "PATCH",
    cookie: ownerCookie,
    origin: ORIGIN,
    accept: "application/json",
    body: JSON.stringify({ writeId: uuid(), expectedVersion: 99, patch: { quantity: 2 } }),
  });
  await m.gateway.handleGateway(stale.req, stale.params);
}, 300_000);

afterAll(async () => {
  await closeHosted(m);
  removeDir(DATA);
});

describe("Gate 11 — real health, real logs, and honest labels", () => {
  it("measures the app rather than describing it, and says `simulated: false`", async () => {
    const health = await m.health.appHealth(app.id, { artifacts: store });

    expect(health.simulated, "hosted health is never simulated").toBe(false);
    expect(health.appId).toBe(app.id);
    expect(health.slug).toBe("alpha");
    expect(health.state).toBe("active");
    expect(health.release, "the release that is serving").toEqual({
      id: releaseId,
      number: releaseNumber,
      digest,
    });
    expect(health.runtime.id).toBe("local");
    expect(health.runtime.label, "the runtime says what it is").toContain("single machine");
    expect(health.runtime.enforcement.outboundSubrequests, "and what it does not enforce").toBe(
      "not_enforced"
    );

    const byId = Object.fromEntries(health.checks.map((check) => [check.id, check]));
    for (const id of [
      "authority_row",
      "active_release",
      "artifact_verified",
      "data_quick_check",
      "schema_version",
      "records",
    ])
      expect(byId[id], `a real check named ${id} must be present`).toBeTruthy();

    expect(byId.artifact_verified.ok, byId.artifact_verified?.detail).toBe(true);
    expect(byId.artifact_verified.detail, "and it says it re-hashed the bytes").toMatch(
      /re-hashed from its stored bytes/
    );
    expect(byId.data_quick_check.ok, byId.data_quick_check?.detail).toBe(true);
    expect(byId.schema_version.ok).toBe(true);
    expect(byId.records.detail, "the record count is a measurement").toMatch(/1 equipment request/);
    expect(health.ok, "every check passed").toBe(true);
  });

  it("summarises what actually happened, from the app's own events", async () => {
    const health = await m.health.appHealth(app.id, { artifacts: store });
    expect(health.lastEvents.total, "there is activity to describe").toBeGreaterThan(0);
    expect(health.lastEvents.writes, "one record was created").toBeGreaterThanOrEqual(1);
    expect(health.lastEvents.denials, "a viewer's write was refused").toBeGreaterThanOrEqual(1);
    expect(health.lastEvents.conflicts, "and a stale write was refused").toBeGreaterThanOrEqual(1);
    expect(Object.keys(health.lastEvents.byEvent), "counted per event name").toContain("record.created");

    const day = m.authority.utcDay();
    expect(health.quota.day).toBe(day);
    expect(health.quota.requests, "the quota block is the real counter").toBe(
      (await m.authority.authority().repos.quotas.get(app.id, day)).requests
    );
    expect(health.quota.limit).toBe(m.contracts.DEFAULT_LIMITS.requestsPerDay);
  });

  it("answers /_zenith/health on the app host, attributed to the release", async () => {
    const one = call({ host: HOST, path: "/_zenith/health", cookie: viewerCookie, accept: "application/json" });
    const res = await m.gateway.handleGateway(one.req, one.params);
    expect(res.status, "any role may read health").toBe(200);
    expect(res.headers.get("x-zenith-release"), "the response is attributed").toBe(releaseId);

    const body = (await res.json()) as {
      simulated: boolean;
      release: { id: string; number: number; digest: string };
      app: { slug: string; state: string };
      runtime: { id: string; label: string };
      checks: { id: string; ok: boolean; detail: string }[];
    };
    expect(body.simulated).toBe(false);
    expect(body.release).toEqual({ id: releaseId, number: releaseNumber, digest });
    expect(body.app).toEqual({ slug: "alpha", state: "active" });
    expect(body.runtime.id).toBe("local");
    expect(body.checks.find((check) => check.id === "artifact.verified")?.ok).toBe(true);
    expect(body.checks.find((check) => check.id === "data.schemaVersion")?.ok).toBe(true);
  });

  it("goes red when the thing it checks is actually broken, and green again when it is not", async () => {
    const target = storedFilePath(artifactDir, digest, "index.html");
    const original = fs.readFileSync(target);
    const tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)] ^= 0x20;
    fs.writeFileSync(target, tampered);

    const broken = await m.health.appHealth(app.id, { artifacts: store });
    expect(broken.simulated, "still not simulated, just failing").toBe(false);
    expect(broken.ok).toBe(false);
    const check = broken.checks.find((one) => one.id === "artifact_verified");
    expect(check?.ok).toBe(false);
    expect(check?.detail, "and it names what disagrees").toMatch(/does not match its own manifest/);
    // The other checks are unaffected: a failure is localised, not a blanket red.
    expect(broken.checks.find((one) => one.id === "data_quick_check")?.ok).toBe(true);
    expect(broken.release?.id, "and health still says which release it looked at").toBe(releaseId);

    const onHost = call({ host: HOST, path: "/_zenith/health", cookie: ownerCookie, accept: "application/json" });
    const res = await m.gateway.handleGateway(onHost.req, onHost.params);
    expect(res.status, "a failing check is a result, not an error").toBe(200);
    const body = (await res.json()) as { simulated: boolean; checks: { id: string; ok: boolean }[] };
    expect(body.simulated).toBe(false);
    expect(body.checks.find((one) => one.id === "artifact.verified")?.ok).toBe(false);

    fs.writeFileSync(target, original);
    expect((await m.health.appHealth(app.id, { artifacts: store })).ok, "green again").toBe(true);
  });

  it("answers for an app that is not there without pretending, and without throwing", async () => {
    const health = await m.health.appHealth("00000000-0000-4000-8000-000000000000", { artifacts: store });
    expect(health.simulated).toBe(false);
    expect(health.ok).toBe(false);
    expect(health.release).toBeNull();
    expect(health.checks[0]).toMatchObject({ id: "authority_row", ok: false });
    expect(health.checks[0].detail).toMatch(/holds no app with the id/);
  });

  /* ---------------------------------- logs -------------------------------- */

  it("renders logs that carry the release and no record contents", async () => {
    const logs = await m.health.appLogs(app.id, { limit: 200 });
    expect(logs.lines.length, "there is something to read").toBeGreaterThan(3);
    expect(logs.disclosure, "the reader is told what these are and are not").toMatch(
      /never a record's contents/
    );

    const withRelease = logs.lines.filter((line) => line.releaseId !== null);
    expect(withRelease.length, "the request-time events carry a release id").toBeGreaterThan(0);
    for (const line of withRelease)
      expect(line.releaseId, "and it is this app's release").toBe(releaseId);
    for (const line of logs.lines)
      expect(line.line.startsWith(line.ts), `a line begins with its timestamp: ${line.line}`).toBe(true);

    const all = logs.lines.map((line) => line.line).join("\n");
    expect(all, "a record's title must never reach a log line").not.toContain(SECRET_TITLE);
    expect(all, "nor a person's address").not.toContain(OWNER.email);
    expect(all, "and the outcomes are there to read").toMatch(/record\.created ok/);
    expect(all).toMatch(/access\.denied denied/);
  });

  it("keeps the events themselves free of record contents and raw subjects", async () => {
    const events = await m.authority.authority().repos.events.listSince({ appId: app.id }, { limit: 500 });
    const serialised = JSON.stringify(events);
    expect(serialised, "no record title in the event table").not.toContain(SECRET_TITLE);
    expect(serialised, "no address in the event table").not.toContain(OWNER.email);
  });

  /* ------------------------------- the contrast --------------------------- */

  it("leaves the infrastructure product's simulated health labelled simulated", async () => {
    const legacy = fs.readFileSync(
      path.join(process.cwd(), "src", "app", "api", "health", "[envId]", "route.ts"),
      "utf8"
    );
    expect(legacy, "the legacy route declares itself simulated").toMatch(/simulated:\s*true/);
    expect(legacy, "and says who generated the numbers").toMatch(/log simulator/);

    // Comments are stripped first: the hosted health module says in prose that
    // it will never write `simulated: true`, and that sentence is not code.
    const code = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const file of [
      path.join("src", "lib", "hosted", "health", "index.ts"),
      path.join("src", "lib", "hosted", "gateway", "reserved.ts"),
    ]) {
      const source = code(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
      expect(source, `${file} must never claim simulated: true`).not.toMatch(/simulated:\s*true/);
      expect(source, `${file} declares simulated: false`).toMatch(/simulated:\s*false/);
    }
  });
});
