/**
 * The control API for hosted apps, driven the way the browser drives it.
 *
 * Handlers are called directly with a `NextRequest`, in the style of
 * `tests/api/slug-scoping.test.ts`, so what is under test is the whole route:
 * the boot, the workspace resolution, the role checks, the action, and — the
 * part that only exists at this layer — the status a hosted refusal comes back
 * as. A duplicate slug has to be a 409 and a missing owner grant a 403; both
 * would be a 500 if the route lost the error's code on the way out of the
 * action.
 *
 * Workstream W7 (hosted R3).
 */
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Member, Workspace } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { IDENTITIES, isolatedDataDir, removeDir, uuid } from "../_fixtures";

const DATA = isolatedDataDir("zenith-w7-routes-");
// Tenancy only exists once auth does: demo mode is one local user who is in
// every workspace, so there would be no role to enforce.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => session.user }));

const { resetDb } = await import("@/lib/db/store");
const { ensureBoot } = await import("@/lib/server/boot");
const authority = await import("@/lib/hosted/authority");
const release = await import("@/lib/hosted/release");
const contracts = await import("@/lib/hosted/contracts");
const artifacts = await import("@/lib/hosted/artifacts");
const data = await import("@/lib/hosted/data");
const { runtimeDouble, buildRunnerDouble, usageDouble } = await import("./_doubles");

const appsRoute = await import("@/app/api/hosted/apps/route");
const appRoute = await import("@/app/api/hosted/apps/[appId]/route");
const publishRoute = await import("@/app/api/hosted/apps/[appId]/publish/route");
const jobRoute = await import("@/app/api/hosted/apps/[appId]/jobs/[jobId]/route");
const releasesRoute = await import("@/app/api/hosted/apps/[appId]/releases/route");
const rollbackRoute = await import("@/app/api/hosted/apps/[appId]/rollback/route");

const AT = "2026-09-01T10:00:00.000Z";
const workspace: Workspace = { id: "ws-one", name: "Kepler Labs", slug: "kepler", createdAt: AT };

const owner: SessionUser = { id: IDENTITIES.owner.subject, email: IDENTITIES.owner.email, name: "Ona Owner" };
const editor: SessionUser = { id: IDENTITIES.editor.subject, email: IDENTITIES.editor.email, name: "Ed Editor" };

const member = (user: SessionUser, role: Member["role"]): Member => ({
  id: user.id,
  workspaceId: workspace.id,
  name: user.name,
  email: user.email,
  role,
});

const store = new artifacts.FsArtifactStore(path.join(DATA, "artifacts"));

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;

const call = (
  handler: unknown,
  url: string,
  params: Record<string, string> = {},
  init: { method?: string; body?: unknown } = {}
): Promise<Response> =>
  (handler as Handler)(
    new NextRequest(`http://localhost${url}`, {
      method: init.method ?? "GET",
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
    }),
    { params: Promise.resolve(params) as Promise<never> }
  );

let undo: (() => void) | undefined;

/** Point the release module at doubles; only `holder` has the app owner grant. */
function wire(holder: string = owner.id) {
  const runtime = runtimeDouble({ store });
  const build = buildRunnerDouble();
  const usage = usageDouble();
  return release.setReleaseDepsForTests({
    runtime: () => runtime.runtime,
    buildRunner: () => build.runner,
    artifactStore: () => store,
    recordUsage: usage.recordUsage as never,
    buildsPaused: usage.buildsPaused,
    requireAppRole: (appId, subject) => {
      if (subject !== holder)
        throw new contracts.HostedError("forbidden", `${subject} does not hold an owner grant on ${appId}.`, {
          fix: "Ask an owner of this app to give you the owner role.",
        });
      return grant(appId, subject);
    },
    activeGrant: (appId, subject) => (subject === holder ? grant(appId, subject) : null),
  });
}

const grant = (appId: string, subject: string) => ({
  id: `grant-${appId}`,
  appId,
  subject,
  email: `${subject}@example.test`,
  role: "owner" as const,
  state: "active" as const,
  grantedBy: subject,
  createdAt: AT,
  updatedAt: AT,
});

beforeAll(async () => {
  await ensureBoot();
  // `ensureHosted()` starts the ticker on boot; these tests drive jobs
  // themselves and must not race a background worker.
  release.stopHostedJobRunner();
});

beforeEach(() => {
  resetDb({ workspaces: [workspace], members: [member(owner, "admin"), member(editor, "editor")] });
  session.user = owner;
});

afterEach(() => {
  undo?.();
  undo = undefined;
  release.resetReleaseDeps();
  release.stopHostedJobRunner();
});

afterAll(() => {
  release.stopHostedJobRunner();
  data.closeAllAppData();
  authority.closeAuthority();
  removeDir(DATA);
});

describe("POST /api/hosted/apps", () => {
  it("creates the app and answers 201 with it", async () => {
    undo = wire();
    const res = await call(appsRoute.POST, "/api/hosted/apps", {}, { method: "POST", body: { name: "Tracker", slug: "tracker" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { app: { id: string; slug: string; activeReleaseId: null } };
    expect(body.app.slug).toBe("tracker");
    expect(body.app.activeReleaseId).toBeNull();
  });

  it("answers 409 for a slug that is taken, with the code and the fix", async () => {
    undo = wire();
    const res = await call(appsRoute.POST, "/api/hosted/apps", {}, { method: "POST", body: { name: "Again", slug: "tracker" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string; fix?: string } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.fix).toContain("Pick another one");
  });

  it("answers 400 for a body that is not the documented shape", async () => {
    undo = wire();
    const res = await call(appsRoute.POST, "/api/hosted/apps", {}, { method: "POST", body: { name: "" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; fix?: string } };
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.fix).toContain('"slug"');
  });

  it("answers 403 for a workspace viewer", async () => {
    undo = wire();
    resetDb({ workspaces: [workspace], members: [member(owner, "admin"), member(editor, "viewer")] });
    session.user = editor;
    const res = await call(appsRoute.POST, "/api/hosted/apps", {}, { method: "POST", body: { name: "Nope", slug: "nope" } });
    expect(res.status).toBe(403);
    expect(authority.authority().repos.apps.getBySlug("nope")).toBeNull();
  });
});

describe("GET /api/hosted/apps", () => {
  it("answers with the apps, the limits, the runtime and every build runner's availability", async () => {
    undo = wire();
    const res = await call(appsRoute.GET, "/api/hosted/apps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      apps: { app: { slug: string }; hostname: string; activeRelease: unknown }[];
      limits: { buildsPilotWide: number };
      enforcement: Record<string, string> | null;
      runtime: { id: string; label: string; availability: { available: boolean } };
      builder: { id: string; boundary: string; availability: { available: boolean; reason?: string } }[];
    };
    expect(body.apps.map((a) => a.app.slug)).toContain("tracker");
    expect(body.apps[0].hostname).toBe("tracker.apps.localhost");
    expect(body.apps[0].activeRelease).toBeNull();
    expect(body.limits.buildsPilotWide).toBe(contracts.DEFAULT_LIMITS.buildsPilotWide);
    expect(body.runtime.id).toBe("local");
    // Every runner says what it isolates and whether it can run — that is what
    // stops a publish button being enabled with nothing behind it.
    expect(body.builder.map((b) => b.id).sort()).toEqual(["docker", "e2b", "recipe-local"]);
    for (const runner of body.builder) expect(runner.boundary.length).toBeGreaterThan(20);
  });
});

describe("the publish, job and release routes", () => {
  it("answers 202 with the queued job, then serves it back with its log", async () => {
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("tracker")!;
    const jobId = uuid();

    const accepted = await call(
      publishRoute.POST,
      `/api/hosted/apps/${app.id}/publish`,
      { appId: app.id },
      { method: "POST", body: { jobId, source: { kind: "fixture", name: "minimal-app" } } }
    );
    expect(accepted.status).toBe(202);
    const queued = (await accepted.json()) as { job: { id: string; status: string }; created: boolean };
    expect(queued.job.id).toBe(jobId);
    expect(queued.job.status).toBe("queued");
    expect(queued.created).toBe(true);

    const finished = await release.runJobOnce(jobId);
    expect(finished.status).toBe("succeeded");

    const job = await call(jobRoute.GET, `/api/hosted/apps/${app.id}/jobs/${jobId}`, { appId: app.id, jobId });
    expect(job.status).toBe(200);
    const jobBody = (await job.json()) as { job: { status: string; phase: string }; logs: string[] };
    expect(jobBody.job.status).toBe("succeeded");
    expect(jobBody.job.phase).toBe("finish");
    expect(jobBody.logs.length).toBeGreaterThan(0);
    expect(jobBody.logs.join("\n")).toContain("activated");

    const releases = await call(releasesRoute.GET, `/api/hosted/apps/${app.id}/releases`, { appId: app.id });
    const releaseBody = (await releases.json()) as {
      releases: { number: number; status: string; id: string }[];
      activeReleaseId: string;
      activeFence: number;
    };
    expect(releaseBody.releases).toHaveLength(1);
    expect(releaseBody.releases[0].status).toBe("active");
    expect(releaseBody.activeReleaseId).toBe(releaseBody.releases[0].id);
    expect(releaseBody.activeFence).toBe(1);
  });

  it("answers 202 for a repeated job id without queueing a second publish", async () => {
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("tracker")!;
    const jobId = uuid();
    const body = { jobId, source: { kind: "fixture", name: "minimal-app" } };
    const first = await call(publishRoute.POST, `/api/hosted/apps/${app.id}/publish`, { appId: app.id }, { method: "POST", body });
    const second = await call(publishRoute.POST, `/api/hosted/apps/${app.id}/publish`, { appId: app.id }, { method: "POST", body });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(((await second.json()) as { created: boolean }).created).toBe(false);
    expect(authority.authority().repos.jobs.listByApp(app.id).filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("answers 409 when the same job id carries a different source", async () => {
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("tracker")!;
    const jobId = uuid();
    await call(
      publishRoute.POST,
      `/api/hosted/apps/${app.id}/publish`,
      { appId: app.id },
      { method: "POST", body: { jobId, source: { kind: "fixture", name: "minimal-app" } } }
    );
    const res = await call(
      publishRoute.POST,
      `/api/hosted/apps/${app.id}/publish`,
      { appId: app.id },
      { method: "POST", body: { jobId, source: { kind: "fixture", name: "tracker-app" } } }
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("idempotency_conflict");
  });

  it("answers 400 for a job id that is not a UUID and an unknown source kind", async () => {
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("tracker")!;
    const bad = await call(
      publishRoute.POST,
      `/api/hosted/apps/${app.id}/publish`,
      { appId: app.id },
      { method: "POST", body: { jobId: "not-a-uuid", source: { kind: "fixture", name: "minimal-app" } } }
    );
    expect(bad.status).toBe(400);

    const kind = await call(
      publishRoute.POST,
      `/api/hosted/apps/${app.id}/publish`,
      { appId: app.id },
      { method: "POST", body: { jobId: uuid(), source: { kind: "git", url: "https://example.test/repo.git" } } }
    );
    expect(kind.status).toBe(400);
  });

  it("answers 403 to a workspace member who does not own the app", async () => {
    undo = wire(owner.id);
    session.user = editor;
    const app = authority.authority().repos.apps.getBySlug("tracker")!;

    const publish = await call(
      publishRoute.POST,
      `/api/hosted/apps/${app.id}/publish`,
      { appId: app.id },
      { method: "POST", body: { jobId: uuid(), source: { kind: "fixture", name: "minimal-app" } } }
    );
    expect(publish.status).toBe(403);
    expect(((await publish.json()) as { error: { code: string } }).error.code).toBe("forbidden");

    const jobs = await call(jobRoute.GET, `/api/hosted/apps/${app.id}/jobs/${uuid()}`, { appId: app.id, jobId: uuid() });
    expect(jobs.status).toBe(403);
  });

  it("answers 404 for an app in another workspace and for a job of another app", async () => {
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("tracker")!;
    const missing = await call(appRoute.GET, "/api/hosted/apps/app-nope", { appId: "app-nope" });
    expect(missing.status).toBe(404);

    const strayJob = await call(jobRoute.GET, `/api/hosted/apps/${app.id}/jobs/${uuid()}`, {
      appId: app.id,
      jobId: uuid(),
    });
    expect(strayJob.status).toBe(404);
  });
});

describe("GET /api/hosted/apps/[appId]", () => {
  it("gives an owner the grants and invitations, and everyone else the summary alone", async () => {
    undo = wire(owner.id);
    const app = authority.authority().repos.apps.getBySlug("tracker")!;

    const asOwner = await call(appRoute.GET, `/api/hosted/apps/${app.id}`, { appId: app.id });
    expect(asOwner.status).toBe(200);
    const ownerBody = (await asOwner.json()) as { grants?: unknown[]; invites?: unknown[]; app: { slug: string } };
    expect(ownerBody.app.slug).toBe("tracker");
    expect(Array.isArray(ownerBody.grants)).toBe(true);
    expect(Array.isArray(ownerBody.invites)).toBe(true);

    session.user = editor;
    const asMember = await call(appRoute.GET, `/api/hosted/apps/${app.id}`, { appId: app.id });
    expect(asMember.status).toBe(200);
    const memberBody = (await asMember.json()) as { grants?: unknown[]; app: { slug: string } };
    expect(memberBody.app.slug).toBe("tracker");
    expect(memberBody.grants).toBeUndefined();
  });
});

describe("POST /api/hosted/apps/[appId]/rollback", () => {
  it("answers 409 when the named release cannot be rolled back to", async () => {
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("tracker")!;
    const active = authority.authority().repos.apps.get(app.id)!.activeReleaseId!;
    const res = await call(
      rollbackRoute.POST,
      `/api/hosted/apps/${app.id}/rollback`,
      { appId: app.id },
      { method: "POST", body: { jobId: uuid(), releaseId: active } }
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toContain("already the release this app is serving");
  });
});
