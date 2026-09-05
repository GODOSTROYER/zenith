import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { Deployment, Environment, Project, Workspace } from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-bootstrap-"));
const { resetDb } = await import("@/lib/db/store");
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
});
