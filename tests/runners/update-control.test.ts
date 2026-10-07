import { randomBytes } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import type { SessionUser } from "@/lib/auth/session";
import type { Workspace, Member } from "@/lib/domain/types";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import { updateControlSchema } from "./update-control-schema";

tempDataDir("zenith-update-controls-", { fast: true });
process.env.ZENITH_STORE = "file";
const state = vi.hoisted(() => ({ user: null as SessionUser | null, db: null as PlatformDbHandle | null }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/controlplane/db", async (original) => ({ ...await original<object>(), platformDb: async () => state.db! }));

const { openPlatformDb } = await import("@/lib/controlplane/db");
const { getUpdateControl, putUpdateControl } = await import("@/lib/controlplane/db/repos/agent-updates");
const { createPlatformRunnerStore } = await import("@/lib/runners/db/pg-store");
const { resetDb } = await import("@/lib/db/store");
const { NextRequest } = await import("next/server");
const { createPlane, registerFakeAgent, teardownPlane, call, ORIGIN } = await import("./_support");
const { POST: registerRunner } = await import("@/app/api/platform/v1/runners/register/route");
const { POST: registerMachine } = await import("@/app/api/platform/v1/machines/register/route");
const { GET: read, POST: write } = await import("@/app/api/platform/v1/runners/[id]/update/route");
const { POST: writeMachine } = await import("@/app/api/platform/v1/machines/[id]/update/route");
const { POST: heartbeat } = await import("@/app/api/platform/v1/runners/[id]/heartbeat/route");
const { POST: revoke } = await import("@/app/api/platform/v1/runners/[id]/revoke/route");

type Plane = Awaited<ReturnType<typeof createPlane>>;
let plane: Plane;
const user = (id: string): SessionUser => ({ id, name: id, email: `${id}@zenith.test` });
const ws = (id: string): Workspace => ({ id, name: id, slug: id, ownerId: "ada", createdAt: new Date().toISOString() });
const member = (id: string, workspaceId: string, role: Member["role"]): Member => ({ id, workspaceId, role, name: id, email: `${id}@zenith.test` });
const digest = () => randomBytes(32).toString("hex");
const nonce = () => randomBytes(16).toString("base64url");
const intent = (expectedRevision = 0, hold = true, manifestSha256: string | null = null) => ({ expectedRevision, hold, manifestSha256 });
const request = (handler: unknown, id: string, body?: unknown, method = "POST") => call(handler, new NextRequest(new URL(`/api/platform/v1/runners/${id}/update`, ORIGIN), { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { id });
const agent = (workspaceId = "w-a") => registerFakeAgent(plane, registerRunner, { workspaceId, capabilities: ["probe.http", "agent.update.control.v1"] });

beforeAll(async () => { state.db = await openPlatformDb({ kind: "pglite" }); await state.db.exec(updateControlSchema); });
afterAll(async () => { await state.db?.close(); });
beforeEach(async () => {
  await state.db!.exec("truncate platform.agent_update_controls, platform.agent_nonces, platform.runners, platform.machines, platform.runner_registration_tokens cascade");
  resetDb({ workspaces: [ws("w-a"), ws("w-b")], members: [member("ada", "w-a", "admin"), member("edie", "w-a", "editor"), member("vic", "w-a", "viewer"), member("bo", "w-b", "admin")] });
  state.user = user("ada");
  plane = await createPlane("real", {}, createPlatformRunnerStore(state.db!));
});
afterEach(() => teardownPlane());

describe("human update and hold API with proposed PGlite storage contract", () => {
  it("persists exact digest intent, hold and revision, with no-store reads", async () => {
    const a = await agent(), sha = digest();
    const first = await request(write, a.id, intent(0, false, sha));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ revision: 1, hold: false, manifestSha256: sha, requestedBy: "ada" });
    expect((await request(write, a.id, intent(1))).body).toMatchObject({ revision: 2, hold: true, manifestSha256: null });
    const res = await request(read, a.id, undefined, "GET");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.body.revision).toBe(2);
  });
  it("refuses stale writes without replacing the hold", async () => {
    const a = await agent();
    expect((await request(write, a.id, intent())).status).toBe(200);
    expect((await request(write, a.id, intent(0, false, digest()))).status).toBe(409);
    expect(await getUpdateControl(state.db!, "w-a", "runner", a.id)).toMatchObject({ revision: 1, hold: true });
  });
  it("serializes concurrent first writes using the agent row", async () => {
    const a = await agent();
    const results = await Promise.allSettled([putUpdateControl(state.db!, "w-a", "runner", a.id, "ada", intent()), putUpdateControl(state.db!, "w-a", "runner", a.id, "ada", intent())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("conflict");
  });
  it("denies lower roles and anonymous requests; viewers may read", async () => {
    const a = await agent();
    for (const id of ["edie", "vic"]) { state.user = user(id); expect((await request(write, a.id, intent())).status).toBe(403); }
    expect((await request(read, a.id, undefined, "GET")).status).toBe(200);
    state.user = null;
    expect((await request(write, a.id, intent())).status).toBeGreaterThanOrEqual(400);
  });
  it("hides other tenants, including repository writes and reads", async () => {
    const b = await agent("w-b");
    expect((await request(read, b.id, undefined, "GET")).status).toBe(404);
    expect((await request(write, b.id, intent())).status).toBe(404);
    await expect(putUpdateControl(state.db!, "w-a", "runner", b.id, "ada", intent())).rejects.toMatchObject({ code: "not_found" });
    expect((await getUpdateControl(state.db!, "w-a", "runner", b.id)).revision).toBe(0);
    state.user = user("bo");
    expect((await request(write, b.id, intent())).status).toBe(200);
  });
  it("refuses unsupported agents, revoked identities and unknown body fields", async () => {
    const old = await registerFakeAgent(plane, registerRunner);
    expect((await request(write, old.id, intent())).status).toBe(409);
    const a = await agent();
    for (const body of [intent(0, true, digest()), { ...intent(), manifestUrl: "https://other.test" }, { ...intent(), expectedRevision: -1 }, { ...intent(), manifestSha256: "bad" }]) expect((await request(write, a.id, body)).status).toBe(400);
    expect((await call(revoke, new NextRequest(new URL(`/api/platform/v1/runners/${a.id}/revoke`, ORIGIN), { method: "POST" }), { id: a.id })).status).toBe(200);
    expect((await request(write, a.id, intent())).status).toBe(409);
    expect((await a.post(heartbeat, "/heartbeat", { updateControlNonce: nonce() })).status).toBe(401);
  });
  it("supports machine intent using the machine registry", async () => {
    const a = await registerFakeAgent(plane, registerMachine, { kind: "machine", capabilities: ["machine.inspect", "agent.update.control.v1"] });
    const res = await call(writeMachine, new NextRequest(new URL(`/api/platform/v1/machines/${a.id}/update`, ORIGIN), { method: "POST", body: JSON.stringify(intent()) }), { id: a.id });
    expect(res.status).toBe(200);
    expect(await getUpdateControl(state.db!, "w-a", "machine", a.id)).toMatchObject({ revision: 1, hold: true });
  });
  it("delivers pinned-key JWS bound to nonce, tenant, kind, agent and exact intent", async () => {
    const a = await agent(), n = nonce(), sha = digest();
    expect((await request(write, a.id, intent(0, false, sha))).status).toBe(200);
    const res = await a.post(heartbeat, "/heartbeat", { updateControlNonce: n });
    expect(res.status).toBe(200);
    const decoded = a.decodeJob(String(res.body.updateControl), "zenith-update-control+jwt");
    expect(decoded.claims).toMatchObject({ schema: "zenith.update-control/v1", nonce: n, workspaceId: "w-a", agentId: a.id, kind: "runner", revision: 1, hold: false, manifestSha256: sha });
    expect(Number(decoded.claims.exp) - Number(decoded.claims.iat)).toBe(60);
    expect(res.body.pollIntervalSec).toBeGreaterThan(0);
    expect((await a.post(heartbeat, "/heartbeat", { updateControlNonce: "wrong" })).status).toBe(400);
    expect((await a.post(heartbeat, "/heartbeat", {})).body.updateControl).toBeUndefined();
  });
  it("fails closed when the unassigned migration is absent", async () => {
    const a = await agent();
    await state.db!.exec("drop table platform.agent_update_controls");
    try {
      expect((await request(write, a.id, intent())).status).toBe(503);
      const res = await a.post(heartbeat, "/heartbeat", { updateControlNonce: nonce() });
      expect(res.status).toBe(503);
      expect(res.body.error?.code).toBe("schema_behind");
      expect(res.body.updateControl).toBeUndefined();
    } finally { await state.db!.exec(updateControlSchema); }
  });
});
