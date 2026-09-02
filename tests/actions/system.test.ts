import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionContext } from "@/lib/actions/core";

// The store reads ORRERY_DATA when it is first imported, so point it at a
// scratch directory before anything pulls it in.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-test-"));
process.env.ORRERY_DATA = DATA;
// This suite is the UNCONFIGURED secret store: explicit, so a developer with
// the variable exported in their shell gets the same run as CI.
delete process.env.ORRERY_SECRET_KEY;

const { runAction } = await import("@/lib/actions/core");
const { flush, readAudit, resetDb, q } = await import("@/lib/db/store");
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

  it("keeps secrets out of the manifest: records the reference, never the value", async () => {
    await exec("system.setSecret", { serviceId: "api", key: "STRIPE_SECRET" }, pctx());
    const api = manifest().services.find((s) => s.name === "api")!;
    const entry = api.env.find((e) => e.key === "STRIPE_SECRET")!;
    expect(entry.secretRef).toBe("vault:STRIPE_SECRET");
    expect(entry.value).toBeUndefined();
  });

  /*
   * This file runs with no ORRERY_SECRET_KEY (see the top), which is the
   * unconfigured store — the state most installs start in. Its promise is that
   * nothing half-works: a value is refused rather than accepted and dropped,
   * the refusal names the variable and how to make a key, and no value is ever
   * lost on the way. `tests/secrets/store.test.ts` is the configured half.
   */
  it("refuses a secret VALUE rather than accepting and discarding it", async () => {
    const { result } = await runAction(
      "system.setSecret",
      pctx(),
      { serviceId: "api", key: "SENDGRID_KEY", secretValue: "sk_live_do_not_store" },
      { mode: "execute" }
    );
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/secret store is not configured/i);
    // The refusal is only useful if it names the variable and how to make one.
    expect(result!.error).toMatch(/ORRERY_SECRET_KEY/);
    expect(result!.error).toMatch(/openssl rand -base64 32/);
    expect(result!.error).toMatch(/secretRef/); // the path that still works
    expect(JSON.stringify(manifest())).not.toContain("sk_live_do_not_store");
    expect(manifest().services.find((s) => s.name === "api")!.env.some((e) => e.key === "SENDGRID_KEY")).toBe(false);
    // and the plan says so up front, so the control is disabled not dead
    const { plan } = await runAction(
      "system.setSecret",
      pctx(),
      { serviceId: "api", key: "SENDGRID_KEY", secretValue: "sk_live_do_not_store" },
      { mode: "plan" }
    );
    expect(plan!.blocked).toMatch(/secret store is not configured/i);
    expect(JSON.stringify(plan)).not.toContain("sk_live_do_not_store");
  });

  it("never replaces an existing plaintext value with a reference — that would delete it", async () => {
    await exec("system.setEnvVar", { serviceId: "api", key: "LEGACY_ENDPOINT", value: "https://issuer.test/t" }, pctx());
    const { result } = await runAction(
      "system.setSecret",
      pctx(),
      { serviceId: "api", key: "LEGACY_ENDPOINT" },
      { mode: "execute" }
    );
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/delete the only copy/i);
    const api = manifest().services.find((s) => s.name === "api")!;
    expect(api.env.find((e) => e.key === "LEGACY_ENDPOINT")!.value).toBe("https://issuer.test/t");
  });

  it("will not move a value into a store that does not exist, and leaves it untouched", async () => {
    const { result } = await runAction(
      "system.setSecret",
      pctx(),
      { serviceId: "api", key: "LEGACY_ENDPOINT", moveExistingValue: true },
      { mode: "execute" }
    );
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/secret store is not configured/i);
    expect(result!.error).toMatch(/would delete the only copy/i);
    expect(result!.error).toMatch(/ORRERY_SECRET_KEY/);
    const api = manifest().services.find((s) => s.name === "api")!;
    expect(api.env.find((e) => e.key === "LEGACY_ENDPOINT")!.value).toBe("https://issuer.test/t");
  });

  it("refuses to rotate when there is no store, naming the variable", async () => {
    await exec("system.setSecret", { serviceId: "api", key: "MAILER_TOKEN" }, pctx());
    const { result } = await runAction(
      "system.rotateSecret",
      pctx(),
      { serviceId: "api", key: "MAILER_TOKEN", secretValue: "sk_live_rotate_nowhere" },
      { mode: "execute" }
    );
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/ORRERY_SECRET_KEY/);
    const row = readAudit({ projectId }).find((r) => r.actionId === "system.rotateSecret")!;
    expect(JSON.stringify(row.input)).not.toContain("sk_live_rotate_nowhere");
  });

  it("still removes a reference when the store is off", async () => {
    await exec("system.removeSecret", { serviceId: "api", key: "MAILER_TOKEN" }, pctx());
    const api = manifest().services.find((s) => s.name === "api")!;
    expect(api.env.some((e) => e.key === "MAILER_TOKEN")).toBe(false);
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
    // Saves are coalesced over a 50ms window, and this suite runs faster than
    // that — flush so the assertion is about persistence, not about timing.
    flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, "state.json"), "utf8")) as {
      projects: { id: string; workingManifest: { services: { name: string }[] } }[];
    };
    const persisted = onDisk.projects.find((p) => p.id === projectId)!;
    expect(persisted.workingManifest.services.map((s) => s.name)).toEqual(["api"]);
  });
});

describe("system.updateRoute", () => {
  const routeOf = (host: string) => manifest().routes.find((r) => r.host === host)!;

  it("plans the TLS change in words, then applies it", async () => {
    await exec("system.addRoute", { host: "shop.example.com", serviceId: "api", tls: false }, pctx());

    const { plan } = await runAction(
      "system.updateRoute",
      pctx(),
      { routeId: "shop.example.com", tls: true },
      { mode: "plan" }
    );
    expect(plan!.summary).toMatch(/shop\.example\.com/);
    expect(plan!.details.join(" ")).toMatch(/certificate/i);
    expect(routeOf("shop.example.com").tls).toBe(false); // plan never mutates

    await exec("system.updateRoute", { routeId: "shop.example.com", tls: true }, pctx());
    expect(routeOf("shop.example.com").tls).toBe(true);
  });

  it("warns before it lets anyone turn TLS off", async () => {
    const { plan } = await runAction(
      "system.updateRoute",
      pctx(),
      { routeId: "shop.example.com", tls: false },
      { mode: "plan" }
    );
    expect(plan!.warnings.join(" ")).toMatch(/plaintext/i);
  });

  it("normalises a path prefix and refuses one that is already published", async () => {
    await exec("system.updateRoute", { routeId: "shop.example.com", pathPrefix: "api" }, pctx());
    expect(routeOf("shop.example.com").pathPrefix).toBe("/api");

    await exec("system.addRoute", { host: "shop.example.com", pathPrefix: "/admin" }, pctx());
    const { result } = await runAction(
      "system.updateRoute",
      pctx(),
      { routeId: routeOf("shop.example.com").id, pathPrefix: "/admin" },
      { mode: "execute" }
    );
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/already published/);
  });

  it("is what the route_no_tls security finding offers as its fix", async () => {
    await exec("system.addRoute", { host: "plain.example.com", serviceId: "api", tls: false }, pctx());
    const { analyze } = await import("@/lib/security/rules");
    const finding = analyze(q.project(projectId)!, []).find((f) => f.id.includes("route_no_tls"))!;
    expect(finding.fix?.actionId).toBe("system.updateRoute");

    await exec("system.updateRoute", { ...(finding.fix!.input as object) }, pctx());
    expect(routeOf("plain.example.com").tls).toBe(true);
  });

  it("rejects invalid input, and every error names the fix", async () => {
    const missing = await runAction("system.updateRoute", pctx(), { tls: true }, { mode: "execute" });
    expect(missing.result!.ok).toBe(false);
    expect(missing.result!.error).toMatch(/routeId/);

    const nothing = await runAction(
      "system.updateRoute",
      pctx(),
      { routeId: "shop.example.com" },
      { mode: "execute" }
    );
    expect(nothing.result!.ok).toBe(false);
    expect(nothing.result!.error).toMatch(/system\.addRoute/);

    const ghost = await runAction(
      "system.updateRoute",
      pctx(),
      { routeId: "nope.example.com", tls: true },
      { mode: "execute" }
    );
    expect(ghost.result!.ok).toBe(false);
    expect(ghost.result!.error).toMatch(/Known routes/);
  });
});
