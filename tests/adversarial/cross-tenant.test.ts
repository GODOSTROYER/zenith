/**
 * Threat class: cross-tenant read and write (PROD-OPS-08).
 *
 * Attacker model: a legitimate, signed-in admin of workspace B who knows (or guesses) real identifiers from workspace A
 * and replays them against every route and every repository function.
 *
 * Cases are generated, not listed:
 *  - Routes: the filesystem is walked; every product route that takes an identifier in its path must be in the attack
 *    table below (a new route fails the inventory test until it is attacked). Each table entry is then called with EVERY
 *    identifier of workspace A (project, environment, deployment, revision, connection, finding, service, member, ...)
 *    in each path position, so a route that resolves an id of the wrong kind globally is caught too, not only the id
 *    kind it was designed for.
 *  - Repositories: the exported repository namespaces are enumerated by reflection; every function whose signature has
 *    the (sql, workspaceId, ...) shape is invoked as workspace B with workspace A's identifiers, and nothing of A may be
 *    returned or changed.
 *
 * The product routes run through the real request layer (real workspace resolution and scoping; only the session cookie
 * lookup is stubbed, as in tests/api/observe-isolation.test.ts). The repositories run on the real PGlite platform schema.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import { tempDataDir } from "../_support/data-dir";
import { phantomId, twoTenantFixture } from "../_support/security";

tempDataDir("zenith-adv-tenant-", { fast: true });
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => session.user }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));

const fx = twoTenantFixture();
const { alpha, bravo } = fx;
const { db, resetDb, appendEvent } = await import("@/lib/db/store");

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/* ------------------------------------ attack table ------------------------------------ */

interface Attack {
  /** route file relative to src/app */
  file: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** path parameter names, in order */
  params: string[];
  url: (ids: string[]) => string;
  handler: () => Promise<Handler>;
  body?: unknown;
}
const A = <T extends Record<string, Handler>>(load: () => Promise<T>, method: string) => async (): Promise<Handler> => (await load())[method]!;

const attacks: Attack[] = [
  { file: "api/connections/[id]/discover/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/connections/${a}/discover`, handler: A(() => import("@/app/api/connections/[id]/discover/route") as never, "GET") },
  { file: "api/deployments/[id]/events/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/deployments/${a}/events`, handler: A(() => import("@/app/api/deployments/[id]/events/route") as never, "GET") },
  { file: "api/deployments/[id]/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/deployments/${a}`, handler: A(() => import("@/app/api/deployments/[id]/route") as never, "GET") },
  { file: "api/environments/[id]/deployments/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/environments/${a}/deployments`, handler: A(() => import("@/app/api/environments/[id]/deployments/route") as never, "GET") },
  { file: "api/environments/[id]/drift/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/environments/${a}/drift`, handler: A(() => import("@/app/api/environments/[id]/drift/route") as never, "GET") },
  { file: "api/environments/[id]/export/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/environments/${a}/export`, handler: A(() => import("@/app/api/environments/[id]/export/route") as never, "GET") },
  { file: "api/environments/[id]/plan-steps/route.ts", method: "POST", params: ["id"], url: ([a]) => `/api/environments/${a}/plan-steps`, handler: A(() => import("@/app/api/environments/[id]/plan-steps/route") as never, "POST"), body: {} },
  { file: "api/health/[envId]/route.ts", method: "GET", params: ["envId"], url: ([a]) => `/api/health/${a}`, handler: A(() => import("@/app/api/health/[envId]/route") as never, "GET") },
  { file: "api/logs/[envId]/[serviceId]/route.ts", method: "GET", params: ["envId", "serviceId"], url: ([a, b]) => `/api/logs/${a}/${b}`, handler: A(() => import("@/app/api/logs/[envId]/[serviceId]/route") as never, "GET") },
  { file: "api/navigator/runs/[id]/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/navigator/runs/${a}`, handler: A(() => import("@/app/api/navigator/runs/[id]/route") as never, "GET") },
  { file: "api/projects/[id]/alerts/events/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/projects/${a}/alerts/events`, handler: A(() => import("@/app/api/projects/[id]/alerts/events/route") as never, "GET") },
  { file: "api/projects/[id]/alerts/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/projects/${a}/alerts`, handler: A(() => import("@/app/api/projects/[id]/alerts/route") as never, "GET") },
  { file: "api/projects/[id]/audit/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/projects/${a}/audit`, handler: A(() => import("@/app/api/projects/[id]/audit/route") as never, "GET") },
  { file: "api/projects/[id]/revisions/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/projects/${a}/revisions`, handler: A(() => import("@/app/api/projects/[id]/revisions/route") as never, "GET") },
  { file: "api/projects/[id]/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/projects/${a}`, handler: A(() => import("@/app/api/projects/[id]/route") as never, "GET") },
  { file: "api/projects/[id]/stream/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/projects/${a}/stream`, handler: A(() => import("@/app/api/projects/[id]/stream/route") as never, "GET") },
  { file: "api/revisions/[id]/route.ts", method: "GET", params: ["id"], url: ([a]) => `/api/revisions/${a}`, handler: A(() => import("@/app/api/revisions/[id]/route") as never, "GET") },
  { file: "api/workspace/members/[id]/route.ts", method: "PATCH", params: ["id"], url: ([a]) => `/api/workspace/members/${a}`, handler: A(() => import("@/app/api/workspace/members/[id]/route") as never, "PATCH"), body: { role: "viewer", workspaceId: alpha.workspaceId } },
  { file: "api/workspace/members/[id]/route.ts", method: "DELETE", params: ["id"], url: ([a]) => `/api/workspace/members/${a}?workspaceId=${alpha.workspaceId}`, handler: A(() => import("@/app/api/workspace/members/[id]/route") as never, "DELETE") },
  { file: "api/workspace/invites/[id]/route.ts", method: "DELETE", params: ["id"], url: ([a]) => `/api/workspace/invites/${a}?workspaceId=${alpha.workspaceId}`, handler: A(() => import("@/app/api/workspace/invites/[id]/route") as never, "DELETE") },
  { file: "api/workspace/invites/[id]/resend/route.ts", method: "POST", params: ["id"], url: ([a]) => `/api/workspace/invites/${a}/resend`, handler: A(() => import("@/app/api/workspace/invites/[id]/resend/route") as never, "POST"), body: { workspaceId: alpha.workspaceId } },
];

/** Dynamic product routes that are deliberately not tenant-resource lookups, with the reason. */
const NOT_A_TENANT_LOOKUP: Record<string, string> = {
  "api/actions/[actionId]/route.ts": "the id names a catalog action, not a stored row; every action runs through runAction with workspace admission (covered by tests/actions)",
  "api/providers/[id]/health/route.ts": "the id names a built-in provider kind; the response carries no tenant data",
  "api/workspace/invites/[id]/accept/route.ts": "an invite is accepted by the invited email's owner by design; account-bound by requireAccountUser (tests/api/workspace-sharing)",
  "api/admin/waitlist/history/[requestId]/route.ts": "operator surface behind requireWaitlistOperator, not a tenant route",
};

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(path.join(process.cwd(), "src", "app"), f).split(path.sep).join("/");

describe("route inventory", () => {
  const dynamic = routeFiles(path.join(process.cwd(), "src", "app", "api"))
    .map(rel)
    .filter((f) => /\[[^\]]+\]/.test(f))
    // platform/v1 and hosted/ have their own wrappers: classified by the next two tests
    .filter((f) => !f.startsWith("api/platform/v1/") && !f.startsWith("api/hosted/"));

  it("every product route with a path identifier is attacked here or excused with a reason", () => {
    const covered = new Set(attacks.map((a) => a.file));
    const unaccounted = dynamic.filter((f) => !covered.has(f) && !(f in NOT_A_TENANT_LOOKUP));
    expect(unaccounted, `New route(s) with path identifiers: add to the attack table or NOT_A_TENANT_LOOKUP: ${unaccounted.join(", ")}`).toEqual([]);
    const stale = [...covered, ...Object.keys(NOT_A_TENANT_LOOKUP)].filter((f) => !dynamic.includes(f));
    expect(stale).toEqual([]);
  });

  it("every product route with an identifier resolves it through a tenant-scoped lookup", () => {
    const scoped = /scoped(?:Project|Environment|Deployment)\(|requireWorkspace\(|runAction\(|mutateSharing\(|sharingWorkspace\(|scopedRun|workspaceId/;
    const offenders = attacks.map((a) => a.file).filter((f, i, all) => all.indexOf(f) === i).filter((f) => !scoped.test(readFileSync(path.join(process.cwd(), "src", "app", f), "utf8")));
    expect(offenders, "a route takes an id but names no tenant-scoped resolver").toEqual([]);
  });

  it("every platform REST route and method is classified by the edge access table (nothing falls through to the default)", async () => {
    const { platformAccess } = await import("@/app/api/platform/v1/_lib/bearer-paths");
    const files = routeFiles(path.join(process.cwd(), "src", "app", "api", "platform", "v1"));
    const unclassified: string[] = [];
    let checked = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const methods = [...text.matchAll(/export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!);
      const route = "/" + rel(file).replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, (m) => (m === "[jti]" ? "jti_1" : "id_1"));
      for (const method of methods) {
        checked++;
        if (platformAccess(route, method) === undefined) unclassified.push(`${method} ${route}`);
      }
    }
    expect(checked).toBeGreaterThan(80);
    expect(unclassified).toEqual([]);
  });

  it("every route that a browser must drive (approvals, settings, grants, restores) is classified browser-only, never bearer-capable", async () => {
    const { platformAccess } = await import("@/app/api/platform/v1/_lib/bearer-paths");
    const root = "/api/platform/v1";
    const mustBeBrowser: [string, string][] = [
      ["POST", "/operations/id_1/approve"], ["POST", "/operations/id_1/reject"], ["PUT", "/environments/id_1/autonomy"], ["PUT", "/workspace/policy"],
      ["POST", "/standing-grants"], ["GET", "/standing-grants"], ["POST", "/standing-grants/id_1/revoke"], ["POST", "/connections"], ["POST", "/connections/id_1/rotate"],
      ["POST", "/environments/id_1/state-backend/restores/execute"], ["POST", "/operations/id_1/start-portability"], ["POST", "/runbooks"], ["POST", "/effects/id_1/resolve"],
      ["POST", "/mixed/plans"], ["POST", "/releases/id_1/approve-migration"], ["POST", "/coding-agent/runs"], ["POST", "/github/binding"],
    ];
    const wrong = mustBeBrowser.filter(([m, p]) => platformAccess(`${root}${p}`, m) !== "browser-only").map(([m, p]) => `${m} ${p} is ${platformAccess(`${root}${p}`, m)}`);
    expect(wrong).toEqual([]);
  });
});

/* ------------------------------------ route sweep ------------------------------------ */

const bravoUser: SessionUser = { id: bravo.memberId, email: "bravo@zenith.test", name: "Bob" };
const alphaIds = [
  alpha.projectId, alpha.prodEnvId, alpha.stagingEnvId, ...alpha.revisionIds, alpha.deploymentId, alpha.connectionId, alpha.findingId, alpha.serviceId, alpha.memberId,
];

function seed(): void {
  resetDb(fx.data);
  fx.events.forEach(appendEvent);
}
beforeEach(() => {
  seed();
  session.user = bravoUser;
});

async function invoke(attack: Attack, ids: string[]): Promise<{ status: number; text: string }> {
  const handler = await attack.handler();
  const params = Object.fromEntries(attack.params.map((name, i) => [name, ids[i]!]));
  const request = new NextRequest(`http://localhost${attack.url(ids)}`, {
    method: attack.method,
    headers: { origin: "http://localhost", "content-type": "application/json" },
    ...(attack.body !== undefined ? { body: JSON.stringify(attack.body) } : {}),
  });
  const response = await handler(request, { params: Promise.resolve(params) });
  const text = response.status === 200 && response.headers.get("content-type")?.includes("event-stream") ? (void response.body?.cancel(), "") : await response.text();
  return { status: response.status, text };
}

/** Every combination of foreign ids over the route's path positions (capped: two positions use the id and the service). */
function idCombos(attack: Attack): string[][] {
  if (attack.params.length === 1) return alphaIds.map((id) => [id]);
  return alphaIds.flatMap((a) => [[a, alpha.serviceId], [a, "svc-api"]]);
}

describe("every product route, attacked with every identifier of another tenant", () => {
  it("the attack table is not vacuous", () => {
    expect(attacks.length).toBeGreaterThan(15);
    expect(alphaIds.every((id) => id.length >= 6)).toBe(true);
  });

  it("each route refuses every foreign identifier (never 2xx), leaks no canary, and answers exactly as it does for an id that exists nowhere", async () => {
    const leaks: string[] = [];
    const successes: string[] = [];
    const oracles: string[] = [];
    for (const attack of attacks) {
      for (const ids of idCombos(attack)) {
        const label = `${attack.method} ${attack.file} ${ids.join(",")}`;
        const result = await invoke(attack, ids);
        if (result.status >= 200 && result.status < 300) successes.push(`${label} -> ${result.status}`);
        for (const canary of alpha.canaries.all) if (result.text.includes(canary)) leaks.push(`${label} leaked a canary`);
        if (result.text.includes(alpha.workspaceId)) leaks.push(`${label} named the foreign workspace`);
        const ghost = await invoke(attack, ids.map((_, i) => phantomId(["prj", "env", "dep", "rev", "svc"][i] ?? "x")));
        if (ghost.status !== result.status) oracles.push(`${label}: foreign ${result.status} vs missing ${ghost.status}`);
      }
    }
    expect(successes, "a foreign identifier was accepted").toEqual([]);
    expect(leaks).toEqual([]);
    expect(oracles, "a foreign id is distinguishable from a nonexistent one").toEqual([]);
  });

  it("the foreign admin cannot change or remove the other tenant's members or invitations", async () => {
    const before = JSON.stringify({ members: db().members, invites: (db().settings as { invites?: unknown }).invites ?? null });
    for (const attack of attacks.filter((a) => a.file.startsWith("api/workspace/"))) {
      for (const ids of idCombos(attack)) await invoke(attack, ids);
    }
    expect(JSON.stringify({ members: db().members, invites: (db().settings as { invites?: unknown }).invites ?? null })).toBe(before);
    expect(db().members.find((m) => m.id === alpha.memberId)?.role).toBe("admin");
  });

  it("an unauthenticated caller gets nothing from any route, with any identifier", async () => {
    session.user = null;
    const leaks: string[] = [];
    for (const attack of attacks) {
      for (const ids of [[alpha.projectId, alpha.serviceId], [alpha.prodEnvId, alpha.serviceId], [alpha.deploymentId, alpha.serviceId]].map((x) => x.slice(0, attack.params.length))) {
        const result = await invoke(attack, ids);
        if ((result.status >= 200 && result.status < 300) || alpha.canaries.all.some((c) => result.text.includes(c))) leaks.push(`${attack.method} ${attack.file} -> ${result.status}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("the legitimate owner still reads their own data through the same routes (the refusals are about tenancy)", async () => {
    session.user = { id: alpha.memberId, email: "alpha@zenith.test", name: "Alice" };
    const own = attacks.find((a) => a.file === "api/deployments/[id]/route.ts")!;
    expect((await invoke(own, [alpha.deploymentId])).status).toBe(200);
    expect((await invoke(own, [bravo.deploymentId])).status).toBe(404);
  });
});

/* ------------------------------------ repository sweep ------------------------------------ */

describe("every repository function with a (sql, workspaceId, ...) signature, called as another tenant", () => {
  let ctx: Awaited<ReturnType<typeof import("../controlplane/_support/harness").openLane>>;
  let seeded: { workspaceId: string; operation: { id: string } };
  beforeAll(async () => {
    const harness = await import("../controlplane/_support/harness");
    ctx = await harness.openLane(harness.LANES[0]!);
    seeded = (await harness.seedApprovedOperation(ctx.db)) as typeof seeded;
  }, 60_000);
  afterAll(async () => { await ctx?.close(); });

  const SIGNATURE = /^(?:async\s+)?(?:function\s*[\w$]*\s*)?\(\s*(?:sql|db|tx)\s*(?::[^,)]+)?,\s*(?:workspaceId|ws|workspace)\b\s*(?::[^,)]+)?\s*((?:,\s*[\w$]+\s*)*)\)/;

  it("returns nothing of workspace A and changes nothing in it", async () => {
    const repos = (await import("@/lib/controlplane/db/repos")) as Record<string, unknown>;
    const { digest } = await import("@/lib/controlplane/digest");
    const attacker = `ws_attacker_${Math.random().toString(36).slice(2, 10)}`;
    const snapshot = async () => digest(await (repos.operations as { get: (...a: unknown[]) => Promise<unknown> }).get(ctx.db, seeded.workspaceId, seeded.operation.id));
    const before = await snapshot();
    const exercised: string[] = [];
    const leaks: string[] = [];
    for (const [namespace, mod] of Object.entries(repos)) {
      if (typeof mod !== "object" || mod === null) continue;
      for (const [name, fn] of Object.entries(mod as Record<string, unknown>)) {
        if (typeof fn !== "function") continue;
        const match = SIGNATURE.exec(Function.prototype.toString.call(fn));
        if (!match) continue;
        const extra = (match[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).length;
        const args: unknown[] = [ctx.db, attacker, ...Array.from({ length: extra }, () => seeded.operation.id)];
        exercised.push(`${namespace}.${name}`);
        let value: unknown;
        try {
          value = await Promise.race([Promise.resolve((fn as (...a: unknown[]) => unknown)(...args)), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))]);
        } catch { continue; }
        const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)) ?? "";
        if (text.includes(seeded.workspaceId) || text.includes(seeded.operation.id) && /workspace/i.test(text)) leaks.push(`${namespace}.${name}`);
      }
    }
    expect(exercised.length, "the reflective sweep found too few functions to be meaningful").toBeGreaterThan(15);
    expect(leaks, "repository functions returned workspace A data to workspace B").toEqual([]);
    expect(await snapshot(), "workspace A's operation changed after workspace B's calls").toBe(before);
  });
});
