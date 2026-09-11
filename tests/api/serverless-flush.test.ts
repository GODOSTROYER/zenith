/**
 * Commit before ACK, on a host that can freeze the instance.
 *
 * `save()` defers the snapshot write by 50ms behind an unref'd timer. On a
 * long-lived server that is a coalescing window with an exit hook behind it;
 * on a serverless instance it is a write that may never happen, because the
 * instance can be frozen the moment the response leaves and the next request
 * lands on a different one with its own `/tmp`. So `route()` closes the window
 * itself after a mutating handler, in one place, rather than per route.
 *
 * Local behaviour must not change: the same POST with `ZENITH_SERVERLESS`
 * unset still leaves the write on the timer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-flush-", { fast: true });
const STATE = path.join(DATA, "state.json");

const { db, flush, resetDb, save } = await import("@/lib/db/store");
const { route } = await import("@/lib/server/request");

const snapshot = (): string => (fs.existsSync(STATE) ? fs.readFileSync(STATE, "utf8") : "");

/** A route whose handler mutates the store exactly the way an action does. */
const marking = (marker: string) =>
  route(async () => {
    (db().settings as Record<string, unknown>).marker = marker;
    save();
    return { ok: true };
  });

const call = async (handler: ReturnType<typeof marking>, method: string): Promise<Response> =>
  handler(new NextRequest("http://zenith.test/api/test", { method }), {
    params: Promise.resolve({}),
  });

describe("route() and the deferred snapshot write", () => {
  beforeEach(() => {
    delete process.env.VERCEL;
    delete process.env.ZENITH_SERVERLESS;
    resetDb();
    flush();
  });

  it("writes a mutating request's state before answering, on serverless", async () => {
    process.env.ZENITH_SERVERLESS = "1";
    const res = await call(marking("posted"), "POST");
    expect(res.status).toBe(200);
    expect(snapshot()).toContain("posted");
  });

  it("does not pay for a write on a read, even on serverless", async () => {
    process.env.ZENITH_SERVERLESS = "1";
    // The handler is the same one — what differs is only the method, so what
    // this pins is the method test and not a route that happened not to write.
    await call(marking("read-path"), "GET");
    expect(snapshot()).not.toContain("read-path");
    // …and the mutation was real: it was only still sitting on the timer.
    flush();
    expect(snapshot()).toContain("read-path");
  });

  it("leaves local coalescing exactly as it was", async () => {
    await call(marking("local"), "POST");
    expect(snapshot()).not.toContain("local");
    flush();
    expect(snapshot()).toContain("local");
  });
});
