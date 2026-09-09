/**
 * Project slugs are unique per workspace, not per server — so resolving one
 * globally and *then* checking tenancy is wrong in both directions.
 *
 * Slug allocation used to scan every workspace, which leaked a stranger's slug
 * (you asked for "atlas", got "atlas-2", and learned someone else had "atlas").
 * Making allocation per-workspace fixed that leak and made duplicate slugs
 * reachable through the product — which exposed the second half of the bug: the
 * HTTP layer still did `q.project(slug)` across the whole store and then
 * checked ownership. Whichever workspace happened to sort first won the name,
 * and the *other* workspace's own member got a 404 on their own project.
 *
 * These tests pin both halves: a foreign id is refused, and — the regression
 * that would otherwise be silent — each workspace resolves its own `atlas`.
 *
 * Handlers are driven directly with a NextRequest, in the style of
 * tests/api/observe-isolation.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Environment, Manifest, Member, Project, Workspace } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("orrery-slug-");
// Tenancy only exists once auth does: demo mode has one local user in every
// workspace, so there would be nothing to isolate.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/supabase/route", () => ({
  sessionUserFromRequest: async () => session.user,
}));

const { resetDb } = await import("@/lib/db/store");
const { GET: projectGet } = await import("@/app/api/projects/[id]/route");
const { GET: revisionsGet } = await import("@/app/api/projects/[id]/revisions/route");
const { GET: auditGet } = await import("@/app/api/projects/[id]/audit/route");
const { GET: alertsGet } = await import("@/app/api/projects/[id]/alerts/route");

const AT = "2026-01-01T00:00:00.000Z";
const ada: SessionUser = { id: "u-ada", email: "ada@orrery.test", name: "Ada" };
const bo: SessionUser = { id: "u-bo", email: "bo@orrery.test", name: "Bo" };

const manifest = (): Manifest => ({
  version: 1,
  services: [],
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

/** Both projects deliberately carry the slug `atlas`. That is now legal. */
const project = (id: string, workspaceId: string, name: string): Project =>
  ({
    id,
    workspaceId,
    name,
    slug: "atlas",
    workingManifest: manifest(),
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

function seed(): void {
  resetDb({
    // ws-b is listed first on purpose: if resolution is global, ws-b wins the
    // slug and Ada — listed second — is the one who breaks.
    workspaces: [workspace("ws-b", "Orbital", "orbital"), workspace("ws-a", "Kepler Labs", "kepler")],
    members: [member(bo, "ws-b"), member(ada, "ws-a")],
    projects: [project("pb", "ws-b", "Bo Atlas"), project("pa", "ws-a", "Ada Atlas")],
    environments: [environment("env-b", "pb"), environment("env-a", "pa")],
  });
}

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;
const call = (handler: unknown, url: string, params: Record<string, string>): Promise<Response> =>
  (handler as Handler)(new NextRequest(`http://localhost${url}`), {
    params: Promise.resolve(params) as Promise<never>,
  });

interface ErrorBody {
  error: { message: string; fix?: string };
}

const routes = [
  { what: "project detail", handler: projectGet, url: (id: string) => `/api/projects/${id}` },
  { what: "revisions", handler: revisionsGet, url: (id: string) => `/api/projects/${id}/revisions` },
  { what: "audit", handler: auditGet, url: (id: string) => `/api/projects/${id}/audit` },
  { what: "alerts", handler: alertsGet, url: (id: string) => `/api/projects/${id}/alerts` },
];

beforeEach(() => {
  seed();
  session.user = ada;
});

describe("a shared slug resolves per workspace", () => {
  for (const r of routes) {
    it(`${r.what}: each member gets their own atlas, not whichever sorted first`, async () => {
      session.user = ada;
      expect((await call(r.handler, r.url("atlas"), { id: "atlas" })).status).toBe(200);

      session.user = bo;
      expect((await call(r.handler, r.url("atlas"), { id: "atlas" })).status).toBe(200);
    });
  }

  it("project detail returns the caller's own project, not the other tenant's", async () => {
    session.user = ada;
    const mine = (await (await call(projectGet, "/api/projects/atlas", { id: "atlas" })).json()) as {
      project: { id: string; name: string };
    };
    expect(mine.project.id).toBe("pa");
    expect(mine.project.name).toBe("Ada Atlas");

    session.user = bo;
    const theirs = (await (await call(projectGet, "/api/projects/atlas", { id: "atlas" })).json()) as {
      project: { id: string; name: string };
    };
    expect(theirs.project.id).toBe("pb");
    expect(theirs.project.name).toBe("Bo Atlas");
  });
});

describe("a foreign id is still refused, and says nothing", () => {
  for (const r of routes) {
    it(`${r.what}: refuses another workspace's project id exactly as it refuses a missing one`, async () => {
      session.user = ada;
      const foreign = await call(r.handler, r.url("pb"), { id: "pb" });
      const missing = await call(r.handler, r.url("pz"), { id: "pz" });

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);

      const f = (await foreign.json()) as ErrorBody;
      const m = (await missing.json()) as ErrorBody;
      // Identical once the id itself is masked: any other difference is an
      // oracle for "does this id exist somewhere on this server".
      expect(f.error.message.replace("pb", "ID")).toBe(m.error.message.replace("pz", "ID"));
      expect(f.error.fix).toBe(m.error.fix);
      // And it must not name the owner or hint at permission.
      const text = JSON.stringify(f);
      for (const leak of ["Orbital", "Bo Atlas", "access", "permission", "denied"])
        expect(text).not.toContain(leak);
    });
  }
});
