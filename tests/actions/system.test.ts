import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionContext } from "@/lib/actions/core";

// The store reads ORRERY_DATA when it is first imported, so point it at a
// scratch directory before anything pulls it in.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-test-"));
process.env.ORRERY_DATA = DATA;

const { runAction } = await import("@/lib/actions/core");
const { readAudit, resetDb, q } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const ctx: ActionContext = {
  workspaceId: "ws-test",
  actor: { type: "user", id: "you", name: "you" },
};

async function exec(actionId: string, input: unknown, scope: Partial<ActionContext> = {}) {
  const { result } = await runAction(actionId, { ...ctx, ...scope }, input, { mode: "execute" });
  if (!result?.ok) throw new Error(`${actionId} failed: ${result?.error ?? result?.summary}`);
  return result;
}

let projectId = "";
const pctx = () => ({ ...ctx, projectId });
const manifest = () => q.project(projectId)!.workingManifest;

beforeAll(async () => {
  resetDb({
    workspaces: [{ id: "ws-test", name: "Test", slug: "test", createdAt: new Date().toISOString() }],
  });
  const created = await exec("project.create", { name: "Atlas" });
  projectId = (created.data as { projectId: string }).projectId;
});

describe("system.* actions round-trip the working manifest", () => {
  it("adds a service, a resource and a binding, and infers the capability", async () => {
    const svc = await exec("system.addService", { name: "api", kind: "web", image: "ghcr.io/acme/api:1", port: 8080 }, pctx());
    const serviceId = (svc.data as { serviceId: string }).serviceId;

    const res = await exec("system.addResource", { name: "main-db", kind: "postgres" }, pctx());
    const resourceId = (res.data as { resourceId: string }).resourceId;

    await exec("system.bind", { from: "api", to: "main-db" }, pctx());

    const m = manifest();
    expect(m.services.map((s) => s.name)).toEqual(["api"]);
    expect(m.resources.map((r) => r.name)).toEqual(["main-db"]);
    expect(m.bindings).toHaveLength(1);
    expect(m.bindings[0]).toMatchObject({ from: serviceId, to: resourceId, capability: "sql" });
    expect(m.bindings[0].note).toBeTruthy();
  });

  it("plans before it applies: cost delta and explanation, working copy untouched", async () => {
    const before = JSON.stringify(manifest());
    const { plan } = await runAction("system.addResource", pctx(), { name: "cache", kind: "redis" }, { mode: "plan" });
    expect(plan!.costDeltaUsd).toBeGreaterThan(0);
    expect(plan!.details.join(" ")).toMatch(/Redis cache/i);
    expect(JSON.stringify(manifest())).toBe(before); // plan never mutates
  });

  it("keeps secrets out of the manifest", async () => {
    await exec("system.setSecret", { serviceId: "api", key: "STRIPE_SECRET", secretValue: "sk_live_do_not_store" }, pctx());
    const api = manifest().services.find((s) => s.name === "api")!;
    const entry = api.env.find((e) => e.key === "STRIPE_SECRET")!;
    expect(entry.secretRef).toBe("vault:STRIPE_SECRET");
    expect(entry.value).toBeUndefined();
    expect(JSON.stringify(manifest())).not.toContain("sk_live_do_not_store");
  });

  it("refuses a plain env var that looks like a secret, and names the fix", async () => {
    const { result } = await runAction("system.setEnvVar", pctx(), { serviceId: "api", key: "DB_PASSWORD", value: "hunter2" }, { mode: "execute" });
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/system\.setSecret/);
  });

  it("scales a service and prices the change", async () => {
    const { plan } = await runAction("ops.scaleService", pctx(), { serviceId: "api", replicas: 3 }, { mode: "plan" });
    expect(plan!.costDeltaUsd).toBeGreaterThan(0);
    await exec("ops.scaleService", { serviceId: "api", replicas: 3 }, pctx());
    expect(manifest().services.find((s) => s.name === "api")!.replicas).toBe(3);
  });

  it("removing a service also removes the bindings that touched it", async () => {
    await exec("system.addService", { name: "worker", kind: "worker", image: "ghcr.io/acme/worker:1" }, pctx());
    await exec("system.bind", { from: "worker", to: "main-db" }, pctx());
    expect(manifest().bindings).toHaveLength(2);

    await exec("system.removeService", { serviceId: "worker" }, pctx());
    const m = manifest();
    expect(m.services.map((s) => s.name)).toEqual(["api"]);
    expect(m.bindings).toHaveLength(1);
    expect(m.bindings.every((b) => m.services.some((s) => s.id === b.from))).toBe(true);
  });

  it("errors name the fix and list what exists", async () => {
    const { result } = await runAction("system.bind", pctx(), { from: "api", to: "ghost" }, { mode: "execute" });
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/Known nodes/);
    expect(result!.error).toMatch(/api/);
  });

  it("writes an audit entry for every executed mutation", async () => {
    const audit = readAudit({ projectId });
    const ids = audit.map((a) => a.actionId);
    expect(ids).toContain("system.addService");
    expect(ids).toContain("system.bind");
    expect(ids).toContain("system.removeService");
    expect(audit.every((a) => a.summary.length > 0)).toBe(true);
    // the redactor must have kept the secret out of the audit log too
    expect(JSON.stringify(audit)).not.toContain("sk_live_do_not_store");
  });

  it("survives a reload from disk", async () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, "state.json"), "utf8")) as {
      projects: { id: string; workingManifest: { services: { name: string }[] } }[];
    };
    const persisted = onDisk.projects.find((p) => p.id === projectId)!;
    expect(persisted.workingManifest.services.map((s) => s.name)).toEqual(["api"]);
  });
});
