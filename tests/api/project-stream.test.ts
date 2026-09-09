/**
 * The streaming project payload. Driven through the real route handler with a
 * constructed NextRequest — the same trick tests/db uses for the readers — so
 * the SSE framing, the workspace scoping and the change plumbing are all under
 * test rather than a re-implementation of them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { Environment, Manifest, Project, Workspace } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("orrery-stream-");
const { db, flush, resetDb } = await import("@/lib/db/store");
const { GET: streamGet } = await import("@/app/api/projects/[id]/stream/route");
const { GET: projectGet } = await import("@/app/api/projects/[id]/route");

const manifest = (serviceName: string): Manifest => ({
  version: 1,
  services: [
    {
      id: "svc-api",
      name: serviceName,
      kind: "web",
      source: { type: "image", image: "nginx" },
      size: "small",
      replicas: 1,
      port: 3000,
      env: [],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [],
  bindings: [],
});

function seed(): void {
  resetDb({
    workspaces: [{ id: "ws1", name: "Kepler", slug: "kepler" } as Workspace],
    projects: [
      {
        id: "p1",
        workspaceId: "ws1",
        name: "atlas",
        slug: "atlas",
        workingManifest: manifest("api"),
        createdAt: "2026-01-01T00:00:00.000Z",
        origin: { type: "blank" },
      } as Project,
      // Same server, different workspace: an id is not a read grant.
      {
        id: "p2",
        workspaceId: "ws2",
        name: "other",
        slug: "other",
        workingManifest: manifest("api"),
        createdAt: "2026-01-01T00:00:00.000Z",
        origin: { type: "blank" },
      } as Project,
    ],
    environments: [
      {
        id: "env1",
        projectId: "p1",
        name: "sandbox",
        class: "sandbox",
        connectionId: "c1",
        region: "local",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "test",
        createdAt: "2026-01-01T00:00:00.000Z",
      } as unknown as Environment,
    ],
  });
}

const call = (handler: typeof streamGet, id: string, query = "") =>
  handler(new NextRequest(`http://localhost/api/projects/${id}/stream${query}`), {
    params: Promise.resolve({ id }),
  });

const timeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
    ),
  ]);

interface Frame {
  event?: string;
  id?: string;
  data?: Record<string, unknown>;
}

/** Reads the stream frame by frame, ignoring comments (`: open`, `: ping`). */
function frames(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const next = async (what: string): Promise<Frame> => {
    for (;;) {
      const cut = buffer.indexOf("\n\n");
      if (cut >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (raw.startsWith(":")) continue; // heartbeat or the open comment
        const frame: Frame = {};
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("id: ")) frame.id = line.slice(4);
          else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
        }
        return frame;
      }
      const { value, done } = await timeout(reader.read(), 6000, what);
      if (done) throw new Error(`stream ended while waiting for ${what}`);
      buffer += decoder.decode(value, { stream: true });
    }
  };

  return { next, cancel: () => void reader.cancel() };
}

let open: { cancel: () => void } | undefined;

beforeEach(() => seed());
afterEach(() => open?.cancel());

describe("GET /api/projects/:id/stream", () => {
  it("sends the full payload on connect, byte-identical to the GET", async () => {
    const res = await call(streamGet, "atlas");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    open = frames(res);

    const frame = await (open as ReturnType<typeof frames>).next("the payload on connect");
    expect(frame.event).toBe("project");
    expect(frame.id).toBe("0");

    const { etag, ...body } = frame.data as { etag: string };
    // Same shape and same hash as the polled route: one payload, two transports.
    const polled = await call(projectGet, "atlas");
    expect(etag).toBe(polled.headers.get("etag"));
    expect(body).toEqual(await polled.json());
  });

  it("pushes again when the store says the project changed", async () => {
    const res = await call(streamGet, "atlas");
    open = frames(res);
    const first = await (open as ReturnType<typeof frames>).next("the payload on connect");

    db().projects[0].workingManifest = manifest("renamed");
    flush(); // emits the change event the route is subscribed to

    const second = await (open as ReturnType<typeof frames>).next("the payload after a change");
    expect(second.id).toBe("1");
    const project = (second.data as { project: Project }).project;
    expect(project.workingManifest.services[0].name).toBe("renamed");
    expect(second.data!.etag).not.toBe(first.data!.etag);
  });

  it("stays quiet when a save did not move this project's payload", async () => {
    const res = await call(streamGet, "atlas");
    open = frames(res);
    await (open as ReturnType<typeof frames>).next("the payload on connect");

    // A save that touches another project entirely. The route may wake, but a
    // payload whose hash has not moved is not a message.
    db().projects[1].name = "other-renamed";
    flush();

    await expect(
      timeout((open as ReturnType<typeof frames>).next("nothing"), 1200, "silence")
    ).rejects.toThrow(/timed out/);
  });

  it("404s a project in another workspace instead of streaming it", async () => {
    const res = await call(streamGet, "other");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("resumes the id sequence from Last-Event-ID", async () => {
    const req = new NextRequest("http://localhost/api/projects/atlas/stream", {
      headers: { "last-event-id": "41" },
    });
    const res = await streamGet(req, { params: Promise.resolve({ id: "atlas" }) });
    open = frames(res);

    // A snapshot stream has nothing to replay, so a reconnect gets the current
    // state — but its id continues where the last connection left off.
    const frame = await (open as ReturnType<typeof frames>).next("the payload on reconnect");
    expect(frame.id).toBe("42");
  });
});
