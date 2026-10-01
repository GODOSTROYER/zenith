/**
 * The human half of the runner plane — creating registration tokens, listing agents, revoking them — through
 * the real `route({ workspaceRole })` boundary (session, workspace, role), in the style of
 * tests/api/workspace-sharing.test.ts. Includes the tenant boundary: an admin of workspace A can neither see
 * nor revoke nor bind to anything of workspace B.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest as RequestType } from "next/server";
import type { SessionUser } from "@/lib/auth/session";
import type { Environment, Manifest, Member, Project, Workspace } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-runners-admin-", { fast: true });
process.env.ZENITH_STORE = "file";

const state = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));

const { POST: createToken } = await import("@/app/api/platform/v1/runners/tokens/route");
const { GET: listRunners } = await import("@/app/api/platform/v1/runners/route");
const { GET: listMachines } = await import("@/app/api/platform/v1/machines/route");
const { POST: revokeRunner } = await import("@/app/api/platform/v1/runners/[id]/revoke/route");
const { POST: revokeMachine } = await import("@/app/api/platform/v1/machines/[id]/revoke/route");
const { POST: registerRunner } = await import("@/app/api/platform/v1/runners/register/route");
const { POST: registerMachine } = await import("@/app/api/platform/v1/machines/register/route");
const { POST: pollRunner } = await import("@/app/api/platform/v1/runners/[id]/poll/route");
const { POST: heartbeatRunner } = await import("@/app/api/platform/v1/runners/[id]/heartbeat/route");
const { resetDb } = await import("@/lib/db/store");
const { NextRequest } = await import("next/server");
const { createPlane, registerFakeAgent, teardownPlane, call: callRoute, ORIGIN } = await import("./_support");

type Plane = Awaited<ReturnType<typeof createPlane>>;
type Handler = (req: RequestType, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const AT = "2026-01-01T00:00:00.000Z";
const user = (id: string): SessionUser => ({ id, email: `${id}@zenith.test`, name: id });
const workspace = (id: string): Workspace => ({ id, name: id, slug: id, ownerId: "x", createdAt: AT }) as Workspace;
const member = (id: string, workspaceId: string, role: Member["role"]): Member => ({ id, workspaceId, role, name: id, email: `${id}@zenith.test` });
const manifest = (): Manifest => ({ version: 1, services: [], resources: [], routes: [], bindings: [] });
const project = (id: string, workspaceId: string): Project => ({ id, workspaceId, name: id, slug: id, workingManifest: manifest(), createdAt: AT, origin: { type: "blank" } }) as Project;
const environment = (id: string, projectId: string): Environment =>
  ({ id, projectId, name: "sandbox", class: "sandbox", connectionId: "c", region: "local", policies: { approvalRequired: false, allowStatefulDeletion: false }, baseDomain: "t", createdAt: AT }) as unknown as Environment;

function seed(): void {
  resetDb({
    workspaces: [workspace("w-a"), workspace("w-b")],
    members: [member("ada", "w-a", "admin"), member("edie", "w-a", "editor"), member("vic", "w-a", "viewer"), member("bo", "w-b", "admin")],
    projects: [project("pa", "w-a"), project("pb", "w-b")],
    environments: [environment("env-a", "pa"), environment("env-b", "pb")],
  });
}

const http = async (handler: unknown, method: string, path: string, opts: { body?: unknown; id?: string } = {}) => {
  const res = await (handler as Handler)(
    new NextRequest(`https://zenith.test${path}`, { method, headers: { "content-type": "application/json" }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }),
    { params: Promise.resolve({ id: opts.id ?? "unused" }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { message: string; fix?: string } }, headers: res.headers };
};

let plane: Plane;
beforeEach(async () => {
  seed();
  state.user = user("ada");
  plane = await createPlane("fake");
});
afterEach(teardownPlane);

describe("POST /runners/tokens", () => {
  it("lets a workspace admin mint a runner token: zrt_…, shown once, at most an hour, bound to THEIR workspace", async () => {
    const res = await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body: { kind: "runner" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.body).toMatchObject({ kind: "runner", workspaceId: "w-a", shownOnce: true });
    expect(String(res.body.token)).toMatch(/^zrt_[A-Za-z0-9_-]{32}$/);
    expect(Date.parse(String(res.body.expiresAt)) - plane.rt.now()).toBe(60 * 60 * 1000);
    // the token registers a runner into w-a — and only once
    const reg = await callRoute(registerRunner, new NextRequest(new URL("/api/platform/v1/runners/register", ORIGIN), { method: "POST", body: JSON.stringify({ token: res.body.token, publicKey: "A".repeat(43), name: "r", capabilities: ["aws.http"] }) }));
    expect(reg.status).toBe(201);
    expect(reg.body.workspaceId).toBe("w-a");
  });

  it("does not list the raw token anywhere afterwards", async () => {
    const res = await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body: {} });
    const token = String(res.body.token);
    const list = await http(listRunners, "GET", "/api/platform/v1/runners");
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(res.body.kind).toBe("runner"); // the default kind
  });

  it("mints machine tokens, optionally bound to an environment of the caller's workspace", async () => {
    const res = await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body: { kind: "machine", ttlMinutes: 10, binding: { environmentId: "env-a", address: "compute_instance/worker-1" } } });
    expect(res.status).toBe(201);
    expect(String(res.body.token)).toMatch(/^zmt_/);
    expect(Date.parse(String(res.body.expiresAt)) - plane.rt.now()).toBe(10 * 60 * 1000);
    const reg = await callRoute(registerMachine, new NextRequest(new URL("/api/platform/v1/machines/register", ORIGIN), { method: "POST", body: JSON.stringify({ token: res.body.token, publicKey: "A".repeat(43), name: "m", capabilities: ["machine.inspect"] }) }));
    expect(reg.status).toBe(201);
    expect(await plane.store.machines.get("w-a", String(reg.body.id))).toMatchObject({ environmentId: "env-a", address: "compute_instance/worker-1" });
  });

  it("refuses to bind a machine to another workspace's environment (404), and a binding on a runner token (400)", async () => {
    const other = await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body: { kind: "machine", binding: { environmentId: "env-b" } } });
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain("pb"); // and it does not confirm the foreign environment exists
    const runnerBinding = await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body: { kind: "runner", binding: { environmentId: "env-a" } } });
    expect(runnerBinding.status).toBe(400);
  });

  it("refuses anyone below admin", async () => {
    for (const who of ["edie", "vic"]) {
      state.user = user(who);
      const res = await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body: { kind: "runner" } });
      expect(res.status, who).toBe(403);
    }
  });

  it("refuses an anonymous caller and another workspace's admin acting in the wrong workspace", async () => {
    state.user = null;
    expect((await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body: {} })).status).toBeGreaterThanOrEqual(400);
    // Bo is an admin of w-b only: the token he mints is for w-b, never w-a
    state.user = user("bo");
    const res = await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body: {} });
    expect(res.status).toBe(201);
    expect(res.body.workspaceId).toBe("w-b");
  });

  it("validates the body: kind, ttl bounds, unknown members", async () => {
    for (const body of [{ kind: "agent" }, { ttlMinutes: 0 }, { ttlMinutes: 61 }, { ttlMinutes: 1.5 }, { unknown: 1 }, { binding: { secret: "x" }, kind: "machine" }, { kind: "machine", binding: { address: "" } }]) {
      const res = await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await http(createToken, "POST", "/api/platform/v1/runners/tokens", { body: { ttlMinutes: 60 } })).status).toBe(201);
  });
});

describe("list and revoke are tenant-scoped", () => {
  it("each admin sees only their own workspace's runners and machines", async () => {
    const a = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-a", name: "a-runner" });
    await registerFakeAgent(plane, registerRunner, { workspaceId: "w-b", name: "b-runner" });
    await registerFakeAgent(plane, registerMachine, { kind: "machine", workspaceId: "w-a", name: "a-box" });
    const mine = await http(listRunners, "GET", "/api/platform/v1/runners");
    expect((mine.body.runners as { id: string; name: string }[]).map((r) => r.name)).toEqual(["a-runner"]);
    expect((mine.body.runners as { id: string }[])[0].id).toBe(a.id);
    expect(JSON.stringify(mine.body)).not.toContain("b-runner");
    expect(Object.keys((mine.body.runners as object[])[0] as object)).not.toContain("publicKey");
    expect(((await http(listMachines, "GET", "/api/platform/v1/machines")).body.machines as { name: string }[]).map((m) => m.name)).toEqual(["a-box"]);
    state.user = user("bo");
    expect(((await http(listRunners, "GET", "/api/platform/v1/runners")).body.runners as { name: string }[]).map((r) => r.name)).toEqual(["b-runner"]);
    // a viewer may look, not revoke
    state.user = user("vic");
    expect((await http(listRunners, "GET", "/api/platform/v1/runners")).status).toBe(200);
  });

  it("an admin revokes their own runner: it is told 401 agent_revoked on its next call and never polled again", async () => {
    const runner = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-a" });
    const res = await http(revokeRunner, "POST", `/api/platform/v1/runners/${runner.id}/revoke`, { id: runner.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: runner.id, status: "revoked", cancelledJobs: 0 });
    expect((await runner.post(pollRunner, "/poll", { max: 1, waitSec: 0 })).body.error?.code).toBe("agent_revoked");
    expect((await runner.post(heartbeatRunner, "/heartbeat", {})).status).toBe(401);
    expect(plane.events.map((e) => e.type)).toContain("runner.revoked");
    expect(plane.events.find((e) => e.type === "runner.revoked")).toMatchObject({ workspaceId: "w-a", agentId: runner.id, actorId: "ada" });
  });

  it("an admin of workspace A CANNOT revoke a runner of workspace B: 404, and B's runner keeps working", async () => {
    const theirs = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-b" });
    const res = await http(revokeRunner, "POST", `/api/platform/v1/runners/${theirs.id}/revoke`, { id: theirs.id });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("w-b");
    expect((await plane.store.runners.get("w-b", theirs.id))?.status).toBe("active");
    expect((await theirs.post(heartbeatRunner, "/heartbeat", {})).status).toBe(200);
    expect(plane.events.filter((e) => e.type === "runner.revoked")).toEqual([]);
  });

  it("the same holds for machines, and for ids that do not exist or are not ids", async () => {
    const theirs = await registerFakeAgent(plane, registerMachine, { kind: "machine", workspaceId: "w-b" });
    expect((await http(revokeMachine, "POST", `/api/platform/v1/machines/${theirs.id}/revoke`, { id: theirs.id })).status).toBe(404);
    expect((await plane.store.machines.get("w-b", theirs.id))?.status).toBe("active");
    expect((await http(revokeRunner, "POST", "/api/platform/v1/runners/run_nope/revoke", { id: "run_nope" })).status).toBe(404);
    expect((await http(revokeRunner, "POST", "/api/platform/v1/runners/x%20y/revoke", { id: "x y" })).status).toBe(404);
    const mine = await registerFakeAgent(plane, registerMachine, { kind: "machine", workspaceId: "w-a" });
    expect((await http(revokeMachine, "POST", `/api/platform/v1/machines/${mine.id}/revoke`, { id: mine.id })).status).toBe(200);
  });

  it("only admins revoke", async () => {
    const runner = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-a" });
    for (const who of ["edie", "vic"]) {
      state.user = user(who);
      expect((await http(revokeRunner, "POST", `/api/platform/v1/runners/${runner.id}/revoke`, { id: runner.id })).status, who).toBe(403);
    }
    expect((await plane.store.runners.get("w-a", runner.id))?.status).toBe("active");
  });

  it("a revoke cancels the runner's queued work and is idempotent", async () => {
    const { enqueueProbeJob } = await import("./_support");
    const runner = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-a" });
    await enqueueProbeJob(plane, runner);
    await enqueueProbeJob(plane, runner, { port: 23 });
    const first = await http(revokeRunner, "POST", `/api/platform/v1/runners/${runner.id}/revoke`, { id: runner.id });
    expect(first.body).toMatchObject({ status: "revoked", cancelledJobs: 2 });
    expect((await http(revokeRunner, "POST", `/api/platform/v1/runners/${runner.id}/revoke`, { id: runner.id })).body).toMatchObject({ status: "revoked", cancelledJobs: 0 });
  });
});
