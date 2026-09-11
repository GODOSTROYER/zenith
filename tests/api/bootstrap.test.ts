import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { CloudConnection, Deployment, Environment, Project, Workspace } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-bootstrap-");
const { db, resetDb } = await import("@/lib/db/store");
const { emptyManifest } = await import("@/lib/domain/types");
const { actionRegistry } = await import("@/lib/actions/core");
const { GET } = await import("@/app/api/bootstrap/route");

beforeEach(() => {
  resetDb({
    workspaces: [{ id: "ws1", name: "One", slug: "one" }, { id: "ws2", name: "Two", slug: "two" }] as Workspace[],
    projects: ["1", "2"].map((n) => ({
      id: `p${n}`, workspaceId: `ws${n}`, name: n, slug: n,
      workingManifest: emptyManifest(), origin: { type: "blank" }, createdAt: "2026-01-01",
    })) as Project[],
    environments: [
      { id: "env1", projectId: "p1" }, { id: "empty", projectId: "p1" }, { id: "env2", projectId: "p2" },
    ] as Environment[],
    deployments: [
      { id: "old", environmentId: "env1", createdAt: "2026-01-01", status: "succeeded" },
      { id: "other-workspace", environmentId: "env2", createdAt: "2026-03-01", status: "succeeded" },
      { id: "latest", environmentId: "env1", createdAt: "2026-02-01", status: "failed" },
    ] as Deployment[],
    connections: [{
      id: "aws-old", workspaceId: "ws1", provider: "aws", label: "AWS", region: "us-east-1",
      status: "healthy", grantedPermissions: ["stale permission prose"], createdAt: "2026-01-01",
      lastCheckedAt: "2026-01-02",
    }] as CloudConnection[],
  });
});

async function read() {
  const response = await GET(new NextRequest("http://localhost/api/bootstrap"), { params: Promise.resolve({}) });
  expect(response.status).toBe(200);
  return response.json();
}

describe("workspace bootstrap", () => {
  it("carries the real action catalog with only display and permission fields", async () => {
    const body = await read();
    const registry = actionRegistry();
    expect(body.catalog).toHaveLength(registry.size);
    expect(body.catalog.length).toBeGreaterThan(20);
    for (const row of body.catalog) {
      expect(Object.keys(row).sort()).toEqual(["category", "id", "requiredRole", "risk", "title"]);
      expect(row).toEqual(expect.objectContaining({
        id: registry.get(row.id)!.id,
        title: registry.get(row.id)!.title,
        requiredRole: registry.get(row.id)!.requiredRole,
        risk: registry.get(row.id)!.risk,
      }));
    }
  });

  it("selects the newest attempt without leaking another workspace or requiring a deployment", async () => {
    const body = await read();
    expect(body.projects.map((p: Project) => p.id)).toEqual(["p1"]);
    expect(body.environments.map((e: Environment) => e.id)).toEqual(["env1", "empty"]);
    expect(body.deployments.map((d: Deployment) => d.id)).toEqual(["latest"]);
  });

  it("presents current declared access without rewriting the stored check snapshot", async () => {
    const body = await read();
    const connection = body.connections[0] as CloudConnection;
    expect(connection.grantedPermissions).toEqual(["stale permission prose"]);
    expect(connection.declaredPermissions).not.toEqual(connection.grantedPermissions);
    expect(connection.declaredPermissions?.join(" ")).toMatch(/AWS access|Preview/i);
    expect(connection.lastCheckedAt).toBe("2026-01-02");
  });

  it("answers 304 to a matching if-none-match, and 200 again once the payload moves", async () => {
    const first = await GET(new NextRequest("http://localhost/api/bootstrap"), {
      params: Promise.resolve({}),
    });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"[0-9a-f]{8}"$/);

    const conditional = async (tag: string) =>
      GET(
        new NextRequest("http://localhost/api/bootstrap", { headers: { "if-none-match": tag } }),
        { params: Promise.resolve({}) }
      );

    const unchanged = await conditional(etag!);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(etag);
    // A 304 carries no body, and must not become a cacheable one either.
    expect(unchanged.headers.get("cache-control")).toBe("no-store");
    expect(await unchanged.text()).toBe("");

    // A stale tag is a normal read, not a refusal.
    const stale = await conditional('W/"00000000"');
    expect(stale.status).toBe(200);
    expect(stale.headers.get("etag")).toBe(etag);

    // And the tag really tracks the payload.
    db().projects.push({
      id: "p3",
      workspaceId: "ws1",
      name: "three",
      slug: "three",
      workingManifest: emptyManifest(),
      origin: { type: "blank" },
      createdAt: "2026-01-03",
    } as Project);
    const moved = await conditional(etag!);
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).not.toBe(etag);
  });
});
