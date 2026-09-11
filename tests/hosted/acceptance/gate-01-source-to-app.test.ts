/**
 * Gate 1 — pinned source → real Vite build → SHA-256 artifact → running app on
 * its own host; hostile inputs rejected.
 *
 * The only fixture that matters here is `fixtures/tracker-app`, and it is
 * compiled for real by `recipe-local`: a child process, the pinned recipe, and
 * an artifact keyed by the SHA-256 of its own bytes. Nothing is staged by a
 * double; the release the gateway serves at the end is the one the pipeline
 * activated.
 *
 * The hostile half is the half worth arguing about. Five submissions a hostile
 * builder would send — a `..` entry, a symlink, a submitted `vite.config.ts`,
 * an undeclared dependency and a file over the per-file ceiling — each go
 * through the same `admitPublish` + `runJobOnce` path as the good one. The
 * assertion is not only that they failed: it is that the job says *why*, that
 * no release row was created, and that the app is still serving what it was.
 *
 * The last case is what makes the digest mean something. A byte of a stored
 * artifact is changed after the release is live, and both the store's own
 * `verify()` and `appHealth` have to notice.
 */
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactStore, HostedApp } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir } from "../_fixtures";
import {
  acceptanceEnv,
  appHost,
  call,
  closeHosted,
  entriesFromDirectory,
  errorBody,
  fixtureDir,
  gzip,
  loadHosted,
  publish,
  publishOrThrow,
  releaseOf,
  signIn,
  storedFilePath,
  writeTar,
  type HostedModules,
  type TarEntry,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate01-");
acceptanceEnv(DATA);

let m: HostedModules;
let store: ArtifactStore;
let app: HostedApp;
let first: { releaseId: string; number: number; digest: string };
let artifactDir = "";
let cookie = "";

const OWNER = IDENTITIES.owner;
const HOST = appHost("alpha");

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
    source: { kind: "fixture", name: "tracker-app" },
  });
  first = releaseOf(job);
  cookie = await signIn(m, app, OWNER.subject);
}, 300_000);

afterAll(() => {
  closeHosted(m);
  removeDir(DATA);
});

/** The tracker fixture's entries, so a hostile archive is one edit away from a real one. */
const trackerEntries = (): TarEntry[] => entriesFromDirectory(fixtureDir("tracker-app"));

/** A hostile archive: the real fixture plus whatever the case adds or replaces. */
const hostile = (mutate: (entries: TarEntry[]) => TarEntry[]): string =>
  gzip(writeTar(mutate(trackerEntries()))).toString("base64");

/** Publish a hostile archive and answer with the finished job. */
const submit = (base64: string) =>
  publish(m, { app, actor: OWNER.subject, source: { kind: "tarball", base64 } });

describe("Gate 1 — source to a running app", () => {
  it("compiles the fixture with the pinned recipe into one content-addressed artifact", async () => {
    expect(first.digest, "the artifact key must be a sha256 hex digest").toMatch(/^[0-9a-f]{64}$/);

    const indexed = m.authority.authority().repos.artifacts.get(first.digest);
    expect(indexed, `artifact ${first.digest} must be indexed in the authority`).toBeTruthy();
    expect(indexed?.provenance.recipe.id, "recipe that produced it").toBe("vite-react-v1");
    expect(indexed?.provenance.builtBy, "runner that produced it").toBe("recipe-local");
    expect(
      indexed?.provenance.buildBoundary,
      "the runner's boundary must be recorded verbatim, not implied"
    ).toContain("not a hostile-code sandbox");
    expect(indexed?.verifiedAt, "the publisher verification must be recorded").toBeTruthy();

    const files = await store.list(first.digest);
    const names = files.map((file) => file.path);
    expect(names, "the build must emit an entry document").toContain("index.html");
    expect(
      names.some((name) => /^assets\/.+-[0-9A-Za-z_-]{6,}\.js$/.test(name)),
      `expected a hashed JS asset among ${JSON.stringify(names)}`
    ).toBe(true);
    expect(
      names.some((name) => /^assets\/.+\.css$/.test(name)),
      `expected a stylesheet among ${JSON.stringify(names)}`
    ).toBe(true);
  });

  it("recomputes the stored bytes to the same digest", async () => {
    const verdict = await store.verify(first.digest);
    expect(verdict.ok, `verify() said: ${verdict.detail}`).toBe(true);
    expect(verdict.detail, "verify must name what it recomputed").toMatch(/digest matches/);
  });

  it("left the release active and the app's durable pointer on it", () => {
    const a = m.authority.authority();
    const release = a.repos.releases.get(first.releaseId);
    expect(release?.status, "release status").toBe("active");
    expect(release?.artifactDigest, "release artifact").toBe(first.digest);
    expect(release?.probe?.ok, "the candidate probe must have passed").toBe(true);
    expect(release?.verifiedAt, "verifiedAt").toBeTruthy();
    expect(release?.activatedAt, "activatedAt").toBeTruthy();

    const current = a.repos.apps.get(app.id);
    expect(current?.activeReleaseId, "active release pointer").toBe(first.releaseId);
    expect(current?.activeFence, "fence after the first activation").toBe(1);
  });

  it("serves the built index.html on the app host, stamped with the release", async () => {
    const { req, params } = call({ host: HOST, path: "/", cookie, accept: "text/html" });
    const res = await m.gateway.handleGateway(req, params);
    expect(res.status, "GET / on the app host").toBe(200);
    expect(res.headers.get("x-zenith-release"), "release attribution header").toBe(first.releaseId);
    expect(res.headers.get("content-type"), "content type").toContain("text/html");

    const html = await res.text();
    const stored = await store.open(first.digest, "index.html");
    expect(stored, "index.html must be in the store").toBeTruthy();
    expect(html, "the served bytes must be the stored bytes").toBe(stored?.bytes.toString("utf8"));
    expect(html, "the tracker fixture's entry document").toContain('<div id="root">');
    expect(html, "the entry document must reference a hashed module").toMatch(
      /<script[^>]+src="\/assets\/[^"]+\.js"/
    );
  });

  it("serves the hashed asset the entry document names, after admission", async () => {
    const files = await store.list(first.digest);
    const asset = files.find((file) => /^assets\/.+\.js$/.test(file.path));
    expect(asset, "the build emitted no JS asset").toBeTruthy();

    const { req, params } = call({ host: HOST, path: `/${asset?.path}`, cookie });
    const res = await m.gateway.handleGateway(req, params);
    expect(res.status, `GET /${asset?.path}`).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control"), "a hashed asset may be cached, privately").toBe(
      "private, max-age=300, immutable"
    );
  });

  /* ------------------------------- hostile ------------------------------- */

  it("refuses a `..` traversal entry, records the reason, and creates no release", async () => {
    const before = m.authority.authority().repos.releases.listByApp(app.id).length;
    const job = await submit(
      hostile((entries) => [...entries, { path: "../escaped.tsx", bytes: Buffer.from("export {}") }])
    );

    expect(job.status, `job ${job.id} was expected to fail`).toBe("failed");
    expect(job.phase, "it must fail at intake, before anything is built").toBe("intake");
    const logs = m.release.jobLogs(job.id).join("\n");
    expect(logs, "the job log must name the reason").toMatch(/source rejected:.*"\.\." segment/s);
    expect(m.authority.authority().repos.releases.listByApp(app.id).length, "release count").toBe(before);
  });

  it("refuses a symlink entry rather than following it", async () => {
    const before = m.authority.authority().repos.releases.listByApp(app.id).length;
    const job = await submit(
      hostile((entries) => [
        ...entries,
        { path: "src/passwd.ts", type: "symlink", linkname: "/etc/passwd" },
      ])
    );

    expect(job.status).toBe("failed");
    expect(m.release.jobLogs(job.id).join("\n")).toMatch(/symbolic link is not accepted/);
    expect(m.authority.authority().repos.releases.listByApp(app.id).length).toBe(before);
  });

  it("refuses a submitted vite.config.ts — the recipe is the platform's, not the app's", async () => {
    const before = m.authority.authority().repos.releases.listByApp(app.id).length;
    const job = await submit(
      hostile((entries) => [
        ...entries,
        { path: "vite.config.ts", bytes: Buffer.from("export default { plugins: [] }") },
      ])
    );

    expect(job.status).toBe("failed");
    expect(m.release.jobLogs(job.id).join("\n")).toMatch(/vite\.config\.ts/);
    expect(m.authority.authority().repos.releases.listByApp(app.id).length).toBe(before);
  });

  it("refuses a dependency the recipe does not provide", async () => {
    const before = m.authority.authority().repos.releases.listByApp(app.id).length;
    const job = await submit(
      hostile((entries) =>
        entries.map((entry) =>
          entry.path === "package.json"
            ? {
                ...entry,
                bytes: Buffer.from(
                  JSON.stringify({
                    name: "tracker",
                    private: true,
                    type: "module",
                    dependencies: { react: "19.1.0", "react-dom": "19.1.0", "left-pad": "1.3.0" },
                  })
                ),
              }
            : entry
        )
      )
    );

    expect(job.status).toBe("failed");
    expect(m.release.jobLogs(job.id).join("\n")).toMatch(/left-pad/);
    expect(m.authority.authority().repos.releases.listByApp(app.id).length).toBe(before);
  });

  it("refuses a file over the per-file ceiling", async () => {
    const before = m.authority.authority().repos.releases.listByApp(app.id).length;
    const oversize = Buffer.alloc(m.contracts.SOURCE_LIMITS.maxFileBytes + 1, 0x61);
    const job = await submit(
      hostile((entries) => [...entries, { path: "public/huge.txt", bytes: oversize }])
    );

    expect(job.status).toBe("failed");
    expect(m.release.jobLogs(job.id).join("\n")).toMatch(/per-file limit is/);
    expect(m.authority.authority().repos.releases.listByApp(app.id).length).toBe(before);
  });

  it("kept serving the release it had while every hostile submission was refused", async () => {
    const current = m.authority.authority().repos.apps.get(app.id);
    expect(current?.activeReleaseId, "the active pointer must not have moved").toBe(first.releaseId);
    expect(current?.activeFence, "no activation happened, so the fence must not have moved").toBe(1);

    const { req, params } = call({ host: HOST, path: "/", cookie, accept: "text/html" });
    const res = await m.gateway.handleGateway(req, params);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-zenith-release")).toBe(first.releaseId);
  });

  /* ------------------------------- tampering ------------------------------ */

  it("fails verification and health once a stored artifact byte is changed", async () => {
    const before = await m.health.appHealth(app.id, { artifacts: store });
    expect(before.simulated, "hosted health is never simulated").toBe(false);
    expect(
      before.checks.find((check) => check.id === "artifact_verified")?.ok,
      "the artifact check must pass before tampering"
    ).toBe(true);

    // One byte, same length, so what is detected is the hash and not the size.
    const target = storedFilePath(artifactDir, first.digest, "index.html");
    const original = fs.readFileSync(target);
    const tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)] ^= 0x20;
    fs.writeFileSync(target, tampered);

    const verdict = await store.verify(first.digest);
    expect(verdict.ok, "verify() must refuse changed bytes").toBe(false);
    expect(verdict.detail, "and must name the file that changed").toMatch(/index\.html has changed/);

    const after = await m.health.appHealth(app.id, { artifacts: store });
    expect(after.ok, "overall health after tampering").toBe(false);
    const check = after.checks.find((c) => c.id === "artifact_verified");
    expect(check?.ok, "the artifact check after tampering").toBe(false);
    expect(check?.detail).toMatch(/does not match its own manifest/);

    // The gateway's own health route, on the app host, agrees.
    const { req, params } = call({ host: HOST, path: "/_zenith/health", cookie, accept: "application/json" });
    const res = await m.gateway.handleGateway(req, params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      simulated: boolean;
      checks: { id: string; ok: boolean }[];
    };
    expect(body.simulated).toBe(false);
    expect(body.checks.find((c) => c.id === "artifact.verified")?.ok).toBe(false);

    fs.writeFileSync(target, original);
    expect((await store.verify(first.digest)).ok, "restoring the byte restores the digest").toBe(true);
  });

  it("refuses a path a browser could not produce, before any file is read", async () => {
    const { req, params } = call({
      host: HOST,
      path: "/assets/x",
      cookie,
      segments: ["..", "..", "control.sqlite"],
    });
    const res = await m.gateway.handleGateway(req, params);
    expect(res.status, "a `..` segment must never reach the artifact store").toBe(404);
    expect((await errorBody(res)).message).toMatch(/not an address this app can serve/);
  });
});
