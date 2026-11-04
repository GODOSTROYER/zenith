/** Real local HTTP/session acceptance after the route join. No auth or SQL mocks. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const enabled = process.env.ZENITH_TEST_COST_OPT_IN_HTTP === "1";
const Settings = z.object({ enabled: z.boolean(), version: z.number().int().nonnegative() });
const Saved = z.object({ settings: Settings, proposalOnly: z.literal(true) });
const ID = /^[A-Za-z0-9_-]{1,100}$/;

describe.skipIf(!enabled)("actual local optimizer consent route (needs registered route, local identity provider and human cookie)", () => {
  it("requires a human session and same-origin consent, enforces tenant scope/CAS and restores opt-out", async () => {
    const base = new URL(process.env.ZENITH_TEST_COST_OPT_IN_BASE_URL ?? "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || !["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Consent acceptance requires an unauthenticated loopback base URL.");
    const workspace = process.env.ZENITH_TEST_COST_WORKSPACE_ID ?? "";
    const environment = process.env.ZENITH_TEST_COST_ENVIRONMENT_ID ?? "";
    const foreign = process.env.ZENITH_TEST_COST_FOREIGN_ENVIRONMENT_ID ?? "";
    const file = process.env.ZENITH_TEST_COST_HUMAN_COOKIE_FILE ?? "";
    if (![workspace, environment, foreign].every(id => ID.test(id)) || environment === foreign || !isAbsolute(file)) throw new Error("Supply owned local workspace/environment IDs, a different tenant's environment ID and an absolute human-cookie file.");
    const cookie = readFileSync(file, "utf8").trim();
    if (!cookie || /[\r\n]/.test(cookie)) throw new Error("The human-cookie file must contain one Cookie header value.");
    const endpoint = (id: string) => new URL(`/api/platform/v1/environments/${id}/optimizer`, base);
    const headers = { cookie, "x-zenith-workspace": workspace };
    const request = (url: URL, init: RequestInit = {}) => fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const get = async () => {
      const response = await request(endpoint(environment), { headers });
      expect(response.status).toBe(200);
      return Settings.parse(await response.json());
    };
    const post = (body: unknown, origin = true) => {
      const requestHeaders: Record<string, string> = { ...headers, "content-type": "application/json" };
      if (origin) { requestHeaders.origin = base.origin; requestHeaders["sec-fetch-site"] = "same-origin"; }
      return request(endpoint(environment), { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
    };

    // Actual configured local auth is mandatory: local-demo anonymous access must fail this lane.
    expect((await request(endpoint(environment), { headers: { "x-zenith-workspace": workspace } })).status).toBe(401);
    expect((await request(endpoint(environment), { headers: { ...headers, authorization: `Bearer ${randomUUID()}` } })).status).toBe(403);
    expect((await request(endpoint(foreign), { headers })).status).toBe(404);
    const initial = await get(); // Browser GETs normally carry no Origin header.
    expect(initial.enabled).toBe(false); // Use a dedicated opted-out environment.
    expect((await post({ enabled: true, expectedVersion: initial.version }, false)).status).toBe(403);
    expect((await post({ enabled: true, expectedVersion: initial.version, approved: true })).status).toBe(400);
    let changed = false;
    try {
      const response = await post({ enabled: true, expectedVersion: initial.version });
      expect(response.status).toBe(200);
      changed = true;
      const saved = Saved.parse(await response.json());
      expect(saved.settings).toMatchObject({ enabled: true, version: initial.version + 1 });
      expect(await get()).toMatchObject(saved.settings);
      expect((await post({ enabled: false, expectedVersion: initial.version })).status).toBe(409);
    } finally {
      if (changed) {
        const current = await get();
        const response = await post({ enabled: false, expectedVersion: current.version });
        expect(response.status).toBe(200);
        expect(Saved.parse(await response.json()).settings.enabled).toBe(false);
      }
    }
    expect((await get()).enabled).toBe(false);
    // Consent calls create no approval or execution request. The composed sweep may propose only.
  }, 60_000);
});
