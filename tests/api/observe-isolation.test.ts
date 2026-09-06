/**
 * Tenancy for the observe surface, and for the life of a stream — not just its
 * first millisecond.
 *
 * Two workspaces on one server. Ada belongs to A, Bo to B, and every id below
 * is real: the point is that a *valid* id from the other tenant is refused, and
 * refused with the identical 404 a made-up id gets, so the id space cannot be
 * probed. Four routes are covered because they all took the same shortcut of
 * resolving an id globally: deployment events, deployment detail, health, logs.
 *
 * The last describe is the other half of the finding. An SSE connection
 * authorised at connect and never again keeps delivering payloads to someone
 * who has been removed from the workspace, for as long as they keep the socket
 * open. So the project stream is opened, the member row is deleted underneath
 * it, and the stream has to say why and stop.
 *
 * Routes are driven directly with a NextRequest, in the style of
 * tests/api/project-stream.test.ts — the real handlers, the real workspace
 * resolution, no re-implementation of either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type {
  Deployment,
  Environment,
  Manifest,
  Member,
  Project,
  Workspace,
} from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-observe-"));
// Tenancy only exists once auth does: in demo mode there is one local user who
// is in every workspace, and nothing here would have anything to isolate.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";

/** Who the request layer sees. Set per test; `null` is signed out. */
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));

// The only thing stubbed. Everything downstream of "who is calling" — member
// resolution, workspace selection, the scoped lookups — is the real code.
vi.mock("@/lib/supabase/route", () => ({
  sessionUserFromRequest: async () => session.user,
}));

const { db, flush, resetDb } = await import("@/lib/db/store");
const { GET: deploymentEventsGet } = await import("@/app/api/deployments/[id]/events/route");
const { GET: deploymentGet } = await import("@/app/api/deployments/[id]/route");
const { GET: healthGet } = await import("@/app/api/health/[envId]/route");
const { GET: logsGet } = await import("@/app/api/logs/[envId]/[serviceId]/route");
const { GET: streamGet } = await import("@/app/api/projects/[id]/stream/route");

const AT = "2026-01-01T00:00:00.000Z";

const ada: SessionUser = { id: "u-ada", email: "ada@orrery.test", name: "Ada" };
const bo: SessionUser = { id: "u-bo", email: "bo@orrery.test", name: "Bo" };

const manifest = (serviceName: string): Manifest => ({
  version: 1,
  services: [
    {
      id: "svc-api",
      name: serviceName,
      kind: "web",
      source: { type: "image", image: "nginx" },
      size: "small",
      replicas: 1,
      port: 3000,
      env: [],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [],
  bindings: [],
});

const workspace = (id: string, name: string, slug: string): Workspace =>
  ({ id, name, slug, createdAt: AT }) as Workspace;

const member = (user: SessionUser, workspaceId: string): Member => ({
  id: user.id,
  workspaceId,
  name: user.name,
  email: user.email,
  role: "admin",
});

const project = (id: string, workspaceId: string): Project =>
  ({
    id,
    workspaceId,
    name: id,
    slug: id,
    workingManifest: manifest("api"),
    createdAt: AT,
    origin: { type: "blank" },
  }) as Project;

const environment = (id: string, projectId: string): Environment =>
  ({
    id,
    projectId,
    name: "sandbox",
    class: "sandbox",
    connectionId: `conn-${projectId}`,
    region: "local",
    policies: { approvalRequired: false, allowStatefulDeletion: false },
    baseDomain: "test",
    createdAt: AT,
  }) as unknown as Environment;

const deployment = (id: string, projectId: string, environmentId: string): Deployment =>
  ({
    id,
    projectId,
    environmentId,
    revisionId: `rev-${id}`,
    status: "succeeded",
    steps: [],
    outputs: [],
    changeSummary: "no change",
    estCostDeltaUsd: 0,
    actor: { type: "user", id: "u-ada", name: "Ada" },
    createdAt: AT,
  }) as Deployment;

function seed(): void {
  resetDb({
    workspaces: [workspace("ws-a", "Kepler Labs", "kepler"), workspace("ws-b", "Orbital", "orbital")],
    members: [member(ada, "ws-a"), member(bo, "ws-b")],
    projects: [project("pa", "ws-a"), project("pb", "ws-b")],
    environments: [environment("env-a", "pa"), environment("env-b", "pb")],
    deployments: [deployment("dep-a", "pa", "env-a"), deployment("dep-b", "pb", "env-b")],
  });
}

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;

/** Drive a route handler with the params Next 15 would have awaited for it. */
const call = (handler: unknown, url: string, params: Record<string, string>): Promise<Response> =>
  (handler as Handler)(new NextRequest(`http://localhost${url}`), {
    params: Promise.resolve(params) as Promise<never>,
  });

interface ErrorBody {
  error: { message: string; fix?: string };
}

beforeEach(() => {
  seed();
  session.user = ada;
});

/* ---------------------------- cross-tenant reads --------------------------- */

/**
 * Each case names the route, the id Ada may read, and the id from Bo's
 * workspace she may not. `missing` is an id nobody owns: a foreign id has to
 * answer identically to it, or the difference between the two answers is an
 * oracle for "does this id exist somewhere on this server".
 */
const cases = [
  {
    what: "deployment events",
    handler: deploymentEventsGet,
    url: (id: string) => `/api/deployments/${id}/events`,
    params: (id: string) => ({ id }),
    mine: "dep-a",
    theirs: "dep-b",
    missing: "dep-nowhere",
  },
  {
    what: "deployment detail",
    handler: deploymentGet,
    url: (id: string) => `/api/deployments/${id}`,
    params: (id: string) => ({ id }),
    mine: "dep-a",
    theirs: "dep-b",
    missing: "dep-nowhere",
  },
  {
    what: "health",
    handler: healthGet,
    url: (id: string) => `/api/health/${id}`,
    params: (id: string) => ({ envId: id }),
    mine: "env-a",
    theirs: "env-b",
    missing: "env-nowhere",
  },
  {
    what: "logs",
    handler: logsGet,
    url: (id: string) => `/api/logs/${id}/svc-api`,
    params: (id: string) => ({ envId: id, serviceId: "svc-api" }),
    mine: "env-a",
    theirs: "env-b",
    missing: "env-nowhere",
  },
] as const;

describe.each(cases)("$what", ({ handler, url, params, mine, theirs, missing }) => {
  it("answers a member of the owning workspace", async () => {
    const res = await call(handler, url(mine), params(mine));
    expect(res.status).toBe(200);
    // Whatever the transport, the caller got past the guard rather than a body
    // that happens to be an error with a 200 on it.
    res.body?.cancel();
  });

  it("404s an id from another workspace instead of serving it", async () => {
    const res = await call(handler, url(theirs), params(theirs));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");

    // Not 403: a refusal that admits the id is real is still a disclosure.
    const body = (await res.json()) as ErrorBody;
    expect(body.error.message).toContain(theirs);
    // Errors name their fix.
    expect(body.error.fix).toBeTruthy();
  });

  it("answers a foreign id exactly as it answers one that does not exist", async () => {
    const foreign = (await (await call(handler, url(theirs), params(theirs))).json()) as ErrorBody;
    const absent = (await (await call(handler, url(missing), params(missing))).json()) as ErrorBody;

    // Same shape, same fix, and the only difference is the id the caller typed.
    expect(foreign.error.fix).toBe(absent.error.fix);
    expect(foreign.error.message.replace(theirs, "ID")).toBe(
      absent.error.message.replace(missing, "ID")
    );
  });

  it("404s the other tenant's id for its owner's neighbour too, in both directions", async () => {
    session.user = bo;
    const res = await call(handler, url(mine), params(mine));
    expect(res.status).toBe(404);
  });
});

/* ------------------------- membership during a stream ---------------------- */

interface Frame {
  event?: string;
  id?: string;
  data?: Record<string, unknown>;
}

const timeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
    ),
  ]);

/** Reads the stream frame by frame, ignoring comments (`: open`, `: ping`). */
function frames(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;

  const next = async (what: string): Promise<Frame> => {
    for (;;) {
      const cut = buffer.indexOf("\n\n");
      if (cut >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (raw.startsWith(":")) continue;
        const frame: Frame = {};
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("id: ")) frame.id = line.slice(4);
          else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
        }
        return frame;
      }
      const { value, done } = await timeout(reader.read(), 6000, what);
      if (done) {
        ended = true;
        throw new Error(`stream ended while waiting for ${what}`);
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };

  return { next, ended: () => ended, cancel: () => void reader.cancel() };
}

let open: { cancel: () => void } | undefined;
afterEach(() => open?.cancel());

describe("GET /api/projects/:id/stream after membership is revoked", () => {
  it("stops delivering payloads and says why", async () => {
    const res = await call(streamGet, "/api/projects/pa/stream", { id: "pa" });
    expect(res.status).toBe(200);
    const stream = frames(res);
    open = stream;

    // Connected and authorised: the payload arrives.
    const first = await stream.next("the payload on connect");
    expect(first.event).toBe("project");

    // Ada is removed from Kepler Labs while she is still connected. Nothing
    // about her socket changed; her right to read it did.
    db().members = db().members.filter((m) => m.workspaceId !== "ws-a");

    // A change she would have received a moment ago.
    db().projects[0].workingManifest = manifest("renamed");
    flush();

    const last = await stream.next("the stream to close");
    expect(last.event).toBe("error");
    // Named, with a way back in — an unexplained dead stream is a bug report.
    expect(String(last.data?.message)).toContain("Kepler Labs");
    expect(String(last.data?.fix)).toMatch(/invite|reload/i);

    // And the payload she was no longer entitled to never went out.
    await expect(stream.next("nothing more")).rejects.toThrow(/stream ended/);
  });

  it("keeps streaming to a member who is still in the workspace", async () => {
    const res = await call(streamGet, "/api/projects/pa/stream", { id: "pa" });
    const stream = frames(res);
    open = stream;
    await stream.next("the payload on connect");

    // Bo losing his seat in the *other* workspace is not Ada's problem.
    db().members = db().members.filter((m) => m.workspaceId !== "ws-b");
    db().projects[0].workingManifest = manifest("renamed");
    flush();

    const second = await stream.next("the payload after a change");
    expect(second.event).toBe("project");
    const project = (second.data as { project: Project }).project;
    expect(project.workingManifest.services[0].name).toBe("renamed");
  });

  it("404s a project in another workspace rather than opening a stream at all", async () => {
    const res = await call(streamGet, "/api/projects/pb/stream", { id: "pb" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
