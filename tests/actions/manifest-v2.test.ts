/** Actual action registry and file store; deployment itself is sandbox only. */
import { beforeEach, describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-product-v2-", { fast: true });
const { db, resetDb, readAudit } = await import("@/lib/db/store");
const { runAction } = await import("@/lib/actions/core");
const { manifestHash } = await import("@/lib/actions/defs/project-manifest");
const { ctx, productSeed, v1, v2 } = await import("./manifest-v2-fixture");
await import("@/lib/actions/defs");

const run = (action: string, input: unknown, mode: "plan" | "execute" = "execute") => runAction(action, ctx, input, { mode });
beforeEach(() => resetDb(productSeed(v1())));

describe("product Manifest V2 edits", () => {
  it.each([v1, v2])("saves a complete valid document without rewriting it (%#)", async (make) => {
    const manifest = make();
    const source = JSON.stringify(manifest);
    const input = { manifest, expectedHash: manifestHash(db().projects[0].workingManifest) };
    const before = JSON.stringify(db().projects);
    const plan = await run("project.updateManifest", input, "plan");
    expect(plan.plan?.blocked).toBeUndefined();
    expect(JSON.stringify(db().projects)).toBe(before);
    const result = await run("project.updateManifest", input);
    expect(result.result?.ok).toBe(true);
    expect(JSON.stringify(db().projects[0].workingManifest)).toBe(source);
    expect(JSON.stringify(manifest)).toBe(source);
  });

  it("reviews V2-only edits, guards stale writes, and includes them in the next deploy plan", async () => {
    resetDb(productSeed(v2()));
    const old = manifestHash(db().projects[0].workingManifest);
    const next = v2();
    next.placement!.zones = 3;
    next.release!.migrate!.command = ["node", "next-migrate.js"];
    const plan = await run("project.updateManifest", { manifest: next, expectedHash: old }, "plan");
    expect(plan.plan?.details.join(" ")).toMatch(/placement.*release/);
    expect(plan.plan?.details.join(" ")).not.toContain("next-migrate.js");
    expect((await run("project.updateManifest", { manifest: next, expectedHash: old })).result?.ok).toBe(true);
    expect((await run("project.updateManifest", { manifest: v2(), expectedHash: old })).result?.error).toMatch(/working copy changed/);
    const deploy = await run("deploy.plan", {}, "plan");
    expect(deploy.plan?.blocked).toBeUndefined();
    expect(deploy.plan?.details.join(" ")).toContain("placement");
  });

  it.each([
    ["placement.zones", { ...v2(), placement: { provider: "auto", zones: 4 } }],
    ["providerConfig.aws.natGateways", { ...v2(), providerConfig: { aws: { natGateways: "sensitive-invalid-value" } } }],
    ["release.migrate.timeoutSec", { ...v2(), release: { migrate: { service: "web", command: ["node"], timeoutSec: 0 } } }],
    ["release.migrate.service", { ...v2(), release: { migrate: { service: "absent", command: ["node"] } } }],
    ["services.0.port", { ...v2(), services: [{ ...v1().services[0], port: undefined }] }],
    ["bindings.0.to", { ...v2(), bindings: [{ id: "bad", from: "svc-web", to: "missing", capability: "http" }] }],
  ])("refuses malformed V2 at %s in both plan and execute", async (path, manifest) => {
    const before = JSON.stringify(db().projects);
    const plan = await run("project.updateManifest", { manifest }, "plan");
    expect(plan.plan?.blocked).toContain(path);
    const result = await run("project.updateManifest", { manifest });
    expect(result.result?.ok).toBe(false);
    expect(result.result?.error).toContain(path);
    expect(JSON.stringify({ plan, result })).not.toContain("sensitive-invalid-value");
    expect(JSON.stringify(db().projects)).toBe(before);
  });

  it("refuses inline credentials before they reach the audit input", async () => {
    const manifest = v2();
    manifest.services[0].env = [{ key: "DATABASE_PASSWORD", value: "private-test-value" }];
    const result = await run("project.updateManifest", { manifest });
    expect(result.result?.error).toContain("services.0.env.0.value");
    expect(JSON.stringify({ result, audit: readAudit({ workspaceId: "ws" }) })).not.toContain("private-test-value");
    expect(db().projects[0].workingManifest.version).toBe(1);
  });

  it("refuses V2 sections on a V1 document rather than silently dropping them", async () => {
    const result = await run("project.updateManifest", { manifest: { ...v1(), placement: { provider: "auto" } } });
    expect(result.result?.ok).toBe(false);
    expect(result.result?.error).toMatch(/placement.*Unknown/);
  });

  it("keeps every V2 section during per-service edits and rejects dangling V2 references", async () => {
    resetDb(productSeed(v2()));
    expect((await run("system.updateService", { serviceId: "svc-web", replicas: 2 })).result?.ok).toBe(true);
    const expected = v2(); expected.services[0].replicas = 2;
    expect(db().projects[0].workingManifest).toStrictEqual(expected);
    const before = JSON.stringify(db().projects);
    const plan = await run("system.removeService", { serviceId: "svc-web" }, "plan");
    expect(plan.plan?.blocked).toMatch(/release\.migrate\.service|nodePlacement/);
    expect((await run("system.removeService", { serviceId: "svc-web" })).result?.ok).toBe(false);
    expect(JSON.stringify(db().projects)).toBe(before);
  });

  it("reports all lost sections when compose replaces V2 with V1", async () => {
    resetDb(productSeed(v2()));
    const plan = await run("project.importCompose", { composeYaml: "services:\n  web:\n    image: nginx:1\n    ports: ['3000:3000']" }, "plan");
    expect(plan.plan?.blocked).toBeUndefined();
    expect(plan.plan?.warnings.join(" ")).toMatch(/drops V2-only sections:.*release/);
    expect(db().projects[0].workingManifest.version).toBe(2);
    const result = await run("project.importCompose", { composeYaml: "services:\n  web:\n    image: nginx:1\n    ports: ['3000:3000']" });
    expect(result.result?.ok).toBe(true);
    expect(result.result?.summary).toMatch(/drops V2-only sections:.*release/);
  });

  it("reports loss on direct source saves and blueprint replacements too", async () => {
    resetDb(productSeed(v2()));
    const source = await run("project.updateManifest", { manifest: v1() });
    expect(source.result?.ok).toBe(true);
    expect(source.result?.summary).toMatch(/drops V2-only sections:.*release/);
    resetDb(productSeed(v2()));
    const blueprint = await run("project.applyBlueprint", { blueprint: "internal-tool" });
    expect(blueprint.result?.ok).toBe(true);
    expect(blueprint.result?.summary).toMatch(/drops V2-only sections:.*release/);
  });
});
