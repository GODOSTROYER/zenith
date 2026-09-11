/**
 * The internal tick routes: who may call them, and what they answer.
 *
 * These five routes are the only way background work happens on a host with no
 * long-lived process, which makes them the only routes in the product that do
 * real work for a caller with no session. So the gate is the whole design, and
 * it is pinned here:
 *
 *  1. **401 without the bearer** — a wrong token, a missing header and an empty
 *     one all take the same path;
 *  2. **503 with `CRON_SECRET` unset** — never "run it anyway": an internal
 *     route that silently becomes public because a variable was forgotten is a
 *     worse failure than a tick that does not happen;
 *  3. **200 with counts** when the bearer matches, on the file store;
 *  4. the comparison is **constant-time** — `timingSafeEqual`, over digests so
 *     that a length mismatch neither throws nor answers faster.
 *
 * The file store is the store under test on purpose: what these routes own is
 * the gate and the shape of the pass, and both are identical on either store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-cron-", { fast: true });

/**
 * Spy on the one primitive the gate is allowed to use. Everything else in
 * `node:crypto` is passed through untouched — half the server reaches for
 * `randomUUID` and `createHash` on the way through a request.
 */
const timingSafeEqual = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, default: actual, timingSafeEqual };
});

const SECRET = "test-cron-secret-value";

const { POST: tickEngine } = await import("@/app/api/internal/tick/engine/route");
const { POST: tickAlerts } = await import("@/app/api/internal/tick/alerts/route");
const { POST: tickOutbox } = await import("@/app/api/internal/tick/outbox/route");
const { POST: tickJobs } = await import("@/app/api/internal/tick/jobs/route");
const { GET: keepalive } = await import("@/app/api/internal/keepalive/route");
const { constantTimeEqual, nudge, NUDGE_INTERVAL_MS } = await import("@/lib/server/cron");
const { db, resetDb, save, flush } = await import("@/lib/db/store");

type Handler = (req: NextRequest) => Promise<Response>;

/** Every route, by the name its body reports, so each claim covers all five. */
const ROUTES: [string, Handler, string][] = [
  ["engine", tickEngine as Handler, "POST"],
  ["alerts", tickAlerts as Handler, "POST"],
  ["outbox", tickOutbox as Handler, "POST"],
  ["jobs", tickJobs as Handler, "POST"],
  ["keepalive", keepalive as Handler, "GET"],
];

const call = (
  handler: Handler,
  method: string,
  opts: { bearer?: string; raw?: string; query?: string } = {}
): Promise<Response> => {
  const headers = new Headers();
  if (opts.raw !== undefined) headers.set("authorization", opts.raw);
  else if (opts.bearer !== undefined) headers.set("authorization", `Bearer ${opts.bearer}`);
  return handler(
    new NextRequest(`http://zenith.test/api/internal/x${opts.query ?? ""}`, { method, headers })
  );
};

describe("the internal tick routes", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    delete process.env.VERCEL;
    delete process.env.ZENITH_SERVERLESS;
    timingSafeEqual.mockClear();
    resetDb();
    flush();
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  describe.each(ROUTES)("/api/internal/.../%s", (name, handler, method) => {
    it("refuses a request with no Authorization header", async () => {
      const res = await call(handler, method);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { message: string; fix?: string } };
      expect(body.error.message).toContain("scheduler");
      expect(body.error.fix).toContain("CRON_SECRET");
    });

    it("refuses a wrong bearer, and a header that is not a bearer at all", async () => {
      expect((await call(handler, method, { bearer: "nope" })).status).toBe(401);
      expect((await call(handler, method, { raw: SECRET })).status).toBe(401);
      expect((await call(handler, method, { raw: `Basic ${SECRET}` })).status).toBe(401);
      expect((await call(handler, method, { bearer: "" })).status).toBe(401);
    });

    it("answers 503, not 200, when CRON_SECRET is unset", async () => {
      delete process.env.CRON_SECRET;
      const res = await call(handler, method, { bearer: SECRET });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { message: string; fix?: string } };
      expect(body.error.message).toContain("CRON_SECRET");
      expect(body.error.fix).toContain("Vercel");
    });

    it("runs one pass and answers counts with the right bearer", async () => {
      const res = await call(handler, method, { bearer: SECRET, query: "?budgetMs=0" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.pass).toBe(name);
      expect(body.ok).toBe(true);
      expect(typeof body.ms).toBe("number");
      // Every pass reports numbers, never a bare ok: a tick that says nothing
      // about what it did is indistinguishable from one that did nothing.
      const counts = Object.entries(body).filter(
        ([k]) => k !== "pass" && k !== "ok" && k !== "ms"
      );
      expect(counts.length).toBeGreaterThan(0);
    });
  });

  it("compares the bearer in constant time, over digests", async () => {
    await call(tickAlerts as Handler, "POST", { bearer: "x" });
    expect(timingSafeEqual).toHaveBeenCalled();
    // Both sides are SHA-256 digests, so a length mismatch can neither throw
    // (which `timingSafeEqual` does on unequal buffers) nor return early.
    for (const [a, b] of timingSafeEqual.mock.calls as [Buffer, Buffer][]) {
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
    }
    // A wildly shorter candidate is still compared, and still refused.
    expect(constantTimeEqual("", SECRET)).toBe(false);
    expect(constantTimeEqual(`${SECRET} `, SECRET)).toBe(false);
    expect(constantTimeEqual(SECRET, SECRET)).toBe(true);
  });

  it("reports what the engine pass found, and stays inside its budget", async () => {
    const res = await call(tickEngine as Handler, "POST", {
      bearer: SECRET,
      query: "?budgetMs=0",
    });
    const body = (await res.json()) as {
      deployments: number;
      ticks: number;
      remaining: number;
      timedOut: boolean;
    };
    expect(body.deployments).toBe(0);
    expect(body.remaining).toBe(0);
    expect(body.timedOut).toBe(false);
    // Nothing is deploying, so the loop never runs: an idle tick costs nothing.
    expect(body.ticks).toBe(0);
  });

  it("keepalive reads the store, which is the whole point of it", async () => {
    const res = await call(keepalive as Handler, "GET", { bearer: SECRET });
    const body = (await res.json()) as { workspaces: number };
    expect(res.status).toBe(200);
    expect(body.workspaces).toBe(db().workspaces.length);
  });

  it("the hosted job pass is honest when the authority is not open", async () => {
    const res = await call(tickJobs as Handler, "POST", { bearer: SECRET });
    const body = (await res.json()) as { ran: boolean; queued: number };
    expect(res.status).toBe(200);
    expect(typeof body.ran).toBe("boolean");
    expect(body.queued).toBe(0);
  });
});

describe("nudge() on the request path", () => {
  beforeEach(() => {
    delete process.env.VERCEL;
    delete process.env.ZENITH_SERVERLESS;
    delete (globalThis as { __zenithNudgeAt?: number }).__zenithNudgeAt;
    resetDb();
    flush();
  });

  it("does nothing on a host that has its own ticker", () => {
    nudge("ws-1");
    expect((globalThis as { __zenithNudgeAt?: number }).__zenithNudgeAt).toBeUndefined();
  });

  it("does nothing on serverless when nothing is in flight", () => {
    process.env.ZENITH_SERVERLESS = "1";
    nudge("ws-1");
    expect((globalThis as { __zenithNudgeAt?: number }).__zenithNudgeAt).toBeUndefined();
  });

  it("ticks at most once per window when a deployment is in flight", () => {
    process.env.ZENITH_SERVERLESS = "1";
    const data = db() as unknown as {
      workspaces: Record<string, unknown>[];
      projects: Record<string, unknown>[];
      deployments: Record<string, unknown>[];
    };
    data.workspaces.push({ id: "ws-1", slug: "acme", name: "Acme", createdAt: new Date().toISOString() });
    data.projects.push({ id: "p-1", workspaceId: "ws-1", slug: "api", name: "API" });
    data.deployments.push({ id: "d-1", projectId: "p-1", status: "applying", steps: [] });
    save();

    nudge("ws-1");
    const first = (globalThis as { __zenithNudgeAt?: number }).__zenithNudgeAt;
    expect(first).toBeGreaterThan(0);

    nudge("ws-1");
    expect((globalThis as { __zenithNudgeAt?: number }).__zenithNudgeAt).toBe(first);
    expect(NUDGE_INTERVAL_MS).toBeGreaterThan(0);

    // A different workspace's read never advances this one.
    delete (globalThis as { __zenithNudgeAt?: number }).__zenithNudgeAt;
    nudge("ws-other");
    expect((globalThis as { __zenithNudgeAt?: number }).__zenithNudgeAt).toBeUndefined();
  });
});
