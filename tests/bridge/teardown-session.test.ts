/** Fake headers/identity replies; exercises the real proof guard without network. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import { teardownBrowserSession } from "@/lib/bridge/teardown-session";

const fake = vi.hoisted(() => ({ headers: vi.fn(), state: vi.fn(), configured: vi.fn(), hosted: vi.fn(), identity: vi.fn() }));
vi.mock("next/headers", () => ({ headers: fake.headers }));
vi.mock("@/lib/server/request", () => ({ currentRequest: fake.state }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: fake.configured }));
vi.mock("@/lib/hosted/config", () => ({ hostedMode: fake.hosted }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: fake.identity }));
const ctx: ActionContext = { workspaceId: "ws", actor: { type: "user", id: "human", name: "Human" } };
let headers: Headers;
beforeEach(() => {
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.example.com");
  headers = new Headers({ host: "zenith.example.com", origin: "https://zenith.example.com", "sec-fetch-site": "same-origin", cookie: "fixture=nonsecret" });
  fake.headers.mockImplementation(async () => headers);
  fake.state.mockReturnValue({ user: { id: "human" }, member: { id: "human", workspaceId: "ws" } });
  fake.configured.mockReturnValue(true); fake.hosted.mockReturnValue(true);
  fake.identity.mockReset(); fake.identity.mockResolvedValue({ subject: "human", emailVerified: true });
});
afterEach(() => vi.unstubAllEnvs());
it("verifies identity live for a same-origin browser member", async () => {
  expect(await teardownBrowserSession(ctx)).toMatchObject({ method: "browser_session", subject: "human" });
  expect(fake.identity).toHaveBeenCalledTimes(1);
  expect(fake.identity.mock.calls[0][0].headers.get("cookie")).toBe("fixture=nonsecret");
});
it.each(["authorization", "x-zenith-actor", "x-zenith-actor-key"])("refuses %s before identity verification", async (key) => {
  headers.set(key, "fixture"); expect(await teardownBrowserSession(ctx)).toBeUndefined(); expect(fake.identity).not.toHaveBeenCalled();
});
it.each(["https://zenith.example.com.evil.test", "null", "https://evil.test"])("refuses foreign origin %s", async (origin) => {
  headers.set("origin", origin); expect(await teardownBrowserSession(ctx)).toBeUndefined();
});
it("refuses missing origin, cross-site, expired identity and mismatched subjects", async () => {
  headers.delete("origin"); expect(await teardownBrowserSession(ctx)).toBeUndefined();
  headers.set("origin", "https://zenith.example.com"); headers.set("sec-fetch-site", "cross-site"); expect(await teardownBrowserSession(ctx)).toBeUndefined();
  headers.set("sec-fetch-site", "same-origin"); fake.identity.mockRejectedValueOnce(new Error("identity unavailable")); expect(await teardownBrowserSession(ctx)).toBeUndefined();
  fake.identity.mockResolvedValueOnce({ subject: "someone-else", emailVerified: true }); expect(await teardownBrowserSession(ctx)).toBeUndefined();
  fake.identity.mockResolvedValueOnce({ subject: "human", emailVerified: false }); expect(await teardownBrowserSession(ctx)).toBeUndefined();
});
it("refuses non-human contexts and calls outside route", async () => {
  expect(await teardownBrowserSession({ ...ctx, actor: { ...ctx.actor, type: "navigator" } })).toBeUndefined();
  expect(await teardownBrowserSession({ ...ctx, integration: { clientId: "agent", operationId: "op", proposalDigest: "digest" } })).toBeUndefined();
  fake.state.mockReturnValue(undefined); expect(await teardownBrowserSession(ctx)).toBeUndefined();
});
it("allows the local browser only in self-hosted demo mode", async () => {
  fake.configured.mockReturnValue(false); const local = { ...ctx, actor: { ...ctx.actor, id: "local" } };
  expect(await teardownBrowserSession(local)).toBeUndefined();
  fake.hosted.mockReturnValue(false); expect(await teardownBrowserSession(local)).toMatchObject({ subject: "local" });
  expect(await teardownBrowserSession(ctx)).toBeUndefined();
});
