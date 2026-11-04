/** Structural request guard, with explicit fake request/session state (no live auth). */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RequestState } from "@/lib/server/request";
import type { ActionContext } from "@/lib/actions/core";
import { bridgeDeps, setBridgeDepsForTests } from "@/lib/bridge/deps";
const mocks = vi.hoisted(() => ({ request: vi.fn<() => RequestState | undefined>(), configured: vi.fn(() => true), hosted: vi.fn(() => true) }));
vi.mock("@/lib/server/request", () => ({ currentRequest: mocks.request }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: mocks.configured }));
vi.mock("@/lib/hosted/config", () => ({ hostedMode: mocks.hosted }));
const ctx: ActionContext = { workspaceId: "ws", actor: { type: "user", id: "human", name: "Human" } };
const state = (): RequestState => ({ user: { id: "human", email: "human@example.com", name: "Human" }, member: { id: "human", workspaceId: "ws", role: "admin", name: "Human", email: "human@example.com" } });
beforeEach(() => { mocks.configured.mockReturnValue(true); mocks.hosted.mockReturnValue(true); mocks.request.mockReturnValue(state()); setBridgeDepsForTests(null); });
afterEach(() => setBridgeDepsForTests(null));
it("requires a route request and a matching signed-in workspace member", async () => {
  expect(await bridgeDeps().browserSession(ctx)).toMatchObject({ method: "browser_session", subject: "human" });
  mocks.request.mockReturnValue(undefined); expect(await bridgeDeps().browserSession(ctx)).toBeUndefined();
  mocks.request.mockReturnValue({ ...state(), user: null }); expect(await bridgeDeps().browserSession(ctx)).toBeUndefined();
  mocks.request.mockReturnValue({ ...state(), member: { ...state().member!, id: "someone-else" } }); expect(await bridgeDeps().browserSession(ctx)).toBeUndefined();
  mocks.request.mockReturnValue({ ...state(), member: { ...state().member!, workspaceId: "foreign" } }); expect(await bridgeDeps().browserSession(ctx)).toBeUndefined();
});
it("Navigator, system actors and integrations cannot mint a browser proof", async () => {
  for (const type of ["navigator", "system"] as const) expect(await bridgeDeps().browserSession({ ...ctx, actor: { ...ctx.actor, type } })).toBeUndefined();
  expect(await bridgeDeps().browserSession({ ...ctx, integration: { operationId: "op", proposalDigest: "digest", clientId: "client" } })).toBeUndefined();
});
it("demo proof requires self-hosted mode and the local actor inside route", async () => {
  mocks.configured.mockReturnValue(false); mocks.request.mockReturnValue({ user: null });
  const local = { ...ctx, actor: { ...ctx.actor, id: "local" } };
  expect(await bridgeDeps().browserSession(local)).toBeUndefined();
  mocks.hosted.mockReturnValue(false); expect(await bridgeDeps().browserSession(local)).toMatchObject({ subject: "local" });
  expect(await bridgeDeps().browserSession(ctx)).toBeUndefined();
});
