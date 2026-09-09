/**
 * The hosted actions, and the two halves of their authorization.
 *
 * PLAN-R3 G10: publishing to a hosted app needs a workspace role *and* the
 * app's owner grant. Neither is enough on its own, and the plan has to say
 * which one is missing before the button is pressed — a confirm control that is
 * enabled for something that will be refused is the dead control this codebase
 * refuses to ship.
 *
 * So every case here checks the same three things in different combinations:
 * what the plan says, whether the plan is blocked, and whether execute agrees
 * with the plan. A plan that says "go" and an execute that refuses would be a
 * worse bug than either refusing on its own.
 *
 * Workstream W7 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import type { Actor, Member, Workspace } from "@/lib/domain/types";
import type { Availability, BuildRunner, HostedRuntime } from "@/lib/hosted/contracts";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-w7-actions-", { fast: true });

const { runAction } = await import("@/lib/actions/core");
const { resetDb } = await import("@/lib/db/store");
const authority = await import("@/lib/hosted/authority");
const release = await import("@/lib/hosted/release");
const contracts = await import("@/lib/hosted/contracts");
const artifacts = await import("@/lib/hosted/artifacts");
const data = await import("@/lib/hosted/data");
const { runtimeDouble, buildRunnerDouble, usageDouble } = await import("../hosted/release/_doubles");
await import("@/lib/actions/defs/hosted");

const AT = "2026-09-01T10:00:00.000Z";
const workspace: Workspace = { id: "ws-one", name: "Kepler Labs", slug: "kepler", createdAt: AT };

const member = (id: string, role: Member["role"]): Member => ({
  id,
  workspaceId: workspace.id,
  name: id,
  email: `${id}@example.test`,
  role,
});

const OWNER = "owner-subject";
const EDITOR = "editor-subject";
const VIEWER = "viewer-subject";

const actor = (id: string): Actor => ({ type: "user", id, name: id });
const ctx = (id: string): ActionContext => ({ workspaceId: workspace.id, actor: actor(id) });

const store = new artifacts.FsArtifactStore(path.join(DATA, "artifacts"));

/** Wire the release module's collaborators; `owner` is the only subject with the grant. */
function wire(opts: { owner?: string; runner?: BuildRunner | null; unavailable?: Availability; paused?: { paused: boolean; reason?: string } } = {}) {
  const runtime: HostedRuntime = runtimeDouble({ store }).runtime;
  const build = opts.runner === undefined ? buildRunnerDouble({ unavailable: opts.unavailable }).runner : opts.runner;
  const usage = usageDouble(opts.paused);
  return release.setReleaseDepsForTests({
    runtime: () => runtime,
    buildRunner: () => build,
    artifactStore: () => store,
    recordUsage: usage.recordUsage as never,
    buildsPaused: usage.buildsPaused,
    appSchemaVersion: () => Promise.resolve(1),
    requireAppRole: (appId, subject) => {
      const holder = opts.owner ?? OWNER;
      if (subject !== holder)
        throw new contracts.HostedError("forbidden", `${subject} does not hold an owner grant on ${appId}.`, {
          fix: "Ask an owner of this app to give you the owner role, or have them run this.",
        });
      return grant(appId, subject);
    },
    activeGrant: (appId, subject) => (subject === (opts.owner ?? OWNER) ? grant(appId, subject) : null),
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

let undo: (() => void) | undefined;

beforeAll(() => {
  authority.openAuthority();
});

beforeEach(() => {
  resetDb({
    workspaces: [workspace],
    members: [member(OWNER, "editor"), member(EDITOR, "editor"), member(VIEWER, "viewer")],
  });
});

afterEach(() => {
  undo?.();
  undo = undefined;
  release.resetReleaseDeps();
});

afterAll(() => {
  release.stopHostedJobRunner();
  data.closeAllAppData();
  authority.closeAuthority();
  fs.rmSync(DATA, { recursive: true, force: true });
});

/** Create an app through the action, so the test uses the same door the API does. */
async function createApp(slug: string, who = OWNER) {
  const { result } = await runAction("app.create", ctx(who), { name: slug, slug }, { mode: "execute" });
  expect(result?.ok).toBe(true);
  return (result?.data as { app: { id: string } }).app;
}

describe("app.create", () => {
  it("plans the hostname and the runtime, then creates the app and its owner grant", async () => {
    undo = wire();
    const { plan } = await runAction("app.create", ctx(EDITOR), { name: "Tracker", slug: "tracker" }, { mode: "plan" });
    expect(plan?.blocked).toBeUndefined();
    expect(plan?.summary).toContain("tracker.apps.localhost");
    expect(plan?.details.join(" ")).toContain("local runtime");
    expect(plan?.requiredRole).toBe("editor");

    const { result } = await runAction("app.create", ctx(EDITOR), { name: "Tracker", slug: "tracker" }, { mode: "execute" });
    expect(result?.ok).toBe(true);
    const app = (result?.data as { app: { id: string; slug: string } }).app;
    expect(app.slug).toBe("tracker");
    expect(authority.authority().repos.grants.listByApp(app.id)[0].subject).toBe(EDITOR);
  });

  it("blocks the plan for a slug that is taken and for one that cannot be a hostname", async () => {
    undo = wire();
    const taken = await runAction("app.create", ctx(EDITOR), { name: "Again", slug: "tracker" }, { mode: "plan" });
    expect(taken.plan?.blocked).toContain("already belongs to another app");

    const reserved = await runAction("app.create", ctx(EDITOR), { name: "Api", slug: "api" }, { mode: "plan" });
    expect(reserved.plan?.blocked).toContain("reserved");
  });

  it("refuses a viewer, naming the role they would need", async () => {
    undo = wire();
    const { result } = await runAction("app.create", ctx(VIEWER), { name: "Nope", slug: "nope" }, { mode: "execute" });
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("role_denied");
    expect(authority.authority().repos.apps.getBySlug("nope")).toBeNull();
  });
});

describe("app.publish", () => {
  it("plans with the runner that will build and the phases it will run", async () => {
    undo = wire();
    const app = await createApp("publishable");
    const { plan } = await runAction(
      "app.publish",
      ctx(OWNER),
      { appId: app.id, jobId: crypto.randomUUID(), source: { kind: "fixture", name: "minimal-app" } },
      { mode: "plan" }
    );
    expect(plan?.blocked).toBeUndefined();
    expect(plan?.details.join(" ")).toContain("Build runner (test double)");
    expect(plan?.details.join(" ")).toContain("intake, build, artifact");
  });

  it("blocks the plan when this install has no build runner, quoting the variable", async () => {
    undo = wire({ runner: null });
    const app = authority.authority().repos.apps.getBySlug("publishable")!;
    const { plan } = await runAction(
      "app.publish",
      ctx(OWNER),
      { appId: app.id, jobId: crypto.randomUUID(), source: { kind: "fixture", name: "minimal-app" } },
      { mode: "plan" }
    );
    expect(plan?.blocked).toContain("ZENITH_BUILD_RUNNER");
  });

  it("blocks the plan when the selected runner cannot run here", async () => {
    undo = wire({ unavailable: { available: false, reason: "the Docker daemon is not reachable", fix: "Start Docker Desktop." } });
    const app = authority.authority().repos.apps.getBySlug("publishable")!;
    const { plan } = await runAction(
      "app.publish",
      ctx(OWNER),
      { appId: app.id, jobId: crypto.randomUUID(), source: { kind: "fixture", name: "minimal-app" } },
      { mode: "plan" }
    );
    expect(plan?.blocked).toContain("Docker daemon is not reachable");
    expect(plan?.blocked).toContain("Start Docker Desktop.");
  });

  it("blocks the plan when the actor has the workspace role but not the owner grant", async () => {
    undo = wire({ owner: OWNER });
    const app = authority.authority().repos.apps.getBySlug("publishable")!;
    const { plan } = await runAction(
      "app.publish",
      ctx(EDITOR),
      { appId: app.id, jobId: crypto.randomUUID(), source: { kind: "fixture", name: "minimal-app" } },
      { mode: "plan" }
    );
    expect(plan?.blocked).toContain("does not hold an owner grant");
  });

  it("blocks the plan while spending has paused builds", async () => {
    undo = wire({ paused: { paused: true, reason: "Builds are paused at 90 % of the approved envelope." } });
    const app = authority.authority().repos.apps.getBySlug("publishable")!;
    const { plan } = await runAction(
      "app.publish",
      ctx(OWNER),
      { appId: app.id, jobId: crypto.randomUUID(), source: { kind: "fixture", name: "minimal-app" } },
      { mode: "plan" }
    );
    expect(plan?.blocked).toContain("90 %");
  });

  it("refuses execute for a workspace viewer, and for an editor without the owner grant", async () => {
    undo = wire({ owner: OWNER });
    const app = authority.authority().repos.apps.getBySlug("publishable")!;

    const viewer = await runAction(
      "app.publish",
      ctx(VIEWER),
      { appId: app.id, jobId: crypto.randomUUID(), source: { kind: "fixture", name: "minimal-app" } },
      { mode: "execute" }
    );
    expect(viewer.result?.ok).toBe(false);
    expect(viewer.result?.error).toContain("role_denied");

    const editor = await runAction(
      "app.publish",
      ctx(EDITOR),
      { appId: app.id, jobId: crypto.randomUUID(), source: { kind: "fixture", name: "minimal-app" } },
      { mode: "execute" }
    );
    expect(editor.result?.ok).toBe(false);
    expect(editor.result?.error).toContain("does not hold an owner grant");
    expect(authority.authority().repos.jobs.listByApp(app.id)).toHaveLength(0);
  });

  it("queues the job for an editor who also owns the app, and replays a repeated job id", async () => {
    undo = wire({ owner: OWNER });
    const app = authority.authority().repos.apps.getBySlug("publishable")!;
    const jobId = crypto.randomUUID();
    const input = { appId: app.id, jobId, source: { kind: "fixture", name: "minimal-app" } };

    const first = await runAction("app.publish", ctx(OWNER), input, { mode: "execute" });
    expect(first.result?.ok).toBe(true);
    expect((first.result?.data as { jobId: string }).jobId).toBe(jobId);
    expect((first.result?.data as { created: boolean }).created).toBe(true);

    const second = await runAction("app.publish", ctx(OWNER), input, { mode: "execute", idempotencyKey: jobId });
    expect(second.result?.ok).toBe(true);
    expect(authority.authority().repos.jobs.listByApp(app.id)).toHaveLength(1);
  });

  it("refuses an app id from another workspace exactly as it refuses one that does not exist", async () => {
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("publishable")!;
    const foreign: ActionContext = { workspaceId: "ws-two", actor: actor(OWNER) };
    const { plan } = await runAction(
      "app.publish",
      foreign,
      { appId: app.id, jobId: crypto.randomUUID(), source: { kind: "fixture", name: "minimal-app" } },
      { mode: "plan" }
    );
    expect(plan?.blocked).toContain("No hosted app");
  });
});

describe("app.suspend and app.resume", () => {
  it("need the admin role, and say so on the plan", async () => {
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("publishable")!;
    const { plan } = await runAction(
      "app.suspend",
      ctx(OWNER),
      { appId: app.id, jobId: crypto.randomUUID() },
      { mode: "plan" }
    );
    // The owner here is a workspace *editor*, so the role block fires even
    // though the app-owner half passes.
    expect(plan?.requiredRole).toBe("admin");
    expect(plan?.blocked).toContain("admin");

    const { result } = await runAction(
      "app.suspend",
      ctx(OWNER),
      { appId: app.id, jobId: crypto.randomUUID() },
      { mode: "execute" }
    );
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("role_denied");
  });

  it("queues the suspension for a workspace admin who owns the app", async () => {
    resetDb({ workspaces: [workspace], members: [member(OWNER, "admin")] });
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("publishable")!;
    const jobId = crypto.randomUUID();
    const { result } = await runAction(
      "app.suspend",
      ctx(OWNER),
      { appId: app.id, jobId, reason: "paused for review" },
      { mode: "execute" }
    );
    expect(result?.ok).toBe(true);
    const job = authority.authority().repos.jobs.get(jobId)!;
    expect(job.kind).toBe("suspend");
    expect(job.status).toBe("queued");
  });
});

describe("app.rollback", () => {
  it("blocks the plan when the named release is not a rollback target", async () => {
    undo = wire();
    const app = authority.authority().repos.apps.getBySlug("publishable")!;
    const { plan } = await runAction(
      "app.rollback",
      ctx(OWNER),
      { appId: app.id, jobId: crypto.randomUUID(), releaseId: "rel-nope" },
      { mode: "plan" }
    );
    expect(plan?.blocked).toContain("not a release of this app");
    expect(plan?.details.join(" ")).toContain("replaces code, not data");
  });
});
