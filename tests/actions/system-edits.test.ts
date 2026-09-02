/**
 * Editing shapes that used to have no honest path: clearing a port, an empty
 * rename that silently did nothing, and changing a connection's capability
 * without tearing the connection down first.
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionContext } from "@/lib/actions/core";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-edits-"));

const { runAction } = await import("@/lib/actions/core");
const { q, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const ctx: ActionContext = {
  workspaceId: "ws-edits",
  actor: { type: "user", id: "u", name: "Editor" },
};

let projectId = "";
const pctx = () => ({ ...ctx, projectId });
const manifest = () => q.project(projectId)!.workingManifest;
const service = (name: string) => manifest().services.find((s) => s.name === name)!;

const exec = (actionId: string, input: unknown) =>
  runAction(actionId, pctx(), input, { mode: "execute" }).then((r) => r.result!);
const plan = (actionId: string, input: unknown) =>
  runAction(actionId, pctx(), input, { mode: "plan" }).then((r) => r.plan!);

beforeAll(async () => {
  resetDb({
    workspaces: [{ id: "ws-edits", name: "Edits", slug: "edits", createdAt: new Date().toISOString() }],
  });
  const created = await runAction("project.create", ctx, { name: "Atlas" }, { mode: "execute" });
  projectId = (created.result!.data as { projectId: string }).projectId;
  await exec("system.addService", { name: "api", kind: "web", image: "ghcr.io/acme/api:1", port: 8080 });
  await exec("system.addService", { name: "jobs", kind: "worker", image: "ghcr.io/acme/jobs:1", port: 9000 });
  await exec("system.addResource", { name: "main-db", kind: "postgres" });
});

describe("system.updateService", () => {
  it("clears a port with an explicit null, and leaves it alone when the field is absent", async () => {
    expect(service("jobs").port).toBe(9000);

    // absent ≠ null: an unrelated edit must not wipe the port
    await exec("system.updateService", { serviceId: service("jobs").id, size: "standard" });
    expect(service("jobs").port).toBe(9000);

    const cleared = await exec("system.updateService", { serviceId: service("jobs").id, port: null });
    expect(cleared.ok).toBe(true);
    expect(service("jobs").port).toBeUndefined();
  });

  it("warns rather than silently breaking the system when a web port is cleared", async () => {
    const preview = await plan("system.updateService", { serviceId: service("api").id, port: null });
    expect(preview.warnings.join(" ")).toMatch(/must say what it listens on/i);
  });

  it("rejects an empty name instead of accepting it and changing nothing", async () => {
    const before = service("api").name;
    const preview = await plan("system.updateService", { serviceId: service("api").id, name: "" });
    expect(preview.blocked).toBeTruthy();
    expect(preview.blocked).toMatch(/name/i);

    const result = await exec("system.updateService", { serviceId: service("api").id, name: "" });
    expect(result.ok).toBe(false);
    expect(service("api").name).toBe(before);
  });
});

describe("system.bind edits an existing connection in place", () => {
  it("changes the capability without an unbind/bind round trip, and says what moves", async () => {
    await exec("system.bind", { from: "jobs", to: "main-db" });
    const before = manifest().bindings.find((b) => b.from === service("jobs").id)!;
    expect(before.capability).toBe("sql");

    const preview = await plan("system.bind", { from: "jobs", to: "main-db", capability: "cache" });
    expect(preview.warnings.join(" ")).toMatch(/loses the variables sql injected/i);

    const result = await exec("system.bind", { from: "jobs", to: "main-db", capability: "cache" });
    expect(result.ok).toBe(true);
    const after = manifest().bindings.filter((b) => b.from === service("jobs").id);
    expect(after).toHaveLength(1); // edited, not duplicated
    expect(after[0].capability).toBe("cache");
    expect(after[0].id).toBe(before.id); // same edge, same identity
  });

  it("updates only the explanation when only a note is given", async () => {
    const result = await exec("system.bind", { from: "jobs", to: "main-db", note: "jobs writes the outbox" });
    expect(result.ok).toBe(true);
    const edge = manifest().bindings.find((b) => b.from === service("jobs").id)!;
    expect(edge.note).toBe("jobs writes the outbox");
    expect(edge.capability).toBe("cache"); // untouched
  });

  it("still says nothing to change when nothing changed", async () => {
    const preview = await plan("system.bind", { from: "jobs", to: "main-db" });
    expect(preview.summary).toMatch(/already connected/i);
    expect(preview.costDeltaUsd).toBe(0);
  });
});
