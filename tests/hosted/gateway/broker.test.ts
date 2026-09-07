/**
 * `/_zenith/data/v1/*` — the fixed broker's HTTP surface, over the real
 * `TrackerDataStore` in this test's own data directory.
 *
 * The store is not doubled: a conflict test that did not exercise the real
 * compare-and-swap would be testing the double. What is doubled is who the
 * caller is, which belongs to W5.
 *
 * The sentinel matters most here. A viewer's write, a cross-site write and an
 * oversized body must all be refused with `brokerInvoked` still at zero — the
 * store enforces the same role rule independently, and this file is what shows
 * which of the two actually fired.
 *
 * Workstream W6 (hosted R3).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { IDENTITIES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import type { EquipmentRequest } from "@/lib/hosted/contracts";
import {
  appOrigin,
  call,
  errorBody,
  makeDoubles,
  provenance,
  resolved,
  seedActiveRelease,
  seedApp,
  seedArtifactRow,
  sessionCookie,
  writeBuiltTree,
} from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-gateway-broker-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { hostedConfig } = await import("@/lib/hosted/config");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { gatewayTelemetry, handleGateway, resetGatewayDeps, resetGatewayTelemetry, setGatewayDepsForTests } =
  await import("@/lib/hosted/gateway");

const authority = openAuthority();
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(writeBuiltTree(DATA_DIR), provenance("job-broker"));
seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const alpha = seedApp(authority, { slug: "alpha" });
const release = seedActiveRelease(authority, alpha, artifact.digest);

const doubles = makeDoubles();
const EDITOR = "cookie-editor";
const VIEWER = "cookie-viewer";
const ORIGIN = appOrigin("alpha");
const REQUESTS = "/_zenith/data/v1/requests";

beforeEach(() => {
  resetGatewayDeps();
  setGatewayDepsForTests(doubles.deps);
  resetGatewayTelemetry();
  doubles.state.events.length = 0;
  doubles.state.sessions.clear();
  doubles.state.sessions.set(
    EDITOR,
    resolved(alpha, { subject: IDENTITIES.editor.subject, email: IDENTITIES.editor.email, role: "editor" })
  );
  doubles.state.sessions.set(
    VIEWER,
    resolved(alpha, { subject: IDENTITIES.viewer.subject, email: IDENTITIES.viewer.email, role: "viewer" })
  );
});

afterAll(() => {
  resetGatewayDeps();
  closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

interface CallShape {
  path: string;
  method?: string;
  cookie?: string;
  origin?: string | undefined;
  body?: unknown;
  headers?: Record<string, string>;
  contentType?: string;
}

/** One broker call as the app's own client would make it. */
async function broker(shape: CallShape): Promise<Response> {
  const { req, params } = call({
    path: shape.path,
    method: shape.method ?? "GET",
    cookie: sessionCookie(shape.cookie ?? EDITOR),
    accept: "application/json",
    ...(shape.origin === undefined ? {} : { origin: shape.origin }),
    ...(shape.contentType === undefined ? {} : { contentType: shape.contentType }),
    ...(shape.body === undefined ? {} : { body: JSON.stringify(shape.body) }),
    headers: shape.headers,
  });
  return handleGateway(req, params);
}

/** A write from the app's own page: same origin, JSON, a fresh write id. */
const write = (shape: Omit<CallShape, "origin">): Promise<Response> => broker({ ...shape, origin: ORIGIN });

const record = async (res: Response): Promise<EquipmentRequest> =>
  ((await res.json()) as { record: EquipmentRequest }).record;

const newRequest = () => ({
  writeId: uuid(),
  record: { title: "Standing desk", category: "furniture" as const, quantity: 1 },
});

describe("reading", () => {
  it("lists, reads and pages through this app's own records", async () => {
    const created = await record(await write({ path: REQUESTS, method: "POST", body: newRequest() }));

    const one = await broker({ path: `${REQUESTS}/${created.id}` });
    expect(one.status).toBe(200);
    expect((await record(one)).id).toBe(created.id);

    const list = await broker({ path: `${REQUESTS}?limit=1` });
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: EquipmentRequest[]; nextCursor?: string };
    expect(page.items.length).toBe(1);
    expect(list.headers.get("x-zenith-release")).toBe(release.id);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
  });

  it("lets a viewer read", async () => {
    const res = await broker({ path: REQUESTS, cookie: VIEWER });
    expect(res.status).toBe(200);
  });

  it("answers 404 for a record this app does not have", async () => {
    const res = await broker({ path: `${REQUESTS}/${uuid()}` });
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("not_found");
  });

  it("drops query parameters the contract does not name rather than refusing the link", async () => {
    const res = await broker({ path: `${REQUESTS}?limit=5&utm_source=email` });
    expect(res.status).toBe(200);
  });
});

describe("writing", () => {
  it("creates with 201 and replays the same write id without creating twice", async () => {
    const body = newRequest();
    const first = await write({ path: REQUESTS, method: "POST", body });
    expect(first.status).toBe(201);
    expect(first.headers.get("x-zenith-replayed")).toBeNull();
    const created = await record(first);

    const replay = await write({ path: REQUESTS, method: "POST", body });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("x-zenith-replayed")).toBe("true");
    expect((await record(replay)).id).toBe(created.id);

    expect(doubles.state.events.filter((e) => e.event === "record.created").length).toBe(2);
    expect(doubles.state.events.find((e) => e.event === "record.created")?.logicalId).toBe(body.writeId);
  });

  it("updates with the version it read, and refuses a stale one with the current record", async () => {
    const created = await record(await write({ path: REQUESTS, method: "POST", body: newRequest() }));

    const updated = await write({
      path: `${REQUESTS}/${created.id}`,
      method: "PATCH",
      body: { writeId: uuid(), expectedVersion: created.version, patch: { status: "approved" } },
    });
    expect(updated.status).toBe(200);
    expect((await record(updated)).version).toBe(created.version + 1);

    const stale = await write({
      path: `${REQUESTS}/${created.id}`,
      method: "PATCH",
      body: { writeId: uuid(), expectedVersion: created.version, patch: { status: "ordered" } },
    });
    expect(stale.status).toBe(409);
    const error = await errorBody(stale);
    expect(error.code).toBe("stale_version");
    const current = error.details?.current as EquipmentRequest;
    expect(current.version).toBe(created.version + 1);
    expect(current.status).toBe("approved");
    expect(doubles.state.events.map((e) => e.event)).toContain("record.conflict");
  });

  it("refuses a viewer's write before the store is called at all", async () => {
    const res = await write({ path: REQUESTS, method: "POST", cookie: VIEWER, body: newRequest() });
    expect(res.status).toBe(403);
    const error = await errorBody(res);
    expect(error.code).toBe("forbidden");
    expect(error.message).toContain("viewers can read");
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
    expect(doubles.state.events.map((e) => e.event)).toContain("access.denied");
  });
});

describe("cross-site protection", () => {
  it("refuses a write with no Origin at all", async () => {
    const res = await broker({ path: REQUESTS, method: "POST", body: newRequest() });
    expect(res.status).toBe(403);
    expect((await errorBody(res)).code).toBe("csrf_rejected");
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
  });

  it("refuses a sibling app's origin on the same domain", async () => {
    const res = await broker({
      path: REQUESTS,
      method: "POST",
      origin: appOrigin("beta"),
      body: newRequest(),
    });
    expect(res.status).toBe(403);
    expect((await errorBody(res)).code).toBe("csrf_rejected");
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
  });

  it("refuses a browser that says the request came from another site", async () => {
    const res = await write({
      path: REQUESTS,
      method: "POST",
      body: newRequest(),
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect((await errorBody(res)).code).toBe("csrf_rejected");
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
  });

  it("accepts same-origin and none, which is what a real navigation sends", async () => {
    for (const site of ["same-origin", "none"]) {
      const res = await write({
        path: REQUESTS,
        method: "POST",
        body: newRequest(),
        headers: { "sec-fetch-site": site },
      });
      expect(res.status, site).toBe(201);
    }
  });

  it("refuses a form-encoded write even with the right origin", async () => {
    const res = await write({
      path: REQUESTS,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: newRequest(),
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("invalid_input");
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
  });

  it("does not ask a read for an origin", async () => {
    expect((await broker({ path: REQUESTS })).status).toBe(200);
  });
});

describe("limits and shapes", () => {
  it("answers 413 for a body over the limit, without reading it into a record", async () => {
    const { req, params } = call({
      path: REQUESTS,
      method: "POST",
      cookie: sessionCookie(EDITOR),
      accept: "application/json",
      origin: ORIGIN,
      body: JSON.stringify({ writeId: uuid(), record: { title: "x".repeat(2_000_000), category: "other" } }),
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(413);
    expect((await errorBody(res)).code).toBe("body_too_large");
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
  });

  it("answers 405 with allow for a method the path does not take", async () => {
    const collection = await broker({ path: REQUESTS, method: "PATCH", origin: ORIGIN });
    expect(collection.status).toBe(405);
    expect(collection.headers.get("allow")).toBe("GET, POST");

    const item = await broker({ path: `${REQUESTS}/abc`, method: "POST", origin: ORIGIN });
    expect(item.status).toBe(405);
    expect(item.headers.get("allow")).toBe("GET, PATCH");

    const put = await broker({ path: REQUESTS, method: "PUT", origin: ORIGIN });
    expect(put.status).toBe(405);
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
  });

  it("answers 404 for a reserved path that is not a route", async () => {
    const res = await broker({ path: "/_zenith/unknown" });
    expect(res.status).toBe(404);
    const error = await errorBody(res);
    expect(error.code).toBe("not_found");
    expect(error.fix).toContain("/_zenith/");
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
  });

  it("answers 404 for a nested data path the contract does not define", async () => {
    const res = await broker({ path: `${REQUESTS}/abc/history` });
    expect(res.status).toBe(404);
    expect(gatewayTelemetry.brokerInvoked).toBe(0);
  });

  it("refuses an invalid record with the store's own explanation", async () => {
    const res = await write({
      path: REQUESTS,
      method: "POST",
      body: { writeId: uuid(), record: { title: "", category: "spaceship" } },
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("invalid_input");
  });
});
